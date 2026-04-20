import express from "express";
import Stripe from "stripe";
import { BillingCycle, CouponStatus, EnterpriseProposalStatus, PriceType, SubscriptionStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { isFounderEligible } from "./founder";
import { stripeClient } from "./stripe";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import {
  getActiveSubscription,
  deactivateOtherSubscriptions,
  logPlanChange,
} from "./subscription-service";
import { toPostLimitType, toSchedulerRole } from "./plan-metadata";
import { extractStripePeriodBounds } from "./stripe-period";
import { upsertPlanFromPrice } from "./webhook";
import { mapStripeStatus, toPlanCategory } from "./billing-utils";
import { billingSyncRateLimiter } from "../../middleware/rateLimiter";
import { logActivity } from "../dashboard/activity-logger";

const router = express.Router();
const VIDEO_SESSION_HOURLY_RATE_CENTS = 49_500;
const PLATFORM_ADDON_MONTHLY_CENTS = 500;
const NY_SALES_TAX_BPS = 862.5;
const YEARLY_MULTIPLIER = 12 * 0.8;

type ApplicableCoupon = {
  id: string;
  code: string;
  discountType: string;
  discountValue: number;
  maxUses: number | null;
  usedCount: number;
  maxUsesPerClient: number;
  status: CouponStatus;
  expiresAt: Date | null;
  applicablePlans: string[];
};

function calculateCouponDiscountCents(coupon: ApplicableCoupon, subtotalCents: number): number {
  let discountCents = 0;
  if (coupon.discountType === "percentage") {
    const percentOff = Math.max(0, Math.min(100, Number(coupon.discountValue)));
    discountCents = Math.round((subtotalCents * percentOff) / 100);
  } else {
    discountCents = Math.round(Number(coupon.discountValue) * 100);
  }
  return Math.max(0, Math.min(discountCents, subtotalCents));
}

async function resolveApplicableCoupon(params: {
  couponCode?: string;
  userId: string;
  normalizedPlanCode: string;
}): Promise<{ coupon: ApplicableCoupon | null; error?: string }> {
  const normalizedCouponCode = params.couponCode?.trim().toUpperCase();
  if (!normalizedCouponCode) {
    return { coupon: null };
  }

  const coupon = await prisma.coupon.findUnique({
    where: { code: normalizedCouponCode },
    select: {
      id: true,
      code: true,
      discountType: true,
      discountValue: true,
      maxUses: true,
      usedCount: true,
      maxUsesPerClient: true,
      status: true,
      expiresAt: true,
      applicablePlans: true,
    },
  });

  if (!coupon) return { coupon: null, error: "Invalid coupon code" };
  if (coupon.status !== CouponStatus.ACTIVE) return { coupon: null, error: "Coupon is not active" };
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
    return { coupon: null, error: "Coupon has expired" };
  }
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    return { coupon: null, error: "Coupon usage limit reached" };
  }
  if (coupon.applicablePlans.length > 0 && !coupon.applicablePlans.includes(params.normalizedPlanCode)) {
    return { coupon: null, error: "Coupon is not applicable for this plan" };
  }

  const usageCount = await prisma.couponUsage.count({
    where: {
      couponId: coupon.id,
      userId: params.userId,
    },
  });

  if (usageCount >= coupon.maxUsesPerClient) {
    return { coupon: null, error: "Coupon already used by this client" };
  }

  return { coupon };
}

async function resolveOrCreateYearlyPrice(params: {
  product: Stripe.Product;
  defaultPrice: Stripe.Price;
  normalizedPlanCode: string;
}): Promise<Stripe.Price> {
  if (!stripeClient) {
    throw new Error("Stripe not configured");
  }

  const allPrices = await stripeClient.prices.list({
    product: params.product.id,
    active: true,
  });

  const yearlyPrice = allPrices.data.find((p) => p.recurring?.interval === "year");
  if (yearlyPrice) {
    return yearlyPrice;
  }

  if ((params.defaultPrice.recurring?.interval || "") !== "month") {
    throw new Error("Yearly billing is not available for this plan");
  }

  const monthlyCents = params.defaultPrice.unit_amount ?? 0;
  const yearlyCents = Math.round(monthlyCents * YEARLY_MULTIPLIER);

  const created = await stripeClient.prices.create(
    {
      product: params.product.id,
      unit_amount: yearlyCents,
      currency: params.defaultPrice.currency || "usd",
      recurring: { interval: "year" },
      metadata: {
        interval: "year",
        source: "talexia_runtime_yearly_fallback",
        planCode: params.normalizedPlanCode,
      },
    },
    { idempotencyKey: `yearly-price-${params.product.id}-${yearlyCents}` }
  );

  logger.info("Created yearly price on demand", {
    planCode: params.normalizedPlanCode,
    productId: params.product.id,
    priceId: created.id,
    yearlyCents,
  });

  return created;
}

async function resolveStandardMonthlyPrice(params: {
  product: Stripe.Product;
  fallbackPrice: Stripe.Price | null;
  planStandardCents?: number | null;
}): Promise<Stripe.Price | null> {
  if (!stripeClient) {
    return params.fallbackPrice;
  }

  const prices = await stripeClient.prices.list({
    product: params.product.id,
    active: true,
    limit: 100,
  });

  const monthlyPrices = prices.data.filter((p) => p.recurring?.interval === "month");
  const standardFromMetadata = params.product.metadata.priceStandardCents
    ? parseInt(params.product.metadata.priceStandardCents)
    : null;
  const targetStandardCents = standardFromMetadata ?? params.planStandardCents ?? params.fallbackPrice?.unit_amount ?? null;

  if (targetStandardCents !== null && !Number.isNaN(targetStandardCents)) {
    const matched = monthlyPrices.find((p) => p.unit_amount === targetStandardCents);
    if (matched) {
      return matched;
    }
  }

  if (params.fallbackPrice?.recurring?.interval === "month") {
    return params.fallbackPrice;
  }

  return monthlyPrices[0] ?? params.fallbackPrice;
}

async function resolvePriceForPlanAndCycle(params: {
  normalizedPlanCode: string;
  billingCycle: BillingCycle;
  userId: string;
}): Promise<{ product: Stripe.Product; priceId: string; priceType: PriceType }> {
  if (!stripeClient) {
    throw new Error("Stripe not configured");
  }

  const interval = params.billingCycle === BillingCycle.YEARLY ? "year" : "month";
  const planFromDb = await prisma.plan.findUnique({ where: { code: params.normalizedPlanCode } });

  let product: Stripe.Product | null = null;
  let defaultPrice: Stripe.Price | null = null;

  if (planFromDb?.stripePriceStandardId) {
    try {
      const dbPrice = await stripeClient.prices.retrieve(planFromDb.stripePriceStandardId, {
        expand: ["product"],
      });
      defaultPrice = dbPrice;
      product =
        typeof dbPrice.product === "string"
          ? await stripeClient.products.retrieve(dbPrice.product)
          : (dbPrice.product as Stripe.Product | null);
    } catch (error) {
      logger.warn("Failed to resolve scheduled-change plan from DB stripe price", {
        planCode: params.normalizedPlanCode,
        stripePriceStandardId: planFromDb?.stripePriceStandardId,
        error,
      });
    }
  }

  if (!product || !defaultPrice) {
    const products = await stripeClient.products.list({
      active: true,
      expand: ["data.default_price"],
      limit: 100,
    });

    const byMetadataCode = products.data.find(
      (p) => (p.metadata.code || "").toUpperCase() === params.normalizedPlanCode
    );
    const byName = planFromDb?.name
      ? products.data.find((p) => p.name.trim().toLowerCase() === planFromDb.name.trim().toLowerCase())
      : undefined;

    product = byMetadataCode || byName || null;
    defaultPrice = (product?.default_price as Stripe.Price | null) || null;
  }

  if (!product) {
    throw new Error("Plan not found");
  }

  if (!defaultPrice) {
    throw new Error("Plan has no price configured");
  }

  const standardMonthlyPrice = await resolveStandardMonthlyPrice({
    product,
    fallbackPrice: defaultPrice,
    planStandardCents: planFromDb?.priceStandardCents,
  });
  if (!standardMonthlyPrice) {
    throw new Error("Plan has no monthly standard price configured");
  }

  let selectedPrice: Stripe.Price = standardMonthlyPrice;
  if (interval === "year") {
    selectedPrice = await resolveOrCreateYearlyPrice({
      product,
      defaultPrice: standardMonthlyPrice,
      normalizedPlanCode: params.normalizedPlanCode,
    });
  }

  const eligibleForFounder = await isFounderEligible(params.userId);
  const priceType = eligibleForFounder ? PriceType.FOUNDER : PriceType.STANDARD;
  const selectedPriceId = selectedPrice.id;

  return {
    product,
    priceId: selectedPriceId,
    priceType,
  };
}

