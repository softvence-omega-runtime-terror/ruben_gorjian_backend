import express from "express";
import crypto from "crypto";
import { z } from "zod";
import { AuditAction, Prisma, ProviderRoutingMode } from "@prisma/client";
import Stripe from "stripe";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { requireAdmin } from "../../middleware/requireAdmin";
import { hashPassword } from "../../utils/password";
import { sendVerificationEmail } from "../auth/email";
import { stripeClient } from "../billing/stripe";
import { hasExceededVerificationResendLimit } from "./limits";
import { getOrCreateAdminOperation } from "./operations";
import {
  ensureUserProviderRoutingConfig,
  getGlobalPublishingRoutingConfig,
  normalizeProviderRoutingMode,
} from "../social/provider-routing";
import { adminCouponRouter } from "./admin-coupon-routes";

const router = express.Router();

router.use(requireAuth, requireAdmin);
router.use("/coupons", adminCouponRouter);

const ADMIN_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isFounder: true,
  status: true,
  signupDate: true,
  emailVerified: true,
  emailVerifiedAt: true,
  blockedAt: true,
  blockedReason: true,
  deletedAt: true,
  onboardingCompleted: true,
  createdAt: true,
  subscriptions: {
    select: {
      id: true,
      planCode: true,
      status: true,
      priceType: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      createdAt: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
    orderBy: { createdAt: "desc" as const },
    take: 1,
  },
  socialAccounts: {
    select: {
      id: true,
      platform: true,
    },
  },
};

type AdminUserRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>;
type StripeSubscriptionWithPeriod = Stripe.Subscription & {
  current_period_start?: number | null;
  current_period_end?: number | null;
};

async function createAuditLog(params: {
  actorId: string;
  actorEmail: string;
  action: AuditAction;
  targetUserId?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      actorEmail: params.actorEmail,
      action: params.action,
      targetUserId: params.targetUserId,
      metadata: params.metadata ? (params.metadata as Prisma.InputJsonValue) : undefined,
    },
  });
}

router.get("/summary", async (_req, res) => {
  const [users, subscriptions, founders] = await Promise.all([
    prisma.user.count(),
    prisma.subscription.count(),
    prisma.founder.count(),
  ]);

  res.json({
    users,
    subscriptions,
    founders,
    message: "Admin summary stub; extend with more insights.",
  });
});

router.get("/users", async (req, res) => {
  const schema = z.object({
    search: z.string().optional(),
    role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
    status: z.enum(["ACTIVE", "BLOCKED", "DELETED"]).optional(),
    plan: z.string().optional(),
    founder: z.enum(["true", "false"]).optional(),
    subscriptionStatus: z.enum(["ACTIVE", "TRIALING", "PAST_DUE", "CANCELED", "INCOMPLETE"]).optional(),
    sortBy: z.enum(["createdAt", "periodEnd", "founder", "plan"]).optional().default("createdAt"),
    sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { search, role, status, plan, founder, subscriptionStatus, sortBy, sortDir, page, pageSize } = parsed.data;
  const where = {
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(founder !== undefined ? { isFounder: founder === "true" } : {}),
    ...(search
      ? {
        OR: [
          { email: { contains: search, mode: "insensitive" as const } },
          { name: { contains: search, mode: "insensitive" as const } },
          { id: { contains: search, mode: "insensitive" as const } },
        ],
      }
      : {}),
    ...(plan ? { subscriptions: { some: { planCode: plan } } } : {}),
    ...(subscriptionStatus ? { subscriptions: { some: { status: subscriptionStatus } } } : {}),
  };

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: sortBy === "createdAt" ? { createdAt: sortDir } : sortBy === "founder" ? { isFounder: sortDir } : { createdAt: sortDir },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: ADMIN_USER_SELECT,
    }),
  ]);

  let sortedUsers = users;
  if (sortBy === "periodEnd") {
    sortedUsers = [...users].sort((a, b) => {
      const aEnd = a.subscriptions[0]?.currentPeriodEnd?.getTime() ?? 0;
      const bEnd = b.subscriptions[0]?.currentPeriodEnd?.getTime() ?? 0;
      return sortDir === "asc" ? aEnd - bEnd : bEnd - aEnd;
    });
  } else if (sortBy === "plan") {
    sortedUsers = [...users].sort((a, b) => {
      const aPlan = a.subscriptions[0]?.planCode ?? "";
      const bPlan = b.subscriptions[0]?.planCode ?? "";
      return sortDir === "asc" ? aPlan.localeCompare(bPlan) : bPlan.localeCompare(aPlan);
    });
  }

  // Calculate counts for each user
  const usersWithCounts = await Promise.all(
    sortedUsers.map(async (user) => {
      const [scheduledPostsCount] = await Promise.all([
        prisma.post.count({
          where: {
            userId: user.id,
            status: { in: ["SCHEDULED", "PUBLISHING"] },
          },
        }),
      ]);
      return {
        ...user,
        connectedPlatformsCount: user.socialAccounts.length,
        scheduledPostsCount,
      };
    })
  );

  res.json({
    items: usersWithCounts.map(serializeUser),
    page,
    pageSize,
    total,
  });
});

