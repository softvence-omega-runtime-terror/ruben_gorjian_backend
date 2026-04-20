import express from "express";
import multer from "multer";
import { z } from "zod";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { buildStorageUrl } from "../../lib/validators";
import { requireAuth } from "../../middleware/requireAuth";
import { requireAdmin } from "../../middleware/requireAdmin";

const router = express.Router();
const multipartUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 20,
    fileSize: 100 * 1024 * 1024,
  },
});

const s3Client =
  env.S3_BUCKET && env.AWS_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? new S3Client({
        region: env.AWS_REGION,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
      })
    : null;

const caseStudyPayloadSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  location: z.string().trim().min(1, "Location is required"),
  displayOrder: z.coerce.number().int().min(0).optional().default(0),
  cycleTitle: z.string().trim().min(1, "cycleTitle is required"),
  services: z.array(z.string().trim().min(1)).min(1, "At least one service is required"),
  tagline: z.string().trim().min(1, "Tagline is required"),
  structureTitle: z.string().trim().min(1, "structureTitle is required"),
  structureItems: z.array(z.string().trim().min(1)).min(1, "At least one structure item is required"),
  videoTitle: z.string().trim().optional(),
  isActive: z.boolean().optional().default(true),
});

const caseStudyUpdateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    location: z.string().trim().min(1).optional(),
    displayOrder: z.coerce.number().int().min(0).optional(),
    cycleTitle: z.string().trim().min(1).optional(),
    services: z.array(z.string().trim().min(1)).min(1).optional(),
    tagline: z.string().trim().min(1).optional(),
    structureTitle: z.string().trim().min(1).optional(),
    structureItems: z.array(z.string().trim().min(1)).min(1).optional(),
    videoTitle: z.string().trim().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

const caseStudyStatusSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

type CaseStudyFiles = {
  logo?: Express.Multer.File[];
  images?: Express.Multer.File[];
  video?: Express.Multer.File[];
};

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const ALLOWED_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);

function parseStringArray(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;

  if (Array.isArray(input)) {
    const normalized = input
      .map((item) => String(item).trim())
      .filter(Boolean);
    return normalized.length ? normalized : undefined;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return undefined;

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const normalized = parsed
            .map((item) => String(item).trim())
            .filter(Boolean);
          return normalized.length ? normalized : undefined;
        }
      } catch {
        // fall through to CSV parsing when JSON parsing fails
      }
    }

    const normalized = trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    return normalized.length ? normalized : undefined;
  }

  return undefined;
}

function parseOptionalString(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const value = String(input).trim();
  return value.length ? value : undefined;
}

function parseOptionalBoolean(input: unknown): boolean | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input === "boolean") return input;

  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return undefined;
}

function normalizeCaseStudyPayload(body: Record<string, unknown>) {
  return {
    logoUrl: parseOptionalString(body.logoUrl),
    title: parseOptionalString(body.title),
    location: parseOptionalString(body.location),
    displayOrder: body.displayOrder,
    cycleTitle: parseOptionalString(body.cycleTitle),
    services: parseStringArray(body.services),
    tagline: parseOptionalString(body.tagline),
    structureTitle: parseOptionalString(body.structureTitle),
    structureItems: parseStringArray(body.structureItems),
    images: parseStringArray(body.images),
    videoTitle: parseOptionalString(body.videoTitle),
    videoUrl: parseOptionalString(body.videoUrl),
    isActive: parseOptionalBoolean(body.isActive),
  };
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) return "file";

  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;

  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return cleaned || "file";
}

function buildCaseStudyStorageKey(category: "logo" | "image" | "video", filename: string): string {
  return `case-studies/${Date.now()}-${category}-${sanitizeFilename(filename)}`;
}

function buildPublicMediaUrl(storageKey: string): string {
  if (env.STORAGE_BASE_URL) {
    const resolved = buildStorageUrl(env.STORAGE_BASE_URL, storageKey);
    if (resolved) return resolved;
  }

  if (!env.S3_BUCKET || !env.AWS_REGION) {
    return storageKey;
  }

  return `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${storageKey}`;
}

async function uploadMediaFile(file: Express.Multer.File, category: "logo" | "image" | "video"): Promise<string> {
  if (!s3Client || !env.S3_BUCKET) {
    throw new Error("S3 is not configured for case study media uploads");
  }

  const storageKey = buildCaseStudyStorageKey(category, file.originalname);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: storageKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  return buildPublicMediaUrl(storageKey);
}

function assertMediaTypes(files: CaseStudyFiles) {
  const logoFile = files.logo?.[0];
  if (logoFile && !ALLOWED_IMAGE_MIME_TYPES.has(logoFile.mimetype)) {
    throw new Error("Logo must be an image file (jpg, jpeg, png, webp)");
  }

  for (const image of files.images ?? []) {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(image.mimetype)) {
      throw new Error("Each image must be jpg, jpeg, png, or webp");
    }
  }

  const videoFile = files.video?.[0];
  if (videoFile && !ALLOWED_VIDEO_MIME_TYPES.has(videoFile.mimetype)) {
    throw new Error("Video must be mp4, mov, webm, or mkv");
  }
}

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