router.get("/plans", async (_req, res) => {
  // Serve from DB first (populated by startup sync — avoids a live Stripe call per request)
  const dbPlans = await prisma.plan.findMany({ orderBy: { priceStandardCents: "asc" } });
  if (dbPlans.length > 0) {
    return res.json(dbPlans.map(serializePlan));
  }

  // DB empty — one-time fallback to Stripe (e.g. first boot before sync ran)
  if (stripeClient) {
    try {
      const products = await stripeClient.products.list({
        active: true,
        expand: ["data.default_price"],
        limit: 100,
      });

      const plans = products.data.map((product) => {
        const price = product.default_price as Stripe.Price | null;
        const metadata = product.metadata || {};
        return {
          code: metadata.code || product.id,
          name: product.name,
          category: toPlanCategory(metadata.category),
          description: product.description,
          isJewelry: metadata.isJewelry?.toLowerCase() === "true",
          platformLimit: metadata.platformLimit ? parseInt(metadata.platformLimit) : null,
          baseVisualQuota: metadata.baseVisualQuota ? parseInt(metadata.baseVisualQuota) : null,
          basePostQuota: metadata.basePostQuota ? parseInt(metadata.basePostQuota) : null,
          postLimitType: metadata.postLimitType || "NONE",
          schedulerRole: metadata.schedulerRole || "CLIENT",
          priceStandardCents: price?.unit_amount || 0,
          priceFounderCents: metadata.priceFounderCents ? parseInt(metadata.priceFounderCents) : price?.unit_amount || 0,
          hasYearlyPrice: false,
        };
      });

      return res.json(plans);
    } catch (error) {
      logger.error("Failed to fetch plans from Stripe", error);
    }
  }

  res.json([]);
});

