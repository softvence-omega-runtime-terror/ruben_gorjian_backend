import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import Stripe from "stripe";
import { EnterpriseInviteStatus, EnterpriseProposalStatus, Role, UserStatus } from "@prisma/client";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { hashPassword, comparePassword } from "../../utils/password";
import { signAccessToken } from "../../utils/tokens";
import { requireAuth } from "../../middleware/requireAuth";
import { env } from "../../config/env";
import { sendVerificationEmail } from "./email";
import { logger } from "../../lib/logger";
import { logActivity } from "../dashboard/activity-logger";
import type { PlanCategory } from "../../types/plan-category";
import { ensureUserProviderRoutingConfig } from "../social/provider-routing";
import { getActiveSubscription } from "../billing/subscription-service";
import { stripeClient } from "../billing/stripe";
import { toPlanCategory } from "../billing/billing-utils";
import { toPostLimitType, toSchedulerRole } from "../billing/plan-metadata";

const router = express.Router();

const noopLimiter: express.RequestHandler = (_req, _res, next) => next();
const authLimiter =
  env.NODE_ENV === "production"
    ? rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      message: "Too many login attempts, please try again later.",
      skipSuccessfulRequests: true,
    })
    : noopLimiter;

const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";
const googleRedirectUri = `${(env.APP_URL ?? "http://localhost:4000").replace(/\/$/, "")}${GOOGLE_CALLBACK_PATH}`;

const googleClient = env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri
  )
  : null;
const PASSWORD_RESET_EXPIRY_MS = 1000 * 60 * 60; // 1 hour
const EMAIL_VERIFICATION_EXPIRY_MS = 1000 * 60 * 60 * 24; // 24 hours

const PAGE_PERMISSION_KEYS = [
  "OVERVIEW",
  "USER_MANAGE",
  "SUBSCRIPTION_MANAGE",
  "SCHEDULE_MANAGE",
  "POST_MANAGE",
  "COUPON_MANAGE",
  "SUPPORT",
  "SUBMISSIONS",
  "FAQ",
  "CASE_STUDIES",
  "VIRTUAL_ADMIN_MANAGE",
  "PROFILE",
] as const;

const SEED_ADMIN_PAGE_PERMISSIONS: PagePermissionKey[] = [
  "OVERVIEW",
  "USER_MANAGE",
  "SUBSCRIPTION_MANAGE",
  "SCHEDULE_MANAGE",
  "POST_MANAGE",
  "COUPON_MANAGE",
  "VIRTUAL_ADMIN_MANAGE",
  "SUBMISSIONS",
  "SUPPORT",
  "FAQ",
  "CASE_STUDIES",
  "PROFILE",
];

type PagePermissionKey = (typeof PAGE_PERMISSION_KEYS)[number];

const PAGE_ROUTE_PERMISSION_MAP: Record<
  PagePermissionKey,
  Array<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL"; pathPattern: string }>
