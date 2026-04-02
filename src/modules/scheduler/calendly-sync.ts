import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { SchedulerCalendlyAction, syncSchedulerSessionToCalendly } from "./calendly";

export async function performSessionCalendlySync(postId: string, action: SchedulerCalendlyAction) {
  logger.info("Calendly sync start", { postId, action });

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
      admin: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });

  if (!post || !post.user?.email) {
    logger.warn("Calendly sync skipped: missing post or user email", {
      postId,
      action,
      found: Boolean(post),
      scheduleType: post?.scheduleType ?? null,
      hasUserEmail: Boolean(post?.user?.email),
    });
    return;
  }

  if (!env.CALENDLY_API_ENDPOINT) {
    await prisma.post.update({
      where: { id: postId },
      data: {
        calendlySyncStatus: "PENDING",
        calendlySyncError: "Calendly endpoint not configured",
      },
    });
    logger.warn("Calendly sync pending: endpoint not configured", { postId, action });
    return;
  }

  try {
    const synced = await syncSchedulerSessionToCalendly({
      action,
      sessionId: post.id,
      scheduleType: post.scheduleType,
      scheduledAt: post.scheduledFor?.toISOString() ?? new Date().toISOString(),
      durationMinutes: post.scheduleType === "POSTING" ? null : post.sessionDurationMinutes ?? null,
      title: post.scheduleType === "POSTING" ? post.caption ?? null : post.sessionTitle ?? null,
      notes:
        post.scheduleType === "POSTING"
          ? post.shortDescription ?? null
          : post.sessionNotes ?? null,
      status: post.scheduleType === "POSTING" ? post.status : post.sessionStatus ?? "BOOKED",
      user: {
        id: post.user.id,
        email: post.user.email,
        name: post.user.name,
      },
      admin: post.admin
        ? {
          id: post.admin.id,
          email: post.admin.email,
          name: post.admin.name,
        }
        : null,
    });

    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: {
          calendlySyncStatus: "SYNCED",
          calendlyEventUri: synced.eventUri,
          calendlyInviteeUri: synced.inviteeUri,
          calendlySyncError: null,
          calendlyLastSyncedAt: new Date(),
        },
      });

      await tx.postEvent.create({
        data: {
          postId,
          type: "SCHEDULER_CALENDLY_SYNCED",
          message: `Calendly sync succeeded (${action})`,
        },
      });
    });

    logger.info("Calendly sync success", {
      postId,
      action,
      status: "SYNCED",
      eventUri: synced.eventUri,
      inviteeUri: synced.inviteeUri,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: {
          calendlySyncStatus: "FAILED",
          calendlySyncError: message,
          calendlyLastSyncedAt: new Date(),
        },
      });

      await tx.postEvent.create({
        data: {
          postId,
          type: "SCHEDULER_CALENDLY_SYNC_FAILED",
          message,
        },
      });
    });
    logger.error("Scheduler Calendly sync failed", { postId, action, error: message });
    throw error;
  }
}