router.post("/coupons/validate", requireAuth, async (req, res) => {
  const schema = z.object({
    couponCode: z.string().trim().min(3).max(64),
    planCode: z.string(),
    subtotalCents: z.coerce.number().int().min(0).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const userId = req.user!.id;
  const normalizedPlanCode = parsed.data.planCode.trim().toUpperCase();
  const couponResult = await resolveApplicableCoupon({
    couponCode: parsed.data.couponCode,
    userId,
    normalizedPlanCode,
  });

  if (couponResult.error || !couponResult.coupon) {
    return res.status(400).json({ error: couponResult.error || "Invalid coupon code" });
  }

  const coupon = couponResult.coupon;
  const subtotalCents = parsed.data.subtotalCents ?? 0;
  const estimatedDiscountCents = calculateCouponDiscountCents(coupon, subtotalCents);

  return res.json({
    valid: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      expiresAt: coupon.expiresAt,
      applicablePlans: coupon.applicablePlans,
    },
    estimatedDiscountCents,
  });
});

router.post("/checkout", requireAuth, async (req, res) => {
  const schema = z.object({
    planCode: z.string(),
    billingCycle: z.enum(["monthly", "yearly"]).optional().default("monthly"),
    termsAccepted: z.literal(true, { message: "Terms & Conditions must be accepted" }),
    addonPlatformQty: z.coerce.number().int().min(0).max(10).optional().default(0),
    videoSessionHours: z.coerce.number().int().min(0).max(40).optional().default(0),
    couponCode: z.string().trim().min(3).max(64).optional(),
    // Backward compatibility for older frontend payload.
    videoAddonEnabled: z.boolean().optional().default(false),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { planCode, billingCycle, addonPlatformQty } = parsed.data;
  const videoSessionHours = parsed.data.videoSessionHours > 0
    ? parsed.data.videoSessionHours
    : parsed.data.videoAddonEnabled
      ? 1
      : 0;
  const videoAddonEnabled = videoSessionHours > 0;
  const termsAcceptedAt = new Date();
  const normalizedPlanCode = planCode.trim().toUpperCase();
  let interval: "month" | "year" = billingCycle === "yearly" ? "year" : "month";
  let billingCycleEnum = billingCycle === "yearly" ? BillingCycle.YEARLY : BillingCycle.MONTHLY;
  const nyTaxRateId = env.STRIPE_NY_SALES_TAX_RATE_ID;

  if (!nyTaxRateId) {
    return res.status(503).json({
      error: "NY sales tax rate is not configured",
      requiredEnv: "STRIPE_NY_SALES_TAX_RATE_ID",
    });
  }

  // Find product in Stripe by code in metadata
  if (!stripeClient) {
    return res.status(503).json({ error: "Stripe not configured" });
  }

  const planFromDb = await prisma.plan.findUnique({ where: { code: normalizedPlanCode } });
  const enterpriseProposal = planFromDb?.isCustomEnterprise
    ? await prisma.enterprisePlanProposal.findUnique({ where: { planCode: normalizedPlanCode } })
    : null;

  if (planFromDb?.isCustomEnterprise && !enterpriseProposal) {
    return res.status(404).json({ error: "Enterprise proposal not found" });
  }

  if (enterpriseProposal) {
    billingCycleEnum = enterpriseProposal.billingCycle;
    interval = enterpriseProposal.billingCycle === BillingCycle.YEARLY ? "year" : "month";
  }

  let product: Stripe.Product | null = null;
  let defaultPrice: Stripe.Price | null = null;

  if (!planFromDb?.isCustomEnterprise && planFromDb?.stripePriceStandardId) {
    try {
      const dbPrice = await stripeClient.prices.retrieve(planFromDb.stripePriceStandardId, {
        expand: ["product"],
      });
      defaultPrice = dbPrice;
      product =
        typeof dbPrice.product === "string"
          ? await stripeClient.products.retrieve(dbPrice.product)
          : (dbPrice.product as Stripe.Product | null);
    } catch (error) {
      logger.warn("Failed to resolve checkout plan from DB stripe price", {
        planCode: normalizedPlanCode,
        stripePriceStandardId: planFromDb.stripePriceStandardId,
        error,
      });
    }
  }

  if (!product || !defaultPrice) {
    const products = await stripeClient.products.list({
      active: true,
      expand: ["data.default_price"],
      limit: 100,
    });

    const byMetadataCode = products.data.find((p) => (p.metadata.code || "").toUpperCase() === normalizedPlanCode);
    const byName = planFromDb?.name
      ? products.data.find((p) => p.name.trim().toLowerCase() === planFromDb.name.trim().toLowerCase())
      : undefined;

    product = byMetadataCode || byName || null;
    defaultPrice = (product?.default_price as Stripe.Price | null) || null;
  }

  const isCustomEnterprisePlan = Boolean(planFromDb?.isCustomEnterprise);
  if (!isCustomEnterprisePlan) {
    if (!product) {
      return res.status(404).json({ error: "Plan not found" });
    }

    if (!defaultPrice) {
      return res.status(400).json({ error: "Plan has no price configured" });
    }

    const standardMonthlyPrice = await resolveStandardMonthlyPrice({
      product,
      fallbackPrice: defaultPrice,
      planStandardCents: planFromDb?.priceStandardCents,
    });
    if (!standardMonthlyPrice) {
      return res.status(400).json({ error: "Plan has no monthly standard price configured" });
    }

    let price: Stripe.Price = standardMonthlyPrice;
    if (interval === "year") {
      try {
        price = await resolveOrCreateYearlyPrice({
          product,
          defaultPrice: standardMonthlyPrice,
          normalizedPlanCode,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Yearly billing is not available for this plan.";
        return res.status(400).json({
          error: `${message} Please choose monthly.`,
        });
      }
    }

    const userId = req.user!.id;
    const eligibleForFounder = await isFounderEligible(userId);
    const priceType = eligibleForFounder ? PriceType.FOUNDER : PriceType.STANDARD;

    const couponResult = await resolveApplicableCoupon({
      couponCode: parsed.data.couponCode,
      userId,
      normalizedPlanCode,
    });
    if (couponResult.error) {
      return res.status(400).json({ error: couponResult.error });
    }
    const applicableCoupon = couponResult.coupon;

    let priceId = price.id;

    // Ensure plan exists in local DB for FK (always use monthly/default price for plan record)
    const planPayload = {
      code: normalizedPlanCode,
      name: product.name,
      category: toPlanCategory(product.metadata.category),
      isCustomEnterprise: false,
      isJewelry: (product.metadata.isJewelry || "").toLowerCase() === "true",
      platformLimit: product.metadata.platformLimit ? parseInt(product.metadata.platformLimit) : null,
      baseVisualQuota: product.metadata.baseVisualQuota ? parseInt(product.metadata.baseVisualQuota) : null,
      basePostQuota: product.metadata.basePostQuota ? parseInt(product.metadata.basePostQuota) : null,
      postLimitType: toPostLimitType(product.metadata.postLimitType),
      schedulerRole: toSchedulerRole(product.metadata.schedulerRole),
      priceStandardCents: price.unit_amount ?? 0,
      priceFounderCents: product.metadata.priceFounderCents
        ? parseInt(product.metadata.priceFounderCents)
        : price.unit_amount ?? 0,
      stripePriceStandardId: price.id,
    };

  await prisma.plan.upsert({
    where: { code: normalizedPlanCode },
    update: planPayload,
    create: planPayload,
  });

  // Check if user has an active subscription to a different plan
    const activeSubscription = await getActiveSubscription(userId);
    const isPlanSwitch = activeSubscription && activeSubscription.planCode !== normalizedPlanCode;

  // Handle plan switching: cancel old subscription in Stripe if switching plans
  // OR cancel default/free plan subscriptions (those without Stripe subscription ID)
  if (isPlanSwitch) {
    // If the active subscription has no Stripe subscription ID, it's a default/free plan
    // Cancel it before creating the new paid subscription
    if (!activeSubscription.stripeSubscriptionId) {
      await prisma.subscription.update({
        where: { id: activeSubscription.id },
        data: {
          status: SubscriptionStatus.CANCELED,
          updatedAt: new Date(),
        },
      });
      // Continue to create new checkout session below (don't return early)
    } else if (activeSubscription.stripeSubscriptionId) {
      try {
        // Check if we should update the subscription or cancel it
        // Stripe supports subscription updates (plan switching) which handles proration automatically
        const stripeSub = await stripeClient.subscriptions.retrieve(
          activeSubscription.stripeSubscriptionId
        );

        if (stripeSub.status === "active" || stripeSub.status === "trialing") {
          const allowDirectPlanSwitch =
            interval === "month" && addonPlatformQty === 0 && videoSessionHours === 0;

          if (!allowDirectPlanSwitch) {
            throw new Error("Direct plan switch skipped due to add-ons or non-monthly cycle");
          }

          // Update existing subscription to new plan (Stripe handles proration)
          // This is the preferred method as it maintains billing continuity
          try {
            await stripeClient.subscriptions.update(activeSubscription.stripeSubscriptionId, {
              items: [
                {
                  id: stripeSub.items.data[0].id,
                  price: priceId,
                },
              ],
              metadata: {
                userId,
                planCode: normalizedPlanCode,
                priceType,
                billingCycle,
                termsAcceptedAt: termsAcceptedAt.toISOString(),
                switchedFrom: activeSubscription.planCode,
              },
              proration_behavior: "create_prorations",
            });

            logger.info(
              `Updated Stripe subscription ${activeSubscription.stripeSubscriptionId} to plan ${normalizedPlanCode}`,
              { userId, oldPlan: activeSubscription.planCode, newPlan: normalizedPlanCode }
            );

            // Update local subscription record
            await prisma.subscription.update({
              where: { id: activeSubscription.id },
              data: {
                planCode: normalizedPlanCode,
                priceType,
                status: SubscriptionStatus.ACTIVE,
                updatedAt: new Date(),
              },
            });

            // Log plan change
            await logPlanChange(userId, activeSubscription.planCode, normalizedPlanCode, "plan_switch_checkout");

            logActivity({
              userId,
              type: "SUBSCRIPTION_CHECKOUT_STARTED",
              title: "Subscription Changed",
              description: `Switched from ${activeSubscription.planCode} to ${normalizedPlanCode} (${billingCycle})`,
            }).catch(() => {});

            // Return success - no checkout needed since we updated the subscription
            return res.json({
              success: true,
              message: "Plan switched successfully",
              planCode: normalizedPlanCode,
              priceType,
              // Optionally redirect to billing page instead of checkout
              redirectUrl: `${env.FRONTEND_URL}/dashboard/billing`,
            });
          } catch (updateError) {
            logger.warn(
              "Failed to update Stripe subscription, falling back to new checkout",
              updateError
            );
            // Fall through to create new checkout session
          }
        } else {
          // Subscription is not active, cancel it in our DB
          await prisma.subscription.update({
            where: { id: activeSubscription.id },
            data: {
              status: SubscriptionStatus.CANCELED,
              updatedAt: new Date(),
            },
          });
        }
      } catch (error) {
        logger.error("Error handling plan switch in Stripe", error);
        // Cancel the old Stripe subscription so the user is not double-billed
        if (activeSubscription.stripeSubscriptionId) {
          try {
            await stripeClient.subscriptions.cancel(activeSubscription.stripeSubscriptionId);
          } catch (cancelError) {
            logger.error("Failed to cancel old subscription after plan-switch error", cancelError);
          }
        }
        // Mark the old local record as canceled before creating a new checkout
        await prisma.subscription.update({
          where: { id: activeSubscription.id },
          data: { status: SubscriptionStatus.CANCELED, updatedAt: new Date() },
        });
      }
    }
  }

  // Guard: Prevent duplicate checkout for the same plan
  if (activeSubscription && activeSubscription.planCode === normalizedPlanCode) {
    if (
      activeSubscription.status === SubscriptionStatus.ACTIVE ||
      activeSubscription.status === SubscriptionStatus.TRIALING
    ) {
      return res.json({
        alreadySubscribed: true,
        currentPlan: activeSubscription.planCode,
      });
    }
  }

  // Get or create Stripe customer
  let stripeCustomerId: string | undefined;
  const existingSubscription = await prisma.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.INCOMPLETE },
    orderBy: { createdAt: "desc" },
  });

  if (existingSubscription?.stripeCustomerId) {
    stripeCustomerId = existingSubscription.stripeCustomerId;
  } else {
    // Create Stripe customer if needed
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.email) {
      try {
        const customer = await stripeClient.customers.create({
          email: user.email,
          metadata: { userId },
        });
        stripeCustomerId = customer.id;
      } catch (error) {
        logger.error("Failed to create Stripe customer", error);
      }
    }
  }

  // Create or update subscription record in INCOMPLETE state
  // This will be updated to ACTIVE when checkout completes via webhook
  let subscriptionRecord;
  if (existingSubscription && !isPlanSwitch) {
    // Update existing incomplete subscription
    subscriptionRecord = await prisma.subscription.update({
      where: { id: existingSubscription.id },
      data: {
        planCode: normalizedPlanCode,
        priceType,
        billingCycle: billingCycleEnum,
        status: SubscriptionStatus.INCOMPLETE,
        stripeCustomerId: stripeCustomerId || existingSubscription.stripeCustomerId,
        termsAcceptedAt,
        addonPlatformQty,
        videoAddonEnabled,
        videoSessionHours,
        updatedAt: new Date(),
      },
    });
  } else {
    // Create new subscription record
    subscriptionRecord = await prisma.subscription.create({
      data: {
        userId,
        planCode: normalizedPlanCode,
        priceType,
        billingCycle: billingCycleEnum,
        status: SubscriptionStatus.INCOMPLETE,
        stripeCustomerId,
        termsAcceptedAt,
        addonPlatformQty,
        videoAddonEnabled,
        videoSessionHours,
      },
    });
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  const taxLineConfig = { tax_rates: [nyTaxRateId] };
  const cartSubtotalCentsParts: number[] = [];
  const basePriceCents = price.unit_amount ?? 0;

  lineItems.push({
    price: priceId,
    quantity: 1,
    ...taxLineConfig,
  });
  cartSubtotalCentsParts.push(basePriceCents);

  if (addonPlatformQty > 0) {
    if (interval === "year" && env.STRIPE_PLATFORM_ADDON_YEARLY_PRICE_ID) {
      lineItems.push({
        price: env.STRIPE_PLATFORM_ADDON_YEARLY_PRICE_ID,
        quantity: addonPlatformQty,
        ...taxLineConfig,
      });
      const yearlyUnitCents = PLATFORM_ADDON_MONTHLY_CENTS * 12;
      cartSubtotalCentsParts.push(yearlyUnitCents * addonPlatformQty);
    } else if (interval === "month" && env.STRIPE_PLATFORM_ADDON_PRICE_ID) {
      lineItems.push({
        price: env.STRIPE_PLATFORM_ADDON_PRICE_ID,
        quantity: addonPlatformQty,
        ...taxLineConfig,
      });
      cartSubtotalCentsParts.push(PLATFORM_ADDON_MONTHLY_CENTS * addonPlatformQty);
    } else {
      const addonUnitCents = interval === "year"
        ? PLATFORM_ADDON_MONTHLY_CENTS * 12
        : PLATFORM_ADDON_MONTHLY_CENTS;
      lineItems.push({
        price_data: {
          currency: "usd",
          recurring: { interval },
          unit_amount: addonUnitCents,
          product_data: {
            name: "Additional Platform",
            description:
              interval === "year"
                ? "$60/year per extra platform"
                : "$5/month per extra platform",
          },
        },
        quantity: addonPlatformQty,
        ...taxLineConfig,
      });
      cartSubtotalCentsParts.push(addonUnitCents * addonPlatformQty);
    }
  }

  if (videoSessionHours > 0) {
    lineItems.push({
      price_data: {
        currency: "usd",
        unit_amount: VIDEO_SESSION_HOURLY_RATE_CENTS,
        product_data: {
          name: "Video Session",
          description: "$495 per hour",
        },
      },
      quantity: videoSessionHours,
      ...taxLineConfig,
    });
    cartSubtotalCentsParts.push(VIDEO_SESSION_HOURLY_RATE_CENTS * videoSessionHours);
  }

  const subtotalCents = cartSubtotalCentsParts.reduce((sum, value) => sum + value, 0);
  let couponDiscountCents = 0;
  if (applicableCoupon) {
    couponDiscountCents = calculateCouponDiscountCents(applicableCoupon, subtotalCents);
  }

  const discountedSubtotalCents = Math.max(subtotalCents - couponDiscountCents, 0);
  const estimatedTaxCents = Math.round((discountedSubtotalCents * NY_SALES_TAX_BPS) / 10_000);
  const estimatedTotalCents = discountedSubtotalCents + estimatedTaxCents;

  let checkoutDiscounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
  if (applicableCoupon && couponDiscountCents > 0) {
    try {
      let stripeCoupon: Stripe.Coupon;
      if (applicableCoupon.discountType === "percentage") {
        const percentOff = Math.max(0, Math.min(100, Number(applicableCoupon.discountValue)));
        stripeCoupon = await stripeClient.coupons.create(
          {
            duration: "once",
            percent_off: percentOff,
            name: `Talexia Coupon ${applicableCoupon.code}`,
            metadata: {
              source: "talexia_internal_coupon",
              couponId: applicableCoupon.id,
              couponCode: applicableCoupon.code,
            },
          },
          { idempotencyKey: `coupon-${applicableCoupon.code}-pct-${percentOff}` }
        );
      } else {
        stripeCoupon = await stripeClient.coupons.create(
          {
            duration: "once",
            amount_off: couponDiscountCents,
            currency: "usd",
            name: `Talexia Coupon ${applicableCoupon.code}`,
            metadata: {
              source: "talexia_internal_coupon",
              couponId: applicableCoupon.id,
              couponCode: applicableCoupon.code,
            },
          },
          { idempotencyKey: `coupon-${applicableCoupon.code}-amt-${couponDiscountCents}` }
        );
      }
      checkoutDiscounts = [{ coupon: stripeCoupon.id }];
    } catch (error) {
      logger.error("Failed to create Stripe coupon for checkout", {
        couponCode: applicableCoupon.code,
        error,
      });
      return res.status(500).json({ error: "Unable to apply coupon at this time" });
    }
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    ...(checkoutDiscounts ? { discounts: checkoutDiscounts } : {}),
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    ...(stripeCustomerId
      ? { customer_update: { address: "auto", name: "auto" } }
      : {}),
    billing_address_collection: "required",
    ...(checkoutDiscounts ? {} : { allow_promotion_codes: true }),
    success_url: `${env.FRONTEND_URL}/billing/success`,
    cancel_url: `${env.FRONTEND_URL}/billing/cancel`,
    subscription_data: {
      metadata: {
        userId,
        planCode: normalizedPlanCode,
        priceType,
        subscriptionId: subscriptionRecord.id,
        billingCycle,
        termsAcceptedAt: termsAcceptedAt.toISOString(),
        addonPlatformQty: addonPlatformQty.toString(),
        videoAddonEnabled: videoAddonEnabled.toString(),
        videoSessionHours: videoSessionHours.toString(),
        ...(applicableCoupon
          ? {
            couponId: applicableCoupon.id,
            couponCode: applicableCoupon.code,
            couponDiscountCents: couponDiscountCents.toString(),
          }
          : {}),
        ...(isPlanSwitch ? { switchedFrom: activeSubscription?.planCode } : {}),
      },
    },
    metadata: {
      userId,
      planCode: normalizedPlanCode,
      priceType,
      subscriptionId: subscriptionRecord.id,
      billingCycle,
      termsAcceptedAt: termsAcceptedAt.toISOString(),
      addonPlatformQty: addonPlatformQty.toString(),
      videoAddonEnabled: videoAddonEnabled.toString(),
      videoSessionHours: videoSessionHours.toString(),
      ...(applicableCoupon
        ? {
          couponId: applicableCoupon.id,
          couponCode: applicableCoupon.code,
          couponDiscountCents: couponDiscountCents.toString(),
        }
        : {}),
      ...(isPlanSwitch ? { switchedFrom: activeSubscription?.planCode } : {}),
    },
  });

  logActivity({
    userId,
    type: "SUBSCRIPTION_CHECKOUT_STARTED",
    title: "Subscription Checkout Started",
    description: `Plan ${normalizedPlanCode} (${billingCycle})`,
  }).catch(() => {});

    return res.json({
      checkoutUrl: session.url,
      priceType,
      cart: {
        planCode: normalizedPlanCode,
        billingCycle,
        subtotalCents,
        couponCode: applicableCoupon?.code ?? null,
        couponDiscountCents,
        discountedSubtotalCents,
        taxRatePercent: 8.625,
        estimatedTaxCents,
        estimatedTotalCents,
        addonPlatformQty,
        videoSessionHours,
      },
    });
  }

  const userId = req.user!.id;
  const proposal = enterpriseProposal!;

  if (proposal.status === EnterpriseProposalStatus.PAYMENT_COMPLETED) {
    return res.status(409).json({
      success: false,
      message: "Enterprise plan payment is already completed",
      planCode: normalizedPlanCode,
    });
  }

  const priceType = PriceType.STANDARD;
  const quotedAmountCents = Math.round(Number(proposal.amount) * 100);

  const activeSubscription = await getActiveSubscription(userId);
  const isPlanSwitch = activeSubscription && activeSubscription.planCode !== normalizedPlanCode;

  if (isPlanSwitch) {
    if (!activeSubscription.stripeSubscriptionId) {
      await prisma.subscription.update({
        where: { id: activeSubscription.id },
        data: {
          status: SubscriptionStatus.CANCELED,
          updatedAt: new Date(),
        },
      });
    } else {
      await prisma.subscription.update({
        where: { id: activeSubscription.id },
        data: {
          status: SubscriptionStatus.CANCELED,
          updatedAt: new Date(),
        },
      });
    }
  }

  const existingSubscription = await prisma.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.INCOMPLETE },
    orderBy: { createdAt: "desc" },
  });

  let stripeCustomerId: string | undefined;
  if (existingSubscription?.stripeCustomerId) {
    stripeCustomerId = existingSubscription.stripeCustomerId;
  } else {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.email) {
      try {
        const customer = await stripeClient.customers.create({
          email: user.email,
          metadata: { userId },
        });
        stripeCustomerId = customer.id;
      } catch (error) {
        logger.error("Failed to create Stripe customer", error);
      }
    }
  }

  let subscriptionRecord;
  if (existingSubscription && !isPlanSwitch) {
    subscriptionRecord = await prisma.subscription.update({
      where: { id: existingSubscription.id },
      data: {
        planCode: normalizedPlanCode,
        priceType,
        billingCycle: proposal.billingCycle,
        status: SubscriptionStatus.INCOMPLETE,
        stripeCustomerId: stripeCustomerId || existingSubscription.stripeCustomerId,
        termsAcceptedAt,
        addonPlatformQty,
        videoAddonEnabled,
        videoSessionHours,
        updatedAt: new Date(),
      },
    });
  } else {
    subscriptionRecord = await prisma.subscription.create({
      data: {
        userId,
        planCode: normalizedPlanCode,
        priceType,
        billingCycle: proposal.billingCycle,
        status: SubscriptionStatus.INCOMPLETE,
        stripeCustomerId,
        termsAcceptedAt,
        addonPlatformQty,
        videoAddonEnabled,
        videoSessionHours,
      },
    });
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        price_data: {
          currency: "usd",
          recurring: { interval: proposal.billingCycle === BillingCycle.YEARLY ? "year" : "month" },
          unit_amount: quotedAmountCents,
          product_data: {
            name: proposal.planName,
            description: `Custom enterprise plan for ${proposal.companyName}`,
          },
        },
        quantity: 1,
        tax_rates: [nyTaxRateId],
      },
    ],
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    ...(stripeCustomerId ? { customer_update: { address: "auto", name: "auto" } } : {}),
    billing_address_collection: "required",
    success_url: `${env.FRONTEND_URL}/billing/success`,
    cancel_url: `${env.FRONTEND_URL}/billing/cancel`,
    subscription_data: {
      metadata: {
        userId,
        planCode: normalizedPlanCode,
        priceType,
        subscriptionId: subscriptionRecord.id,
        billingCycle: proposal.billingCycle === BillingCycle.YEARLY ? "yearly" : "monthly",
        termsAcceptedAt: termsAcceptedAt.toISOString(),
        addonPlatformQty: addonPlatformQty.toString(),
        videoAddonEnabled: videoAddonEnabled.toString(),
        videoSessionHours: videoSessionHours.toString(),
        enterpriseProposalId: proposal.id,
        enterpriseProposalPriceCents: quotedAmountCents.toString(),
      },
    },
    metadata: {
      userId,
      planCode: normalizedPlanCode,
      priceType,
      subscriptionId: subscriptionRecord.id,
      billingCycle: proposal.billingCycle === BillingCycle.YEARLY ? "yearly" : "monthly",
      termsAcceptedAt: termsAcceptedAt.toISOString(),
      addonPlatformQty: addonPlatformQty.toString(),
      videoAddonEnabled: videoAddonEnabled.toString(),
      videoSessionHours: videoSessionHours.toString(),
      enterpriseProposalId: proposal.id,
      enterpriseProposalPriceCents: quotedAmountCents.toString(),
    },
  });

  await prisma.enterprisePlanProposal.update({
    where: { id: proposal.id },
    data: {
      ...(proposal.status === EnterpriseProposalStatus.PENDING
        ? { status: EnterpriseProposalStatus.VIEWED }
        : {}),
      ...(proposal.viewedAt ? {} : { viewedAt: new Date() }),
    },
  });

  const estimatedTaxCents = Math.round((quotedAmountCents * NY_SALES_TAX_BPS) / 10_000);
  const estimatedTotalCents = quotedAmountCents + estimatedTaxCents;

  logActivity({
    userId,
    type: "SUBSCRIPTION_CHECKOUT_STARTED",
    title: "Subscription Checkout Started",
    description: `Enterprise plan ${proposal.planName} (${proposal.billingCycle.toLowerCase()})`,
  }).catch(() => {});

  return res.json({
    checkoutUrl: session.url,
    priceType,
    cart: {
      planCode: normalizedPlanCode,
      billingCycle: proposal.billingCycle === BillingCycle.YEARLY ? "yearly" : "monthly",
      subtotalCents: quotedAmountCents,
      couponCode: null,
      couponDiscountCents: 0,
      discountedSubtotalCents: quotedAmountCents,
      taxRatePercent: 8.625,
      estimatedTaxCents,
      estimatedTotalCents,
      addonPlatformQty,
      videoSessionHours,
    },
  });
});