router.post("/users", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email(),
    password: z.string().min(8).optional(),
    role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
    planCode: z.string().optional(),
    sendVerification: z.boolean().optional().default(true),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { name, email, password, role, planCode, sendVerification } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }

  if (planCode) {
    const plan = await prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan) {
      return res.status(400).json({ error: "Invalid plan code" });
    }
  }

  const passwordHash = password ? await hashPassword(password) : null;

  const user = await prisma.user.create({
    data: {
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: role ?? "USER",
      pendingPlanCode: planCode,
      pendingPlanCodeSetAt: planCode ? new Date() : null,
    },
    select: ADMIN_USER_SELECT,
  });
  await ensureUserProviderRoutingConfig(user.id);

  if (sendVerification) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, token, expiresAt },
    });
    await sendVerificationEmail(user.email, token, planCode);
  }

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "CREATE_USER",
    targetUserId: user.id,
    metadata: { email: user.email, role: user.role, planCode },
  });

  res.status(201).json(serializeUser({ ...user, connectedPlatformsCount: 0, scheduledPostsCount: 0 }));
});

router.get("/users/:id", async (req, res) => {
  const { id } = req.params;
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      ...ADMIN_USER_SELECT,
      profile: true,
      brandProfile: true,
      subscriptions: {
        select: {
          id: true,
          planCode: true,
          status: true,
          priceType: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          canceledAt: true,
          createdAt: true,
          plan: {
            select: {
              platformLimit: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // Get usage summary counts
  const [
    scheduledPostsCount,
    publishedPostsCount,
    failedPostsCount,
    uploadedMediaCount,
    connectedPlatformsCount,
  ] = await Promise.all([
    prisma.post.count({
      where: {
        userId: id,
        status: { in: ["SCHEDULED", "PUBLISHING"] },
      },
    }),
    prisma.post.count({
      where: {
        userId: id,
        status: "POSTED",
      },
    }),
    prisma.post.count({
      where: {
        userId: id,
        status: "FAILED",
      },
    }),
    prisma.asset.count({
      where: { userId: id },
    }),
    prisma.socialAccount.count({
      where: { userId: id },
    }),
  ]);

  const platformLimit = user.subscriptions[0]?.plan?.platformLimit ?? null;

  const posts = await prisma.post.findMany({
    where: { userId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  res.json({
    user: serializeUser({ ...user, connectedPlatformsCount, scheduledPostsCount }),
    profile: user.profile,
    brandProfile: user.brandProfile,
    posts,
    usageSummary: {
      scheduledPostsCount,
      publishedPostsCount,
      failedPostsCount,
      uploadedMediaCount,
      connectedPlatformsCount,
      platformLimit,
    },
  });
});

router.get("/users/:id/publishing-routing", async (req, res) => {
  const config = await prisma.providerRoutingConfig.findUnique({
    where: { userId: req.params.id },
  });

  res.json({
    mode: normalizeProviderRoutingMode(config?.mode),
    useInstagram: config?.useInstagram ?? true,
    useFacebook: config?.useFacebook ?? true,
    useLinkedin: config?.useLinkedin ?? true,
  });
});

router.get("/publishing-routing/global", async (_req, res) => {
  const [users, globalConfig] = await Promise.all([
    prisma.user.findMany({
      where: {
        deletedAt: null,
        status: { not: "DELETED" },
        role: "USER",
      },
      select: {
        id: true,
        providerRoutingConfig: {
          select: { mode: true },
        },
      },
    }),
    getGlobalPublishingRoutingConfig(),
  ]);

  let forceNative = 0;
  let forceUploadPost = 0;
  for (const user of users) {
    const mode = normalizeProviderRoutingMode(
      user.providerRoutingConfig?.mode ?? globalConfig?.mode
    );
    if (mode === "FORCE_UPLOAD_POST") {
      forceUploadPost += 1;
    } else {
      forceNative += 1;
    }
  }

  res.json({
    scope: globalConfig?.applyScope === "ALL_USERS" ? "ALL_USERS" : "USERS_ONLY",
    globalDefault: {
      mode: normalizeProviderRoutingMode(globalConfig?.mode),
      useInstagram: globalConfig?.useInstagram ?? true,
      useFacebook: globalConfig?.useFacebook ?? true,
      useLinkedin: globalConfig?.useLinkedin ?? true,
    },
    totalUsers: users.length,
    modeCounts: {
      FORCE_NATIVE: forceNative,
      FORCE_UPLOAD_POST: forceUploadPost,
    },
  });
});

router.put("/publishing-routing/global", async (req, res) => {
  const schema = z.object({
    mode: z.enum(["FORCE_NATIVE", "FORCE_UPLOAD_POST"]),
    applyTo: z.enum(["USERS_ONLY", "ALL_USERS"]).optional().default("USERS_ONLY"),
    useInstagram: z.boolean().optional(),
    useFacebook: z.boolean().optional(),
    useLinkedin: z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const where =
    parsed.data.applyTo === "ALL_USERS"
      ? {
        deletedAt: null as Date | null,
        status: { not: "DELETED" as const },
      }
      : {
        deletedAt: null as Date | null,
        status: { not: "DELETED" as const },
        role: "USER" as const,
      };

  const targetUsers = await prisma.user.findMany({
    where,
    select: { id: true },
  });
  const targetUserIds = targetUsers.map((user) => user.id);

  await prisma.globalPublishingRoutingConfig.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      mode: parsed.data.mode,
      applyScope: parsed.data.applyTo,
      useInstagram: parsed.data.useInstagram ?? true,
      useFacebook: parsed.data.useFacebook ?? true,
      useLinkedin: parsed.data.useLinkedin ?? true,
    },
    update: {
      mode: parsed.data.mode,
      applyScope: parsed.data.applyTo,
      ...(parsed.data.useInstagram !== undefined ? { useInstagram: parsed.data.useInstagram } : {}),
      ...(parsed.data.useFacebook !== undefined ? { useFacebook: parsed.data.useFacebook } : {}),
      ...(parsed.data.useLinkedin !== undefined ? { useLinkedin: parsed.data.useLinkedin } : {}),
    },
  });

  if (targetUserIds.length === 0) {
    return res.json({
      mode: parsed.data.mode,
      applyTo: parsed.data.applyTo,
      targetUsersCount: 0,
      updatedExistingCount: 0,
      createdCount: 0,
    });
  }

  const existingConfigs = await prisma.providerRoutingConfig.findMany({
    where: { userId: { in: targetUserIds } },
    select: { userId: true },
  });
  const existingUserIds = new Set(existingConfigs.map((cfg) => cfg.userId));
  const missingUserIds = targetUserIds.filter((id) => !existingUserIds.has(id));

  const updateData: {
    mode: "FORCE_NATIVE" | "FORCE_UPLOAD_POST";
    useInstagram?: boolean;
    useFacebook?: boolean;
    useLinkedin?: boolean;
  } = {
    mode: parsed.data.mode,
  };
  if (parsed.data.useInstagram !== undefined) updateData.useInstagram = parsed.data.useInstagram;
  if (parsed.data.useFacebook !== undefined) updateData.useFacebook = parsed.data.useFacebook;
  if (parsed.data.useLinkedin !== undefined) updateData.useLinkedin = parsed.data.useLinkedin;

  const [updatedManyResult, createdManyResult] = await prisma.$transaction([
    prisma.providerRoutingConfig.updateMany({
      where: { userId: { in: targetUserIds } },
      data: updateData,
    }),
    prisma.providerRoutingConfig.createMany({
      data: missingUserIds.map((userId) => ({
        userId,
        mode: parsed.data.mode,
        useInstagram: parsed.data.useInstagram ?? true,
        useFacebook: parsed.data.useFacebook ?? true,
        useLinkedin: parsed.data.useLinkedin ?? true,
      })),
      skipDuplicates: true,
    }),
  ]);

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "UPDATE_USER",
    metadata: {
      providerRoutingGlobal: {
        mode: parsed.data.mode,
        applyTo: parsed.data.applyTo,
        targetUsersCount: targetUserIds.length,
        updatedExistingCount: updatedManyResult.count,
        createdCount: createdManyResult.count,
        useInstagram:
          parsed.data.useInstagram !== undefined ? parsed.data.useInstagram : "unchanged",
        useFacebook:
          parsed.data.useFacebook !== undefined ? parsed.data.useFacebook : "unchanged",
        useLinkedin:
          parsed.data.useLinkedin !== undefined ? parsed.data.useLinkedin : "unchanged",
      },
    },
  });

  res.json({
    mode: parsed.data.mode,
    applyTo: parsed.data.applyTo,
    targetUsersCount: targetUserIds.length,
    updatedExistingCount: updatedManyResult.count,
    createdCount: createdManyResult.count,
  });
});

router.put("/users/:id/publishing-routing", async (req, res) => {
  const schema = z.object({
    mode: z.enum(["FORCE_NATIVE", "FORCE_UPLOAD_POST"]),
    useInstagram: z.boolean().optional(),
    useFacebook: z.boolean().optional(),
    useLinkedin: z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const updated = await prisma.providerRoutingConfig.upsert({
    where: { userId: req.params.id },
    create: {
      userId: req.params.id,
      mode: parsed.data.mode,
      useInstagram: parsed.data.useInstagram ?? true,
      useFacebook: parsed.data.useFacebook ?? true,
      useLinkedin: parsed.data.useLinkedin ?? true,
    },
    update: {
      mode: parsed.data.mode,
      ...(parsed.data.useInstagram !== undefined ? { useInstagram: parsed.data.useInstagram } : {}),
      ...(parsed.data.useFacebook !== undefined ? { useFacebook: parsed.data.useFacebook } : {}),
      ...(parsed.data.useLinkedin !== undefined ? { useLinkedin: parsed.data.useLinkedin } : {}),
    },
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "UPDATE_USER",
    targetUserId: req.params.id,
    metadata: {
      providerRouting: {
        mode: updated.mode,
        useInstagram: updated.useInstagram,
        useFacebook: updated.useFacebook,
        useLinkedin: updated.useLinkedin,
      },
    },
  });

  res.json({
    mode: updated.mode,
    useInstagram: updated.useInstagram,
    useFacebook: updated.useFacebook,
    useLinkedin: updated.useLinkedin,
  });
});

router.patch("/users/:id", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { id } = req.params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (req.user!.id === id && parsed.data.role && parsed.data.role !== user.role) {
    return res.status(400).json({ error: "Cannot change your own role" });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.role ? { role: parsed.data.role } : {}),
    },
    select: ADMIN_USER_SELECT,
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "UPDATE_USER",
    targetUserId: id,
    metadata: { name: parsed.data.name, role: parsed.data.role },
  });

  const scheduledPostsCount = await prisma.post.count({
    where: {
      userId: id,
      status: { in: ["SCHEDULED", "PUBLISHING"] },
    },
  });

  res.json(serializeUser({ ...updated, connectedPlatformsCount: updated.socialAccounts.length, scheduledPostsCount }));
});

router.delete("/users/:id", async (req, res) => {
  const { id } = req.params;
  if (req.user!.id === id) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.status === "DELETED") {
    return res.status(400).json({ error: `User ${user.email} is already deleted` });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      status: "DELETED",
      deletedAt: new Date(),
    },
    select: ADMIN_USER_SELECT,
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "DELETE_USER",
    targetUserId: id,
  });

  const scheduledPostsCount = await prisma.post.count({
    where: {
      userId: id,
      status: { in: ["SCHEDULED", "PUBLISHING"] },
    },
  });

  res.json({
    success: true,
    message: `User ${user.email} has been successfully deleted.`,
    user: serializeUser({ ...updated, connectedPlatformsCount: updated.socialAccounts.length, scheduledPostsCount }),
  });
});

