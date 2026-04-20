import { Request, Response } from "express";
import Stripe from "stripe";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { stripeClient } from "./stripe";
import { env } from "../../config/env";
import {
  BillingCycle,
  CouponStatus,
  EnterpriseInviteStatus,
  EnterpriseProposalStatus,
  PriceType,
  SubscriptionStatus,
} from "@prisma/client";
import { mapStripeStatus, toPlanCategory } from "./billing-utils";
import {
  getActiveSubscription,
  deactivateOtherSubscriptions,
  ensureSingleActiveSubscription,
  logPlanChange,
} from "./subscription-service";
import { creditVisualTopup } from "../submissions/quota-service";
import { toPostLimitType, toSchedulerRole } from "./plan-metadata";
import { extractStripePeriodBounds } from "./stripe-period";
import { sendInvoiceEmail } from "../auth/email";

type StripeEvent = Stripe.Event;

function getInvoiceSubtotalCents(invoice: Stripe.Invoice) {
  if (typeof invoice.subtotal === "number") return invoice.subtotal;
  if (typeof invoice.amount_paid === "number") return invoice.amount_paid;
  if (typeof invoice.total === "number") return invoice.total;
  return 0;
}

function getInvoiceTaxCents(invoice: Stripe.Invoice) {
  const invoiceAny = invoice as any;

  if (Array.isArray(invoiceAny.total_tax_amounts) && invoiceAny.total_tax_amounts.length > 0) {
    return invoiceAny.total_tax_amounts.reduce((sum: number, item: any) => {
      const amount = typeof item?.amount === "number" ? item.amount : 0;
      return sum + amount;
    }, 0);
  }

  if (typeof invoiceAny.tax === "number") {
    return invoiceAny.tax;
  }

  const subtotal = getInvoiceSubtotalCents(invoice);
  const total = typeof invoice.total === "number"
    ? invoice.total
    : typeof invoice.amount_paid === "number"
      ? invoice.amount_paid
      : subtotal;
  return Math.max(total - subtotal, 0);
}

export async function upsertPlanFromPrice(price: Stripe.Price | null | undefined) {
  if (!stripeClient || !price) return null;

  // Ensure product is expanded
  let fullPrice = price;
  if (!price.product || typeof price.product === "string") {
    fullPrice = await stripeClient.prices.retrieve(price.id, {
      expand: ["product"],
    });
  }

  const product = fullPrice.product as Stripe.Product | null;
  if (!product) return null;

  const planCode = product.metadata?.code || product.id;
  const planPayload = {
    code: planCode,
    name: product.name,
    category: toPlanCategory(product.metadata.category),
    isJewelry: (product.metadata.isJewelry || "").toLowerCase() === "true",
    platformLimit: product.metadata.platformLimit ? parseInt(product.metadata.platformLimit) : null,
    baseVisualQuota: product.metadata.baseVisualQuota ? parseInt(product.metadata.baseVisualQuota) : null,
    basePostQuota: product.metadata.basePostQuota ? parseInt(product.metadata.basePostQuota) : null,
    postLimitType: toPostLimitType(product.metadata.postLimitType),
    schedulerRole: toSchedulerRole(product.metadata.schedulerRole),
    priceStandardCents: product.metadata.priceStandardCents
      ? parseInt(product.metadata.priceStandardCents)
      : fullPrice.unit_amount ?? 0,
    priceFounderCents: product.metadata.priceFounderCents
      ? parseInt(product.metadata.priceFounderCents)
      : fullPrice.unit_amount ?? 0,
    stripePriceStandardId: fullPrice.id,
  };

  await prisma.plan.upsert({
    where: { code: planCode },
    update: planPayload,
    create: planPayload,
  });

  const isFounderPrice =
    (fullPrice.metadata?.priceType || "").toLowerCase() === "founder" ||
    (product.metadata.priceFounderCents &&
      fullPrice.unit_amount === parseInt(product.metadata.priceFounderCents));

  return { planCode, priceType: isFounderPrice ? PriceType.FOUNDER : PriceType.STANDARD };
}