router.post("/visual-topups/checkout", requireAuth, async (req, res) => {
  const schema = z.object({
    quantity: z.coerce.number().int().min(1).max(10).optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  if (!stripeClient || !env.STRIPE_VISUAL_TOPUP_PRICE_ID) {
    return res.status(503).json({ error: "Stripe top-ups not configured" });
  }

  const userId = req.user!.id;
  const subscription = await getActiveSubscription(userId);
  if (!subscription) {
    return res.status(403).json({ error: "Active subscription required" });
  }
  if (!subscription.plan?.baseVisualQuota) {
    return res.status(403).json({ error: "Visual quota not available for this plan" });
  }

  const quantity = parsed.data.quantity ?? 1;
  const price = await stripeClient.prices.retrieve(env.STRIPE_VISUAL_TOPUP_PRICE_ID, {
    expand: ["product"],
  });

  const product = price.product as Stripe.Product | null;
  const unitsPerPack = price.metadata.visualUnits
    ? parseInt(price.metadata.visualUnits)
    : product?.metadata?.visualUnits
      ? parseInt(product.metadata.visualUnits)
      : env.STRIPE_VISUAL_TOPUP_UNITS;

  if (!unitsPerPack || Number.isNaN(unitsPerPack)) {
    return res.status(500).json({ error: "Top-up units not configured" });
  }

  const totalUnits = unitsPerPack * quantity;

  const session = await stripeClient.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: price.id, quantity }],
    ...(subscription.stripeCustomerId ? { customer: subscription.stripeCustomerId } : {}),
    success_url: parsed.data.successUrl ?? `${env.FRONTEND_URL}/dashboard/submissions?topup=success`,
    cancel_url: parsed.data.cancelUrl ?? `${env.FRONTEND_URL}/dashboard/submissions?topup=cancel`,
    metadata: {
      userId,
      type: "visual_topup",
      topupUnits: unitsPerPack.toString(),
      topupQuantity: quantity.toString(),
      topupTotalUnits: totalUnits.toString(),
    },
  });

  return res.json({
    checkoutUrl: session.url,
    units: totalUnits,
  });
});