router.post("/users/:id/delete-with-password", async (req, res) => {
  const schema = z.object({
    adminPassword: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { id } = req.params;
  if (req.user!.id === id) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }

  // Verify admin password
  const admin = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!admin || !admin.passwordHash) {
    return res.status(401).json({ error: "Admin authentication failed" });
  }

  const { comparePassword } = await import("../../utils/password");
  const passwordValid = await comparePassword(parsed.data.adminPassword, admin.passwordHash);
  if (!passwordValid) {
    return res.status(401).json({ error: "Invalid admin password" });
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.status === "DELETED") {
    return res.status(400).json({ error: `User ${user.email} is already deleted` });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      status: "DELETED",
      deletedAt: new Date(),
    },
    select: ADMIN_USER_SELECT,
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "DELETE_USER",
    targetUserId: id,
    metadata: { passwordVerified: true },
  });

  const scheduledPostsCount = await prisma.post.count({
    where: {
      userId: id,
      status: { in: ["SCHEDULED", "PUBLISHING"] },
    },
  });

  res.json({
    success: true,
    message: `User ${user.email} has been successfully deleted (password verified).`,
    user: serializeUser({ ...updated, connectedPlatformsCount: updated.socialAccounts.length, scheduledPostsCount }),
  });
});

router.post("/users/:id/restore", async (req, res) => {
  const { id } = req.params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.status !== "DELETED") {
    return res.status(400).json({ error: `User ${user.email} is not deleted` });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      status: "ACTIVE",
      deletedAt: null,
      blockedAt: null,
      blockedReason: null,
    },
    select: ADMIN_USER_SELECT,
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "UPDATE_USER",
    targetUserId: id,
    metadata: { restoreUser: true, previousStatus: user.status },
  });

  const scheduledPostsCount = await prisma.post.count({
    where: {
      userId: id,
      status: { in: ["SCHEDULED", "PUBLISHING"] },
    },
  });

  res.json({
    success: true,
    message: `User ${user.email} has been restored successfully`,
    user: serializeUser({ ...updated, connectedPlatformsCount: updated.socialAccounts.length, scheduledPostsCount }),
  });
});

