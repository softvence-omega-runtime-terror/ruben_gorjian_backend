import express from "express";
import multer from "multer";
import { PostStatus, ScheduleType, SessionStatus, SocialPlatform } from "@prisma/client";
import { requireAuth } from "../../middleware/requireAuth";
import { requireAdmin } from "../../middleware/requireAdmin";
import { SchedulerService } from "./service";
import { parseEnumQueryList } from "./functions";
import {
  schedulerCreateSessionSchema,
  formatZodError,
  schedulerListQuerySchema,
  schedulerCreatePostSchema,
  schedulerPublishStatusSchema,
  schedulerUpdateSessionSchema,
  schedulerUpdateSessionStatusSchema,
  schedulerUpdatePostSchema,
} from "./validation";

const router = express.Router();
const schedulerService = new SchedulerService();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 20,
    fileSize: 100 * 1024 * 1024,
  },
});

const platformMap: Record<string, SocialPlatform> = {
  instagram: SocialPlatform.INSTAGRAM,
  facebook: SocialPlatform.FACEBOOK,
  linkedin: SocialPlatform.LINKEDIN,

};

const postStatusMap: Record<string, PostStatus> = {
  draft: PostStatus.DRAFT,
  scheduled: PostStatus.SCHEDULED,
  publishing: PostStatus.PUBLISHING,
  posted: PostStatus.POSTED,
  failed: PostStatus.FAILED,
};

const scheduleTypeMap: Record<string, ScheduleType> = {
  posting: ScheduleType.POSTING,
  photo_session: ScheduleType.PHOTO_SESSION,
  video_session: ScheduleType.VIDEO_SESSION,
};

const sessionStatusMap: Record<string, SessionStatus> = {
  booked: SessionStatus.BOOKED,
  completed: SessionStatus.COMPLETED,
  failed: SessionStatus.FAILED,
  canceled: SessionStatus.CANCELED,
};

function resolveSessionErrorStatus(message: string) {
  const lowered = message.toLowerCase();
  if (
    lowered.includes("not allowed") ||
    lowered.includes("not available for your current plan") ||
    lowered.includes("active subscription is required") ||
    lowered.includes("reached your") ||
    lowered.includes("no remaining") ||
    lowered.includes("only admin")
  ) {
    return 403;
  }
  if (lowered.includes("not found")) return 404;
  return 400;
}

router.use(requireAuth);

router.post("/posts", upload.array("files", 20), async (req, res) => {
  const rawData = req.body?.data;
  if (typeof rawData !== "string" || !rawData.trim()) {
    return res.status(400).json({
      error: "Invalid scheduler post payload",
      details: {
        issues: [
          {
            path: "data",
            message: "data is required and must be a JSON string",
            code: "invalid_type",
          },
        ],
      },
    });
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawData);
  } catch (error) {
    return res.status(400).json({
      error: "Invalid scheduler post payload",
      details: {
        issues: [
          {
            path: "data",
            message: "data must be a valid JSON string",
            code: "invalid_json",
          },
        ],
      },
    });
  }

  const parsed = schedulerCreatePostSchema.safeParse(parsedPayload);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid scheduler post payload", details: formatZodError(parsed.error) });
  }

  const files = ((req as any).files ?? []) as Array<{
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }>;

  try {
    let uploadedAssetIds: string[] = [];
    if (files.length > 0) {
      const uploaded = await schedulerService.uploadMediaFiles(req.user!, {
        userId: parsed.data.userId,
        files,
      });
      uploadedAssetIds = uploaded.media.map((item) => item.id);
    }

    const result = await schedulerService.createScheduledPost(req.user!, {
      ...parsed.data,
      uploadedAssetIds,
    });
    return res.status(201).json({ post: result });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to create scheduled post",
    });
  }
});