// Schedule upgrade/downgrade at next renewal (period end).
router.post("/schedule-change", requireAuth, async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: "Stripe not configured" });
  }

  const schema = z.object({
    targetPlanCode: z.string(),
    targetBillingCycle: z.enum(["monthly", "yearly"]),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const userId = req.user!.id;
  const targetPlanCode = parsed.data.targetPlanCode.trim().toUpperCase();
  const targetBillingCycle =
    parsed.data.targetBillingCycle === "yearly" ? BillingCycle.YEARLY : BillingCycle.MONTHLY;

  const activeSubscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: {
        in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!activeSubscription) {
    return res.status(404).json({
      success: false,
      message: "No active subscription found",
    });
  }

  if (!activeSubscription.stripeSubscriptionId) {
    return res.status(400).json({
      success: false,
      message: "Stripe subscription not found for this active plan",
    });
  }

  const samePlan = activeSubscription.planCode === targetPlanCode;
  const sameCycle = activeSubscription.billingCycle === targetBillingCycle;
  if (samePlan && sameCycle) {
    return res.status(400).json({
      success: false,
      message: "Target plan and billing cycle are already active",
    });
  }

  try {
    const { priceId: targetPriceId } = await resolvePriceForPlanAndCycle({
      normalizedPlanCode: targetPlanCode,
      billingCycle: targetBillingCycle,
      userId,
    });

    const stripeSub = await stripeClient.subscriptions.retrieve(activeSubscription.stripeSubscriptionId, {
      expand: ["items.data.price"],
    });

    const { startUnix, endUnix } = extractStripePeriodBounds(stripeSub);
    if (!startUnix || !endUnix) {
      return res.status(400).json({
        success: false,
        message: "Unable to determine current billing period bounds",
      });
    }

    const currentItems = stripeSub.items.data.map((item) => ({
      price: String(item.price.id),
      quantity: item.quantity ?? 1,
    }));
    const nextCycleItems = currentItems.map((item, index) =>
      index === 0
        ? { price: targetPriceId, quantity: 1 }
        : { price: item.price, quantity: item.quantity }
    );

    const existingScheduleId =
      typeof stripeSub.schedule === "string"
        ? stripeSub.schedule
        : stripeSub.schedule?.id;

    const schedule = existingScheduleId
      ? await stripeClient.subscriptionSchedules.update(existingScheduleId, {
        end_behavior: "release",
        phases: [
          {
            start_date: startUnix,
            end_date: endUnix,
            items: currentItems,
            proration_behavior: "none",
          },
          {
            start_date: endUnix,
            items: nextCycleItems,
            proration_behavior: "none",
            metadata: {
              source: "talexia_scheduled_change",
              targetPlanCode,
              targetBillingCycle,
            },
          },
        ],
      })
      : await stripeClient.subscriptionSchedules.create({
        from_subscription: stripeSub.id,
      });

    const finalSchedule = existingScheduleId
      ? schedule
      : await stripeClient.subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        phases: [
          {
            start_date: startUnix,
            end_date: endUnix,
            items: currentItems,
            proration_behavior: "none",
          },
          {
            start_date: endUnix,
            items: nextCycleItems,
            proration_behavior: "none",
            metadata: {
              source: "talexia_scheduled_change",
              targetPlanCode,
              targetBillingCycle,
            },
          },
        ],
      });

    await logPlanChange(
      userId,
      activeSubscription.planCode,
      `${targetPlanCode}:${targetBillingCycle}`,
      "plan_switch_scheduled"
    );

    logActivity({
      userId,
      type: "SUBSCRIPTION_CHANGE_SCHEDULED",
      title: "Subscription Change Scheduled",
      description: `From ${activeSubscription.planCode} to ${targetPlanCode} (${targetBillingCycle.toLowerCase()})`,
    }).catch(() => {});

    return res.json({
      success: true,
      message: "Plan change scheduled for next billing cycle",
      scheduleId: finalSchedule.id,
      currentPlanCode: activeSubscription.planCode,
      currentBillingCycle: activeSubscription.billingCycle,
      targetPlanCode,
      targetBillingCycle,
      effectiveAt: new Date(endUnix * 1000),
    });
  } catch (error) {
    logger.error("Failed to schedule plan change", error);
    const message = error instanceof Error ? error.message : "Unable to schedule plan change";
    const knownClientErrors = [
      "Plan not found",
      "Plan has no price configured",
      "Yearly billing is not available for this plan",
      "Unable to determine current billing period bounds",
    ];
    const isClientError = knownClientErrors.some((known) => message.includes(known));
    return res.status(isClientError ? 400 : 500).json({
      success: false,
      message: isClientError ? message : "Unable to schedule plan change",
    });
  }
});

