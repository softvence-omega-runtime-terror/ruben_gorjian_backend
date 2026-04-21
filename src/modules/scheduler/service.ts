import {
  Asset,
  PostStatus,
  PostTargetStatus,
  Prisma,
  ScheduleType,
  SocialPlatform,
  SocialAccount,
  SessionStatus,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { buildStorageUrl } from "../../lib/validators";
import { logger } from "../../lib/logger";
import { getSubscriptionPeriod } from "../../lib/subscription-period";
import { validatePostAsUserPermission } from "../../middleware/requireAdminPostPermission";
import { SchedulerStorageService, validateSchedulerContentType } from "./storage";
import { sendSchedulerEmail } from "./email";
import { enqueueSchedulerEmail } from "../jobs/scheduler-email-queue";
import { enqueuePostPublish } from "../jobs/post-queue";
import {
  Actor,
  SchedulerCreateInput,
  SchedulerCreateSessionInput,
  SchedulerListFilters,
  SchedulerMultipartUploadInput,
  SchedulerPublishStatusInput,
  SchedulerUpdateSessionInput,
  SchedulerUpdateSessionStatusInput,
  SchedulerUpdateInput,
  SchedulerUploadInput,
} from "./interfaces";
import { isAdmin, normalizeDateRange } from "./functions";
import { logActivity } from "../dashboard/activity-logger";

const SCHEDULER_UPLOAD_CONTEXT = "SCHEDULER_POST";

type SchedulerTargetAccount = {
  id: string | null;
  platform: SocialPlatform;
  displayName: string | null;
  externalAccountId: string | null;
  accessToken?: string | null;
  expiresAt: Date | null;
};

function formatHashtags(hashtags?: string[] | null) {
  if (!hashtags) return Prisma.JsonNull;
  const sanitized = hashtags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
  return sanitized.length ? sanitized : Prisma.JsonNull;
}


export class SchedulerService {
  private readonly storage = new SchedulerStorageService();

  private toSchedulerStatus(
    status: PostStatus,
    scheduleType: ScheduleType,
    sessionStatus?: SessionStatus | null
  ): "pending" | "completed" | "failed" {
    if (scheduleType !== "POSTING") {
      if (sessionStatus === "COMPLETED") return "completed";
      if (sessionStatus === "FAILED" || sessionStatus === "CANCELED") return "failed";
      return "pending";
    }
    if (status === "POSTED") return "completed";
    if (status === "FAILED") return "failed";
    return "pending";
  }

  private async resolveTargetUser(actor: Actor, targetUserId?: string) {
    if (!targetUserId || targetUserId === actor.id || !isAdmin(actor)) {
      return actor.id;
    }

    const permission = await validatePostAsUserPermission(actor.id, targetUserId);
    if (!permission.allowed) {
      throw new Error(permission.error || "Not allowed to manage posts for this user");
    }

    return targetUserId;
  }

  private async getOwnedPost(actor: Actor, postId: string) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            status: true,
          },
        },
        admin: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        PostAsset: {
          include: {
            Asset: true,
          },
          orderBy: { order: "asc" },
        },
        targets: {
          include: {
            socialAccount: {
              select: {
                id: true,
                platform: true,
                displayName: true,
                externalAccountId: true,
                expiresAt: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        events: {
          orderBy: { createdAt: "desc" },
          take: 15,
        },
      },
    });

    if (!post) {
      throw new Error("Scheduled post not found");
    }

    if (!isAdmin(actor) && post.userId !== actor.id) {
      throw new Error("You do not have access to this scheduled post");
    }

    if (isAdmin(actor) && post.userId !== actor.id) {
      const permission = await validatePostAsUserPermission(actor.id, post.userId);
      if (!permission.allowed) {
        throw new Error(permission.error || "Not allowed to manage posts for this user");
      }
    }

    return post;
  }

  private async getSchedulingSubscription(userId: string) {
    return prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "TRIALING"] },
      },
      select: {
        id: true,
        userId: true,
        status: true,
        planCode: true,
        addonPlatformQty: true,
        videoAddonEnabled: true,
        videoSessionHours: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        plan: {
          select: {
            code: true,
            platformLimit: true,
            basePostQuota: true,
            postLimitType: true,
            photoSessionEnabled: true,
            videoSessionEnabled: true,
            photoSessionsPerPeriod: true,
            videoSessionsPerPeriod: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  private async assertSchedulingAccess(userId: string) {
    const [user, subscription] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          status: true,
        },
      }),
      this.getSchedulingSubscription(userId),
    ]);

    if (!user) {
      throw new Error("Target user not found");
    }

    if (user.status === "BLOCKED") {
      throw new Error("Blocked users cannot use the scheduler");
    }

    if (user.status === "DELETED") {
      throw new Error("Deleted users cannot use the scheduler");
    }

    if (!subscription?.plan) {
      throw new Error("An active subscription is required to schedule posts");
    }

    return { user, subscription };
  }

  private async validateSocialAccounts(
    userId: string,
    socialAccountIds: string[],
    platformLimit: number | null
  ): Promise<SchedulerTargetAccount[]> {
    const uniqueIds = Array.from(new Set(socialAccountIds));
    if (uniqueIds.length === 0) {
      throw new Error("At least one connected social account is required");
    }

    const socialAccounts = await prisma.socialAccount.findMany({
      where: {
        id: { in: uniqueIds },
        userId,
      },
      select: {
        id: true,
        platform: true,
        displayName: true,
        externalAccountId: true,
        accessToken: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (socialAccounts.length !== uniqueIds.length) {
      throw new Error("Selected target platforms must already be connected by this client");
    }

    if (platformLimit !== null && uniqueIds.length > platformLimit) {
      throw new Error(
        `Selected platform count exceeds the allowed limit for this subscription (${platformLimit})`
      );
    }

    const now = new Date();
    const invalidAccounts = socialAccounts.filter((account) => {
      const isUploadPostConnection = String(account.externalAccountId || "").startsWith("upload-post:");
      if (isUploadPostConnection) {
        return false;
      }
      if (!account.accessToken) {
        return true;
      }
      return Boolean(account.expiresAt && account.expiresAt <= now);
    });

    if (invalidAccounts.length > 0) {
      throw new Error("One connected target social account is disconnected or token-expired");
    }

    return socialAccounts;
  }

  private async getConnectedSocialAccountsForUser(
    userId: string,
    platformLimit: number | null
  ): Promise<SchedulerTargetAccount[]> {
    const socialAccounts = await prisma.socialAccount.findMany({
      where: { userId },
      select: {
        id: true,
        platform: true,
        displayName: true,
        externalAccountId: true,
        accessToken: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (socialAccounts.length === 0) {
      throw new Error("At least one connected social account is required before scheduling");
    }

    if (platformLimit !== null && socialAccounts.length > platformLimit) {
      throw new Error(
        `Connected platform count exceeds the allowed limit for this subscription (${platformLimit})`
      );
    }

    const now = new Date();
    const validAccounts = socialAccounts.filter((account) => {
      const isUploadPostConnection = String(account.externalAccountId || "").startsWith("upload-post:");
      if (isUploadPostConnection) {
        return true;
      }
      if (!account.accessToken) {
        return false;
      }
      return !(account.expiresAt && account.expiresAt <= now);
    });

    if (validAccounts.length === 0) {
      throw new Error("No valid connected social account found. Please reconnect your social account(s)");
    }

    return validAccounts;
  }

  private async validateAssets(userId: string, assetIds: string[]) {
    const uniqueIds = Array.from(new Set(assetIds));
    if (uniqueIds.length === 0) {
      return [];
    }

    const assets = await prisma.asset.findMany({
      where: {
        id: { in: uniqueIds },
        userId,
        status: "READY",
      },
      orderBy: { createdAt: "asc" },
    });

    // TEMPORARY (testing): ignore invalid/non-ready asset references instead of failing request.
    // TODO: Re-enable strict equality check before production rollout.

    const invalidMedia = assets.some((asset) => asset.type !== "IMAGE" && asset.type !== "VIDEO");
    if (invalidMedia) {
      throw new Error("Only image and video assets are supported for scheduled posts");
    }

    return assets;
  }

  private validateMediaRules(accounts: SchedulerTargetAccount[], assets: Asset[]) {
    if (accounts.length === 0) {
      throw new Error("At least one connected social account is required before scheduling");
    }

    const disconnectedAccounts = accounts.filter((account) => {
      const isUploadPostConnection = String(account.externalAccountId || "").startsWith("upload-post:");
      if (isUploadPostConnection) {
        return false;
      }
      if (!account.id || !account.accessToken) {
        return true;
      }
      return Boolean(account.expiresAt && account.expiresAt <= new Date());
    });

    if (disconnectedAccounts.length > 0) {
      throw new Error("Please connect valid social account(s) before scheduling posts");
    }

    const videoCount = assets.filter((asset) => asset.type === "VIDEO").length;
    if (videoCount > 1) {
      throw new Error("Only one video is allowed per scheduled post");
    }

    if (assets.length > 0 && !env.STORAGE_BASE_URL) {
      throw new Error("STORAGE_BASE_URL must be configured before scheduling media posts");
    }
  }

  private async enforceQuota(
    userId: string,
    subscription: Awaited<ReturnType<SchedulerService["getSchedulingSubscription"]>>,
    excludePostId?: string
  ) {
    if (!subscription?.plan?.basePostQuota || subscription.plan.postLimitType !== "HARD") {
      return;
    }

    const { periodStart, periodEnd } = getSubscriptionPeriod(subscription);
    const activeStatuses: PostStatus[] = ["SCHEDULED", "PUBLISHING", "POSTED"];

    const scheduledCount = await prisma.post.count({
      where: {
        userId,
        scheduleType: "POSTING",
        status: { in: activeStatuses },
        scheduledFor: {
          gte: periodStart,
          lte: periodEnd,
        },
        ...(excludePostId ? { id: { not: excludePostId } } : {}),
      },
    });

    if (scheduledCount >= subscription.plan.basePostQuota) {
      throw new Error(
        `You have reached the scheduled post limit for this billing period (${subscription.plan.basePostQuota})`
      );
    }
  }

  private assertSessionEntitlement(
    subscription: Awaited<ReturnType<SchedulerService["getSchedulingSubscription"]>>,
    scheduleType: Exclude<ScheduleType, "POSTING">
  ) {
    if (!subscription?.plan) {
      throw new Error("An active subscription is required to schedule sessions");
    }

    // Photo sessions are open to all active subscribers in this phase.
    if (scheduleType !== "VIDEO_SESSION") {
      return;
    }

    if (!subscription.plan.videoSessionEnabled) {
      throw new Error("Video session booking is not available for your current plan");
    }
  }

  private getUtcDayRange(date: Date) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start, end };
  }

  private async assertScheduleDayAvailability(scheduledAt: Date, excludePostId?: string) {
    const { start, end } = this.getUtcDayRange(scheduledAt);

    const existingCount = await prisma.post.count({
      where: {
        scheduledFor: {
          gte: start,
          lt: end,
        },
        ...(excludePostId ? { id: { not: excludePostId } } : {}),
        OR: [
          {
            scheduleType: "POSTING",
            status: { in: ["SCHEDULED", "PUBLISHING", "POSTED"] },
          },
          {
            scheduleType: { in: ["PHOTO_SESSION", "VIDEO_SESSION"] },
            sessionStatus: { in: ["BOOKED", "COMPLETED"] },
          },
        ],
      },
    });

    if (existingCount > 0) {
      throw new Error("This date is already booked. Only one schedule is allowed per day");
    }
  }

  private getVideoHoursNeededFromMinutes(sessionDurationMinutes: number) {
    if (sessionDurationMinutes <= 0) {
      return 0;
    }
    return Math.ceil(sessionDurationMinutes / 60);
  }

  private assertVideoAddonHours(
    subscription: Awaited<ReturnType<SchedulerService["getSchedulingSubscription"]>>,
    sessionDurationMinutes: number
  ) {
    if (!subscription) {
      throw new Error("An active subscription is required to schedule sessions");
    }

    if (!subscription.videoAddonEnabled) {
      throw new Error("Video session add-on is not enabled for this subscription");
    }

    const requiredHours = this.getVideoHoursNeededFromMinutes(sessionDurationMinutes);
    if (requiredHours <= 0) {
      throw new Error("sessionDurationMinutes must be greater than 0 for video sessions");
    }

    if ((subscription.videoSessionHours ?? 0) < requiredHours) {
      throw new Error(
        `Video session duration exceeds purchased hours. Required: ${requiredHours}h, Available: ${subscription.videoSessionHours}h`
      );
    }
  }

  private async enforceSessionQuota(
    userId: string,
    scheduleType: Exclude<ScheduleType, "POSTING">,
    subscription: Awaited<ReturnType<SchedulerService["getSchedulingSubscription"]>>,
    excludePostId?: string
  ) {
    if (!subscription?.plan) {
      throw new Error("An active subscription is required to schedule sessions");
    }

    // Photo sessions have no quota restrictions in this phase.
    if (scheduleType !== "VIDEO_SESSION") {
      return;
    }

    const quota = subscription.plan.videoSessionsPerPeriod;

    if (!quota || quota <= 0) {
      throw new Error("No remaining video sessions available in your plan");
    }

    const { periodStart, periodEnd } = getSubscriptionPeriod(subscription);
    const count = await prisma.post.count({
      where: {
        userId,
        scheduleType: "VIDEO_SESSION",
        sessionStatus: { in: ["BOOKED", "COMPLETED"] },
        scheduledFor: {
          gte: periodStart,
          lte: periodEnd,
        },
        ...(excludePostId ? { id: { not: excludePostId } } : {}),
      },
    });

    if (count >= quota) {
      throw new Error(`You have reached your video session limit for this billing period (${quota})`);
    }
  }

  private formatPostResponse(
    post: Awaited<ReturnType<SchedulerService["getOwnedPost"]>>,
    actor: Actor
  ) {
    const ownerSummary = isAdmin(actor)
      ? {
        id: post.user.id,
        email: post.user.email,
        name: post.user.name,
      }
      : undefined;

    const media = post.PostAsset.map((entry) => ({
      id: entry.Asset.id,
      storageKey: entry.Asset.storageKey,
      url: env.STORAGE_BASE_URL
        ? buildStorageUrl(env.STORAGE_BASE_URL, entry.Asset.storageKey)
        : null,
      mimeType: entry.Asset.contentType,
      mediaType: entry.Asset.type,
      source: entry.Asset.source,
      uploadContext: entry.Asset.uploadContext,
      createdAt: entry.Asset.createdAt,
    }));

    const failureReason =
      post.scheduleType === "POSTING"
        ? post.targets.find((target) => target.errorMessage)?.errorMessage ??
        (post.status === "FAILED" ? "One or more publish targets failed" : null)
        : post.sessionFailureReason;

    return {
      id: post.id,
      scheduleType: post.scheduleType,
      caption: post.caption,
      captionPreview: post.caption ? post.caption.slice(0, 140) : null,
      hashtags: Array.isArray(post.hashtags) ? (post.hashtags as string[]) : [],
      cta: post.cta,
      shortDescription: post.shortDescription,
      scheduledAt: post.scheduledFor,
      timezone: null,
      status: post.status,
      schedulerStatus: this.toSchedulerStatus(post.status, post.scheduleType, post.sessionStatus),
      session:
        post.scheduleType === "POSTING"
          ? null
          : {
            title: post.sessionTitle,
            notes: post.sessionNotes,
            durationMinutes: post.sessionDurationMinutes,
            status: post.sessionStatus,
            failureReason: post.sessionFailureReason,
          },
      failureReason,
      selectedPlatforms: post.targets.map((target) => target.platform),
      targets: post.targets.map((target) => ({
        id: target.id,
        platform: target.platform,
        status: target.status,
        scheduledAt: target.scheduledFor,
        publishedAt: target.publishedAt,
        failureReason: target.errorMessage,
        socialAccount: target.socialAccount
          ? {
            id: target.socialAccount.id,
            platform: target.socialAccount.platform,
            displayName: target.socialAccount.displayName,
            externalAccountId: target.socialAccount.externalAccountId,
            expiresAt: target.socialAccount.expiresAt,
          }
          : null,
      })),
      media,
      assets: media.map((item) => item.url).filter((url): url is string => Boolean(url)),
      owner: ownerSummary,
      initiatedBy: post.initiatedBy,
      admin: post.admin,
      adminReason: post.adminReason,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      events: post.events.map((event) => ({
        type: event.type,
        message: event.message,
        createdAt: event.createdAt,
      })),
    };
  }

  private async createAdminNotification(
    targetUserId: string,
    message: string,
    payload: Record<string, unknown>
  ) {
    await prisma.notification.create({
      data: {
        userId: targetUserId,
        type: "ADMIN_POST_CREATED",
        title: "Scheduler updated by admin",
        message,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async enqueueScheduledPostPublish(postId: string, scheduledAt: Date | null | undefined) {
    if (!scheduledAt) {
      logger.info("Post publish enqueue skipped: no scheduledAt", { postId });
      return;
    }

    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    const enqueued = await enqueuePostPublish(postId, {
      delay,
    });

    if (!enqueued) {
      logger.warn("Post publish enqueue skipped (queue unavailable)", { postId });
      return;
    }

    logger.info("Post publish enqueued", {
      postId,
      delayMs: delay,
      scheduledAt: scheduledAt.toISOString(),
    });
  }

  private async listAdminEmails() {
    const admins = await prisma.user.findMany({
      where: {
        role: { in: ["ADMIN", "SUPER_ADMIN"] },
        status: "ACTIVE",
      },
      select: {
        email: true,
      },
    });

    const emails = admins
      .map((admin) => admin.email?.trim().toLowerCase())
      .filter((email): email is string => Boolean(email));

    if (env.ADMIN_EMAIL) {
      emails.push(env.ADMIN_EMAIL.trim().toLowerCase());
    }

    return Array.from(new Set(emails));
  }

  private async createSessionInAppNotifications(
    postId: string,
    action: "booked" | "rescheduled" | "completed" | "failed" | "canceled"
  ) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!post || post.scheduleType === "POSTING") {
      return;
    }

    const sessionLabel = post.scheduleType === "PHOTO_SESSION" ? "photo session" : "video session";
    const title = "Scheduler Session Update";
    const message = `Your ${sessionLabel} has been ${action}.`;
    const payload = {
      postId: post.id,
      scheduleType: post.scheduleType,
      action,
      scheduledAt: post.scheduledFor?.toISOString() ?? null,
      sessionStatus: post.sessionStatus,
    };

    await prisma.notification.create({
      data: {
        userId: post.userId,
        type: "ADMIN_POST_CREATED",
        title,
        message,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    const admins = await prisma.user.findMany({
      where: {
        role: { in: ["ADMIN", "SUPER_ADMIN"] },
        status: "ACTIVE",
      },
      select: {
        id: true,
      },
    });

    if (!admins.length) {
      return;
    }

    await prisma.notification.createMany({
      data: admins.map((admin) => ({
        userId: admin.id,
        type: "ADMIN_POST_CREATED",
        title,
        message: `${post.user.name || post.user.email}'s ${sessionLabel} has been ${action}.`,
        payload: payload as Prisma.InputJsonValue,
      })),
    });
  }

  private async sendSessionLifecycleEmails(
    postId: string,
    action:
      | "booked"
      | "rescheduled"
      | "status_completed"
      | "status_failed"
      | "status_canceled"
  ) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!post || post.scheduleType === "POSTING" || !post.user?.email) {
      return;
    }

    const sessionLabel = post.scheduleType === "PHOTO_SESSION" ? "Photo Session" : "Video Session";
    const when = post.scheduledFor ? post.scheduledFor.toISOString() : "TBD";

    const subjectMap: Record<typeof action, string> = {
      booked: `${sessionLabel} booked`,
      rescheduled: `${sessionLabel} rescheduled`,
      status_completed: `${sessionLabel} completed`,
      status_failed: `${sessionLabel} failed`,
      status_canceled: `${sessionLabel} canceled`,
    };

    const userBody =
      `Hello ${post.user.name || "there"},\n\n` +
      `Your ${sessionLabel.toLowerCase()} has been ${action.replace("status_", "").replace("_", " ")}.\n` +
      `Session ID: ${post.id}\n` +
      `Schedule: ${when}\n` +
      `Duration (minutes): ${post.sessionDurationMinutes ?? "N/A"}\n` +
      `${post.sessionFailureReason ? `Failure reason: ${post.sessionFailureReason}\n` : ""}` +
      `\nRegards,\nTalexia`;

    const adminBody =
      `Scheduler session update\n\n` +
      `Action: ${action}\n` +
      `Session: ${sessionLabel}\n` +
      `Session ID: ${post.id}\n` +
      `User: ${post.user.email}\n` +
      `Schedule: ${when}\n` +
      `Duration (minutes): ${post.sessionDurationMinutes ?? "N/A"}\n` +
      `${post.sessionFailureReason ? `Failure reason: ${post.sessionFailureReason}\n` : ""}`;

    const userEmailPayload = {
      to: post.user.email,
      subject: subjectMap[action],
      body: userBody,
      context: "scheduler-session-lifecycle-user",
      postId: post.id,
      action,
    };
    const userEnqueued = await enqueueSchedulerEmail(userEmailPayload);
    if (!userEnqueued) {
      await sendSchedulerEmail(userEmailPayload);
    }

    const adminEmails = await this.listAdminEmails();
    await Promise.all(
      adminEmails.map(async (email) => {
        const payload = {
          to: email,
          subject: `[Admin] ${subjectMap[action]}`,
          body: adminBody,
          context: "scheduler-session-lifecycle-admin",
          postId: post.id,
          action,
        };
        const enqueued = await enqueueSchedulerEmail(payload);
        if (!enqueued) {
          await sendSchedulerEmail(payload);
        }
      })
    );
  }

  async createMediaUploads(actor: Actor, data: SchedulerUploadInput) {
    const userId = await this.resolveTargetUser(actor, data.userId);
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });

    if (!targetUser) {
      throw new Error("Target user not found");
    }

    if (targetUser.status !== "ACTIVE") {
      throw new Error("Media uploads are only allowed for active users");
    }

    const uploads = await Promise.all(
      data.files.map(async (file) => {
        if (!validateSchedulerContentType(file.contentType)) {
          throw new Error(`Unsupported media type: ${file.contentType}`);
        }

        const signed = await this.storage.createSignedUpload({
          userId,
          fileName: file.fileName,
          contentType: file.contentType,
          fileSize: file.fileSize,
        });

        const asset = await prisma.asset.create({
          data: {
            userId,
            type: signed.mediaType,
            kind: "ORIGINAL",
            storageKey: signed.storageKey,
            contentType: file.contentType,
            source: isAdmin(actor) && userId !== actor.id ? "ADMIN_UPLOAD" : "USER_UPLOAD",
            uploadedByAdminId: isAdmin(actor) && userId !== actor.id ? actor.id : null,
            uploadContext: SCHEDULER_UPLOAD_CONTEXT,
            status: "UPLOADING",
          },
        });

        return {
          id: asset.id,
          storageKey: asset.storageKey,
          uploadUrl: signed.uploadUrl,
          previewUrl: signed.previewUrl,
          mimeType: file.contentType,
          mediaType: signed.mediaType,
          originalFileName: file.fileName,
          status: asset.status,
        };
      })
    );

    return { userId, media: uploads };
  }

  async uploadMediaFiles(actor: Actor, data: SchedulerMultipartUploadInput) {
    const userId = await this.resolveTargetUser(actor, data.userId);
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });

    if (!targetUser) {
      throw new Error("Target user not found");
    }

    if (targetUser.status !== "ACTIVE") {
      throw new Error("Media uploads are only allowed for active users");
    }

    if (!data.files.length) {
      throw new Error("At least one file is required");
    }

    const assets = [];
    for (const file of data.files) {
      if (!validateSchedulerContentType(file.mimetype)) {
        throw new Error(`Unsupported media type: ${file.mimetype}`);
      }

      const storageKey = this.storage.buildStorageKey(userId, file.originalname);
      await this.storage.uploadBuffer({
        storageKey,
        contentType: file.mimetype,
        body: file.buffer,
      });

      const mediaType = this.storage.inferMediaType(file.originalname, file.mimetype);
      const asset = await prisma.asset.create({
        data: {
          userId,
          type: mediaType,
          kind: "ORIGINAL",
          storageKey,
          contentType: file.mimetype,
          source: isAdmin(actor) && userId !== actor.id ? "ADMIN_UPLOAD" : "USER_UPLOAD",
          uploadedByAdminId: isAdmin(actor) && userId !== actor.id ? actor.id : null,
          uploadContext: SCHEDULER_UPLOAD_CONTEXT,
          status: "READY",
        },
      });

      assets.push({
        id: asset.id,
        storageKey: asset.storageKey,
        previewUrl: this.storage.buildPreviewUrl(asset.storageKey),
        mimeType: asset.contentType,
        mediaType: asset.type,
        originalFileName: file.originalname,
        size: file.size,
        status: asset.status,
      });
    }

    return { userId, media: assets };
  }

  async finalizeMediaUploads(actor: Actor, input: { userId?: string; assetIds: string[] }) {
    const userId = await this.resolveTargetUser(actor, input.userId);
    const uniqueAssetIds = Array.from(new Set(input.assetIds));
    const assets = await prisma.asset.findMany({
      where: {
        id: { in: uniqueAssetIds },
        userId,
        uploadContext: SCHEDULER_UPLOAD_CONTEXT,
      },
    });

    if (assets.length !== uniqueAssetIds.length) {
      throw new Error("One or more scheduler media records were not found");
    }

    const finalized = await Promise.all(
      assets.map((asset) =>
        prisma.asset.update({
          where: { id: asset.id },
          data: {
            status: "READY",
          },
        })
      )
    );

    return {
      userId,
      media: finalized.map((asset) => ({
        id: asset.id,
        storageKey: asset.storageKey,
        previewUrl: this.storage.buildPreviewUrl(asset.storageKey),
        mimeType: asset.contentType,
        mediaType: asset.type,
        status: asset.status,
      })),
    };
  }

  async createScheduledPost(actor: Actor, input: SchedulerCreateInput) {
    const userId = await this.resolveTargetUser(actor, input.userId);

    if (input.scheduledAt <= new Date()) {
      throw new Error("Scheduled time must be in the future");
    }

    const { subscription } = await this.assertSchedulingAccess(userId);
    await this.assertScheduleDayAvailability(input.scheduledAt);
    await this.enforceQuota(userId, subscription);

    const platformLimit =
      subscription.plan.platformLimit !== null && subscription.plan.platformLimit !== undefined
        ? subscription.plan.platformLimit + (subscription.addonPlatformQty ?? 0)
        : null;

    const socialAccounts =
      input.socialAccountIds && input.socialAccountIds.length > 0
        ? await this.validateSocialAccounts(userId, input.socialAccountIds, platformLimit)
        : await this.getConnectedSocialAccountsForUser(userId, platformLimit);
    const assets = await this.validateAssets(userId, input.uploadedAssetIds ?? []);
    this.validateMediaRules(socialAccounts, assets);

    const postId = await prisma.$transaction(async (tx) => {
      const post = await tx.post.create({
        data: {
          userId,
          scheduleType: "POSTING",
          sessionStatus: null,
          sessionTitle: null,
          sessionNotes: null,
          sessionDurationMinutes: null,
          sessionFailureReason: null,
          caption: input.caption,
          hashtags: formatHashtags(input.hashtags),
          cta: input.cta ?? null,
          shortDescription: input.shortDescription ?? null,
          scheduledFor: input.scheduledAt,
          status: "SCHEDULED",
          initiatedBy: isAdmin(actor) && userId !== actor.id ? "ADMIN" : "USER",
          adminId: isAdmin(actor) && userId !== actor.id ? actor.id : null,
          adminReason: isAdmin(actor) && userId !== actor.id ? input.adminReason ?? null : null,
          assetId: assets[0]?.id ?? null,
        },
      });

      if (assets.length > 0) {
        await tx.postAsset.createMany({
          data: assets.map((asset, index) => ({
            postId: post.id,
            assetId: asset.id,
            order: index,
          })),
        });
      }

      await tx.postTarget.createMany({
        data: socialAccounts.map((account) => ({
          postId: post.id,
          socialAccountId: account.id ?? null,
          platform: account.platform,
          status: PostTargetStatus.SCHEDULED,
          scheduledFor: input.scheduledAt,
        })),
      });

      await tx.postEvent.create({
        data: {
          postId: post.id,
          type: "SCHEDULER_CREATED",
          message:
            isAdmin(actor) && userId !== actor.id
              ? `Scheduled by admin ${actor.id} for ${input.scheduledAt.toISOString()}`
              : `Scheduled by user for ${input.scheduledAt.toISOString()}`,
        },
      });

      return post.id;
    });

    if (isAdmin(actor) && userId !== actor.id) {
      await this.createAdminNotification(
        userId,
        `An admin scheduled a post for ${input.scheduledAt.toLocaleString()}.`,
        { postId, scheduledAt: input.scheduledAt.toISOString() }
      );
    }

    await Promise.allSettled([
      this.enqueueScheduledPostPublish(postId, input.scheduledAt),
    ]);

    logActivity({
      userId,
      type: "SCHEDULE_CREATED",
      title: "Schedule Created",
      description: `Scheduled for ${input.scheduledAt.toISOString()}`,
    }).catch(() => { });

    return this.getScheduledPost(actor, postId);
  }

  async updateScheduledPost(actor: Actor, postId: string, input: SchedulerUpdateInput) {
    const existingPost = await this.getOwnedPost(actor, postId);
    if (existingPost.scheduleType !== "POSTING") {
      throw new Error("Use session endpoints to update session bookings");
    }

    if (existingPost.status === "POSTED") {
      throw new Error("Posted scheduled posts cannot be edited");
    }

    const targetUserId = await this.resolveTargetUser(actor, input.userId ?? existingPost.userId);
    if (targetUserId !== existingPost.userId && !isAdmin(actor)) {
      throw new Error("You cannot reassign scheduled posts");
    }

    const { subscription } = await this.assertSchedulingAccess(existingPost.userId);
    const nextScheduledAt = input.scheduledAt ?? existingPost.scheduledFor;

    if (!nextScheduledAt) {
      throw new Error("Scheduled time is required");
    }
    if (nextScheduledAt <= new Date()) {
      throw new Error("Scheduled time must be in the future");
    }
    await this.assertScheduleDayAvailability(nextScheduledAt, postId);

    await this.enforceQuota(existingPost.userId, subscription, existingPost.id);

    const platformLimit =
      subscription.plan.platformLimit !== null && subscription.plan.platformLimit !== undefined
        ? subscription.plan.platformLimit + (subscription.addonPlatformQty ?? 0)
        : null;

    const nextSocialAccountIds = input.socialAccountIds;
    const nextAssetIds = existingPost.PostAsset.map((entry) => entry.Asset.id);

    const socialAccounts =
      nextSocialAccountIds && nextSocialAccountIds.length > 0
        ? await this.validateSocialAccounts(existingPost.userId, nextSocialAccountIds, platformLimit)
        : await this.getConnectedSocialAccountsForUser(existingPost.userId, platformLimit);
    const assets = await this.validateAssets(existingPost.userId, nextAssetIds);
    this.validateMediaRules(socialAccounts, assets);

    const previousAssetIds = existingPost.PostAsset.map((entry) => entry.Asset.id);
    const removedAssetIds = previousAssetIds.filter((assetId) => !nextAssetIds.includes(assetId));

    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: {
          caption: input.caption ?? existingPost.caption,
          hashtags: input.hashtags ? formatHashtags(input.hashtags) : undefined,
          cta: input.cta !== undefined ? input.cta : existingPost.cta,
          shortDescription:
            input.shortDescription !== undefined
              ? input.shortDescription
              : existingPost.shortDescription,
          scheduledFor: nextScheduledAt,
          status: "SCHEDULED",
          assetId: assets[0]?.id ?? null,
          ...(isAdmin(actor) && existingPost.userId !== actor.id && input.adminReason !== undefined
            ? { adminReason: input.adminReason }
            : {}),
        },
      });

      await tx.postAsset.deleteMany({
        where: { postId },
      });

      if (assets.length > 0) {
        await tx.postAsset.createMany({
          data: assets.map((asset, index) => ({
            postId,
            assetId: asset.id,
            order: index,
          })),
        });
      }

      await tx.postTarget.deleteMany({
        where: { postId },
      });

      await tx.postTarget.createMany({
        data: socialAccounts.map((account) => ({
          postId,
          socialAccountId: account.id ?? null,
          platform: account.platform,
          status: PostTargetStatus.SCHEDULED,
          scheduledFor: nextScheduledAt,
        })),
      });

      await tx.postEvent.create({
        data: {
          postId,
          type: "SCHEDULER_UPDATED",
          message:
            isAdmin(actor) && existingPost.userId !== actor.id
              ? `Updated by admin ${actor.id}`
              : "Updated by owner",
        },
      });
    });

    await this.cleanupOrphanedSchedulerAssets(removedAssetIds, postId);

    if (isAdmin(actor) && existingPost.userId !== actor.id) {
      await this.createAdminNotification(
        existingPost.userId,
        `An admin updated a scheduled post for ${nextScheduledAt.toLocaleString()}.`,
        { postId, scheduledAt: nextScheduledAt.toISOString() }
      );
    }

    await Promise.allSettled([
      this.enqueueScheduledPostPublish(postId, nextScheduledAt),
    ]);

    logActivity({
      userId: existingPost.userId,
      type: "SCHEDULE_UPDATED",
      title: "Schedule Updated",
      description: `Rescheduled to ${nextScheduledAt.toISOString()}`,
    }).catch(() => { });

    return this.getScheduledPost(actor, postId);
  }

  async deleteScheduledPost(actor: Actor, postId: string) {
    const existingPost = await this.getOwnedPost(actor, postId);

    if (existingPost.status === "POSTED") {
      throw new Error("Posted scheduled posts cannot be deleted");
    }

    const assetIds = existingPost.PostAsset.map((entry) => entry.Asset.id);

    await prisma.$transaction(async (tx) => {
      await tx.postTarget.deleteMany({ where: { postId } });
      await tx.postAsset.deleteMany({ where: { postId } });
      await tx.postEvent.deleteMany({ where: { postId } });
      await tx.post.delete({ where: { id: postId } });
    });

    await this.cleanupOrphanedSchedulerAssets(assetIds, postId);

    if (isAdmin(actor) && existingPost.userId !== actor.id) {
      await this.createAdminNotification(existingPost.userId, "An admin deleted a scheduled post.", {
        postId,
      });
    }

    logger.info("Scheduled post deleted", {
      postId,
      actorId: actor.id,
      userId: existingPost.userId,
    });

    logActivity({
      userId: existingPost.userId,
      type: "SCHEDULE_DELETED",
      title: "Schedule Deleted",
      description: existingPost.caption ? existingPost.caption.slice(0, 100) : undefined,
    }).catch(() => { });

    return { success: true };
  }

  async getScheduledPost(actor: Actor, postId: string) {
    const post = await this.getOwnedPost(actor, postId);
    return this.formatPostResponse(post, actor);
  }

  async createScheduledSession(
    actor: Actor,
    input: SchedulerCreateSessionInput
  ) {
    const userId = await this.resolveTargetUser(actor, input.userId);
    if (input.scheduledAt <= new Date()) {
      throw new Error("Scheduled time must be in the future");
    }
    await this.assertScheduleDayAvailability(input.scheduledAt);

    const { subscription } = await this.assertSchedulingAccess(userId);
    this.assertSessionEntitlement(subscription, input.scheduleType);
    if (input.scheduleType === "VIDEO_SESSION") {
      this.assertVideoAddonHours(subscription, input.sessionDurationMinutes);
    }
    await this.enforceSessionQuota(userId, input.scheduleType, subscription);

    const postId = await prisma.$transaction(async (tx) => {
      const post = await tx.post.create({
        data: {
          userId,
          scheduleType: input.scheduleType,
          status: "SCHEDULED",
          scheduledFor: input.scheduledAt,
          sessionStatus: "BOOKED",
          sessionTitle: input.sessionTitle ?? null,
          sessionNotes: input.sessionNotes ?? null,
          sessionDurationMinutes: input.sessionDurationMinutes,
          sessionFailureReason: null,
          initiatedBy: isAdmin(actor) && userId !== actor.id ? "ADMIN" : "USER",
          adminId: isAdmin(actor) && userId !== actor.id ? actor.id : null,
          adminReason: isAdmin(actor) && userId !== actor.id ? input.adminReason ?? null : null,
        },
      });

      await tx.postEvent.create({
        data: {
          postId: post.id,
          type: "SCHEDULER_SESSION_CREATED",
          message:
            isAdmin(actor) && userId !== actor.id
              ? `Session booked by admin ${actor.id} for ${input.scheduledAt.toISOString()}`
              : `Session booked by user for ${input.scheduledAt.toISOString()}`,
        },
      });

      return post.id;
    });

    if (isAdmin(actor) && userId !== actor.id) {
      await this.createAdminNotification(
        userId,
        `An admin scheduled your ${input.scheduleType === "PHOTO_SESSION" ? "photo" : "video"} session.`,
        { postId, scheduleType: input.scheduleType, scheduledAt: input.scheduledAt.toISOString() }
      );
    }

    await Promise.allSettled([
      this.createSessionInAppNotifications(postId, "booked"),
      this.sendSessionLifecycleEmails(postId, "booked"),
    ]);
    logger.info("Session lifecycle hooks processed", {
      postId,
      scheduleType: input.scheduleType,
      lifecycleAction: "booked",
    });

    return this.getScheduledPost(actor, postId);
  }

  async updateScheduledSession(
    actor: Actor,
    postId: string,
    input: SchedulerUpdateSessionInput
  ) {
    const existingPost = await this.getOwnedPost(actor, postId);
    if (existingPost.scheduleType === "POSTING") {
      throw new Error("Use posting endpoints to update posting schedules");
    }

    const targetUserId = await this.resolveTargetUser(actor, input.userId ?? existingPost.userId);
    if (targetUserId !== existingPost.userId && !isAdmin(actor)) {
      throw new Error("You cannot reassign scheduled sessions");
    }

    if (existingPost.sessionStatus && existingPost.sessionStatus !== "BOOKED") {
      throw new Error("Only booked sessions can be edited");
    }

    const nextScheduledAt = input.scheduledAt ?? existingPost.scheduledFor;
    if (!nextScheduledAt) {
      throw new Error("Scheduled time is required");
    }
    if (nextScheduledAt <= new Date()) {
      throw new Error("Scheduled time must be in the future");
    }
    await this.assertScheduleDayAvailability(nextScheduledAt, postId);

    const { subscription } = await this.assertSchedulingAccess(existingPost.userId);
    const scheduleType = existingPost.scheduleType as Exclude<ScheduleType, "POSTING">;
    this.assertSessionEntitlement(subscription, scheduleType);
    const nextDurationMinutes =
      input.sessionDurationMinutes !== undefined
        ? input.sessionDurationMinutes
        : existingPost.sessionDurationMinutes ?? 0;
    if (scheduleType === "VIDEO_SESSION") {
      this.assertVideoAddonHours(subscription, nextDurationMinutes);
    }
    await this.enforceSessionQuota(existingPost.userId, scheduleType, subscription, existingPost.id);

    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: {
          scheduledFor: nextScheduledAt,
          sessionTitle: input.sessionTitle !== undefined ? input.sessionTitle : existingPost.sessionTitle,
          sessionNotes: input.sessionNotes !== undefined ? input.sessionNotes : existingPost.sessionNotes,
          sessionDurationMinutes:
            input.sessionDurationMinutes !== undefined
              ? input.sessionDurationMinutes
              : existingPost.sessionDurationMinutes,
          ...(isAdmin(actor) && existingPost.userId !== actor.id && input.adminReason !== undefined
            ? { adminReason: input.adminReason }
            : {}),
          updatedAt: new Date(),
        },
      });

      await tx.postEvent.create({
        data: {
          postId,
          type: "SCHEDULER_SESSION_UPDATED",
          message:
            isAdmin(actor) && existingPost.userId !== actor.id
              ? `Session updated by admin ${actor.id}`
              : "Session updated by owner",
        },
      });
    });

    await Promise.allSettled([
      this.createSessionInAppNotifications(postId, "rescheduled"),
      this.sendSessionLifecycleEmails(postId, "rescheduled"),
    ]);
    logger.info("Session lifecycle hooks processed", {
      postId,
      scheduleType: existingPost.scheduleType,
      lifecycleAction: "rescheduled",
    });

    return this.getScheduledPost(actor, postId);
  }

  async updateScheduledSessionStatus(
    actor: Actor,
    postId: string,
    input: SchedulerUpdateSessionStatusInput
  ) {
    if (!isAdmin(actor)) {
      throw new Error("Only admin or super admin can update session status");
    }

    const existingPost = await this.getOwnedPost(actor, postId);
    if (existingPost.scheduleType === "POSTING") {
      throw new Error("Session status endpoint is only available for photo/video sessions");
    }

    const targetUserId = await this.resolveTargetUser(actor, input.userId ?? existingPost.userId);
    if (targetUserId !== existingPost.userId) {
      throw new Error("You cannot reassign scheduled sessions");
    }

    if (input.status === "failed" && !input.sessionFailureReason?.trim()) {
      throw new Error("sessionFailureReason is required when session status is failed");
    }

    const mappedSessionStatus: SessionStatus =
      input.status === "completed"
        ? "COMPLETED"
        : input.status === "failed"
          ? "FAILED"
          : "CANCELED";
    const mappedPostStatus: PostStatus =
      input.status === "completed"
        ? "POSTED"
        : input.status === "failed"
          ? "FAILED"
          : "SCHEDULED";

    await prisma.$transaction(async (tx) => {
      if (
        existingPost.scheduleType === "VIDEO_SESSION" &&
        input.status === "completed" &&
        existingPost.sessionStatus !== "COMPLETED"
      ) {
        const activeSubscription = await tx.subscription.findFirst({
          where: {
            userId: existingPost.userId,
            status: { in: ["ACTIVE", "TRIALING"] },
          },
          select: {
            id: true,
            videoAddonEnabled: true,
            videoSessionHours: true,
          },
          orderBy: { createdAt: "desc" },
        });

        if (!activeSubscription) {
          throw new Error("Active subscription not found for video session completion");
        }

        if (!activeSubscription.videoAddonEnabled) {
          throw new Error("Video session add-on is not enabled for this subscription");
        }

        const requiredHours = this.getVideoHoursNeededFromMinutes(
          existingPost.sessionDurationMinutes ?? 0
        );
        if (requiredHours <= 0) {
          throw new Error("Invalid video session duration. Cannot deduct purchased hours");
        }

        if ((activeSubscription.videoSessionHours ?? 0) < requiredHours) {
          throw new Error(
            `Insufficient purchased video hours. Required: ${requiredHours}h, Available: ${activeSubscription.videoSessionHours}h`
          );
        }

        await tx.subscription.update({
          where: { id: activeSubscription.id },
          data: {
            videoSessionHours: {
              decrement: requiredHours,
            },
          },
        });
      }

      await tx.post.update({
        where: { id: postId },
        data: {
          status: mappedPostStatus,
          sessionStatus: mappedSessionStatus,
          sessionFailureReason: input.status === "failed" ? input.sessionFailureReason?.trim() ?? null : null,
          adminId: actor.id,
          adminReason: input.adminReason ?? existingPost.adminReason ?? null,
          updatedAt: new Date(),
        },
      });

      await tx.postEvent.create({
        data: {
          postId,
          type: "SCHEDULER_SESSION_STATUS_UPDATED",
          message:
            input.status === "completed"
              ? `Session marked completed by admin ${actor.id}`
              : input.status === "failed"
                ? `Session marked failed by admin ${actor.id}`
                : `Session marked canceled by admin ${actor.id}`,
        },
      });
    });

    const lifecycleAction =
      input.status === "completed"
        ? "completed"
        : input.status === "failed"
          ? "failed"
          : "canceled";

    await Promise.allSettled([
      this.createSessionInAppNotifications(postId, lifecycleAction),
      this.sendSessionLifecycleEmails(
        postId,
        input.status === "completed"
          ? "status_completed"
          : input.status === "failed"
            ? "status_failed"
            : "status_canceled"
      ),
    ]);
    logger.info("Session lifecycle hooks processed", {
      postId,
      scheduleType: existingPost.scheduleType,
      lifecycleAction,
    });

    return this.getScheduledPost(actor, postId);
  }

  async updatePublishStatus(actor: Actor, postId: string, input: SchedulerPublishStatusInput) {
    if (!isAdmin(actor)) {
      throw new Error("Only admin or super admin can update publish status");
    }

    const existingPost = await this.getOwnedPost(actor, postId);
    if (existingPost.scheduleType !== "POSTING") {
      throw new Error("Publish status endpoint is only available for posting schedules");
    }
    const targetUserId = await this.resolveTargetUser(actor, input.userId ?? existingPost.userId);
    if (targetUserId !== existingPost.userId) {
      throw new Error("You cannot reassign scheduled posts");
    }

    const nextPostStatus: PostStatus = input.status === "completed" ? "POSTED" : "FAILED";
    const now = new Date();
    const failureReason =
      input.status === "failed"
        ? input.failureReason?.trim() || "Publish failed"
        : null;
    const adminReason = input.adminReason ?? existingPost.adminReason ?? null;
    const nextTargetStatus = input.status === "completed" ? "POSTED" : "FAILED";

    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: {
          status: nextPostStatus,
          adminId: actor.id,
          adminReason,
          updatedAt: now,
        },
      });

      await tx.postTarget.updateMany({
        where: { postId },
        data: {
          status: nextTargetStatus,
          publishedAt: input.status === "completed" ? now : null,
          errorMessage: failureReason,
          updatedAt: now,
        },
      });

      await tx.postEvent.create({
        data: {
          postId,
          type: "SCHEDULER_PUBLISH_STATUS_UPDATED",
          message:
            input.status === "completed"
              ? `Marked completed by admin ${actor.id}`
              : `Marked failed by admin ${actor.id}${failureReason ? `: ${failureReason}` : ""}`,
        },
      });
    });

    await this.createAdminNotification(
      existingPost.userId,
      input.status === "completed"
        ? "Your scheduled post has been marked as completed."
        : "Your scheduled post has been marked as failed.",
      {
        postId,
        schedulerStatus: input.status === "completed" ? "completed" : "failed",
        failureReason,
      }
    );

    return this.getScheduledPost(actor, postId);
  }

  async listScheduledPosts(actor: Actor, filters: SchedulerListFilters) {
    const range = normalizeDateRange(filters);
    const targetUserId =
      filters.userId && isAdmin(actor)
        ? await this.resolveTargetUser(actor, filters.userId)
        : null;

    const where: Prisma.PostWhereInput = {
      ...(isAdmin(actor)
        ? targetUserId
          ? { userId: targetUserId }
          : {}
        : { userId: actor.id }),
      ...(filters.status?.length ? { status: { in: filters.status } } : {}),
      ...(filters.scheduleType?.length ? { scheduleType: { in: filters.scheduleType } } : {}),
      ...(filters.sessionStatus?.length ? { sessionStatus: { in: filters.sessionStatus } } : {}),
      ...(range.start || range.end
        ? {
          scheduledFor: {
            ...(range.start ? { gte: range.start } : {}),
            ...(range.end ? { lte: range.end } : {}),
          },
        }
        : {}),
      ...(filters.platform?.length
        ? {
          targets: {
            some: {
              platform: { in: filters.platform },
            },
          },
        }
        : {}),
      ...(filters.failure
        ? {
          OR: [
            { status: "FAILED" },
            { targets: { some: { status: "FAILED" } } },
            { targets: { some: { errorMessage: { not: null } } } },
            { sessionStatus: "FAILED" },
            { sessionFailureReason: { not: null } },
          ],
        }
        : {}),
    };

    const totalCount = await prisma.post.count({ where });
    const skip = (filters.page - 1) * filters.pageSize;
    const posts = await prisma.post.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            status: true,
          },
        },
        admin: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        PostAsset: {
          include: {
            Asset: true,
          },
          orderBy: { order: "asc" },
        },
        targets: {
          include: {
            socialAccount: {
              select: {
                id: true,
                platform: true,
                displayName: true,
                externalAccountId: true,
                expiresAt: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        events: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
      skip,
      take: filters.pageSize,
    });

    const totalPages = Math.max(1, Math.ceil(totalCount / filters.pageSize));

    return {
      items: posts.map((post) => this.formatPostResponse(post as Awaited<ReturnType<SchedulerService["getOwnedPost"]>>, actor)),
      filters: {
        view: filters.view,
        date: filters.date?.toISOString() ?? null,
        from: range.start?.toISOString() ?? null,
        to: range.end?.toISOString() ?? null,
        status: filters.status ?? [],
        scheduleType: filters.scheduleType ?? [],
        sessionStatus: filters.sessionStatus ?? [],
        failure: filters.failure ?? false,
        userId: targetUserId,
        platform: filters.platform ?? [],
        page: filters.page,
        pageSize: filters.pageSize,
      },
      meta: {
        count: posts.length,
        totalCount,
        page: filters.page,
        pageSize: filters.pageSize,
        totalPages,
        hasNextPage: filters.page < totalPages,
        hasPreviousPage: filters.page > 1,
      },
    };
  }

  private async cleanupOrphanedSchedulerAssets(assetIds: string[], deletedPostId: string) {
    if (assetIds.length === 0) {
      return;
    }

    for (const assetId of assetIds) {
      const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        include: {
          posts: {
            where: { id: { not: deletedPostId } },
            select: { id: true },
          },
          PostAsset: {
            where: { postId: { not: deletedPostId } },
            select: { id: true },
          },
          contentItems: {
            select: { id: true },
            take: 1,
          },
        },
      });

      if (!asset) {
        continue;
      }

      const isReferencedElsewhere =
        asset.posts.length > 0 || asset.PostAsset.length > 0 || asset.contentItems.length > 0;

      if (isReferencedElsewhere || asset.uploadContext !== SCHEDULER_UPLOAD_CONTEXT) {
        continue;
      }

      try {
        await this.storage.deleteObject(asset.storageKey);
      } catch (error) {
        logger.warn("Failed to delete scheduler media from S3", {
          assetId: asset.id,
          storageKey: asset.storageKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await prisma.asset.delete({
        where: { id: asset.id },
      });
    }
  }
}