> = {
  OVERVIEW: [
    { method: "GET", pathPattern: "/api/admin/summary" },
    { method: "GET", pathPattern: "/admin/summary" },
    { method: "GET", pathPattern: "/api/admin/overview/stats" },
    { method: "GET", pathPattern: "/api/admin/overview/revenue" },
    { method: "GET", pathPattern: "/api/admin/overview/activity" },
    { method: "GET", pathPattern: "/api/admin/upload-post/health" },
    { method: "GET", pathPattern: "/api/providers/upload-post/health" },
    { method: "GET", pathPattern: "/admin/overview/stats" },
    { method: "GET", pathPattern: "/admin/overview/revenue" },
    { method: "GET", pathPattern: "/admin/overview/activity" },
  ],
  USER_MANAGE: [
    { method: "ALL", pathPattern: "/api/admin/users*" },
    { method: "ALL", pathPattern: "/admin/users*" },
  ],
  SUBSCRIPTION_MANAGE: [
    { method: "GET", pathPattern: "/api/admin/subscriptions" },
    { method: "GET", pathPattern: "/admin/subscriptions" },
    { method: "ALL", pathPattern: "/api/admin/enterprise-plan*" },
    { method: "ALL", pathPattern: "/admin/enterprise-plan*" },
    { method: "POST", pathPattern: "/api/admin/users/:id/cancel-subscription-schedule" },
    { method: "POST", pathPattern: "/api/admin/users/:id/cancel-subscription-immediately" },
    { method: "POST", pathPattern: "/api/admin/users/:id/resume-subscription" },
    { method: "POST", pathPattern: "/api/admin/users/:id/refresh-subscription" },
    { method: "GET", pathPattern: "/api/admin/users/:id/invoices" },
    { method: "POST", pathPattern: "/admin/users/:id/cancel-subscription-schedule" },
    { method: "POST", pathPattern: "/admin/users/:id/cancel-subscription-immediately" },
    { method: "POST", pathPattern: "/admin/users/:id/resume-subscription" },
    { method: "POST", pathPattern: "/admin/users/:id/refresh-subscription" },
    { method: "GET", pathPattern: "/admin/users/:id/invoices" },
  ],
  SCHEDULE_MANAGE: [
    { method: "GET", pathPattern: "/api/admin/users/:id/scheduled-items" },
    { method: "GET", pathPattern: "/api/admin/calendars" },
    { method: "GET", pathPattern: "/admin/users/:id/scheduled-items" },
    { method: "GET", pathPattern: "/admin/calendars" },
  ],
  POST_MANAGE: [
    { method: "ALL", pathPattern: "/api/admin/users/:userId/posts*" },
    { method: "ALL", pathPattern: "/api/admin/:userId/posts/:postId/approve" },
    { method: "ALL", pathPattern: "/api/admin/users/:userId/media*" },
    { method: "GET", pathPattern: "/api/admin/users/:userId/connected-platforms" },
    { method: "GET", pathPattern: "/api/social-media/platform/get-all-performed-links" },
    { method: "ALL", pathPattern: "/admin/users/:userId/posts*" },
    { method: "ALL", pathPattern: "/admin/:userId/posts/:postId/approve" },
    { method: "ALL", pathPattern: "/admin/users/:userId/media*" },
    { method: "GET", pathPattern: "/admin/users/:userId/connected-platforms" },
    { method: "GET", pathPattern: "/social-media/platform/get-all-performed-links" },
  ],
  COUPON_MANAGE: [
    { method: "ALL", pathPattern: "/api/admin/coupons*" },
    { method: "ALL", pathPattern: "/admin/coupons*" },
  ],
  SUPPORT: [
    { method: "ALL", pathPattern: "/api/contact/admin/submissions*" },
  ],
  SUBMISSIONS: [
    { method: "ALL", pathPattern: "/api/admin/submissions*" },
    { method: "ALL", pathPattern: "/admin/submissions*" },
  ],
  FAQ: [
    { method: "ALL", pathPattern: "/api/faq*" },
    { method: "ALL", pathPattern: "/faq*" },
  ],
  CASE_STUDIES: [
    { method: "ALL", pathPattern: "/api/case-studies*" },
    { method: "ALL", pathPattern: "/case-studies*" },
  ],
  VIRTUAL_ADMIN_MANAGE: [
    { method: "ALL", pathPattern: "/api/admin/virtual-admins*" },
    { method: "ALL", pathPattern: "/admin/virtual-admins*" },
  ],
  PROFILE: [
    { method: "GET", pathPattern: "/auth/me" },
    { method: "ALL", pathPattern: "/user/settings*" },
  ],
};

function normalizePathPattern(pathPattern: string) {
  const trimmed = pathPattern.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\s+/g, "");
}

function expandPagePermissions(pagePermissions: PagePermissionKey[]) {
  const expanded = pagePermissions.flatMap((permissionKey) => PAGE_ROUTE_PERMISSION_MAP[permissionKey]);
  const unique = new Map<string, { method: string; pathPattern: string }>();

  for (const permission of expanded) {
    const method = permission.method;
    const pathPattern = normalizePathPattern(permission.pathPattern);
    const key = `${method}|${pathPattern}`;
    if (!unique.has(key)) {
      unique.set(key, {
        method,
        pathPattern,
      });
    }
  }

  return Array.from(unique.values());
}

function inferPagePermissions(adminRoutePermissions: Array<{ method: string; pathPattern: string; active: boolean }>) {
  const activePermissionKeys = new Set(
    adminRoutePermissions
      .filter((permission) => permission.active)
      .map((permission) => `${permission.method.toUpperCase()}|${normalizePathPattern(permission.pathPattern)}`)
  );

  return PAGE_PERMISSION_KEYS.filter((pageKey) => {
    const requiredPermissions = expandPagePermissions([pageKey]);
    return requiredPermissions.every((permission) => activePermissionKeys.has(`${permission.method}|${permission.pathPattern}`));
  });
}

async function ensurePlanAvailable(planCode: string) {
  const existing = await prisma.plan.findUnique({ where: { code: planCode } });
  if (existing) {
    return existing;
  }

  if (!stripeClient) {
    return null;
  }

  const products = await stripeClient.products.list({
    active: true,
    expand: ["data.default_price"],
    limit: 100,
  });

  const product = products.data.find((p) => p.metadata.code === planCode);
  if (!product) {
    return null;
  }

  const defaultPrice = product.default_price as Stripe.Price | null;
  const allPrices = await stripeClient.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });
  const hasYearlyPrice = allPrices.data.some((p) => p.recurring?.interval === "year");

  const synced = await prisma.plan.upsert({
    where: { code: planCode },
    update: {
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
        : defaultPrice?.unit_amount ?? 0,
      priceFounderCents: product.metadata.priceFounderCents
        ? parseInt(product.metadata.priceFounderCents)
        : defaultPrice?.unit_amount ?? 0,
      stripePriceStandardId: defaultPrice?.id,
      hasYearlyPrice,
    },
    create: {
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
        : defaultPrice?.unit_amount ?? 0,
      priceFounderCents: product.metadata.priceFounderCents
        ? parseInt(product.metadata.priceFounderCents)
        : defaultPrice?.unit_amount ?? 0,
      stripePriceStandardId: defaultPrice?.id,
      hasYearlyPrice,
    },
  });

  return synced;
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  pendingPlanCode: z.string().optional(), // Optional plan code selected before signup
});

const enterpriseInviteSignupSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  name: z.string().trim().min(1).max(120).optional(),
});

async function resolveEnterpriseInvite(token: string) {
  const invite = await prisma.enterprisePlanInvite.findUnique({
    where: { inviteToken: token },
    include: {
      proposal: true,
    },
  });

  if (!invite) {
    return { error: "Invalid invite token" as const, invite: null };
  }

  if (invite.status === EnterpriseInviteStatus.CANCELED) {
    return { error: "Invite is canceled" as const, invite: null };
  }

  if (
    invite.status === EnterpriseInviteStatus.SIGNED_UP ||
    invite.status === EnterpriseInviteStatus.PAYMENT_COMPLETED
  ) {
    return { error: "Invite already used" as const, invite: null };
  }

  if (invite.expiresAt.getTime() < Date.now()) {
    if (invite.status !== EnterpriseInviteStatus.EXPIRED) {
      await prisma.enterprisePlanInvite.update({
        where: { id: invite.id },
        data: { status: EnterpriseInviteStatus.EXPIRED },
      });
    }
    return { error: "Invite expired" as const, invite: null };
  }

  return { invite, error: null };
}

router.get("/enterprise-invite/validate", async (req, res) => {
  const schema = z.object({ token: z.string().min(1) });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const token = parsed.data.token;
  const resolved = await resolveEnterpriseInvite(token);
  if (!resolved.invite || resolved.error) {
    return res.status(400).json({ valid: false, error: resolved.error || "Invalid invite" });
  }

  const invite = resolved.invite;
  if (invite.status === EnterpriseInviteStatus.PENDING) {
    await prisma.enterprisePlanInvite.update({
      where: { id: invite.id },
      data: {
        status: EnterpriseInviteStatus.VIEWED,
        viewedAt: new Date(),
      },
    });
    await prisma.enterprisePlanProposal.update({
      where: { id: invite.proposalId },
      data: {
        status: EnterpriseProposalStatus.VIEWED,
        viewedAt: new Date(),
      },
    });
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: invite.email.toLowerCase() },
    select: { id: true, emailVerified: true },
  });

  return res.json({
    valid: true,
    invite: {
      email: invite.email,
      fullName: invite.fullName,
      companyName: invite.companyName,
      planCode: invite.planCode,
      socialPlatforms: invite.socialPlatforms,
      reelsPerMonth: invite.reelsPerMonth,
      microReelsPerMonth: invite.microReelsPerMonth,
      proPhotoShootFrequency: invite.proPhotoShootFrequency,
      proPhotoShootLength: invite.proPhotoShootLength,
      captionHashtags: invite.captionHashtags,
      scheduling: invite.scheduling,
      expiresAt: invite.expiresAt,
      userExists: Boolean(existingUser),
      userEmailVerified: existingUser?.emailVerified ?? null,
      proposal: invite.proposal
        ? {
          id: invite.proposal.id,
          planCode: invite.proposal.planCode,
          planName: invite.proposal.planName,
          amount: Number(invite.proposal.amount),
          billingCycle: invite.proposal.billingCycle,
          currency: invite.proposal.currency,
          status: invite.proposal.status,
        }
        : null,
    },
  });
});