// Remove a previously scheduled plan change.
router.post("/scheduled-change/cancel", requireAuth, async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: "Stripe not configured" });
  }

  const userId = req.user!.id;
  const activeSubscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: {
        in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!activeSubscription?.stripeSubscriptionId) {
    return res.status(404).json({
      success: false,
      message: "No active Stripe subscription found",
    });
  }

  try {
    const stripeSub = await stripeClient.subscriptions.retrieve(activeSubscription.stripeSubscriptionId);
    const scheduleId =
      typeof stripeSub.schedule === "string"
        ? stripeSub.schedule
        : stripeSub.schedule?.id;

    if (!scheduleId) {
      return res.status(404).json({
        success: false,
        message: "No scheduled change found",
      });
    }

    await stripeClient.subscriptionSchedules.release(scheduleId);

    logActivity({
      userId,
      type: "SUBSCRIPTION_CHANGE_CANCELED",
      title: "Scheduled Subscription Change Canceled",
      description: `Schedule ID: ${scheduleId}`,
    }).catch(() => {});

    return res.json({
      success: true,
      message: "Scheduled plan change canceled successfully",
      scheduleId,
    });
  } catch (error) {
    logger.error("Failed to cancel scheduled plan change", error);
    return res.status(500).json({
      success: false,
      message: "Unable to cancel scheduled plan change",
    });
  }
});

// Cancel recurring charges from the next billing cycle.
router.post("/cancel", requireAuth, async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: "Stripe not configured" });
  }

  const userId = req.user!.id;
  const activeSubscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: {
        in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!activeSubscription) {
    return res.status(404).json({
      success: false,
      message: "No active subscription found",
    });
  }

  if (!activeSubscription.stripeSubscriptionId) {
    return res.status(400).json({
      success: false,
      message: "Stripe subscription not found for this active plan",
    });
  }

  try {
    const stripeSub = await stripeClient.subscriptions.update(
      activeSubscription.stripeSubscriptionId,
      {
        cancel_at_period_end: true,
      }
    );

    const { endUnix } = extractStripePeriodBounds(stripeSub);

    await prisma.subscription.update({
      where: { id: activeSubscription.id },
      data: {
        cancelAtPeriodEnd: true,
        currentPeriodEnd: endUnix ? new Date(endUnix * 1000) : activeSubscription.currentPeriodEnd,
        updatedAt: new Date(),
      },
    });

    logActivity({
      userId,
      type: "SUBSCRIPTION_CANCEL_SCHEDULED",
      title: "Subscription Cancellation Scheduled",
      description: `Plan ${activeSubscription.planCode}`,
    }).catch(() => {});

    return res.json({
      success: true,
      message: "Subscription will be canceled at the end of current billing cycle",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: endUnix ? new Date(endUnix * 1000) : activeSubscription.currentPeriodEnd,
      planCode: activeSubscription.planCode,
    });
  } catch (error) {
    logger.error("Failed to cancel subscription at period end", error);
    return res.status(500).json({
      success: false,
      message: "Unable to schedule cancellation",
    });
  }
});

// Resume recurring charges if cancellation was scheduled.
router.post("/resume", requireAuth, async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: "Stripe not configured" });
  }

  const userId = req.user!.id;
  const activeSubscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: {
        in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!activeSubscription) {
    return res.status(404).json({
      success: false,
      message: "No active subscription found",
    });
  }

  if (!activeSubscription.stripeSubscriptionId) {
    return res.status(400).json({
      success: false,
      message: "Stripe subscription not found for this active plan",
    });
  }

  try {
    await stripeClient.subscriptions.update(activeSubscription.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    await prisma.subscription.update({
      where: { id: activeSubscription.id },
      data: {
        cancelAtPeriodEnd: false,
        updatedAt: new Date(),
      },
    });

    logActivity({
      userId,
      type: "SUBSCRIPTION_RESUMED",
      title: "Subscription Resumed",
      description: `Plan ${activeSubscription.planCode}`,
    }).catch(() => {});

    return res.json({
      success: true,
      message: "Subscription cancellation removed; recurring charges resumed",
      cancelAtPeriodEnd: false,
      planCode: activeSubscription.planCode,
    });
  } catch (error) {
    logger.error("Failed to resume subscription recurring", error);
    return res.status(500).json({
      success: false,
      message: "Unable to resume recurring charges",
    });
  }
});

