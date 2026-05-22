import express from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { requireAdmin } from "../../middleware/requireAdmin";

const router = express.Router();

const faqPayloadSchema = z.object({
  question: z.string().trim().min(1, "Question is required"),
  answer: z.string().trim().min(1, "Answer is required"),
  displayOrder: z.coerce.number().int().min(0).optional().default(0),
  isActive: z.boolean().optional().default(true),
});

const faqUpdateSchema = z
  .object({
    question: z.string().trim().min(1).optional(),
    answer: z.string().trim().min(1).optional(),
    displayOrder: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

const faqStatusSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

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

// Get FAQs - available for authenticated  active only
router.get("/", async (req, res) => {
  const { page, limit } = paginationSchema.parse(req.query);
  const skip = (page - 1) * limit;

  const [faqs, total] = await Promise.all([
    prisma.faq.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      skip,
      take: limit,
    }),
    prisma.faq.count({ where: { isActive: true } }),
  ]);

  const pagination: PaginationMeta = {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };

  return res.json({ success: true, data: faqs, pagination });
});

// Get all FAQs - admin only
router.get("/admin", requireAuth, requireAdmin, async (req, res) => {
  const { page, limit } = paginationSchema.parse(req.query);
  const skip = (page - 1) * limit;

  const [faqs, total] = await Promise.all([
    prisma.faq.findMany({
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      skip,
      take: limit,
    }),
    prisma.faq.count(),
  ]);

  const pagination: PaginationMeta = {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };

  return res.json({ success: true, data: faqs, pagination });
});

// Create FAQ - admin only
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const parsed = faqPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const faq = await prisma.faq.create({
    data: {
      question: parsed.data.question,
      answer: parsed.data.answer,
      displayOrder: parsed.data.displayOrder,
      isActive: parsed.data.isActive,
      createdByAdminId: req.user!.id,
      updatedByAdminId: req.user!.id,
    },
  });

  return res.status(201).json({ success: true, data: faq });
});

// Update FAQ - admin only
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  const faqId = req.params.id as string;
  const parsed = faqUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const existing = await prisma.faq.findUnique({ where: { id: faqId } });
  if (!existing) {
    return res.status(404).json({ error: "FAQ not found" });
  }

  const faq = await prisma.faq.update({
    where: { id: faqId },
    data: {
      ...parsed.data,
      updatedByAdminId: req.user!.id,
    },
  });

  return res.json({ success: true, data: faq });
});

// Update FAQ status - admin only
router.patch("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  const faqId = req.params.id as string;
  const parsed = faqStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }

  const existing = await prisma.faq.findUnique({ where: { id: faqId } });
  if (!existing) {
    return res.status(404).json({ error: "FAQ not found" });
  }

  const faq = await prisma.faq.update({
    where: { id: faqId },
    data: {
      isActive: parsed.data.status === "ACTIVE",
      updatedByAdminId: req.user!.id,
    },
  });

  return res.json({ success: true, data: faq });
});

// Delete FAQ - admin only
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  const faqId = req.params.id as string;

  const existing = await prisma.faq.findUnique({ where: { id: faqId } });
  if (!existing) {
    return res.status(404).json({ error: "FAQ not found" });
  }

  await prisma.faq.delete({ where: { id: faqId } });

  return res.json({ success: true });
});

export { router as faqRouter };