router.post("/signup-enterprise-invite", authLimiter, async (req, res) => {
  const parsed = enterpriseInviteSignupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { token, password, name } = parsed.data;
  const resolved = await resolveEnterpriseInvite(token);
  if (!resolved.invite || resolved.error) {
    return res.status(400).json({ error: resolved.error || "Invalid invite" });
  }

  const invite = resolved.invite;
  const email = invite.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        pendingPlanCode: invite.planCode,
        pendingPlanCodeSetAt: new Date(),
      },
    });

    if (!existing.emailVerified) {
      const verificationToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS);

      await prisma.emailVerificationToken.create({
        data: {
          userId: existing.id,
          token: verificationToken,
          expiresAt,
        },
      });
      await sendVerificationEmail(email, verificationToken, invite.planCode);

      return res.status(200).json({
        message: "Account already exists and is not verified. Verification email sent again.",
        requiresVerification: true,
        requiresLogin: false,
        email,
        planCode: invite.planCode,
        amount: Number(invite.proposal.amount),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Email already registered. Please login to continue checkout.",
      requiresLogin: true,
      code: "USER_EXISTS",
      email,
      planCode: invite.planCode,
      amount: Number(invite.proposal.amount),
    });
  }

  await ensurePlanAvailable(invite.planCode);

  const passwordHash = await hashPassword(password);
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS);

  const user = await prisma.user.create({
    data: {
      name: name ?? invite.fullName ?? null,
      email,
      passwordHash,
      role: "USER",
      emailVerified: false,
      pendingPlanCode: invite.planCode,
      pendingPlanCodeSetAt: new Date(),
      emailVerifications: {
        create: {
          token: verificationToken,
          expiresAt,
        },
      },
    },
  });

  await prisma.brandProfile.upsert({
    where: { userId: user.id },
    update: {
      fullManagementOnboardingData: {
        enterpriseInvitePrefill: {
          companyName: invite.companyName,
          fullName: invite.fullName,
          socialPlatforms: invite.socialPlatforms,
          reelsPerMonth: invite.reelsPerMonth,
          microReelsPerMonth: invite.microReelsPerMonth,
          proPhotoShootFrequency: invite.proPhotoShootFrequency,
          proPhotoShootLength: invite.proPhotoShootLength,
          captionHashtags: invite.captionHashtags,
          scheduling: invite.scheduling,
          planCode: invite.planCode,
          inviteId: invite.id,
        },
      },
    },
    create: {
      userId: user.id,
      fullManagementOnboardingData: {
        enterpriseInvitePrefill: {
          companyName: invite.companyName,
          fullName: invite.fullName,
          socialPlatforms: invite.socialPlatforms,
          reelsPerMonth: invite.reelsPerMonth,
          microReelsPerMonth: invite.microReelsPerMonth,
          proPhotoShootFrequency: invite.proPhotoShootFrequency,
          proPhotoShootLength: invite.proPhotoShootLength,
          captionHashtags: invite.captionHashtags,
          scheduling: invite.scheduling,
          planCode: invite.planCode,
          inviteId: invite.id,
        },
      },
    },
  });

  await ensureUserProviderRoutingConfig(user.id);

  await prisma.enterprisePlanInvite.update({
    where: { id: invite.id },
    data: {
      status: EnterpriseInviteStatus.SIGNED_UP,
      signedUpAt: new Date(),
      createdUserId: user.id,
    },
  });

  await prisma.enterprisePlanProposal.update({
    where: { id: invite.proposalId },
    data: {
      status: EnterpriseProposalStatus.SIGNED_UP,
      signedUpAt: new Date(),
      createdUserId: user.id,
    },
  });

  await sendVerificationEmail(email, verificationToken, invite.planCode);

  return res.status(201).json({
    message: "Account created from enterprise invite. Check your email to verify.",
    requiresVerification: true,
    email,
    planCode: invite.planCode,
    amount: Number(invite.proposal.amount),
  });
});

router.post("/signup", authLimiter, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { email, password, pendingPlanCode } = parsed.data;
  const normalizedPendingPlanCode = pendingPlanCode?.trim().toUpperCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }

  // Require plan selection - no default plan
  if (!normalizedPendingPlanCode) {
    logger.warn("No pendingPlanCode provided during signup", { email });
    return res.status(400).json({
      error: "Please select a plan to continue.",
      details: "No plan selected",
    });
  }

  // Try to sync/validate selected plan from DB/Stripe, but do not block account creation.
  // Final plan validity is enforced at checkout.
  const pendingPlan = await ensurePlanAvailable(normalizedPendingPlanCode);
  if (!pendingPlan) {
    logger.warn("Pending plan code not yet synced at signup; continuing", {
      email,
      pendingPlanCode: normalizedPendingPlanCode,
    });
  }

  logger.info("Creating user with pendingPlanCode", {
    pendingPlanCode: normalizedPendingPlanCode,
    email,
    planCategory: pendingPlan?.category,
  });

  const passwordHash = await hashPassword(password);
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: "USER",
      emailVerified: false,
      pendingPlanCode: normalizedPendingPlanCode,
      pendingPlanCodeSetAt: normalizedPendingPlanCode ? new Date() : null,
      emailVerifications: {
        create: {
          token: verificationToken,
          expiresAt,
        },
      },
      // No default subscription - user must complete checkout first
    },
  });
  await ensureUserProviderRoutingConfig(user.id);

  await sendVerificationEmail(email, verificationToken, normalizedPendingPlanCode);

  // Do not issue session until email verified.
  return res.status(201).json({
    message: "Account created. Check your email to verify.",
    requiresVerification: true,
  });
});