// Get current active plan details
router.get("/current-plan", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;

    let activeSubscription = await prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
      include: {
        plan: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    if (!activeSubscription) {
      const latestSubscription = await prisma.subscription.findFirst({
        where: { userId },
        include: { plan: true },
        orderBy: { updatedAt: "desc" },
      });

      if (latestSubscription && stripeClient && latestSubscription.stripeSubscriptionId) {
        try {
          const stripeSub = await stripeClient.subscriptions.retrieve(latestSubscription.stripeSubscriptionId, {
            expand: ["schedule"],
          });
          const stripeStatus = stripeSub.status;
          const nextStatus =
            stripeStatus === "active"
              ? SubscriptionStatus.ACTIVE
              : stripeStatus === "trialing"
                ? SubscriptionStatus.TRIALING
                : stripeStatus === "past_due"
                  ? SubscriptionStatus.PAST_DUE
                  : stripeStatus === "canceled" || stripeStatus === "incomplete_expired"
                    ? SubscriptionStatus.CANCELED
                    : latestSubscription.status;

          if (nextStatus !== latestSubscription.status) {
            activeSubscription = await prisma.subscription.update({
              where: { id: latestSubscription.id },
              data: {
                status: nextStatus,
                updatedAt: new Date(),
              },
              include: { plan: true },
            });
          } else if (stripeStatus === "active" || stripeStatus === "trialing") {
            activeSubscription = latestSubscription;
          }
        } catch (error) {
          logger.warn("Unable to recover enterprise current-plan from Stripe", {
            userId,
            subscriptionId: latestSubscription.id,
            error,
          });
        }
      }
    }

    if (!activeSubscription) {
      return res.status(404).json({
        success: false,
        message: "No active plan found",
      });
    }

    const plan = activeSubscription.plan;
    let scheduledChange: {
      scheduleId: string;
      effectiveAt: Date | null;
      targetPriceId: string | null;
      targetPlanCode: string | null;
      targetBillingCycle: "monthly" | "yearly" | null;
    } | null = null;

    if (stripeClient && activeSubscription.stripeSubscriptionId) {
      try {
        const stripeSub = await stripeClient.subscriptions.retrieve(activeSubscription.stripeSubscriptionId, {
          expand: ["schedule"],
        });
        const schedule =
          typeof stripeSub.schedule === "string"
            ? await stripeClient.subscriptionSchedules.retrieve(stripeSub.schedule)
            : stripeSub.schedule;

        if (schedule && schedule.status !== "released" && schedule.status !== "canceled") {
          const phases = schedule.phases || [];
          if (phases.length > 1) {
            const nextPhase = phases[1];
            const nextPrice = nextPhase.items?.[0]?.price;
            const nextPriceId =
              typeof nextPrice === "string"
                ? nextPrice
                : nextPrice?.id || null;
            const nextPlanCode = nextPhase.metadata?.targetPlanCode || null;
            const nextCycleMeta = nextPhase.metadata?.targetBillingCycle;
            const nextCycle =
              nextCycleMeta === "monthly" || nextCycleMeta === "yearly"
                ? nextCycleMeta
                : null;

            scheduledChange = {
              scheduleId: schedule.id,
              effectiveAt: nextPhase.start_date ? new Date(nextPhase.start_date * 1000) : null,
              targetPriceId: nextPriceId,
              targetPlanCode: nextPlanCode,
              targetBillingCycle: nextCycle,
            };
          }
        }
      } catch (error) {
        logger.warn("Unable to resolve scheduled change for current-plan", {
          userId,
          subscriptionId: activeSubscription.id,
          error,
        });
      }
    }

    return res.json({
      success: true,
      message: "Current plan details retrieved successfully",
      plan: {
        code: plan.code,
        name: plan.name,
        category: plan.category,
        isJewelry: plan.isJewelry,
        platformLimit: plan.platformLimit,
        baseVisualQuota: plan.baseVisualQuota,
        basePostQuota: plan.basePostQuota,
        postLimitType: plan.postLimitType,
        schedulerRole: plan.schedulerRole,
      },
      subscription: {
        id: activeSubscription.id,
        status: activeSubscription.status,
        billingCycle: activeSubscription.billingCycle,
        priceType: activeSubscription.priceType,
        currentPeriodStart: activeSubscription.currentPeriodStart,
        currentPeriodEnd: activeSubscription.currentPeriodEnd,
        cancelAtPeriodEnd: activeSubscription.cancelAtPeriodEnd,
        addonPlatformQty: activeSubscription.addonPlatformQty,
        videoAddonEnabled: activeSubscription.videoAddonEnabled,
        videoSessionHours: activeSubscription.videoSessionHours,
        termsAcceptedAt: activeSubscription.termsAcceptedAt,
        createdAt: activeSubscription.createdAt,
        updatedAt: activeSubscription.updatedAt,
      },
      scheduledChange,
    });
  } catch (error) {
    logger.error("Error fetching current plan", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch current plan",
    });
  }
});

// Stripe Customer Portal session
router.post("/portal", requireAuth, async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: "Stripe not configured" });
  }
  const stripe = stripeClient;

  const userId = req.user!.id;
  const subscription = await prisma.subscription.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  let stripeCustomerId = subscription?.stripeCustomerId;

  // Attempt to recover customer ID from Stripe if missing but we have a subscription ID
  if (!stripeCustomerId && subscription?.stripeSubscriptionId) {
    try {
      const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      stripeCustomerId = String(stripeSub.customer);
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { stripeCustomerId },
      });
    } catch (error) {
      logger.warn("Failed to recover Stripe customer from subscription", error);
    }
  }

  // As a fallback, create a customer if we have a user record but no customer yet
  if (!stripeCustomerId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(400).json({ error: "No user found for portal" });
    }
    try {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { userId },
      });
      stripeCustomerId = customer.id;
      if (subscription) {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { stripeCustomerId },
        });
      }
    } catch (error) {
      logger.error("Failed to create Stripe customer for portal", error);
      return res.status(400).json({ error: "No Stripe customer found for this user" });
    }
  }

  const createPortalSession = async (customerId: string) => {
    return stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: env.FRONTEND_URL || env.APP_URL || "http://localhost:3000/dashboard/billing",
    });
  };

  try {
    const session = await createPortalSession(stripeCustomerId);
    return res.json({ url: session.url });
  } catch (error) {
    const err = error as Error & { code?: string };
    const isNoSuchCustomer =
      err instanceof Error &&
      (String(err.message).includes("No such customer") || err.code === "resource_missing");

    if (isNoSuchCustomer && subscription) {
      logger.warn("Stripe customer ID in DB not found; attempting recovery by email", {
        userId,
        oldCustomerId: stripeCustomerId,
      });
      await prisma.subscription.updateMany({
        where: { userId, stripeCustomerId },
        data: { stripeCustomerId: null },
      });
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return res.status(400).json({ error: "No user found for portal" });
      }
      try {
        // Try to find existing Stripe customer by email so we keep invoice history
        let recoveredCustomerId: string | null = null;
        if (user.email) {
          const existing = await stripe.customers.list({
            email: user.email,
            limit: 1,
          });
          if (existing.data.length > 0) {
            recoveredCustomerId = existing.data[0].id;
            logger.info("Recovered Stripe customer by email for portal", {
              userId,
              email: user.email,
              customerId: recoveredCustomerId,
            });
          }
        }
        const customerId =
          recoveredCustomerId ||
          (await stripe.customers.create({
            email: user.email || undefined,
            metadata: { userId },
          })).id;
        await prisma.subscription.updateMany({
          where: { userId },
          data: { stripeCustomerId: customerId },
        });
        const retrySession = await createPortalSession(customerId);
        return res.json({ url: retrySession.url });
      } catch (createError) {
        logger.error("Failed to recover or create Stripe customer after invalid ID", createError);
        return res.status(500).json({ error: "Unable to create portal session" });
      }
    }

    logger.error("Failed to create billing portal session", error);
    return res.status(500).json({ error: "Unable to create portal session" });
  }
});

