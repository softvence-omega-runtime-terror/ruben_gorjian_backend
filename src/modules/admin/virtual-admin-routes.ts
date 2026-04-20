import express from "express";
import { z } from "zod";
import { Prisma, Role, UserStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { hashPassword } from "../../utils/password";
import { hasAdminRoutePermission, normalizeRouteMethod } from "../../middleware/adminRoutePermission";

const router = express.Router();

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

type PagePermissionKey = (typeof PAGE_PERMISSION_KEYS)[number];

type RoutePermissionInput = {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";
	pathPattern: string;
	description?: string;
	active?: boolean;
};

const pagePermissionSchema = z.enum(PAGE_PERMISSION_KEYS);

const PAGE_ROUTE_PERMISSION_MAP: Record<PagePermissionKey, RoutePermissionInput[]> = {
	OVERVIEW: [
		{ method: "GET", pathPattern: "/api/admin/summary", description: "Admin overview summary" },
		{ method: "GET", pathPattern: "/admin/summary", description: "Admin overview summary (legacy mount)" },
		{ method: "GET", pathPattern: "/api/admin/overview/stats", description: "Admin overview stats" },
		{ method: "GET", pathPattern: "/api/admin/overview/revenue", description: "Admin overview revenue" },
		{ method: "GET", pathPattern: "/api/admin/overview/activity", description: "Admin overview activity" },
		{ method: "GET", pathPattern: "/api/admin/upload-post/health", description: "Upload-Post health (admin alias)" },
		{ method: "GET", pathPattern: "/api/providers/upload-post/health", description: "Upload-Post health" },
		{ method: "GET", pathPattern: "/admin/overview/stats", description: "Admin overview stats (legacy mount)" },
		{ method: "GET", pathPattern: "/admin/overview/revenue", description: "Admin overview revenue (legacy mount)" },
		{ method: "GET", pathPattern: "/admin/overview/activity", description: "Admin overview activity (legacy mount)" },
	],
	USER_MANAGE: [
		{ method: "ALL", pathPattern: "/api/admin/users*", description: "Manage users" },
		{ method: "ALL", pathPattern: "/admin/users*", description: "Manage users (legacy mount)" },
	],
	SUBSCRIPTION_MANAGE: [
		{ method: "GET", pathPattern: "/api/admin/subscriptions", description: "View subscriptions" },
		{ method: "GET", pathPattern: "/admin/subscriptions", description: "View subscriptions (legacy mount)" },
		{ method: "ALL", pathPattern: "/api/admin/enterprise-plan*", description: "Manage enterprise invites" },
		{ method: "ALL", pathPattern: "/admin/enterprise-plan*", description: "Manage enterprise invites (legacy mount)" },
		{ method: "POST", pathPattern: "/api/admin/users/:id/cancel-subscription-schedule", description: "Schedule cancellation" },
		{ method: "POST", pathPattern: "/api/admin/users/:id/cancel-subscription-immediately", description: "Immediate cancellation" },
		{ method: "POST", pathPattern: "/api/admin/users/:id/resume-subscription", description: "Resume subscription" },
		{ method: "POST", pathPattern: "/api/admin/users/:id/refresh-subscription", description: "Refresh subscription" },
		{ method: "GET", pathPattern: "/api/admin/users/:id/invoices", description: "View invoices" },
		{ method: "POST", pathPattern: "/admin/users/:id/cancel-subscription-schedule", description: "Schedule cancellation (legacy mount)" },
		{ method: "POST", pathPattern: "/admin/users/:id/cancel-subscription-immediately", description: "Immediate cancellation (legacy mount)" },
		{ method: "POST", pathPattern: "/admin/users/:id/resume-subscription", description: "Resume subscription (legacy mount)" },
		{ method: "POST", pathPattern: "/admin/users/:id/refresh-subscription", description: "Refresh subscription (legacy mount)" },
		{ method: "GET", pathPattern: "/admin/users/:id/invoices", description: "View invoices (legacy mount)" },
	],
	SCHEDULE_MANAGE: [
		{ method: "GET", pathPattern: "/api/admin/users/:id/scheduled-items", description: "View user scheduled items" },
		{ method: "GET", pathPattern: "/api/admin/calendars", description: "View admin calendar data" },
		{ method: "ALL", pathPattern: "/api/scheduler/sessions*", description: "Manage scheduler sessions" },
		{ method: "ALL", pathPattern: "/api/scheduler/posts*", description: "Manage scheduler posts" },
		{ method: "GET", pathPattern: "/admin/users/:id/scheduled-items", description: "View user scheduled items (legacy mount)" },
		{ method: "GET", pathPattern: "/admin/calendars", description: "View admin calendar data (legacy mount)" },
		{ method: "ALL", pathPattern: "/scheduler/sessions*", description: "Manage scheduler sessions (legacy mount)" },
		{ method: "ALL", pathPattern: "/scheduler/posts*", description: "Manage scheduler posts (legacy mount)" },
	],
	POST_MANAGE: [
		{ method: "ALL", pathPattern: "/api/admin/users/:userId/posts*", description: "Manage admin posts" },
		{ method: "ALL", pathPattern: "/api/admin/:userId/posts/:postId/approve", description: "Approve admin posts" },
		{ method: "ALL", pathPattern: "/api/admin/users/:userId/media*", description: "Manage admin media" },
		{ method: "GET", pathPattern: "/api/admin/users/:userId/connected-platforms", description: "View connected platforms" },
		{ method: "GET", pathPattern: "/api/social-media/platform/get-all-performed-links", description: "Get all performed links" },
		{ method: "ALL", pathPattern: "/admin/users/:userId/posts*", description: "Manage admin posts (legacy mount)" },
		{ method: "ALL", pathPattern: "/admin/:userId/posts/:postId/approve", description: "Approve admin posts (legacy mount)" },
		{ method: "ALL", pathPattern: "/admin/users/:userId/media*", description: "Manage admin media (legacy mount)" },
		{ method: "GET", pathPattern: "/admin/users/:userId/connected-platforms", description: "View connected platforms (legacy mount)" },
		{ method: "GET", pathPattern: "/social-media/platform/get-all-performed-links", description: "Get all performed links (legacy mount)" },
	],
	COUPON_MANAGE: [
		{ method: "ALL", pathPattern: "/api/admin/coupons*", description: "Manage coupons" },
		{ method: "ALL", pathPattern: "/admin/coupons*", description: "Manage coupons (legacy mount)" },
	],
	SUPPORT: [
		{ method: "ALL", pathPattern: "/api/contact/admin/submissions*", description: "Manage support submissions" },
	],
	SUBMISSIONS: [
		{ method: "ALL", pathPattern: "/api/admin/submissions*", description: "Manage visual submissions" },
		{ method: "ALL", pathPattern: "/admin/submissions*", description: "Manage visual submissions (legacy mount)" },
	],
	FAQ: [
		{ method: "ALL", pathPattern: "/api/faq*", description: "Manage FAQs" },
		{ method: "ALL", pathPattern: "/faq*", description: "Manage FAQs (legacy mount)" },
	],
	CASE_STUDIES: [
		{ method: "ALL", pathPattern: "/api/case-studies*", description: "Manage case studies" },
		{ method: "ALL", pathPattern: "/case-studies*", description: "Manage case studies (legacy mount)" },
	],
	VIRTUAL_ADMIN_MANAGE: [
		{ method: "ALL", pathPattern: "/api/admin/virtual-admins*", description: "Manage virtual admins" },
		{ method: "ALL", pathPattern: "/admin/virtual-admins*", description: "Manage virtual admins (legacy mount)" },
	],
	PROFILE: [
		{ method: "GET", pathPattern: "/auth/me", description: "View profile" },
		{ method: "ALL", pathPattern: "/user/settings*", description: "Manage profile settings" },
	],
};

router.use(requireAuth);

router.use((req, res, next) => {
	if (!req.user || req.user.role !== "SUPER_ADMIN") {
		return res.status(403).json({ error: "Super admin privileges are required." });
	}
	return next();
});

router.use(async (req, res, next) => {
	const allowed = await hasAdminRoutePermission(req);
	if (!allowed) {
		return res.status(403).json({
			error: "You do not have permission to access this route",
		});
	}
	return next();
});

const createAdminSchema = z.object({
	name: z.string().min(1).max(120).optional(),
	email: z.string().email(),
	password: z.string().min(8),
	role: z.enum(["ADMIN", "SUPER_ADMIN"]),
	permissions: z.array(pagePermissionSchema).default([]),
});

const updateAdminSchema = z.object({
	name: z.string().min(1).max(120).optional(),
	role: z.enum(["ADMIN", "SUPER_ADMIN"]).optional(),
	replacePermissions: z.array(pagePermissionSchema).optional(),
});

const updateAdminStatusSchema = z.object({
	status: z.enum(["ACTIVE", "BLOCKED", "DELETED"]),
});

const emptyStringToUndefined = (value: unknown) => {
	if (typeof value === "string" && value.trim() === "") {
		return undefined;
	}
	return value;
};

const listAdminQuerySchema = z.object({
	search: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).optional()),
	role: z.preprocess(emptyStringToUndefined, z.enum(["ADMIN", "SUPER_ADMIN"]).optional()),
	status: z.preprocess(emptyStringToUndefined, z.enum(["ACTIVE", "BLOCKED", "DELETED"]).optional()),
	page: z.preprocess(emptyStringToUndefined, z.coerce.number().int().min(1).optional()),
	limit: z.preprocess(emptyStringToUndefined, z.coerce.number().int().min(1).max(100).optional()),
});