router.get("/users/:id/scheduled-items", async (req, res) => {
  const schema = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
    status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHING", "POSTED", "FAILED"]).optional(),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { id } = req.params;
  const { page, pageSize, status } = parsed.data;

  const where = {
    userId: id,
    ...(status ? { status } : {}),
  };

  const [total, posts] = await Promise.all([
    prisma.post.count({ where }),
    prisma.post.findMany({
      where,
      orderBy: [
        { scheduledFor: "desc" },
        { createdAt: "desc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        status: true,
        scheduledFor: true,
        caption: true,
        createdAt: true,
        updatedAt: true,
        targets: {
          select: {
            id: true,
            platform: true,
            status: true,
            publishedAt: true,
            errorMessage: true,
          },
        },
      },
    }),
  ]);

  res.json({
    items: posts,
    page,
    pageSize,
    total,
  });
});

router.post("/users/:id/block", async (req, res) => {
  const schema = z.object({
    reason: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { id } = req.params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  if (req.user!.id === id) {
    return res.status(400).json({ error: "Cannot block your own account" });
  }
  if (user.status === "DELETED") {
    return res.status(400).json({ error: `Cannot block a deleted user account` });
  }
  if (user.status === "BLOCKED") {
    return res.status(400).json({ error: `User ${user.email} is already blocked` });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      status: "BLOCKED",
      blockedAt: new Date(),
      blockedReason: parsed.data.reason,
    },
    select: ADMIN_USER_SELECT,
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "BLOCK_USER",
    targetUserId: id,
    metadata: { reason: parsed.data.reason },
  });

  const scheduledPostsCount = await prisma.post.count({
    where: {
      userId: id,
      status: { in: ["SCHEDULED", "PUBLISHING"] },
    },
  });

  res.json({
    success: true,
    message: `User ${user.email} has been successfully blocked. Reason: ${parsed.data.reason}`,
    user: serializeUser({ ...updated, connectedPlatformsCount: updated.socialAccounts.length, scheduledPostsCount }),
  });
});

router.post("/users/:id/unblock", async (req, res) => {
  const { id } = req.params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  if (user.status === "DELETED") {
    return res.status(400).json({ error: `Cannot unblock user ${user.email} - account is deleted` });
  }
  if (user.status !== "BLOCKED") {
    return res.status(400).json({ error: `User ${user.email} is not currently blocked` });
  }
  const updated = await prisma.user.update({
    where: { id },
    data: {
      status: "ACTIVE",
      blockedAt: null,
      blockedReason: null,
    },
    select: ADMIN_USER_SELECT,
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "UNBLOCK_USER",
    targetUserId: id,
  });

  const scheduledPostsCount = await prisma.post.count({
    where: {
      userId: id,
      status: { in: ["SCHEDULED", "PUBLISHING"] },
    },
  });

  res.json({
    success: true,
    message: `User ${user.email} has been successfully unblocked`,
    user: serializeUser({ ...updated, connectedPlatformsCount: updated.socialAccounts.length, scheduledPostsCount }),
  });
});

router.post("/users/:id/resend-verification", async (req, res) => {
  const { id } = req.params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  if (user.emailVerified) {
    return res.json({ success: true });
  }

  const isRateLimited = await hasExceededVerificationResendLimit(id);
  if (isRateLimited) {
    return res.status(429).json({ error: "Verification resend limit reached. Try again later." });
  }

  const idempotencyKey =
    (req.headers["idempotency-key"] as string | undefined) ??
    `resend:${id}:${new Date().toISOString().slice(0, 13)}`;

  const operation = await getOrCreateAdminOperation(idempotencyKey, req.user!.id, "RESEND_VERIFICATION", id);
  if (operation?.status === "COMPLETED") {
    return res.json({ success: true });
  }

  await prisma.emailVerificationToken.updateMany({
    where: { userId: id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await prisma.emailVerificationToken.create({
    data: { userId: id, token, expiresAt },
  });

  await sendVerificationEmail(user.email, token, user.pendingPlanCode ?? undefined);

  await prisma.adminOperation.update({
    where: { key: idempotencyKey },
    data: { status: "COMPLETED" },
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "RESEND_VERIFICATION",
    targetUserId: id,
  });

  res.json({ success: true });
});

router.post("/users/:id/cancel-subscription", async (req, res) => {
  const schema = z.object({
    cancelAtPeriodEnd: z.boolean().optional().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { id } = req.params;
  const subscription = await prisma.subscription.findFirst({
    where: { userId: id },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) {
    return res.status(404).json({ error: "Subscription not found" });
  }

  const idempotencyKey =
    (req.headers["idempotency-key"] as string | undefined) ??
    `cancel:${id}:${subscription.id}`;
  const operation = await getOrCreateAdminOperation(idempotencyKey, req.user!.id, "CANCEL_SUBSCRIPTION", id);
  if (operation?.status === "COMPLETED") {
    return res.json({ subscription });
  }

  let stripeResult: Record<string, unknown> | null = null;
  if (subscription.stripeSubscriptionId && stripeClient) {
    if (parsed.data.cancelAtPeriodEnd) {
      const stripeSub = (await stripeClient.subscriptions.update(
        subscription.stripeSubscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey }
      )) as StripeSubscriptionWithPeriod;
      stripeResult = serializeStripeSubscription(stripeSub);
    } else {
      const stripeSub = (await stripeClient.subscriptions.cancel(
        subscription.stripeSubscriptionId,
        undefined,
        { idempotencyKey }
      )) as StripeSubscriptionWithPeriod;
      stripeResult = serializeStripeSubscription(stripeSub);
    }
  }

  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      cancelAtPeriodEnd: parsed.data.cancelAtPeriodEnd,
      canceledAt: parsed.data.cancelAtPeriodEnd ? null : new Date(),
      status: parsed.data.cancelAtPeriodEnd ? subscription.status : "CANCELED",
    },
  });

  await prisma.adminOperation.update({
    where: { key: idempotencyKey },
    data: {
      status: "COMPLETED",
      metadata: stripeResult ? (stripeResult as Prisma.InputJsonValue) : undefined,
    },
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "CANCEL_SUBSCRIPTION",
    targetUserId: id,
    metadata: { cancelAtPeriodEnd: parsed.data.cancelAtPeriodEnd },
  });

  res.json({ subscription: updated });
});

router.post("/users/:id/refresh-subscription", async (req, res) => {
  const { id } = req.params;
  const subscription = await prisma.subscription.findFirst({
    where: { userId: id },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription || !subscription.stripeSubscriptionId || !stripeClient) {
    return res.status(404).json({ error: "Stripe subscription not found" });
  }

  const stripeSub = (await stripeClient.subscriptions.retrieve(
    subscription.stripeSubscriptionId
  )) as StripeSubscriptionWithPeriod;
  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      status: stripeSub.status.toUpperCase() as any,
      currentPeriodStart: stripeSub.current_period_start
        ? new Date(stripeSub.current_period_start * 1000)
        : subscription.currentPeriodStart,
      currentPeriodEnd: stripeSub.current_period_end
        ? new Date(stripeSub.current_period_end * 1000)
        : subscription.currentPeriodEnd,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? subscription.cancelAtPeriodEnd,
      canceledAt: stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000) : subscription.canceledAt,
    },
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "REFRESH_SUBSCRIPTION",
    targetUserId: id,
    metadata: { stripeSubscriptionId: subscription.stripeSubscriptionId },
  });

  res.json({ subscription: updated });
});

