import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

export type ActivityType =
  | "POST_CREATED"
  | "POST_PUBLISHED"
  | "POST_DELETED"
  | "POST_SCHEDULED"
  | "SCHEDULE_CREATED"
  | "SCHEDULE_UPDATED"
  | "SCHEDULE_DELETED"
  | "SOCIAL_ACCOUNT_CONNECTED"
  | "SOCIAL_ACCOUNT_DISCONNECTED"
  | "SUBMISSION_CREATED"
  | "SUBMISSION_STATUS_UPDATED"
  | "PASSWORD_RESET"
  | "PASSWORD_CHANGED"
  | "PROFILE_UPDATED"
  | "SETTINGS_CHANGED"
  | "BRAND_UPDATED"
  | "SUBSCRIPTION_CHECKOUT_STARTED"
  | "SUBSCRIPTION_CHANGE_SCHEDULED"
  | "SUBSCRIPTION_CHANGE_CANCELED"
  | "SUBSCRIPTION_CANCEL_SCHEDULED"
  | "SUBSCRIPTION_RESUMED";

interface LogActivityParams {
  userId: string;
  type: ActivityType;
  title: string;
  description?: string;
}

/**
 * Log user activity to RecentActivity table
 * Non-blocking function - errors are logged but not thrown
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    await prisma.recentActivity.create({
      data: {
        userId: params.userId,
        type: params.type,
        title: params.title,
        description: params.description,
      },
    });
  } catch (error) {
    logger.error("Failed to log activity", {
      error,
      userId: params.userId,
      type: params.type,
    });
    // Don't throw - activity logging is non-critical
  }
}