function normalizePathPattern(pathPattern: string) {
	const trimmed = pathPattern.trim();
	if (!trimmed) return "/";
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	return withSlash.replace(/\s+/g, "");
}

function expandPagePermissions(pagePermissions: PagePermissionKey[]): RoutePermissionInput[] {
	const expanded = pagePermissions.flatMap((permissionKey) => PAGE_ROUTE_PERMISSION_MAP[permissionKey]);
	const unique = new Map<string, RoutePermissionInput>();

	for (const permission of expanded) {
		const method = normalizeRouteMethod(permission.method);
		const pathPattern = normalizePathPattern(permission.pathPattern);
		const key = `${method}|${pathPattern}`;
		if (!unique.has(key)) {
			unique.set(key, {
				method,
				pathPattern,
				description: permission.description,
				active: permission.active ?? true,
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
		return requiredPermissions.every((permission) =>
			activePermissionKeys.has(`${permission.method}|${permission.pathPattern}`)
		);
	});
}

function toAdminResponse(admin: {
	id: string;
	name: string | null;
	email: string;
	role: Role;
	status: UserStatus;
	createdAt: Date;
	updatedAt: Date;
	adminRoutePermissions: Array<{
		id: string;
		method: string;
		pathPattern: string;
		description: string | null;
		active: boolean;
		grantedByAdminId: string;
		grantedAt: Date;
	}>;
}) {
	return {
		id: admin.id,
		name: admin.name,
		email: admin.email,
		role: admin.role,
		status: admin.status,
		createdAt: admin.createdAt,
		updatedAt: admin.updatedAt,
		permissions: inferPagePermissions(admin.adminRoutePermissions),
	};
}

async function replaceRoutePermissions(params: {
	adminUserId: string;
	grantedByAdminId: string;
	permissions: RoutePermissionInput[];
	tx: Prisma.TransactionClient;
}) {
	await params.tx.adminRoutePermission.deleteMany({
		where: { adminUserId: params.adminUserId },
	});

	if (!params.permissions.length) {
		return;
	}

	await params.tx.adminRoutePermission.createMany({
		data: params.permissions.map((permission) => ({
			adminUserId: params.adminUserId,
			method: normalizeRouteMethod(permission.method),
			pathPattern: normalizePathPattern(permission.pathPattern),
			description: permission.description ?? null,
			active: permission.active ?? true,
			grantedByAdminId: params.grantedByAdminId,
			grantedAt: new Date(),
		})),
	});
}

router.get("/permission-pages", (_req, res) => {
	return res.json({
		items: PAGE_PERMISSION_KEYS.map((key) => ({
			key,
			routes: PAGE_ROUTE_PERMISSION_MAP[key],
		})),
	});
});

router.post("/", async (req, res) => {
	const parsed = createAdminSchema.safeParse(req.body);
	if (!parsed.success) {
		return res.status(400).json({ error: "The submitted payload is invalid.", details: parsed.error.flatten() });
	}

	const { name, email, password, role, permissions } = parsed.data;
	const normalizedEmail = email.toLowerCase().trim();
	const routePermissions = expandPagePermissions(permissions);

	const existing = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
	if (existing) {
		return res.status(409).json({ error: "An account with this email already exists." });
	}

	const passwordHash = await hashPassword(password);

	const created = await prisma.$transaction(async (tx) => {
		const adminUser = await tx.user.create({
			data: {
				name: name ?? null,
				email: normalizedEmail,
				passwordHash,
				role,
				status: "ACTIVE",
				emailVerified: true,
				emailVerifiedAt: new Date(),
			},
			select: {
				id: true,
				name: true,
				email: true,
				role: true,
				status: true,
				createdAt: true,
				updatedAt: true,
			},
		});

		await replaceRoutePermissions({
			adminUserId: adminUser.id,
			grantedByAdminId: req.user!.id,
			permissions: routePermissions,
			tx,
		});

		await tx.auditLog.create({
			data: {
				actorId: req.user!.id,
				actorEmail: req.user!.email,
				action: "CREATE_USER",
				targetUserId: adminUser.id,
				metadata: {
					targetRole: role,
					pagePermissionCount: permissions.length,
					routePermissionCount: routePermissions.length,
					permissionPages: permissions,
					source: "virtual-admin-routes",
				} as Prisma.InputJsonValue,
			},
		});

		const fullAdmin = await tx.user.findUniqueOrThrow({
			where: { id: adminUser.id },
			select: {
				id: true,
				name: true,
				email: true,
				role: true,
				status: true,
				createdAt: true,
				updatedAt: true,
				adminRoutePermissions: {
					select: {
						id: true,
						method: true,
						pathPattern: true,
						description: true,
						active: true,
						grantedByAdminId: true,
						grantedAt: true,
					},
					orderBy: [{ method: "asc" }, { pathPattern: "asc" }],
				},
			},
		});

		return fullAdmin;
	});

	return res.status(201).json({ admin: toAdminResponse(created) });
});


router.get("/", async (req, res) => {
	const parsed = listAdminQuerySchema.safeParse(req.query);
	if (!parsed.success) {
		return res.status(400).json({ error: "The supplied query parameters are invalid.", details: parsed.error.flatten() });
	}

	const { search, role, status } = parsed.data;
	const page = parsed.data.page ?? 1;
	const limit = parsed.data.limit ?? 20;
	const where: Prisma.UserWhereInput = {
		role: { in: ["ADMIN", "SUPER_ADMIN"] },
		...(role ? { role } : {}),
		...(status ? { status } : {}),
		...(search
			? {
				OR: [
					{ name: { contains: search, mode: "insensitive" } },
					{ email: { contains: search, mode: "insensitive" } },
				],
			}
			: {}),
	};

	const [total, admins] = await Promise.all([
		prisma.user.count({ where }),
		prisma.user.findMany({
			where,
			select: {
				id: true,
				name: true,
				email: true,
				role: true,
				status: true,
				createdAt: true,
				updatedAt: true,
				adminRoutePermissions: {
					select: {
						id: true,
						method: true,
						pathPattern: true,
						description: true,
						active: true,
						grantedByAdminId: true,
						grantedAt: true,
					},
					orderBy: [{ method: "asc" }, { pathPattern: "asc" }],
				},
			},
			orderBy: { createdAt: "desc" },
			skip: (page - 1) * limit,
			take: limit,
		}),
	]);

	return res.json({
		items: admins.map(toAdminResponse),
		total,
		page,
		limit,
		totalPages: Math.max(1, Math.ceil(total / limit)),
	});
});

router.get("/:id", async (req, res) => {
	const admin = await prisma.user.findFirst({
		where: {
			id: req.params.id,
			role: { in: ["ADMIN", "SUPER_ADMIN"] },
		},
		select: {
			id: true,
			name: true,
			email: true,
			role: true,
			status: true,
			createdAt: true,
			updatedAt: true,
			adminRoutePermissions: {
				select: {
					id: true,
					method: true,
					pathPattern: true,
					description: true,
					active: true,
					grantedByAdminId: true,
					grantedAt: true,
				},
				orderBy: [{ method: "asc" }, { pathPattern: "asc" }],
			},
		},
	});

	if (!admin) {
		return res.status(404).json({ error: "The requested admin account was not found." });
	}

	return res.json({ admin: toAdminResponse(admin) });
});

router.patch("/:id/status", async (req, res) => {
	const parsed = updateAdminStatusSchema.safeParse(req.body);
	if (!parsed.success) {
		return res.status(400).json({ error: "The submitted payload is invalid.", details: parsed.error.flatten() });
	}

	const adminId = req.params.id;
	const existing = await prisma.user.findFirst({
		where: {
			id: adminId,
			role: { in: ["ADMIN", "SUPER_ADMIN"] },
		},
		select: { id: true, status: true },
	});

	if (!existing) {
		return res.status(404).json({ error: "The requested admin account was not found." });
	}

	const updated = await prisma.$transaction(async (tx) => {
		await tx.user.update({
			where: { id: adminId },
			data: { status: parsed.data.status },
		});

		await tx.auditLog.create({
			data: {
				actorId: req.user!.id,
				actorEmail: req.user!.email,
				action: parsed.data.status === "BLOCKED" ? "BLOCK_USER" : parsed.data.status === "ACTIVE" ? "UNBLOCK_USER" : "DELETE_USER",
				targetUserId: adminId,
				metadata: {
					previousStatus: existing.status,
					nextStatus: parsed.data.status,
					source: "virtual-admin-routes",
				} as Prisma.InputJsonValue,
			},
		});

		return tx.user.findUniqueOrThrow({
			where: { id: adminId },
			select: {
				id: true,
				name: true,
				email: true,
				role: true,
				status: true,
				createdAt: true,
				updatedAt: true,
				adminRoutePermissions: {
					select: {
						id: true,
						method: true,
						pathPattern: true,
						description: true,
						active: true,
						grantedByAdminId: true,
						grantedAt: true,
					},
					orderBy: [{ method: "asc" }, { pathPattern: "asc" }],
				},
			},
		});
	});

	return res.json({ admin: toAdminResponse(updated) });
});

router.patch("/:id", async (req, res) => {
	const parsed = updateAdminSchema.safeParse(req.body);
	if (!parsed.success) {
		return res.status(400).json({ error: "The submitted payload is invalid.", details: parsed.error.flatten() });
	}

	const adminId = req.params.id;
	const payload = parsed.data;
	const routePermissions = payload.replacePermissions
		? expandPagePermissions(payload.replacePermissions)
		: undefined;

	const existing = await prisma.user.findFirst({
		where: {
			id: adminId,
			role: { in: ["ADMIN", "SUPER_ADMIN"] },
		},
		select: { id: true, role: true },
	});

	if (!existing) {
		return res.status(404).json({ error: "The requested admin account was not found." });
	}

	const updated = await prisma.$transaction(async (tx) => {
		await tx.user.update({
			where: { id: adminId },
			data: {
				...(payload.name !== undefined ? { name: payload.name } : {}),
				...(payload.role !== undefined ? { role: payload.role } : {}),
			},
		});

		if (payload.replacePermissions) {
			await replaceRoutePermissions({
				adminUserId: adminId,
				grantedByAdminId: req.user!.id,
				permissions: routePermissions ?? [],
				tx,
			});
		}

		await tx.auditLog.create({
			data: {
				actorId: req.user!.id,
				actorEmail: req.user!.email,
				action: "UPDATE_USER",
				targetUserId: adminId,
				metadata: {
					updatedRole: payload.role,
					updatedName: payload.name,
					permissionsReplaced: payload.replacePermissions !== undefined,
					pagePermissionCount: payload.replacePermissions?.length ?? null,
					routePermissionCount: routePermissions?.length ?? null,
					permissionPages: payload.replacePermissions ?? null,
					source: "virtual-admin-routes",
				} as Prisma.InputJsonValue,
			},
		});

		return tx.user.findUniqueOrThrow({
			where: { id: adminId },
			select: {
				id: true,
				name: true,
				email: true,
				role: true,
				status: true,
				createdAt: true,
				updatedAt: true,
				adminRoutePermissions: {
					select: {
						id: true,
						method: true,
						pathPattern: true,
						description: true,
						active: true,
						grantedByAdminId: true,
						grantedAt: true,
					},
					orderBy: [{ method: "asc" }, { pathPattern: "asc" }],
				},
			},
		});
	});

	return res.json({ admin: toAdminResponse(updated) });
});

router.delete("/:id", async (req, res) => {
	const adminId = req.params.id;

	if (adminId === req.user!.id) {
		return res.status(400).json({ error: "You cannot delete your own account." });
	}

	const existing = await prisma.user.findFirst({
		where: {
			id: adminId,
			role: { in: ["ADMIN", "SUPER_ADMIN"] },
		},
		select: { id: true },
	});

	if (!existing) {
		return res.status(404).json({ error: "The requested admin account was not found." });
	}

	await prisma.$transaction(async (tx) => {
		await tx.adminRoutePermission.deleteMany({ where: { adminUserId: adminId } });
		await tx.user.update({
			where: { id: adminId },
			data: {
				role: "USER",
				status: "DELETED",
				deletedAt: new Date(),
			},
		});

		await tx.auditLog.create({
			data: {
				actorId: req.user!.id,
				actorEmail: req.user!.email,
				action: "DELETE_USER",
				targetUserId: adminId,
				metadata: {
					softDeleted: true,
					source: "virtual-admin-routes",
				} as Prisma.InputJsonValue,
			},
		});
	});

	return res.json({ success: true });
});



export { router as virtualAdminRouter }