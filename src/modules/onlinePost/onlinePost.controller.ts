import type { Request, Response } from "express";
import { handleError } from "../../lib/errors";
import { SocialMediaService } from "./onlinePost.service";
import { ScheduledPostStatus, SocialPlatform } from "@prisma/client";

type AuthedRequest = Request & { user?: any };

function firstQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value;
  return undefined;
}

export class OnlinePostController {
  constructor(private readonly onlinePostService = new SocialMediaService()) { }

  private parseMultipartPayload(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "string" || !raw.trim()) return {};

    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid JSON in `data` field");
    }
  }

  me = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.onlinePostService.me());
    } catch (error) {
      return handleError(error, res);
    }
  };
  createUser = async (req: Request, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.createUser(req.body?.username),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  connectLinkForLoggedUser = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.createConnectLinkForUser(req.user, {
          redirectUrl: req.body?.redirectUrl,
          platform: req.body?.platform,
          showCalendar: req.body?.showCalendar,
        }),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  disconnectLinkForLoggedUser = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.disconnectLinkForUser(req.user, {
          platform: req.body?.platform,
        }),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  publishNow = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.publishNowByUser(req.user, {
          username: req.body?.username,
          platform: req.body?.platform,
          title: req.body?.title,
          mediaUrl: req.body?.mediaUrl,
          mediaUrls: req.body?.mediaUrls,
          asyncUpload: req.body?.asyncUpload,
        }),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  publishNowMultipart = async (req: AuthedRequest, res: Response) => {
    try {
      const data = this.parseMultipartPayload(req.body?.data);
      const files = Array.isArray(req.files) ? req.files : [];

      return res.json(
        await this.onlinePostService.publishNowMultipartByUser(req.user, {
          username: (data.username ?? req.body?.username) as string | undefined,
          platform: (data.platform ?? req.body?.platform) as string | undefined,
          title: (data.title ?? req.body?.title) as string | undefined,
          asyncUpload: data.asyncUpload ?? req.body?.asyncUpload,
          files,
        }),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  schedule = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.schedulePost(req.user, {
          platform: req.body?.platform,
          title: req.body?.title,
          mediaUrl: req.body?.mediaUrl,
          mediaUrls: req.body?.mediaUrls,
          scheduledAt: req.body?.scheduledAt,
        }),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  myCalendar = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.getMyCalendar(
          req.user?.id,
          firstQuery(req.query?.month),
        ),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  getScheduledPost = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.getScheduledPost(
          req.user,
          req.params.id as string,
        ),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  rescheduleScheduledPost = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.reschedulePost(
          req.user,
          req.params.id as string,
          req.body?.scheduledAt,
        ),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  cancelScheduledPost = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.cancelScheduledPost(
          req.user,
          req.params.id as string,
        ),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  retryScheduledPost = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.retryFailedPost(
          req.user,
          req.params.id as string,
          req.body?.scheduledAt,
        ),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  clientCalendar = async (req: AuthedRequest, res: Response) => {
    try {
      const clientId = firstQuery(req.query.clientId);
      if (!clientId) {
        return res.status(400).json({ error: "clientId is required" });
      }
      return res.json(
        await this.onlinePostService.getAdminClientCalendar(
          req.user,
          clientId,
          firstQuery(req.query.month),
        ),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  myPlatformLinks = async (req: AuthedRequest, res: Response) => {
    try {
      const result = await this.onlinePostService.getMyPlatformLinks(
        req.user?.id,
      );

      const response = {
        success: true,
        message: "My connected links get successfully..",
        data: result,
      };

      return res.status(200).json(response);
    } catch (error) {
      return handleError(error, res);
    }
  };

  getAllPlatformLinks = async (req: AuthedRequest, res: Response) => {
    try {
      const { email, search, platforms, page, limit } = req.query;

      const filter: { email?: string; platforms?: SocialPlatform[] } = {};

      if (email && typeof email === "string") filter.email = email;

      if (platforms) {
        let platformArray: SocialPlatform[] = [];

        if (typeof platforms === "string") {
          // Split comma-separated and cast to enum
          platformArray = platforms
            .split(",")
            .map((p) => p.trim().toUpperCase() as SocialPlatform)
            .filter((p) => ["FACEBOOK", "INSTAGRAM", "TIKTOK"].includes(p));
        } else if (Array.isArray(platforms)) {
          platformArray = platforms
            .map((p) => String(p).trim().toUpperCase() as SocialPlatform)
            .filter((p) => ["FACEBOOK", "INSTAGRAM", "TIKTOK"].includes(p));
        }

        if (platformArray.length) filter.platforms = platformArray;
      }

      const pageNumber = page ? parseInt(page as string, 10) : 1;
      const limitNumber = limit ? parseInt(limit as string, 10) : 20;

      const result = await this.onlinePostService.getAllPlatformLinks(
        filter,
        typeof search === "string" ? search : undefined,
        pageNumber,
        limitNumber,
      );

      return res.status(200).json({
        success: true,
        message: "My connected links fetched successfully.",
        data: result,
      });
    } catch (error) {
      return handleError(error, res);
    }
  };

  getAllPost = async (req: AuthedRequest, res: Response) => {
    try {
      const { platform, status, search, page, limit } = req.query;

      // Build filter object
      const filter: {
        platform?: SocialPlatform;
        status?: ScheduledPostStatus;
      } = {};

      if (
        platform &&
        Object.values(SocialPlatform).includes(platform as SocialPlatform)
      ) {
        filter.platform = platform as SocialPlatform;
      }

      if (
        status &&
        Object.values(ScheduledPostStatus).includes(
          status as ScheduledPostStatus,
        )
      ) {
        filter.status = status as ScheduledPostStatus;
      }

      const result = await this.onlinePostService.getAllPost(
        filter,
        search as string,
        page ? parseInt(page as string, 10) : 1,
        limit ? parseInt(limit as string, 10) : 20,
      );

      return res.json(result);
    } catch (error) {
      return handleError(error, res);
    }
  };

  updatePlan = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.updatePlan(
          req.user,
          req.body?.userId,
          req.body?.plan,
        ),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  providerCalendarLink = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.getProviderCalendarLink(req.user, {
          platform: firstQuery(req.query.platform),
          redirectUrl: firstQuery(req.query.redirectUrl),
        }),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  providerCalendar = async (req: AuthedRequest, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.getProviderCalendar(req.user, {
          platform: firstQuery(req.query.platform),
          month: firstQuery(req.query.month),
          from: firstQuery(req.query.from),
          to: firstQuery(req.query.to),
          page: firstQuery(req.query.page)
            ? Number(firstQuery(req.query.page))
            : undefined,
          limit: firstQuery(req.query.limit)
            ? Number(firstQuery(req.query.limit))
            : undefined,
        }),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };

  status = async (req: Request, res: Response) => {
    try {
      return res.json(
        await this.onlinePostService.status({
          jobId: firstQuery(req.query.jobId),
          requestId: firstQuery(req.query.requestId),
        }),
      );
    } catch (error) {
      return handleError(error, res);
    }
  };
}
