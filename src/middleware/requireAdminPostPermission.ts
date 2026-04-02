import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

/**
 * Middleware to check if admin has permission to post on behalf of users
 * This is a granular permission check beyond just being an admin
 */
export async function requireAdminPostPermission(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Must be authenticated and an admin first
  if (!req.user || (req.user.role !== "ADMIN" && req.user.role !== "SUPER_ADMIN")) {
    return res.status(403).json({ error: "Admin access required" });
  }

  // SUPER_ADMIN always has permission
  if (req.user.role === "SUPER_ADMIN") {
    return next();
  }

  // For now, ADMIN role also has permission by default
  // In the future, this can be extended to check specific permissions
  // Example: Check if admin has `admin:post_as_user` permission in a permission table
  return next();
}

/**
 * Check if admin can post to a specific user's account
 * Validates:
 * - User exists and is not blocked/deleted
 * - Admin has permission from the user (if required)
 */
export async function validatePostAsUserPermission(
  adminId: string,
  targetUserId: string
): Promise<{ allowed: boolean; requiresApproval: boolean; error?: string }> {
  try {
    // Check if target user exists and is not blocked/deleted
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        status: true,
        email: true,
      },
    });

    if (!targetUser) {
      return {
        allowed: false,
        requiresApproval: false,
        error: "Target user not found",
      };
    }

    if (targetUser.status === "BLOCKED") {
      return {
        allowed: false,
        requiresApproval: false,
        error: "Cannot post for blocked users",
      };
    }

    if (targetUser.status === "DELETED") {
      return {
        allowed: false,
        requiresApproval: false,
        error: "Cannot post for deleted users",
      };
    }

    // Check user's admin post permission settings
    const permission = await prisma.adminPostPermission.findUnique({
      where: { userId: targetUserId },
    });

    // If no permission record exists, default is requiresApproval=true, canPostDirectly=false
    if (!permission) {
      return {
        allowed: true,
        requiresApproval: true,
        error: undefined,
      };
    }

    if (permission.revokedAt) {
      return {
        allowed: false,
        requiresApproval: false,
        error: "User has revoked admin posting permission",
      };
    }

    return {
      allowed: true,
      requiresApproval: permission.requiresApproval,
      error: undefined,
    };
  } catch (error) {
    logger.error("Error validating post as user permission", { error, adminId, targetUserId });
    return {
      allowed: false,
      requiresApproval: false,
      error: "Failed to validate permissions",
    };
  }
}

/**
 * Grant or update admin post permissions for a user
 */
export async function grantAdminPostPermission(
  adminId: string,
  targetUserId: string,
  canPostDirectly: boolean
): Promise<void> {
  await prisma.adminPostPermission.upsert({
    where: { userId: targetUserId },
    create: {
      userId: targetUserId,
      canPostDirectly,
      requiresApproval: !canPostDirectly,
      grantedByAdminId: adminId,
      grantedAt: new Date(),
    },
    update: {
      canPostDirectly,
      requiresApproval: !canPostDirectly,
      grantedByAdminId: adminId,
      grantedAt: new Date(),
      revokedAt: null,
    },
  });
}

/**
 * Revoke admin post permissions for a user
 */
export async function revokeAdminPostPermission(targetUserId: string): Promise<void> {
  const permission = await prisma.adminPostPermission.findUnique({
    where: { userId: targetUserId },
  });

  if (permission) {
    await prisma.adminPostPermission.update({
      where: { userId: targetUserId },
      data: { revokedAt: new Date() },
    });
  }
}