router.post("/login", authLimiter, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const email = parsed.data.email.toLowerCase();
  const { password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (user.status === "BLOCKED") {
    return res.status(403).json({ error: "Account is blocked" });
  }
  if (user.status === "DELETED") {
    return res.status(403).json({ error: "Account is deleted" });
  }

  if (!user.emailVerified) {
    return res.status(403).json({ error: "Email not verified" });
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  issueSession(res, user);
  return res.json(safeUser(user));
});

router.post("/admin/login", authLimiter, async (req, res) => {
  await ensureSeedAdmin();

  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const email = parsed.data.email.toLowerCase();
  const { password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }

  if (user.status === "BLOCKED") {
    return res.status(403).json({ error: "Account is blocked" });
  }
  if (user.status === "DELETED") {
    return res.status(403).json({ error: "Account is deleted" });
  }

  if (!user.emailVerified) {
    return res.status(403).json({ error: "Email not verified" });
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  issueSession(res, user);
  return res.json(safeUser(user));
});

router.post("/logout", (_req, res) => {
  const isProduction = env.NODE_ENV === "production";
  res.clearCookie("token", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  });
  res.json({ success: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      profile: {
        select: {
          fullName: true,
          avatarStorageKey: true,
          updatedAt: true,
        },
      },
      adminRoutePermissions: {
        select: {
          method: true,
          pathPattern: true,
          active: true,
        },
      },
    },
  });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // Use the subscription service helper to get the active subscription
  // This ensures consistency with billing summary and handles edge cases
  const subscription = await getActiveSubscription(userId);

  // Check for INCOMPLETE subscriptions if no active one found
  let finalSubscription = subscription;
  if (!subscription) {
    const incompleteSub = await prisma.subscription.findFirst({
      where: { userId },
      include: { plan: true },
      orderBy: { updatedAt: "desc" },
    });
    finalSubscription = incompleteSub;
  }

  // Determine plan category: from subscription, or from pendingPlanCode if no subscription
  let planCategory: PlanCategory | null = (finalSubscription?.plan?.category as PlanCategory) || null;
  let planResolutionPath: "from_subscription" | "from_pending_plan_code" | "unknown" = "unknown";

  // Only query for pendingPlan if we don't have a subscription and user has pendingPlanCode
  if (!planCategory && user.pendingPlanCode) {
    // No active subscription, but user has pendingPlanCode - resolve plan from it
    try {
      const pendingPlan = await prisma.plan.findUnique({
        where: { code: user.pendingPlanCode },
      });
      if (pendingPlan) {
        planCategory = pendingPlan.category as PlanCategory;
        planResolutionPath = "from_pending_plan_code";
        logger.info("Plan resolved from pendingPlanCode", {
          userId,
          pendingPlanCode: user.pendingPlanCode,
          planCategory,
          planCode: pendingPlan.code,
          planName: pendingPlan.name,
        });
      } else {
        // Plan not found - log warning and clear invalid pendingPlanCode
        logger.warn("Invalid pendingPlanCode found - plan does not exist", {
          userId,
          pendingPlanCode: user.pendingPlanCode,
        });
        // Clear invalid pendingPlanCode to prevent stuck state (fire-and-forget)
        prisma.user.update({
          where: { id: userId },
          data: { pendingPlanCode: null },
        }).catch((err) => {
          logger.error("Failed to clear invalid pendingPlanCode", {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (error) {
      logger.error("Error looking up pendingPlanCode", {
        userId,
        pendingPlanCode: user.pendingPlanCode,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue without planCategory - user will be redirected to pricing
    }
  } else if (planCategory) {
    planResolutionPath = "from_subscription";
    logger.info("Plan resolved from subscription", {
      userId,
      planCategory,
      subscriptionStatus: finalSubscription?.status,
      planCode: finalSubscription?.planCode,
    });
  }

  // Log final plan resolution for debugging
  logger.info("Plan resolution complete", {
    userId,
    planCategory,
    planResolutionPath,
    hasActiveSubscription: !!finalSubscription && (finalSubscription.status === "ACTIVE" || finalSubscription.status === "TRIALING"),
    subscriptionStatus: finalSubscription?.status,
    hasPendingPlanCode: !!user.pendingPlanCode,
  });

  // Build subscription object: use actual subscription if exists, otherwise use pendingPlanCode
  const subscriptionObj = finalSubscription
    ? {
      planCode: finalSubscription.planCode,
      planCategory: (finalSubscription.plan?.category as PlanCategory) || null,
      status: finalSubscription.status,
      priceType: finalSubscription.priceType,
    }
    : planCategory
      ? {
        planCode: user.pendingPlanCode || null,
        planCategory: planCategory as PlanCategory,
        status: "INCOMPLETE" as const,
        priceType: "STANDARD" as const,
      }
      : null;

  const permissions =
    user.role === "ADMIN" || user.role === "SUPER_ADMIN"
      ? inferPagePermissions(user.adminRoutePermissions)
      : [];

  return res.json({
    ...safeUser(user), // safeUser already includes pendingPlanCode
    subscription: subscriptionObj,
    permissions,
  });
});

// Stubbed for now; integrate email provider later.
router.post("/request-password-reset", async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { email } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.json({ success: true }); // avoid leaking user existence
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS);

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    });
    await tx.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt },
    });
  });

  // TODO: send email with token link. For now, return token in non-production.
  if (env.NODE_ENV !== "production") {
    return res.json({ success: true, token, expiresAt });
  }

  return res.json({ success: true });
});