router.patch("/posts/:id", async (req, res) => {
  const parsed = schedulerUpdatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid scheduler update payload", details: formatZodError(parsed.error) });
  }

  try {
    const result = await schedulerService.updateScheduledPost(req.user!, req.params.id, parsed.data);
    return res.json({ post: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update scheduled post";
    const statusCode = message.includes("not found") ? 404 : 400;
    return res.status(statusCode).json({ error: message });
  }
});

router.delete("/posts/:id", async (req, res) => {
  try {
    const result = await schedulerService.deleteScheduledPost(req.user!, req.params.id);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete scheduled post";
    const statusCode = message.includes("not found") ? 404 : 400;
    return res.status(statusCode).json({ error: message });
  }
});

router.get("/posts/:id", async (req, res) => {
  try {
    const post = await schedulerService.getScheduledPost(req.user!, req.params.id);
    return res.json({
      post,
      meta: {
        count: 1,
        totalCount: 1,
        page: 1,
        pageSize: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch scheduled post";
    const statusCode = message.includes("not found") ? 404 : 400;
    return res.status(statusCode).json({ error: message });
  }
});

// Admin-only endpoint to update publish status of a post (e.g. mark as posted, failed, etc.)
router.patch("/posts/:id/publish-status", requireAdmin, async (req, res) => {
  const parsed = schedulerPublishStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid publish status payload", details: formatZodError(parsed.error) });
  }

  try {
    const postId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!postId) {
      return res.status(400).json({ error: "Missing post id" });
    }
    const post = await schedulerService.updatePublishStatus(req.user!, postId, parsed.data);
    return res.json({ post });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update publish status";
    const statusCode = message.includes("not found") ? 404 : 400;
    return res.status(statusCode).json({ error: message });
  }
});

router.post("/sessions", async (req, res) => {
  const parsed = schedulerCreateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid scheduler session payload", details: formatZodError(parsed.error) });
  }

  try {
    const session = await schedulerService.createScheduledSession(req.user!, parsed.data);
    return res.status(201).json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create session";
    const statusCode = resolveSessionErrorStatus(message);
    return res.status(statusCode).json({ error: message });
  }
});

router.patch("/sessions/:id", async (req, res) => {
  const parsed = schedulerUpdateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid scheduler session update payload", details: formatZodError(parsed.error) });
  }

  try {
    const session = await schedulerService.updateScheduledSession(req.user!, req.params.id, parsed.data);
    return res.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update session";
    const statusCode = resolveSessionErrorStatus(message);
    return res.status(statusCode).json({ error: message });
  }
});

router.patch("/sessions/:id/status", requireAdmin, async (req, res) => {
  const parsed = schedulerUpdateSessionStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid scheduler session status payload", details: formatZodError(parsed.error) });
  }

  try {
    const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!sessionId) {
      return res.status(400).json({ error: "Missing session id" });
    }
    const session = await schedulerService.updateScheduledSessionStatus(req.user!, sessionId, parsed.data);
    return res.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update session status";
    const statusCode = resolveSessionErrorStatus(message);
    return res.status(statusCode).json({ error: message });
  }
});

router.get("/posts", async (req, res) => {
  const parsed = schedulerListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid scheduler filters", details: formatZodError(parsed.error) });
  }

  try {
    const statuses = parseEnumQueryList(parsed.data.status, postStatusMap, "status");
    const scheduleTypes = parseEnumQueryList(parsed.data.scheduleType, scheduleTypeMap, "scheduleType");
    const sessionStatuses = parseEnumQueryList(parsed.data.sessionStatus, sessionStatusMap, "sessionStatus");
    const platforms = parseEnumQueryList(parsed.data.platform, platformMap, "platform");
    const result = await schedulerService.listScheduledPosts(req.user!, {
      view: parsed.data.view,
      date: parsed.data.date ? new Date(`${parsed.data.date}T00:00:00.000Z`) : undefined,
      from: parsed.data.from,
      to: parsed.data.to,
      status: statuses,
      scheduleType: scheduleTypes,
      sessionStatus: sessionStatuses,
      failure: parsed.data.failure,
      userId: parsed.data.userId,
      platform: platforms,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to fetch scheduled posts",
    });
  }
});

export { router as schedulerRouter };