export async function billingWebhook(req: Request, res: Response) {
  if (!stripeClient || !env.STRIPE_WEBHOOK_SECRET) {
    // Stripe not configured; ignore webhook gracefully
    return res.status(200).json({ received: true, skipped: true });
  }

  const sig = req.headers["stripe-signature"];
  if (!sig || Array.isArray(sig)) {
    return res.status(400).send("Missing signature");
  }

  let event: StripeEvent;
  try {
    const rawBody = req.body as Buffer | string;
    event = stripeClient.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error("Webhook signature verification failed", err);
    return res.status(400).send("Webhook Error");
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, event.id);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_succeeded":
      case "invoice.paid":
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      default:
        break;
    }
  } catch (err) {
    logger.error("Webhook handler error", err);
    // Return 500 only for transient errors (DB timeouts, connection issues) so
    // Stripe will retry. For logic/data errors return 200 to stop retry loops.
    const isTransient =
      err instanceof Error &&
      ((err as any).code?.startsWith("P1") || // Prisma connection errors
        err.message.toLowerCase().includes("timeout") ||
        err.message.toLowerCase().includes("connection"));
    if (isTransient) {
      return res.status(500).send("Webhook handler error");
    }
    return res.json({ received: true });
  }

  return res.json({ received: true });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session, stripeEventId: string) {
  // Idempotency guard: skip events we have already fully processed
  const alreadyProcessed = await prisma.processedWebhookEvent.findUnique({
    where: { eventId: stripeEventId },
  });
  if (alreadyProcessed) {
    logger.info("Skipping already-processed webhook event", { stripeEventId });
    return;
  }

  const metadata = session.metadata || {};
  const userId = metadata.userId;
  const planCode = metadata.planCode;
  const subscriptionId = metadata.subscriptionId; // Our internal subscription ID
  const priceType = Object.values(PriceType).includes(metadata.priceType as PriceType)
    ? (metadata.priceType as PriceType)
    : PriceType.STANDARD;
  const stripeSubscriptionId = session.subscription ? String(session.subscription) : undefined;
  const switchedFrom = metadata.switchedFrom; // Plan code user switched from
  const billingCycle = (metadata.billingCycle || "monthly").toLowerCase() === "yearly"
    ? BillingCycle.YEARLY
    : BillingCycle.MONTHLY;
  const couponId = metadata.couponId;
  const couponDiscountCents = parseInt(metadata.couponDiscountCents || "0");
  const enterpriseProposalId = metadata.enterpriseProposalId;
  const termsAcceptedAt = metadata.termsAcceptedAt
    ? new Date(metadata.termsAcceptedAt)
    : new Date();
  const isEnterpriseCheckout = Boolean(metadata.enterpriseProposalId);

  if (metadata.type === "visual_topup") {
    await handleVisualTopupCheckout(session, stripeEventId);
    return;
  }

  logger.info("Checkout completed webhook received", {
    userId,
    planCode,
    subscriptionId,
    stripeSubscriptionId,
    sessionId: session.id,
  });

  if (!userId || !planCode) {
    logger.warn("Checkout completed webhook missing required metadata", { metadata });
    return;
  }

  let resolvedPlanCode = planCode;
  let resolvedPriceType = priceType;
  let currentPeriodStart: Date | undefined;
  let currentPeriodEnd: Date | undefined;
  let cancelAtPeriodEnd = false;
  let addonPlatformQty = 0;
  let videoAddonEnabled = false;
  let videoSessionHours = parseInt(metadata.videoSessionHours || "0");

  // Sync plan + price type from the live Stripe subscription when available
  if (stripeClient && stripeSubscriptionId) {
    try {
      const stripeSub = await stripeClient.subscriptions.retrieve(stripeSubscriptionId, {
        expand: ["items.data.price.product"],
      });
      const item = stripeSub.items.data[0];
      if (!isEnterpriseCheckout) {
        const planInfo = await upsertPlanFromPrice(item?.price as Stripe.Price | undefined);
        resolvedPlanCode = planInfo?.planCode || planCode;
        resolvedPriceType = planInfo?.priceType || priceType;
      } else {
        resolvedPlanCode = planCode;
        resolvedPriceType = priceType;
      }
      const { startUnix, endUnix } = extractStripePeriodBounds(stripeSub);
      currentPeriodStart = startUnix ? new Date(startUnix * 1000) : undefined;
      currentPeriodEnd = endUnix ? new Date(endUnix * 1000) : undefined;
      cancelAtPeriodEnd = Boolean((stripeSub as any).cancel_at_period_end);
      addonPlatformQty = parseInt(stripeSub.metadata?.addonPlatformQty || "0");
      videoAddonEnabled = (stripeSub.metadata?.videoAddonEnabled || "").toLowerCase() === "true";
      videoSessionHours = parseInt(stripeSub.metadata?.videoSessionHours || metadata.videoSessionHours || "0");
    } catch (err) {
      logger.warn("Unable to sync plan from Stripe subscription on checkout completion", err);
    }
  }

  let finalSubscriptionId: string | null = null;

  await prisma.$transaction(async (tx) => {
    // Find existing subscription by ID if provided, otherwise find by userId
    let subscription = subscriptionId
      ? await tx.subscription.findUnique({ where: { id: subscriptionId } })
      : await tx.subscription.findFirst({ where: { userId } });

    // If still not found and we have a customer ID, try to find by customer ID
    if (!subscription && session.customer) {
      subscription = await tx.subscription.findFirst({
        where: {
          stripeCustomerId: String(session.customer),
        },
        orderBy: { updatedAt: "desc" },
      });
    }

    // If still not found, try to find any INCOMPLETE subscription for this user
    if (!subscription) {
      subscription = await tx.subscription.findFirst({
        where: {
          userId,
          status: SubscriptionStatus.INCOMPLETE,
        },
        orderBy: { createdAt: "desc" },
      });
    }

    if (!subscription) {
      logger.warn("No subscription found for checkout completion", {
        userId,
        subscriptionId,
        stripeSubscriptionId,
        customerId: session.customer,
      });
    }

    // Get old plan code before update for logging
    const oldPlanCode = subscription?.planCode || null;

    // Clear pendingPlanCode from user after successful checkout
    await tx.user.update({
      where: { id: userId },
      data: { pendingPlanCode: null, pendingPlanCodeSetAt: null },
    });

    // Mark this event as processed (idempotency)
    await tx.processedWebhookEvent.create({
      data: { eventId: stripeEventId, type: "checkout.session.completed" },
    });

    if (enterpriseProposalId) {
      await tx.enterprisePlanProposal.updateMany({
        where: { id: enterpriseProposalId },
        data: {
          status: EnterpriseProposalStatus.PAYMENT_COMPLETED,
          paidAt: new Date(),
        },
      });

      await tx.enterprisePlanInvite.updateMany({
        where: { proposalId: enterpriseProposalId },
        data: {
          status: EnterpriseInviteStatus.PAYMENT_COMPLETED,
          paidAt: new Date(),
        },
      });
    }

    if (subscription) {
      // Update existing subscription
      subscription = await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          planCode: resolvedPlanCode,
          priceType: resolvedPriceType,
          billingCycle,
          status: SubscriptionStatus.ACTIVE,
          stripeSubscriptionId,
          stripeCustomerId: session.customer ? String(session.customer) : undefined,
          currentPeriodStart,
          currentPeriodEnd,
          termsAcceptedAt: Number.isNaN(termsAcceptedAt.getTime()) ? new Date() : termsAcceptedAt,
          cancelAtPeriodEnd,
          addonPlatformQty: Number.isFinite(addonPlatformQty) ? addonPlatformQty : 0,
          videoAddonEnabled,
          videoSessionHours: Number.isFinite(videoSessionHours) ? Math.max(videoSessionHours, 0) : 0,
          updatedAt: new Date(),
        },
      });
      finalSubscriptionId = subscription.id;
    } else {
      // Create new subscription
      subscription = await tx.subscription.create({
        data: {
          userId,
          planCode: resolvedPlanCode,
          priceType: resolvedPriceType,
          billingCycle,
          status: SubscriptionStatus.ACTIVE,
          stripeSubscriptionId,
          stripeCustomerId: session.customer ? String(session.customer) : undefined,
          currentPeriodStart,
          currentPeriodEnd,
          termsAcceptedAt: Number.isNaN(termsAcceptedAt.getTime()) ? new Date() : termsAcceptedAt,
          cancelAtPeriodEnd,
          addonPlatformQty: Number.isFinite(addonPlatformQty) ? addonPlatformQty : 0,
          videoAddonEnabled,
          videoSessionHours: Number.isFinite(videoSessionHours) ? Math.max(videoSessionHours, 0) : 0,
        },
      });
      finalSubscriptionId = subscription.id;
    }

    // CRITICAL: Deactivate all other active subscriptions for this user
    // This ensures only one active subscription exists at any time
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

    // Update founder status if applicable
    if (resolvedPriceType === PriceType.FOUNDER) {
      await tx.user.update({
        where: { id: userId },
        data: { isFounder: true },
      });
      await tx.founder.upsert({
        where: { userId },
        update: {},
        create: { userId },
      });
    }

    // Log plan change for audit
    if (oldPlanCode !== resolvedPlanCode) {
      await logPlanChange(
        userId,
        oldPlanCode,
        resolvedPlanCode,
        switchedFrom ? "plan_switch_completed" : "checkout_completed"
      );
    }

    if (couponId && Number.isFinite(couponDiscountCents) && couponDiscountCents > 0) {
      const existingUsage = await tx.couponUsage.findUnique({
        where: {
          couponId_userId: {
            couponId,
            userId,
          },
        },
      });

      if (!existingUsage) {
        await tx.couponUsage.create({
          data: {
            couponId,
            userId,
          },
        });

        const updatedCoupon = await tx.coupon.update({
          where: { id: couponId },
          data: {
            usedCount: { increment: 1 },
          },
          select: {
            id: true,
            code: true,
            maxUses: true,
            usedCount: true,
            status: true,
          },
        });

        if (
          updatedCoupon.maxUses !== null &&
          updatedCoupon.usedCount >= updatedCoupon.maxUses &&
          updatedCoupon.status === CouponStatus.ACTIVE
        ) {
          await tx.coupon.update({
            where: { id: updatedCoupon.id },
            data: {
              status: CouponStatus.INACTIVE,
            },
          });
        }
      }
    }
  });

  logger.info(
    `Checkout completed for user ${userId}, plan ${resolvedPlanCode}`,
    { subscriptionId: finalSubscriptionId, switchedFrom }
  );

  // Send invoice email directly after checkout (does not depend on invoice.paid webhook)
  if (stripeClient && session.invoice) {
    try {
      const invoiceId = typeof session.invoice === "string" ? session.invoice : (session.invoice as any).id;
      const [stripeInvoice, user] = await Promise.all([
        stripeClient.invoices.retrieve(invoiceId),
        prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } }),
      ]);
      if (user?.email) {
        const subtotalCents = getInvoiceSubtotalCents(stripeInvoice);
        const taxCents = getInvoiceTaxCents(stripeInvoice);
        await sendInvoiceEmail(
          user.email,
          stripeInvoice.number || stripeInvoice.id,
          (stripeInvoice.amount_paid / 100).toFixed(2),
          stripeInvoice.hosted_invoice_url ?? undefined,
          (stripeInvoice as any).invoice_pdf ?? undefined,
          {
            planName: resolvedPlanCode,
            billingCycle: billingCycle === BillingCycle.YEARLY ? "Yearly" : "Monthly",
            userName: user.name ?? undefined,
            customerEmail: user.email,
            invoiceStatus: stripeInvoice.status || "paid",
            subtotalAmount: (subtotalCents / 100).toFixed(2),
            taxAmount: (taxCents / 100).toFixed(2),
            transactionId: String((stripeInvoice as any).payment_intent || stripeInvoice.id),
          },
        );
        logger.info(`Invoice email sent to ${user.email} after checkout`, { invoiceId });
      }
    } catch (err) {
      // Non-fatal — do not fail the webhook if email sending fails
      logger.error(`Failed to send invoice email for user ${userId} after checkout`, err);
    }
  }
}