router.post("/reset-password", async (req, res) => {
  const schema = z.object({
    token: z.string(),
    password: z.string().min(8),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { token, password } = parsed.data;
  const resetToken = await prisma.passwordResetToken.findUnique({ where: { token } });
  if (!resetToken) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  if (resetToken.usedAt || resetToken.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    });
  });

  logActivity({
    userId: resetToken.userId,
    type: "PASSWORD_RESET",
    title: "Password Reset",
    description: "Password changed via password reset link",
  }).catch(() => {});

  return res.json({ success: true });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const schema = z.object({
    "current-password": z.string().min(1),
    "new-password": z.string().min(8),
    "confirm-password": z.string().min(8),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const currentPassword = parsed.data["current-password"];
  const newPassword = parsed.data["new-password"];
  const confirmPassword = parsed.data["confirm-password"];

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "New password and confirm password do not match" });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ error: "New password must be different from current password" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      passwordHash: true,
      status: true,
    },
  });

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.status === UserStatus.BLOCKED) {
    return res.status(403).json({ error: "Account is blocked" });
  }

  if (user.status === UserStatus.DELETED) {
    return res.status(403).json({ error: "Account is deleted" });
  }

  if (!user.passwordHash) {
    return res.status(400).json({ error: "Password change is unavailable for this account" });
  }

  const isCurrentPasswordValid = await comparePassword(currentPassword, user.passwordHash);
  if (!isCurrentPasswordValid) {
    return res.status(400).json({ error: "Current password is incorrect" });
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    await tx.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    });
  });

  logActivity({
    userId: user.id,
    type: "PASSWORD_CHANGED",
    title: "Password Changed",
    description: "User changed their password",
  }).catch(() => {});

  return res.json({ success: true, message: "Password changed successfully" });
});

router.post("/google", async (req, res) => {
  const schema = z.object({
    idToken: z.string(),
    pendingPlanCode: z.string().optional(), // Accept pendingPlanCode from frontend
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  if (!googleClient || !env.GOOGLE_CLIENT_ID) {
    return res.status(400).json({ error: "Google auth not configured" });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: parsed.data.idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email || !payload.email_verified) {
      return res.status(400).json({ error: "Invalid Google token" });
    }

    const googleId = payload.sub;
    const email = payload.email.toLowerCase();
    const pendingPlanCode = parsed.data.pendingPlanCode?.trim().toUpperCase();
    const validatedPendingPlan = pendingPlanCode
      ? await ensurePlanAvailable(pendingPlanCode)
      : null;

    let user = await prisma.user.findFirst({
      where: {
        OR: [{ googleId }, { email }],
      },
    });

    if (user) {
      if (!user.googleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { googleId },
        });
      }
    } else {
      user = await prisma.user.create({
        data: {
          email,
          googleId,
          role: "USER",
          passwordHash: null,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          pendingPlanCode: pendingPlanCode || null,
          pendingPlanCodeSetAt: pendingPlanCode ? new Date() : null,
        },
      });
      await ensureUserProviderRoutingConfig(user.id);
    }

    if (user.status === "BLOCKED") {
      return res.status(403).json({ error: "Account is blocked" });
    }
    if (user.status === "DELETED") {
      return res.status(403).json({ error: "Account is deleted" });
    }

    // No default subscription - user must select a plan and complete checkout
    // If user has pendingPlanCode, they will be redirected to checkout after verification
    issueSession(res, user);
    return res.json(safeUser(user));
  } catch (err) {
    logger.error("Google login verification failed", err);
    return res.status(400).json({ error: "Google token verification failed" });
  }
});