// Get active case studies - available for authenticated users/admins
router.get("/", async (req, res) => {
  const { page, limit } = paginationSchema.parse(req.query);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.caseStudy.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      skip,
      take: limit,
    }),
    prisma.caseStudy.count({ where: { isActive: true } }),
  ]);

  const pagination: PaginationMeta = {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };

  return res.json({ success: true, data: items, pagination });
});

// Get all case studies - admin only
router.get("/admin", requireAuth, requireAdmin, async (req, res) => {
  const { page, limit } = paginationSchema.parse(req.query);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.caseStudy.findMany({
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      skip,
      take: limit,
    }),
    prisma.caseStudy.count(),
  ]);

  const pagination: PaginationMeta = {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };

  return res.json({ success: true, data: items, pagination });
});

// Create case study - admin only
router.post(
  "/",
  requireAuth,
  requireAdmin,
  multipartUpload.fields([
    { name: "logo", maxCount: 1 },
    { name: "images", maxCount: 20 },
    { name: "video", maxCount: 1 },
  ]),
  async (req, res) => {
    const files = (req.files as CaseStudyFiles | undefined) ?? {};
    const logoFile = files.logo?.[0];
    const imageFiles = files.images ?? [];
    const videoFile = files.video?.[0];

    if (!logoFile) {
      return res.status(400).json({ error: "Logo file is required" });
    }

    if (imageFiles.length === 0) {
      return res.status(400).json({ error: "At least one image file is required" });
    }

    try {
      assertMediaTypes(files);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid media files" });
    }

  const parsed = caseStudyPayloadSchema.safeParse(normalizeCaseStudyPayload(req.body as Record<string, unknown>));
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

    try {
      const logoUrl = await uploadMediaFile(logoFile, "logo");
      const images = await Promise.all(imageFiles.map((file) => uploadMediaFile(file, "image")));
      const videoUrl = videoFile ? await uploadMediaFile(videoFile, "video") : undefined;

  const item = await prisma.caseStudy.create({
    data: {
          logoUrl,
      title: parsed.data.title,
      location: parsed.data.location,
      displayOrder: parsed.data.displayOrder,
      cycleTitle: parsed.data.cycleTitle,
      services: parsed.data.services,
      tagline: parsed.data.tagline,
      structureTitle: parsed.data.structureTitle,
      structureItems: parsed.data.structureItems,
          images,
      videoTitle: parsed.data.videoTitle,
          videoUrl,
      isActive: parsed.data.isActive,
    },
  });

      return res.status(201).json({ success: true, data: item });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to upload files" });
    }
  }
);

// Update case study - admin only
router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  multipartUpload.fields([
    { name: "logo", maxCount: 1 },
    { name: "images", maxCount: 20 },
    { name: "video", maxCount: 1 },
  ]),
  async (req, res) => {
  const caseStudyId = req.params.id as string;
  const parsed = caseStudyUpdateSchema.safeParse(normalizeCaseStudyPayload(req.body as Record<string, unknown>));
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const existing = await prisma.caseStudy.findUnique({ where: { id: caseStudyId } });
  if (!existing) {
    return res.status(404).json({ error: "Case study not found" });
  }

    const files = (req.files as CaseStudyFiles | undefined) ?? {};
    const logoFile = files.logo?.[0];
    const imageFiles = files.images ?? [];
    const videoFile = files.video?.[0];

    try {
      assertMediaTypes(files);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid media files" });
    }

    try {
      const logoUrl = logoFile ? await uploadMediaFile(logoFile, "logo") : undefined;
      const images = imageFiles.length
        ? await Promise.all(imageFiles.map((file) => uploadMediaFile(file, "image")))
        : undefined;
      const videoUrl = videoFile ? await uploadMediaFile(videoFile, "video") : undefined;

      const updateData = {
        ...parsed.data,
        ...(logoUrl ? { logoUrl } : {}),
        ...(images ? { images } : {}),
        ...(videoUrl ? { videoUrl } : {}),
      };

  const item = await prisma.caseStudy.update({
    where: { id: caseStudyId },
        data: updateData,
  });

      return res.json({ success: true, data: item });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to upload files" });
    }
  }
);

// Update case study status - admin only
router.patch("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  const caseStudyId = req.params.id as string;
  const parsed = caseStudyStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const existing = await prisma.caseStudy.findUnique({ where: { id: caseStudyId } });
  if (!existing) {
    return res.status(404).json({ error: "Case study not found" });
  }

  const item = await prisma.caseStudy.update({
    where: { id: caseStudyId },
    data: {
      isActive: parsed.data.status === "ACTIVE",
    },
  });

  return res.json({ success: true, data: item });
});

// Delete case study - admin only
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  const caseStudyId = req.params.id as string;
  const existing = await prisma.caseStudy.findUnique({ where: { id: caseStudyId } });
  if (!existing) {
    return res.status(404).json({ error: "Case study not found" });
  }

  await prisma.caseStudy.delete({ where: { id: caseStudyId } });

  return res.json({ success: true });
});

export { router as caseStudiesRouter };