// Get subscription history and current subscription
router.get("/history", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;

    // Get current active subscription
    let currentSubscription = await prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
      include: {
        plan: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    if (!currentSubscription) {
      const latestSubscription = await prisma.subscription.findFirst({
        where: { userId },
        include: {
          plan: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      if (latestSubscription && stripeClient && latestSubscription.stripeSubscriptionId) {
        try {
          const stripeSub = await stripeClient.subscriptions.retrieve(latestSubscription.stripeSubscriptionId);
          const stripeStatus = stripeSub.status;
          const nextStatus =
            stripeStatus === "active"
              ? SubscriptionStatus.ACTIVE
              : stripeStatus === "trialing"
                ? SubscriptionStatus.TRIALING
                : stripeStatus === "past_due"
                  ? SubscriptionStatus.PAST_DUE
                  : stripeStatus === "canceled" || stripeStatus === "incomplete_expired"
                    ? SubscriptionStatus.CANCELED
                    : latestSubscription.status;

          if (nextStatus !== latestSubscription.status) {
            currentSubscription = await prisma.subscription.update({
              where: { id: latestSubscription.id },
              data: {
                status: nextStatus,
                updatedAt: new Date(),
              },
              include: { plan: true },
            });
          } else if (stripeStatus === "active" || stripeStatus === "trialing") {
            currentSubscription = latestSubscription;
          }
        } catch (error) {
          logger.warn("Unable to recover enterprise history subscription from Stripe", {
            userId,
            subscriptionId: latestSubscription.id,
            error,
          });
        }
      } else if (latestSubscription && latestSubscription.plan?.isCustomEnterprise) {
        currentSubscription = latestSubscription;
      }
    }

    // Get all subscriptions (both active and past)
    const allSubscriptions = await prisma.subscription.findMany({
      where: { userId },
      include: {
        plan: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get plan change logs (audit trail)
    const planChangeLogs = await prisma.planChangeLog.findMany({
      where: { userId },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Format the response
    const response = {
      currentSubscription: currentSubscription ? {
        id: currentSubscription.id,
        planCode: currentSubscription.planCode,
        planName: currentSubscription.plan.name,
        status: currentSubscription.status,
        billingCycle: currentSubscription.billingCycle,
        priceType: currentSubscription.priceType,
        currentPeriodStart: currentSubscription.currentPeriodStart,
        currentPeriodEnd: currentSubscription.currentPeriodEnd,
        cancelAtPeriodEnd: currentSubscription.cancelAtPeriodEnd,
        addonPlatformQty: currentSubscription.addonPlatformQty,
        videoAddonEnabled: currentSubscription.videoAddonEnabled,
        videoSessionHours: currentSubscription.videoSessionHours,
        termsAcceptedAt: currentSubscription.termsAcceptedAt,
        stripeSubscriptionId: currentSubscription.stripeSubscriptionId,
        createdAt: currentSubscription.createdAt,
        updatedAt: currentSubscription.updatedAt,
        plan: {
          code: currentSubscription.plan.code,
          name: currentSubscription.plan.name,
          category: currentSubscription.plan.category,
          platformLimit: currentSubscription.plan.platformLimit,
          baseVisualQuota: currentSubscription.plan.baseVisualQuota,
          basePostQuota: currentSubscription.plan.basePostQuota,
          priceStandardCents: currentSubscription.plan.priceStandardCents,
          priceFounderCents: currentSubscription.plan.priceFounderCents,
        },
      } : null,

      subscriptionHistory: allSubscriptions.map(sub => ({
        id: sub.id,
        planCode: sub.planCode,
        planName: sub.plan.name,
        status: sub.status,
        billingCycle: sub.billingCycle,
        priceType: sub.priceType,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        canceledAt: sub.canceledAt,
        addonPlatformQty: sub.addonPlatformQty,
        videoAddonEnabled: sub.videoAddonEnabled,
        videoSessionHours: sub.videoSessionHours,
        termsAcceptedAt: sub.termsAcceptedAt,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
        plan: {
          code: sub.plan.code,
          name: sub.plan.name,
          category: sub.plan.category,
          platformLimit: sub.plan.platformLimit,
          baseVisualQuota: sub.plan.baseVisualQuota,
          basePostQuota: sub.plan.basePostQuota,
          priceStandardCents: sub.plan.priceStandardCents,
          priceFounderCents: sub.plan.priceFounderCents,
        },
      })),

      planChangeLog: planChangeLogs.map(log => ({
        id: log.id,
        oldPlanCode: log.oldPlanCode,
        newPlanCode: log.newPlanCode,
        reason: log.reason,
        createdAt: log.createdAt,
      })),

      summary: {
        totalSubscriptions: allSubscriptions.length,
        totalPlanChanges: planChangeLogs.length,
        hasActiveSubscription: !!currentSubscription,
      },
    };

    return res.json(response);
  } catch (error) {
    logger.error("Error fetching subscription history", error);
    return res.status(500).json({ error: "Unable to fetch subscription history" });
  }
});

// Manual sync endpoint - syncs subscription status from Stripe
// Useful if webhooks are delayed or failed
router.post("/sync", requireAuth, billingSyncRateLimiter, async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: "Stripe not configured" });
  }

  const userId = req.user!.id;

  try {
    // Get user's subscription - try to find one with stripeSubscriptionId first
    let subscription = await prisma.subscription.findFirst({
      where: {
        userId,
        stripeSubscriptionId: { not: null },
      },
      orderBy: { updatedAt: "desc" },
    });

    // If no subscription with stripeSubscriptionId, get the most recent one
    if (!subscription) {
      subscription = await prisma.subscription.findFirst({
        where: { userId },
        orderBy: { updatedAt: "desc" },
      });
    }

    if (!subscription) {
      return res.status(404).json({ error: "No subscription found" });
    }

    // If subscription doesn't have stripeSubscriptionId, try to find it from Stripe customer
    if (!subscription.stripeSubscriptionId && subscription.stripeCustomerId) {
      try {
        const subscriptions = await stripeClient.subscriptions.list({
          customer: subscription.stripeCustomerId,
          status: "all",
          limit: 1,
        });

        if (subscriptions.data.length > 0) {
          const stripeSub = subscriptions.data[0];
          // Update subscription with stripeSubscriptionId
          subscription = await prisma.subscription.update({
            where: { id: subscription.id },
            data: { stripeSubscriptionId: stripeSub.id },
          });
        }
      } catch (err) {
        logger.warn("Failed to find Stripe subscription from customer", err);
      }
    }

    if (!subscription.stripeSubscriptionId) {
      return res.status(404).json({ error: "No Stripe subscription found. Please wait for webhook to process." });
    }

    // Retrieve subscription from Stripe
    const stripeSub = await stripeClient.subscriptions.retrieve(
      subscription.stripeSubscriptionId,
      {
        expand: ["items.data.price.product"],
      }
    );

    const item = stripeSub.items.data[0];
    const planInfo = await upsertPlanFromPrice(item?.price as Stripe.Price | undefined);

    if (!planInfo) {
      return res.status(400).json({ error: "Unable to determine plan from Stripe" });
    }

    const status = mapStripeStatus(stripeSub.status);
    const { startUnix, endUnix } = extractStripePeriodBounds(stripeSub);
    const currentPeriodStart = startUnix ? new Date(startUnix * 1000) : undefined;
    const currentPeriodEnd = endUnix ? new Date(endUnix * 1000) : undefined;
    const cancelAtPeriodEnd = (stripeSub as any).cancel_at_period_end || false;

    // Update subscription
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status,
          planCode: planInfo.planCode,
          priceType: planInfo.priceType,
          currentPeriodStart,
          currentPeriodEnd,
          cancelAtPeriodEnd,
          stripeCustomerId: String(stripeSub.customer),
          updatedAt: new Date(),
        },
      });

      // Deactivate other active subscriptions
      if (status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.TRIALING) {
        await tx.subscription.updateMany({
          where: {
            userId,
            id: { not: subscription.id },
            status: {
              in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
            },
          },
          data: {
            status: SubscriptionStatus.CANCELED,
            updatedAt: new Date(),
          },
        });
      }
    });

    return res.json({
      success: true,
      message: "Subscription synced successfully",
      status,
      planCode: planInfo.planCode,
    });
  } catch (error) {
    logger.error("Error syncing subscription", error);
    return res.status(500).json({ error: "Unable to sync subscription" });
  }
});


export { router as billingRouter };

function serializePlan(plan: {
  code: string;
  name: string;
  category: string;
  isJewelry: boolean;
  platformLimit: number | null;
  baseVisualQuota: number | null;
  basePostQuota: number | null;
  postLimitType?: string | null;
  schedulerRole?: string | null;
  priceStandardCents: number;
  priceFounderCents: number;
  hasYearlyPrice?: boolean;
}) {
  return {
    code: plan.code,
    name: plan.name,
    category: plan.category,
    isJewelry: plan.isJewelry,
    platformLimit: plan.platformLimit,
    baseVisualQuota: plan.baseVisualQuota,
    basePostQuota: plan.basePostQuota,
    postLimitType: plan.postLimitType || "NONE",
    schedulerRole: plan.schedulerRole || "CLIENT",
    priceStandardCents: plan.priceStandardCents,
    priceFounderCents: plan.priceFounderCents,
    hasYearlyPrice: plan.hasYearlyPrice ?? false,
  };
}