router.post("/verify-email", async (req, res) => {
  const schema = z.object({ token: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const token = parsed.data.token;
  const record = await prisma.emailVerificationToken.findUnique({ where: { token } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  const user = await prisma.user.update({
    where: { id: record.userId },
    data: { emailVerified: true, emailVerifiedAt: new Date() },
  });

  await prisma.emailVerificationToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  issueSession(res, user);
  return res.json({ success: true, user: safeUser(user) });
});

router.post("/resend-verification", async (req, res) => {
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid request payload. Please provide a valid email address.",
      details: parsed.error.flatten(),
    });
  }

  const email = parsed.data.email.toLowerCase();

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    logger.warn("Resend verification requested for non-existent email", { email });

    return res.status(404).json({
      success: false,
      message: "No account found with this email address.",
    });
  }

  if (user.emailVerified) {
    logger.warn("Resend verification requested for already verified email", { email });

    return res.status(400).json({
      success: false,
      message: "This email address is already verified. Please log in.",
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS);

  await prisma.emailVerificationToken.create({
    data: { userId: user.id, token, expiresAt },
  });

  const emailResult = await sendVerificationEmail(
    email,
    token,
    user.pendingPlanCode || undefined
  );

  if (!emailResult.sent) {
    logger.error("Failed to send verification email", {
      userId: user.id,
      email,
      reason: emailResult.reason,
    });

    return res.status(500).json({
      success: false,
      message: "Failed to send verification email. Please try again later.",
      details: emailResult.reason,
    });
  }

  return res.status(200).json({
    success: true,
    message: "Verification email has been sent successfully. Please check your inbox.",
  });
});

function safeUser(user: {
  id: string;
  name?: string | null;
  email: string;
  role: string;
  isFounder: boolean;
  status: "ACTIVE" | "BLOCKED" | "DELETED";
  emailVerified?: boolean;
  emailVerifiedAt?: Date | null;
  onboardingCompleted?: boolean;
  onboardingStep?: number;
  calendarOnboardingCompleted?: boolean;
  visualOnboardingCompleted?: boolean;
  fullManagementOnboardingCompleted?: boolean;
  pendingPlanCode?: string | null;
  profile?: {
    fullName?: string | null;
    avatarStorageKey?: string | null;
    updatedAt?: Date | null;
  } | null;
}) {
  const avatarStorageKey = user.profile?.avatarStorageKey ?? null;
  const avatarVersion = user.profile?.updatedAt
    ? user.profile.updatedAt.getTime()
    : null;
  const avatarUrl =
    avatarStorageKey && env.STORAGE_BASE_URL
      ? `${env.STORAGE_BASE_URL.replace(/\/+$/, "")}/${avatarStorageKey.replace(/^\/+/, "")}`
      : null;

  return {
    id: user.id,
    name: user.name ?? user.profile?.fullName ?? null,
    email: user.email,
    role: user.role,
    isFounder: user.isFounder,
    status: user.status,
    emailVerified: user.emailVerified ?? true,
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    onboardingCompleted: user.onboardingCompleted ?? false,
    onboardingStep: user.onboardingStep ?? 1,
    calendarOnboardingCompleted: user.calendarOnboardingCompleted ?? false,
    visualOnboardingCompleted: user.visualOnboardingCompleted ?? false,
    fullManagementOnboardingCompleted: user.fullManagementOnboardingCompleted ?? false,
    pendingPlanCode: user.pendingPlanCode ?? null,
    avatarStorageKey,
    avatarUrl,
    avatarVersion,
  };
}

function setAuthCookie(res: express.Response, token: string) {
  const isSecure = env.COOKIE_SECURE === "true";

  res.cookie("token", token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? "none" : "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

function issueSession(
  res: express.Response,
  user: { id: string; email: string; role: Role; isFounder: boolean; status: UserStatus }
) {
  const token = signAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    isFounder: user.isFounder,
    status: user.status,
  });
  setAuthCookie(res, token);
}

let seedAdminPromise: Promise<void> | null = null;
async function ensureSeedAdmin() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return;
  if (seedAdminPromise) return seedAdminPromise;

  const email = env.ADMIN_EMAIL.toLowerCase();
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  const routePermissions = expandPagePermissions(SEED_ADMIN_PAGE_PERMISSIONS);

  seedAdminPromise = prisma.$transaction(async (tx) => {
    const admin = await tx.user.upsert({
      where: { email },
      update: {
        role: "SUPER_ADMIN",
        passwordHash,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        onboardingCompleted: true,
      },
      create: {
        email,
        role: "SUPER_ADMIN",
        passwordHash,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        onboardingCompleted: true,
        isFounder: false,
      },
    });

    await tx.adminRoutePermission.deleteMany({
      where: { adminUserId: admin.id },
    });

    if (routePermissions.length) {
      await tx.adminRoutePermission.createMany({
        data: routePermissions.map((permission) => ({
          adminUserId: admin.id,
          method: permission.method,
          pathPattern: permission.pathPattern,
          active: true,
          grantedByAdminId: admin.id,
        })),
      });
    }
  }).then(() => undefined);

  return seedAdminPromise;
}

if (env.NODE_ENV === "production") {
  ensureSeedAdmin().catch((error) => {
    logger.error("Failed to seed production admin", error);
  });
}

// Google OAuth callback (GET - browser redirect from Google)
router.get("/google/callback", async (req, res) => {
  const FRONTEND = env.FRONTEND_URL ?? "http://138.68.251.5.nip.io:3000";
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${FRONTEND}/login?error=google_denied`);
  }

  if (!code || typeof code !== "string") {
    return res.redirect(`${FRONTEND}/login?error=missing_code`);
  }

  if (!googleClient) {
    return res.redirect(`${FRONTEND}/login?error=google_not_configured`);
  }

  if (!env.GOOGLE_CLIENT_SECRET) {
    logger.error("Google OAuth GET callback blocked: missing GOOGLE_CLIENT_SECRET", {
      hasClientId: Boolean(env.GOOGLE_CLIENT_ID),
      hasClientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
      redirectUri: googleRedirectUri,
    });
    return res.redirect(`${FRONTEND}/login?error=google_not_configured`);
  }

  try {
    const { tokens } = await googleClient.getToken({
      code,
      redirect_uri: googleRedirectUri,
    });

    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token!,
      audience: env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.email) {
      return res.redirect(`${FRONTEND}/login?error=no_email`);
    }

    const pendingPlanCode =
      typeof state === "string" ? state : undefined;

    let user = await prisma.user.findUnique({ where: { email: payload.email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: payload.email,
          googleId: payload.sub,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          pendingPlanCode: pendingPlanCode || null,
          pendingPlanCodeSetAt: pendingPlanCode ? new Date() : null,
        },
      });
      await ensureUserProviderRoutingConfig(user.id);
    } else if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: payload.sub,
          emailVerified: true,
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          ...(pendingPlanCode && !user.pendingPlanCode
            ? { pendingPlanCode, pendingPlanCodeSetAt: new Date() }
            : {}),
        },
      });
    }

    if (user.status === "BLOCKED") {
      return res.redirect(`${FRONTEND}/login?error=blocked`);
    }
    if (user.status === "DELETED") {
      return res.redirect(`${FRONTEND}/login?error=deleted`);
    }

    issueSession(res, user);

    const redirectTo = user.onboardingCompleted
      ? `${FRONTEND}/dashboard`
      : `${FRONTEND}/onboarding`;

    return res.redirect(redirectTo);
  } catch (err) {
    logger.error("Google OAuth GET callback error", {
      message: err instanceof Error ? err.message : "Unknown error",
      hasClientId: Boolean(env.GOOGLE_CLIENT_ID),
      hasClientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
      redirectUri: googleRedirectUri,
    });
    return res.redirect(`${FRONTEND}/login?error=google_failed`);
  }
});

// Google OAuth callback (code exchange)
router.post("/google/callback", async (req, res) => {
  const schema = z.object({
    code: z.string(),
    pendingPlanCode: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid code" });
  }

  if (!googleClient) {
    return res.status(500).json({ error: "Google OAuth not configured" });
  }

  if (!env.GOOGLE_CLIENT_SECRET) {
    logger.error("Google OAuth callback blocked: missing GOOGLE_CLIENT_SECRET", {
      hasClientId: Boolean(env.GOOGLE_CLIENT_ID),
      hasClientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
      redirectUri: googleRedirectUri,
    });
    return res.status(500).json({ error: "Google OAuth not configured" });
  }

  try {
    // Exchange code for tokens
    const { tokens } = await googleClient.getToken({
      code: parsed.data.code,
      redirect_uri: googleRedirectUri,
    });

    // Verify the ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token!,
      audience: env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.email) {
      return res.status(400).json({ error: "No email in Google response" });
    }

    const pendingPlanCode = parsed.data.pendingPlanCode;

    // Validate pendingPlanCode if provided
    if (pendingPlanCode) {
      const pendingPlan = await prisma.plan.findUnique({
        where: { code: pendingPlanCode },
      });
      if (!pendingPlan) {
        logger.warn("Invalid pendingPlanCode in Google callback", {
          email: payload.email,
          pendingPlanCode,
        });
        // Continue without pendingPlanCode rather than failing auth
      }
    }

    // Same logic as existing Google route
    let user = await prisma.user.findUnique({ where: { email: payload.email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: payload.email,
          googleId: payload.sub,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          pendingPlanCode: pendingPlanCode || null,
          pendingPlanCodeSetAt: pendingPlanCode ? new Date() : null,
        },
      });
      await ensureUserProviderRoutingConfig(user.id);
    } else if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: payload.sub,
          emailVerified: true,
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          // Only update pendingPlanCode if user doesn't have one and we have one
          ...(pendingPlanCode && !user.pendingPlanCode
            ? { pendingPlanCode, pendingPlanCodeSetAt: new Date() }
            : {}),
        },
      });
    }

    // No default subscription - user must select a plan and complete checkout
    // If user has pendingPlanCode, they will be redirected to checkout after verification

    if (user.status === "BLOCKED") {
      return res.status(403).json({ error: "Account is blocked" });
    }
    if (user.status === "DELETED") {
      return res.status(403).json({ error: "Account is deleted" });
    }

    const token = signAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      isFounder: user.isFounder,
      status: user.status,
    });

    setAuthCookie(res, token);

    return res.json({
      success: true,
      token,
      onboardingCompleted: user.onboardingCompleted,
    });
  } catch (error) {
    logger.error("Google OAuth callback error", {
      message: error instanceof Error ? error.message : "Unknown error",
      hasClientId: Boolean(env.GOOGLE_CLIENT_ID),
      hasClientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
      redirectUri: googleRedirectUri,
    });
    return res.status(500).json({ error: "Google authentication failed" });
  }
});

export { router as authRouter };