router.get("/users/:id/invoices", async (req, res) => {
  const { id } = req.params;
  const subscription = await prisma.subscription.findFirst({
    where: { userId: id },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription?.stripeCustomerId || !stripeClient) {
    return res.json({ items: [] });
  }

  const invoices = await stripeClient.invoices.list({
    customer: subscription.stripeCustomerId,
    limit: 20,
  });

  const items = invoices.data.map((inv) => ({
    id: inv.id,
    number: inv.number,
    amount: inv.amount_paid ?? inv.amount_due ?? 0,
    currency: inv.currency,
    status: inv.status,
    createdAt: new Date(inv.created * 1000).toISOString(),
    hostedInvoiceUrl: inv.hosted_invoice_url,
  }));

  res.json({ items });
});

router.get("/users/:id/audit-logs", async (req, res) => {
  const { id } = req.params;
  const logs = await prisma.auditLog.findMany({
    where: { targetUserId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.json({ items: logs });
});

router.post("/users/:id/reset-password", async (req, res) => {
  const schema = z.object({
    password: z.string().min(8),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { id } = req.params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.user.update({
    where: { id },
    data: { passwordHash },
  });

  await createAuditLog({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: "UPDATE_USER",
    targetUserId: id,
    metadata: { resetPassword: true },
  });

  res.json({ success: true });
});

router.get("/subscriptions", async (_req, res) => {
  const subscriptions = await prisma.subscription.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { id: true, email: true, isFounder: true } },
      plan: {
        select: {
          code: true,
          name: true,
          category: true,
          isJewelry: true,
          platformLimit: true,
          baseVisualQuota: true,
          basePostQuota: true,
        },
      },
    },
  });

  res.json(subscriptions.map(serializeSubscription));
});

router.get("/calendars", async (_req, res) => {
  const posts = await prisma.post.findMany({
    orderBy: [
      { scheduledFor: "desc" },
      { createdAt: "desc" },
    ],
    include: {
      user: { select: { id: true, email: true } },
      targets: {
        select: {
          id: true,
          platform: true,
          status: true,
          scheduledFor: true,
          publishedAt: true,
          errorMessage: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
    take: 200,
  });

  const grouped = new Map<
    string,
    {
      userId: string;
      userEmail: string;
      posts: Array<{
        id: string;
        status: string;
        scheduledFor: Date | null;
        createdAt: Date;
        targets: Array<{
          id: string;
          platform: string;
          status: string;
          scheduledFor: Date | null;
          publishedAt: Date | null;
          errorMessage: string | null;
        }>;
      }>;
    }
  >();

  posts.forEach((post: any) => {
    const existing = grouped.get(post.userId);
    const payload = {
      id: post.id,
      status: post.status,
      scheduledFor: post.scheduledFor,
      createdAt: post.createdAt,
      targets: post.targets.map((target: any) => ({
        id: target.id,
        platform: target.platform,
        status: target.status,
        scheduledFor: target.scheduledFor,
        publishedAt: target.publishedAt,
        errorMessage: target.errorMessage,
      })),
    };

    if (existing) {
      existing.posts.push(payload);
    } else {
      grouped.set(post.userId, {
        userId: post.userId,
        userEmail: post.user.email,
        posts: [payload],
      });
    }
  });

  res.json(Array.from(grouped.values()));
});

export { router as adminRouter };

function serializeUser(user: AdminUserRow & { connectedPlatformsCount?: number; scheduledPostsCount?: number }) {
  return {
    id: user.id,
    name: user.name ?? null,
    email: user.email,
    role: user.role,
    isFounder: user.isFounder,
    status: user.status,
    signupDate: user.signupDate,
    emailVerified: user.emailVerified,
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    blockedAt: user.blockedAt ?? null,
    blockedReason: user.blockedReason ?? null,
    deletedAt: user.deletedAt ?? null,
    onboardingCompleted: user.onboardingCompleted,
    createdAt: user.createdAt,
    subscriptions: user.subscriptions,
    socialPlatforms: user.socialAccounts.map((s) => s.platform),
    connectedPlatformsCount: user.connectedPlatformsCount ?? user.socialAccounts.length,
    scheduledPostsCount: user.scheduledPostsCount ?? 0,
  };
}

function serializeSubscription(subscription: {
  id: string;
  userId: string;
  planCode: string;
  status: string;
  priceType: string;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date | null;
  createdAt: Date;
  user: { id: string; email: string; isFounder: boolean };
  plan: {
    code: string;
    name: string;
    category: string;
    isJewelry: boolean;
    platformLimit: number | null;
    baseVisualQuota: number | null;
    basePostQuota: number | null;
  };
}) {
  return {
    id: subscription.id,
    userId: subscription.userId,
    userEmail: subscription.user.email,
    userIsFounder: subscription.user.isFounder,
    planCode: subscription.planCode,
    planName: subscription.plan.name,
    planCategory: subscription.plan.category,
    planIsJewelry: subscription.plan.isJewelry,
    platformLimit: subscription.plan.platformLimit,
    baseVisualQuota: subscription.plan.baseVisualQuota,
    basePostQuota: subscription.plan.basePostQuota,
    status: subscription.status,
    priceType: subscription.priceType,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: subscription.canceledAt ?? null,
    createdAt: subscription.createdAt,
  };
}

function serializeStripeSubscription(subscription: StripeSubscriptionWithPeriod) {
  return {
    id: subscription.id,
    status: subscription.status,
    cancel_at_period_end: subscription.cancel_at_period_end,
    current_period_start: subscription.current_period_start ?? null,
    current_period_end: subscription.current_period_end ?? null,
    canceled_at: subscription.canceled_at,
  };
}