async function handleVisualTopupCheckout(
  session: Stripe.Checkout.Session,
  stripeEventId: string
) {
  const metadata = session.metadata || {};
  const userId = metadata.userId;
  const totalUnits = parseInt(metadata.topupTotalUnits || "0");

  if (!userId || !totalUnits) {
    logger.warn("Visual top-up webhook missing required metadata", { metadata });
    return;
  }

  if (session.payment_status && session.payment_status !== "paid") {
    logger.info("Visual top-up checkout not paid; skipping credit", {
      sessionId: session.id,
      paymentStatus: session.payment_status,
    });
    return;
  }

  const subscription = await getActiveSubscription(userId);
  if (!subscription) {
    logger.warn("No active subscription found for top-up credit", { userId });
    return;
  }

  await creditVisualTopup({
    userId,
    subscription,
    units: totalUnits,
    stripeEventId,
  });
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const customerId = String(subscription.customer);

  // Find subscription by Stripe subscription ID first (most reliable)
  // Fall back to customer ID if subscription ID not found
  let local = await prisma.subscription.findFirst({
    where: { stripeSubscriptionId: subscription.id },
  });

  if (!local) {
    local = await prisma.subscription.findFirst({
      where: { stripeCustomerId: customerId },
      orderBy: { updatedAt: "desc" },
    });
  }

  if (!local) {
    logger.warn(
      `No local subscription found for Stripe subscription ${subscription.id} or customer ${customerId}`
    );
    return;
  }

  const item = subscription.items.data[0];
  const planInfo = await upsertPlanFromPrice(item?.price as Stripe.Price | undefined);
  const status = mapStripeStatus(subscription.status);
  const { startUnix: currentPeriodStart, endUnix: currentPeriodEnd } =
    extractStripePeriodBounds(subscription);
  const cancelAtPeriodEnd = (subscription as any).cancel_at_period_end as boolean | undefined;

  const newPlanCode = planInfo?.planCode || local.planCode;
  const newPriceType = planInfo?.priceType || local.priceType;
  const isPlanChange = local.planCode !== newPlanCode;
  const addonPlatformQty = parseInt(subscription.metadata?.addonPlatformQty || "0");
  const videoAddonEnabled = (subscription.metadata?.videoAddonEnabled || "").toLowerCase() === "true";
  const videoSessionHours = parseInt(subscription.metadata?.videoSessionHours || "0");
  const billingCycle = (subscription.metadata?.billingCycle || "monthly").toLowerCase() === "yearly"
    ? BillingCycle.YEARLY
    : BillingCycle.MONTHLY;

  // Get old plan code before update for logging
  const oldPlanCode = local.planCode;

  await prisma.$transaction(async (tx) => {
    // Update the subscription
    await tx.subscription.update({
      where: { id: local.id },
      data: {
        status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: customerId, // Ensure customer ID is set
        planCode: newPlanCode,
        priceType: newPriceType,
        billingCycle,
        addonPlatformQty: Number.isFinite(addonPlatformQty) ? addonPlatformQty : 0,
        videoAddonEnabled,
        videoSessionHours: Number.isFinite(videoSessionHours) ? Math.max(videoSessionHours, 0) : 0,
        currentPeriodStart: currentPeriodStart
          ? new Date(currentPeriodStart * 1000)
          : undefined,
        currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : undefined,
        cancelAtPeriodEnd: cancelAtPeriodEnd ?? false,
        updatedAt: new Date(),
      },
    });

    // CRITICAL: If this subscription is now active, deactivate all other active subscriptions
    // This prevents duplicate active subscriptions when webhooks arrive out of order
    if (status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.TRIALING) {
      await tx.subscription.updateMany({
        where: {
          userId: local.userId,
          id: { not: local.id },
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

    // Update founder status if applicable
    if (newPriceType === PriceType.FOUNDER) {
      await tx.user.update({
        where: { id: local.userId },
        data: { isFounder: true },
      });
      await tx.founder.upsert({
        where: { userId: local.userId },
        update: {},
        create: { userId: local.userId },
      });
    }

    // Log plan change if plan code changed
    if (isPlanChange) {
      await logPlanChange(local.userId, oldPlanCode, newPlanCode, "webhook_subscription_updated");
    }
  });

  logger.info(
    `Subscription updated for user ${local.userId}, subscription ${local.id}`,
    {
      oldPlan: oldPlanCode,
      newPlan: newPlanCode,
      status,
      isPlanChange,
    }
  );
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  if (!invoice.customer) return;

  const customerId = String(invoice.customer);
  const subscription = await prisma.subscription.findFirst({
    where: { stripeCustomerId: customerId },
    include: { user: true },
    orderBy: { updatedAt: "desc" },
  });

  if (!subscription?.user?.email) return;

  // Skip if invoice.billing_reason is "subscription_create" —
  // already handled by handleCheckoutCompleted to avoid duplicate emails
  if ((invoice as any).billing_reason === "subscription_create") return;

  try {
    const subtotalCents = getInvoiceSubtotalCents(invoice);
    const taxCents = getInvoiceTaxCents(invoice);
    await sendInvoiceEmail(
      subscription.user.email,
      invoice.number || invoice.id,
      (invoice.amount_paid / 100).toFixed(2),
      invoice.hosted_invoice_url ?? undefined,
      (invoice as any).invoice_pdf ?? undefined,
      {
        planName: subscription.planCode,
        billingCycle: subscription.billingCycle === "YEARLY" ? "Yearly" : "Monthly",
        userName: subscription.user.name ?? undefined,
        customerEmail: subscription.user.email,
        invoiceStatus: invoice.status || "paid",
        subtotalAmount: (subtotalCents / 100).toFixed(2),
        taxAmount: (taxCents / 100).toFixed(2),
        transactionId: String((invoice as any).payment_intent || invoice.id),
      },
    );
    logger.info(`Invoice email sent for customer ${customerId}`, {
      invoiceId: invoice.id,
      amountPaid: invoice.amount_paid,
    });
  } catch (err) {
    logger.error(`Failed to send invoice email for customer ${customerId}`, err);
  }
}
