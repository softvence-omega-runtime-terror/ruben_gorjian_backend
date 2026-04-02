/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import {
  Prisma,
  ScheduledPost,
  ScheduledPostStatus,
  SocialPlatform,
  User,
  Role as UserRole,
} from "@prisma/client";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { Upload } from "@aws-sdk/lib-storage";
import { PassThrough } from "stream";

// Minimal Nest-like exceptions so the original pasted logic can remain unchanged in Express.
// Express routes should use `handleError()` to convert these into proper HTTP responses.
class BadRequestException extends ApiError {
  constructor(messageOrDetails: unknown) {
    const message =
      typeof messageOrDetails === "string"
        ? messageOrDetails
        : ((messageOrDetails as any)?.message ?? "Bad Request");
    super(
      400,
      message,
      typeof messageOrDetails === "string" ? undefined : messageOrDetails,
    );
    this.name = "BadRequestException";
  }
  getResponse() {
    return this.details ?? { message: this.message };
  }
}

class ForbiddenException extends ApiError {
  constructor(messageOrDetails: unknown) {
    const message =
      typeof messageOrDetails === "string"
        ? messageOrDetails
        : ((messageOrDetails as any)?.message ?? "Forbidden");
    super(
      403,
      message,
      typeof messageOrDetails === "string" ? undefined : messageOrDetails,
    );
    this.name = "ForbiddenException";
  }
}

class NotFoundException extends ApiError {
  constructor(messageOrDetails: unknown) {
    const message =
      typeof messageOrDetails === "string"
        ? messageOrDetails
        : ((messageOrDetails as any)?.message ?? "Not Found");
    super(
      404,
      message,
      typeof messageOrDetails === "string" ? undefined : messageOrDetails,
    );
    this.name = "NotFoundException";
  }
}

export class SocialMediaService {
  private readonly prisma = prisma;
  private readonly s3Client =
    env.S3_BUCKET &&
    env.AWS_REGION &&
    env.AWS_ACCESS_KEY_ID &&
    env.AWS_SECRET_ACCESS_KEY
      ? new S3Client({
          region: env.AWS_REGION,
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          },
        })
      : null;

  // Minimal ConfigService shim so existing logic stays the same in Express.
  private readonly configService = {
    get: <T = string>(name: string): T | undefined =>
      (process.env[name] as unknown as T | undefined) ?? undefined,
  };

  private readonly allowedPlatforms = [
    "facebook",
    "instagram",
    "tiktok",
  ] as const;

  private planLimits: Record<
    string,
    { maxLinkedPlatforms: number; monthlyScheduledPosts: number }
  > = {
    FREE: { maxLinkedPlatforms: 1, monthlyScheduledPosts: 10 },
    DEFAULT: { maxLinkedPlatforms: 2, monthlyScheduledPosts: 30 },
    PRO: { maxLinkedPlatforms: 3, monthlyScheduledPosts: 200 },
    ENTERPRISE: { maxLinkedPlatforms: 3, monthlyScheduledPosts: 10000 },
  };

  private required(name: string): string {
    const value = this.configService.get<string>(name)?.trim();
    if (!value) {
      throw new BadRequestException(`Missing required env var: ${name}`);
    }
    return value;
  }

  private authHeader(): string {
    const key = this.required("UPLOAD_POST_API_KEY");
    if (/^apikey\s+/i.test(key) || /^bearer\s+/i.test(key)) {
      return key;
    }
    return `ApiKey ${key}`;
  }

  private resolveBaseUrl(): string {
    const raw = (
      this.configService.get<string>("UPLOAD_POST_BASE_URL") ?? ""
    ).trim();
    if (!raw) return "https://api.upload-post.com/api";

    const normalized = raw.replace(/\/$/, "");

    if (
      normalized === "https://upload-post.com" ||
      normalized === "https://www.upload-post.com" ||
      normalized === "https://api.upload-post.com" ||
      normalized === "https://www.api.upload-post.com"
    ) {
      return "https://api.upload-post.com/api";
    }

    if (normalized.endsWith("/api")) return normalized;

    return normalized;
  }

  private normalizePlatform(
    platform: string,
  ): "facebook" | "instagram" | "tiktok" {
    const p = platform?.toLowerCase();
    if (!p || !this.allowedPlatforms.includes(p as any)) {
      throw new BadRequestException(
        "platform must be one of: facebook, instagram, tiktok",
      );
    }
    return p as "facebook" | "instagram" | "tiktok";
  }

  private toPrismaPlatform(
    platform: "facebook" | "instagram" | "tiktok",
  ): SocialPlatform {
    if (platform === "facebook") return SocialPlatform.FACEBOOK;
    if (platform === "instagram") return SocialPlatform.INSTAGRAM;
    return SocialPlatform.TIKTOK;
  }

  private fromPrismaPlatform(
    platform: SocialPlatform,
  ): "facebook" | "instagram" | "tiktok" {
    if (platform === SocialPlatform.FACEBOOK) return "facebook";
    if (platform === SocialPlatform.INSTAGRAM) return "instagram";
    return "tiktok";
  }

  private uploadPostUsername(user: User): string {
    return user.email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_");
  }

  private async api(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", this.authHeader());

    const url = `${this.resolveBaseUrl()}${path}`;
    const response = await fetch(url, { ...init, headers });

    const text = await response.text();
    let data: unknown = text;

    try {
      data = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      // keep text
    }

    if (!response.ok) {
      throw new BadRequestException({
        message: "Upload Post API request failed",
        requestUrl: url,
        statusCode: response.status,
        statusText: response.statusText,
        error: data,
      });
    }

    return data;
  }

  private async ensurePlatformLinked(userId: string, platform: SocialPlatform) {
    const link = await this.prisma.socialPlatformLink.findUnique({
      where: { userId_platform: { userId, platform } },
    });

    // if (!link) {
    //   throw new ForbiddenException('User must login/connect this platform first via API');
    // }
  }

  private async enforceLinkLimit(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    const linked = await this.prisma.socialPlatformLink.count({
      where: { userId },
    });
    const socialPlan = String((user as any).socialPlan ?? "FREE");
    const limit = (this.planLimits[socialPlan] ?? this.planLimits.FREE)
      .maxLinkedPlatforms;
    if (linked >= limit) {
      throw new ForbiddenException(
        `Plan limit reached. Max linked platforms for ${socialPlan}: ${limit}`,
      );
    }
  }

  private async enforceScheduleLimit(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const total = await this.prisma.scheduledPost.count({
      where: {
        userId,
        createdAt: { gte: monthStart, lt: nextMonth },
      },
    });

    const socialPlan = String((user as any).socialPlan ?? "FREE");
    const limit = (this.planLimits[socialPlan] ?? this.planLimits.FREE)
      .monthlyScheduledPosts;
    if (total >= limit) {
      throw new ForbiddenException(
        `Monthly schedule limit reached for ${socialPlan} plan: ${limit}`,
      );
    }
  }

  private isVideoUrl(url: string): boolean {
    return /\.(mp4|mov|avi|mkv|webm|m4v)(\?|$)/i.test(url);
  }

  private isImageUrl(url: string): boolean {
    return /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(url);
  }

  private extractExternalIds(result: unknown): {
    requestId?: string;
    jobId?: string;
  } {
    const obj =
      typeof result === "object" && result
        ? (result as Record<string, unknown>)
        : {};
    const requestId =
      typeof obj.request_id === "string"
        ? obj.request_id
        : typeof obj.requestId === "string"
          ? obj.requestId
          : undefined;
    const jobId =
      typeof obj.job_id === "string"
        ? obj.job_id
        : typeof obj.jobId === "string"
          ? obj.jobId
          : undefined;
    return { requestId, jobId };
  }

  private extractConnectMeta(result: unknown): {
    externalRef?: string;
    externalProfileUrl?: string;
  } {
    const obj =
      typeof result === "object" && result
        ? (result as Record<string, unknown>)
        : {};

    const externalRefCandidates = [
      obj.request_id,
      obj.requestId,
      obj.id,
      obj.jwt,
      obj.token,
      obj.profile_id,
      obj.profileId,
    ];

    const externalProfileUrlCandidates = [
      obj.profile_url,
      obj.profileUrl,
      obj.profile_link,
      obj.profileLink,
      obj.permalink,
    ];

    const externalRef = externalRefCandidates.find(
      (v) => typeof v === "string",
    ) as string | undefined;
    const externalProfileUrl = externalProfileUrlCandidates.find(
      (v) => typeof v === "string",
    ) as string | undefined;

    return { externalRef, externalProfileUrl };
  }

  private extractPostUrl(result: unknown): string | undefined {
    const obj =
      typeof result === "object" && result
        ? (result as Record<string, unknown>)
        : {};

    const candidates = [
      obj.post_url,
      obj.postUrl,
      obj.post_link,
      obj.postLink,
      obj.permalink,
      obj.url,
      obj.link,
      obj.live_post_url,
    ];

    return candidates.find((v) => typeof v === "string") as string | undefined;
  }

  private normalizeMediaUrls(
    mediaUrl?: string,
    mediaUrls?: string[],
  ): string[] {
    const urls = [
      ...(Array.isArray(mediaUrls) ? mediaUrls : []),
      ...(mediaUrl ? [mediaUrl] : []),
    ]
      .map((u) => (u ?? "").trim())
      .filter(Boolean);

    return Array.from(new Set(urls));
  }

  private decodeScheduledMediaUrls(stored?: string | null): string[] {
    if (!stored) return [];
    const raw = stored.trim();
    if (!raw) return [];

    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map((x) => String(x)).filter(Boolean);
        }
      } catch {
        return [];
      }
    }

    return [raw];
  }

  private normalizeBoolean(value: unknown, fallback = true): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    return fallback;
  }

  private sanitizeFilename(fileName: string): string {
    const trimmed = fileName.trim();
    if (!trimmed) return "upload";

    return (
      trimmed
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120) || "upload"
    );
  }

  private buildStorageUrl(storageKey: string): string {
    const baseUrl = env.STORAGE_BASE_URL?.trim();
    if (!baseUrl) {
      throw new BadRequestException(
        "STORAGE_BASE_URL is required to publish uploaded files",
      );
    }
    return `${baseUrl.replace(/\/+$/, "")}/${storageKey.replace(/^\/+/, "")}`;
  }

  // private async uploadMultipartFiles(
  //   userId: string,
  //   files: Express.Multer.File[],
  // ): Promise<string[]> {
  //   if (!files.length) return [];

  //   if (!this.s3Client || !env.S3_BUCKET) {
  //     throw new BadRequestException("S3 upload is not configured");
  //   }

  //   const uploadedUrls: string[] = [];

  //   for (const file of files) {
  //     const storageKey = `attachments/media/${Date.now()}_${userId}_${this.sanitizeFilename(file.originalname)}`;

  //     await this.s3Client.send(
  //       new PutObjectCommand({
  //         Bucket: env.S3_BUCKET,
  //         Key: storageKey,
  //         Body: file.buffer,
  //         ContentType: file.mimetype || "application/octet-stream",
  //       }),
  //     );

  //     uploadedUrls.push(this.buildStorageUrl(storageKey));
  //   }

  //   return uploadedUrls;
  // }

  private async uploadMultipartFiles(
    userId: string,
    files: Express.Multer.File[],
  ): Promise<string[]> {
    if (!files.length) return [];

    if (!this.s3Client || !env.S3_BUCKET) {
      throw new BadRequestException("S3 upload is not configured");
    }

    const uploadedUrls: string[] = [];

    for (const file of files) {
      const storageKey = `attachments/media/${Date.now()}_${userId}_${this.sanitizeFilename(
        file.originalname,
      )}`;

      if (file.mimetype.startsWith("video/")) {
        // Video: upload as stream
        const stream = new PassThrough();
        stream.end(file.buffer); // convert buffer to stream

        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: env.S3_BUCKET,
            Key: storageKey,
            Body: stream,
            ContentType: file.mimetype || "application/octet-stream",
          },
        });

        await upload.done();
      } else {
        // Image: upload directly from buffer
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: storageKey,
            Body: file.buffer,
            ContentType: file.mimetype || "application/octet-stream",
          }),
        );
      }

      uploadedUrls.push(this.buildStorageUrl(storageKey));
    }

    return uploadedUrls;
  }

  private async publishToProvider(payload: {
    username: string;
    platform: "facebook" | "instagram" | "tiktok";
    title: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    asyncUpload?: boolean;
  }) {
    const title = payload.title?.trim() || "Social media post";
    const asyncUpload = payload.asyncUpload ?? true;
    const mediaList = this.normalizeMediaUrls(
      payload.mediaUrl,
      payload.mediaUrls,
    );

    if (mediaList.length === 0) {
      if (payload.platform === "instagram") {
        throw new BadRequestException(
          "Instagram posts require at least one image or one video.",
        );
      }

      const form = new FormData();
      form.append("user", payload.username);
      form.append("platform[]", payload.platform);
      form.append("title", title);
      form.append("status", "active");
      form.append("async_upload", String(asyncUpload));

      const result = await this.api("/upload_text", {
        method: "POST",
        body: form,
      });
      return { result, title, mediaList };
    }

    if (mediaList.every((u) => this.isImageUrl(u))) {
      const form = new FormData();
      form.append("user", payload.username);
      form.append("platform[]", payload.platform);
      form.append("title", title);
      form.append("status", "active");
      form.append("async_upload", String(asyncUpload));
      if (payload.platform === "instagram") {
        form.append("instagram_description", title);
        form.append("description", title);
      }

      for (const url of mediaList) {
        form.append("photo_urls[]", url);
        form.append("photos[]", url);
        form.append("urls[]", url);
      }
      form.append("photo_url", mediaList[0]);
      form.append("image", mediaList[0]);
      form.append("photo", mediaList[0]);

      const result = await this.api("/upload_photos", {
        method: "POST",
        body: form,
      });
      return { result, title, mediaList };
    }

    if (mediaList.every((u) => this.isVideoUrl(u))) {
      if (mediaList.length > 1) {
        throw new BadRequestException("Only one video is allowed per post.");
      }

      const form = new FormData();
      form.append("user", payload.username);
      form.append("platform[]", payload.platform);
      form.append("title", title);
      form.append("status", "active");
      form.append("video", mediaList[0]);
      form.append("async_upload", String(asyncUpload));
      if (payload.platform === "instagram") {
        form.append("instagram_title", title);
      }

      const result = await this.api("/upload", {
        method: "POST",
        body: form,
      });
      return { result, title, mediaList };
    }

    throw new BadRequestException("Use a direct image/video URL");
  }

  private async getOwnedPostOrThrow(
    postId: string,
    user: User,
  ): Promise<ScheduledPost> {
    const post = await this.prisma.scheduledPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException("Scheduled post not found");
    if (user.role !== UserRole.ADMIN && post.userId !== user.id) {
      throw new ForbiddenException(
        "You can only access your own scheduled posts",
      );
    }
    return post;
  }

  me() {
    return this.api("/uploadposts/me");
  }

  createUser(username: string) {
    return this.createOrReuseUploadPostProfile(username);
  }

  private async createOrReuseUploadPostProfile(username: string) {
    try {
      const created = await this.api("/uploadposts/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      return { success: true, profile: created, reused: false };
    } catch (error) {
      const res =
        error instanceof BadRequestException
          ? (error.getResponse() as Record<string, any>)
          : null;
      const providerError = res?.error as Record<string, any> | undefined;

      if (
        providerError?.error_code === "PROFILE_LIMIT_REACHED" ||
        Number(res?.statusCode) === 409
      ) {
        // Try to continue with existing profile list
        const list = await this.api("/uploadposts/users");
        const profiles = Array.isArray((list as any)?.profiles)
          ? (list as any).profiles
          : Array.isArray(list)
            ? list
            : [];

        const existing = profiles.find((p: any) => p?.username === username);
        if (existing) {
          return {
            success: true,
            profile: existing,
            reused: true,
            note: "Existing profile reused due to plan limit.",
          };
        }

        throw new BadRequestException({
          message:
            "Upload-Post profile limit reached. Upgrade plan or delete an existing provider profile, then retry.",
          provider: providerError,
          suggestion:
            "Use one existing username per client, or upgrade from Default plan (limit: 2 profiles).",
        });
      }

      throw error;
    }
  }

  private async disconnectProviderProfileByUsername(username: string) {
    try {
      const result = await this.api("/uploadposts/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });

      return {
        success: true,
        username,
        result,
      };
    } catch (error) {
      const res =
        error instanceof BadRequestException
          ? (error.getResponse() as Record<string, any>)
          : null;

      // ✅ Handle already-deleted profile safely
      if (Number(res?.statusCode) === 404) {
        return {
          success: true,
          username,
          alreadyDeleted: true,
        };
      }

      throw new BadRequestException({
        message: "Failed to delete Upload-Post profile",
        username,
        provider: res?.error,
      });
    }
  }

  async createConnectLinkForUser(
    user: User,
    payload: { redirectUrl: string; platform: string; showCalendar?: boolean },
  ) {
    const platform = this.normalizePlatform(payload.platform);
    const prismaPlatform = this.toPrismaPlatform(platform);

    const existing = await this.prisma.socialPlatformLink.findUnique({
      where: { userId_platform: { userId: user.id, platform: prismaPlatform } },
    });

    if (!existing) {
      await this.enforceLinkLimit(user.id);
    }

    const username = this.uploadPostUsername(user);
    await this.createOrReuseUploadPostProfile(username);

    const linkResult = await this.api("/uploadposts/users/generate-jwt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        platforms: [platform],
        redirect_url: payload.redirectUrl,
        show_calendar: payload.showCalendar ?? true,
      }),
    });

    const connectMeta = this.extractConnectMeta(linkResult);

    await this.prisma.socialPlatformLink.upsert({
      where: { userId_platform: { userId: user.id, platform: prismaPlatform } },
      update: {
        linkedAt: new Date(),
        externalRef: connectMeta.externalRef,
        externalProfileUrl: connectMeta.externalProfileUrl,
      },
      create: {
        userId: user.id,
        platform: prismaPlatform,
        externalRef: connectMeta.externalRef,
        externalProfileUrl: connectMeta.externalProfileUrl,
      },
    });

    return {
      success: true,
      username,
      platform,
      connect: linkResult,
    };
  }

  // async disconnectLinkForUser(user: User, payload: { platform: string }) {
  //   const platform = this.normalizePlatform(payload.platform);
  //   const prismaPlatform = this.toPrismaPlatform(platform);

  //   const existing = await this.prisma.socialPlatformLink.findUnique({
  //     where: { userId_platform: { userId: user.id, platform: prismaPlatform } },
  //   });

  //   if (!existing) {
  //     return {
  //       success: true,
  //       platform,
  //       disconnected: false,
  //       message: "Platform link was not connected.",
  //     };
  //   }

  //   await this.disconnectProviderProfileByUsername(existing.platformUsername);

  //   const previousLink = {
  //     id: existing.id,
  //     userId: existing.userId,
  //     platform,
  //     externalRef: existing.externalRef,
  //     externalProfileUrl: existing.externalProfileUrl,
  //     linkedAt: existing.linkedAt,
  //     createdAt: existing.createdAt,
  //     updatedAt: existing.updatedAt,
  //   };

  //   await this.prisma.socialPlatformLink.delete({
  //     where: { userId_platform: { userId: user.id, platform: prismaPlatform } },
  //   });

  //   return {
  //     success: true,
  //     platform,
  //     disconnected: true,
  //     message: "Platform disconnected successfully.",
  //     link: previousLink,
  //   };
  // }

  async disconnectLinkForUser(user: User, payload: { platform: string }) {
    const platform = this.normalizePlatform(payload.platform);
    const prismaPlatform = this.toPrismaPlatform(platform);

    const existing = await this.prisma.socialPlatformLink.findUnique({
      where: { userId_platform: { userId: user.id, platform: prismaPlatform } },
    });

    if (!existing) {
      return {
        success: true,
        platform,
        disconnected: false,
        message: "Platform link was not connected.",
      };
    }

    // 🔢 Count BEFORE deleting
    const totalLinks = await this.prisma.socialPlatformLink.count({
      where: { userId: user.id },
    });

    const username = this.uploadPostUsername(user);

    const previousLink = {
      id: existing.id,
      userId: existing.userId,
      platform,
      externalRef: existing.externalRef,
      externalProfileUrl: existing.externalProfileUrl,
      linkedAt: existing.linkedAt,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };

    // 🧹 Step 1: remove local link
    await this.prisma.socialPlatformLink.delete({
      where: { userId_platform: { userId: user.id, platform: prismaPlatform } },
    });

    // delete all provider profiles
    await this.disconnectProviderProfileByUsername(username);

    return {
      success: true,
      platform,
      disconnected: true,
      message:
        totalLinks === 1
          ? "Platform disconnected and provider profile deleted."
          : "Platform disconnected locally (provider profile retained).",
      link: previousLink,
    };
  }

  async publishNowByUser(
    user: User,
    payload: {
      username: string;
      platform: string;
      title: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      asyncUpload?: boolean;
    },
  ) {
    const platform = this.normalizePlatform(payload.platform);
    const prismaPlatform = this.toPrismaPlatform(platform);
    await this.ensurePlatformLinked(user.id, prismaPlatform);

    // const username = this.uploadPostUsername(user);
    const published = await this.publishToProvider({
      username: payload.username,
      platform,
      title: payload.title,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
      asyncUpload: payload.asyncUpload,
    });

    const ids = this.extractExternalIds(published.result);
    const postUrl = this.extractPostUrl(published.result);

    const savedPost = await this.prisma.scheduledPost.create({
      data: {
        userId: user.id,
        platform: prismaPlatform,
        title: published.title,
        mediaUrl:
          published.mediaList.length > 1
            ? JSON.stringify(published.mediaList)
            : (published.mediaList[0] ?? null),
        scheduledAt: new Date(),
        status: ScheduledPostStatus.POSTED,
        externalReqId: ids.requestId,
        externalJobId: ids.jobId,
        externalPostUrl: postUrl,
      },
    });

    return { success: true, result: published.result, savedPost };
  }

  async publishNowMultipartByUser(
    user: User,
    payload: {
      username?: string;
      platform?: string;
      title?: string;
      asyncUpload?: unknown;
      files: Express.Multer.File[];
    },
  ) {
    if (!payload.username?.trim()) {
      throw new BadRequestException("username is required");
    }

    if (!payload.platform?.trim()) {
      throw new BadRequestException("platform is required");
    }

    if (!payload.title?.trim()) {
      throw new BadRequestException("title is required");
    }

    const uploadedUrls = await this.uploadMultipartFiles(
      user.id,
      payload.files,
    );

    return this.publishNowByUser(user, {
      username: payload.username.trim(),
      platform: payload.platform.trim(),
      title: payload.title.trim(),
      mediaUrl: uploadedUrls.length === 1 ? uploadedUrls[0] : undefined,
      mediaUrls: uploadedUrls.length > 1 ? uploadedUrls : undefined,
      asyncUpload: this.normalizeBoolean(payload.asyncUpload, true),
    });
  }

  async schedulePost(
    user: User,
    payload: {
      platform: string;
      title: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      scheduledAt: string;
    },
  ) {
    const platform = this.normalizePlatform(payload.platform);
    const prismaPlatform = this.toPrismaPlatform(platform);
    await this.ensurePlatformLinked(user.id, prismaPlatform);

    const scheduledAt = new Date(payload.scheduledAt);

    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException("scheduledAt must be a valid ISO date");
    }

    if (scheduledAt <= new Date()) {
      throw new BadRequestException("scheduledAt must be in the future");
    }

    await this.enforceScheduleLimit(user.id);

    return this.prisma.scheduledPost.create({
      data: {
        userId: user.id,
        platform: prismaPlatform,
        title: payload.title,
        mediaUrl: (() => {
          const list = this.normalizeMediaUrls(
            payload.mediaUrl,
            payload.mediaUrls,
          );
          return list.length > 1 ? JSON.stringify(list) : (list[0] ?? null);
        })(),
        scheduledAt,
      },
    });
  }
  async getMyCalendar(userId: string, month?: string) {
    let from: Date | undefined;
    let to: Date | undefined;

    if (month) {
      const [y, m] = month.split("-").map(Number);
      if (!y || !m || m < 1 || m > 12)
        throw new BadRequestException("month format must be YYYY-MM");
      from = new Date(y, m - 1, 1);
      to = new Date(y, m, 1);
    }

    return this.prisma.scheduledPost.findMany({
      where: {
        userId,
        ...(from && to ? { scheduledAt: { gte: from, lt: to } } : {}),
      },
      orderBy: { scheduledAt: "asc" },
    });
  }

  async getAdminClientCalendar(admin: User, clientId: string, month?: string) {
    if (admin.role !== UserRole.ADMIN)
      throw new ForbiddenException("Admin only");
    return this.getMyCalendar(clientId, month);
  }

  //   async getMyPlatformLinks(userId: string) {
  //     return this.prisma.socialPlatformLink.findMany({
  //       where: { userId },
  //       orderBy: { linkedAt: 'desc' },
  //       include: { user: true },
  //     });
  //   }

  async getMyPlatformLinks(userId: string) {
    const links = await this.prisma.socialPlatformLink.findMany({
      where: { userId },
      orderBy: { linkedAt: "desc" },
      include: { user: true },
    });

    return links.map((link) => {
      const email = link.user?.email || "";
      const username = email.split("@")[0]; // @ এর আগে part

      return {
        uploadPostUsername: username, // 👈 extra field
        ...link,
      };
    });
  }
  async getAllPlatformLinks(
    filter?: { email?: string; platforms?: SocialPlatform[] },
    search?: string,
    page = 1,
    limit = 20,
  ) {
    const where: Prisma.SocialPlatformLinkWhereInput = {};

    // Exact email filter
    if (filter?.email) {
      where.user = { email: filter.email };
    }

    // Filter by platforms or search
    if ((search && search.trim()) || filter?.platforms?.length) {
      where.AND = [];

      // Search in email or username (before @)
      if (search?.trim()) {
        const q = search.trim();
        where.AND.push({
          OR: [
            { user: { email: { contains: q, mode: "insensitive" } } },
            { user: { email: { startsWith: q, mode: "insensitive" } } },
          ],
        });
      }

      // Filter by platforms
      if (filter?.platforms?.length) {
        where.AND.push({
          platform: { in: filter.platforms },
        });
      }
    }

    // Total count for pagination
    const total = await this.prisma.socialPlatformLink.count({ where });

    // Fetch paginated results
    const links = await this.prisma.socialPlatformLink.findMany({
      where,
      orderBy: { linkedAt: "desc" },
      include: { user: true },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Map extra field
    const data = links.map((link) => {
      const email = link.user?.email || "";
      const username = email.split("@")[0];

      return {
        uploadPostUsername: username,
        ...link,
      };
    });

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getAllPost(
    filter?: {
      platform?: SocialPlatform;
      status?: ScheduledPostStatus;
    },
    search?: string,
    page = 1,
    limit = 20,
  ) {
    // Limit maximum items per page
    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    // Build Prisma where clause
    const where: Prisma.ScheduledPostWhereInput = {};

    if (filter?.platform) {
      where.platform = filter.platform;
    }

    if (filter?.status) {
      where.status = filter.status;
    }

    if (search) {
      where.title = {
        contains: search,
        mode: "insensitive",
      };
    }

    // Fetch posts and total count in parallel
    const [posts, total] = await Promise.all([
      prisma.scheduledPost.findMany({
        where,
        include: { user: true },
        orderBy: { scheduledAt: "asc" },
        skip,
        take: limit,
      }),
      prisma.scheduledPost.count({ where }),
    ]);

    return {
      data: posts,
      total,
      page,
      lastPage: Math.ceil(total / limit),
    };
  }

  async updatePlan(admin: User, userId: string, plan: any) {
    if (admin.role !== UserRole.ADMIN)
      throw new ForbiddenException("Admin only");
    return this.prisma.user.update({
      where: { id: userId },
      data: { ...({ socialPlan: plan } as any) },
    });
  }

  async processDueScheduledPosts(limit = 20) {
    const duePosts = await this.prisma.scheduledPost.findMany({
      where: {
        status: ScheduledPostStatus.PENDING,
        scheduledAt: { lte: new Date() },
      },
      include: { user: true },
      orderBy: { scheduledAt: "asc" },
      take: limit,
    });

    for (const post of duePosts) {
      try {
        const mediaUrls = this.decodeScheduledMediaUrls(post.mediaUrl);

        const publish = await this.publishToProvider({
          username: this.uploadPostUsername(post.user),
          platform: this.fromPrismaPlatform(post.platform),
          title: post.title,
          mediaUrl: mediaUrls[0] ?? undefined,
          mediaUrls: mediaUrls.length > 1 ? mediaUrls : undefined,
          asyncUpload: true,
        });

        const ids = this.extractExternalIds(publish.result);
        const postUrl = this.extractPostUrl(publish.result);

        await this.prisma.scheduledPost.update({
          where: { id: post.id },
          data: {
            status: ScheduledPostStatus.POSTED,
            externalReqId: ids.requestId,
            externalJobId: ids.jobId,
            externalPostUrl: postUrl,
          },
        });
      } catch {
        await this.prisma.scheduledPost.update({
          where: { id: post.id },
          data: { status: ScheduledPostStatus.FAILED },
        });
      }
    }

    return { processed: duePosts.length };
  }

  async getScheduledPost(user: User, postId: string) {
    return this.getOwnedPostOrThrow(postId, user);
  }

  async cancelScheduledPost(user: User, postId: string) {
    const post = await this.getOwnedPostOrThrow(postId, user);
    if (post.status !== ScheduledPostStatus.PENDING) {
      throw new BadRequestException("Only PENDING posts can be canceled");
    }
    return this.prisma.scheduledPost.update({
      where: { id: post.id },
      data: { status: ScheduledPostStatus.CANCELED },
    });
  }

  async reschedulePost(user: User, postId: string, scheduledAtInput: string) {
    const post = await this.getOwnedPostOrThrow(postId, user);
    if (post.status !== ScheduledPostStatus.PENDING) {
      throw new BadRequestException("Only PENDING posts can be rescheduled");
    }
    const scheduledAt = new Date(scheduledAtInput);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException("scheduledAt must be a valid ISO date");
    }
    if (scheduledAt <= new Date()) {
      throw new BadRequestException("scheduledAt must be in the future");
    }
    return this.prisma.scheduledPost.update({
      where: { id: post.id },
      data: { scheduledAt },
    });
  }

  async retryFailedPost(user: User, postId: string, scheduledAtInput?: string) {
    const post = await this.getOwnedPostOrThrow(postId, user);
    if (
      post.status !== ScheduledPostStatus.FAILED &&
      post.status !== ScheduledPostStatus.CANCELED
    ) {
      throw new BadRequestException(
        "Only FAILED or CANCELED posts can be retried",
      );
    }
    await this.enforceScheduleLimit(post.userId);

    const scheduledAt = scheduledAtInput
      ? new Date(scheduledAtInput)
      : new Date(Date.now() + 60_000);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
      throw new BadRequestException("scheduledAt must be a future ISO date");
    }

    return this.prisma.scheduledPost.create({
      data: {
        userId: post.userId,
        platform: post.platform,
        title: post.title,
        mediaUrl: post.mediaUrl,
        scheduledAt,
        status: ScheduledPostStatus.PENDING,
      },
    });
  }

  async getProviderCalendar(
    user: User,
    query: {
      platform?: string;
      month?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const username = this.uploadPostUsername(user);
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);

    let from = query.from;
    let to = query.to;

    if (query.month && !from && !to) {
      const [y, m] = query.month.split("-").map(Number);
      if (y && m >= 1 && m <= 12) {
        const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
        const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));
        from = start.toISOString();
        to = end.toISOString();
      }
    }

    const platform = query.platform
      ? this.normalizePlatform(query.platform)
      : undefined;

    const qs = new URLSearchParams();
    qs.set("user", username);
    qs.set("page", String(Number.isFinite(page) && page > 0 ? page : 1));
    qs.set("limit", String(Number.isFinite(limit) && limit > 0 ? limit : 20));
    if (platform) qs.set("platform", platform);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);

    const paths = [
      `/uploadposts/history?${qs.toString()}`,
      `/uploadposts/schedules?${qs.toString()}`,
      `/uploadposts/calendar?${qs.toString()}`,
      `/uploadposts/queue?${qs.toString()}`,
    ];

    const attempts: Array<{
      path: string;
      statusCode?: number;
      statusText?: string;
    }> = [];

    for (const path of paths) {
      try {
        const data = await this.api(path);
        return {
          success: true,
          sourcePath: path,
          data,
        };
      } catch (error) {
        if (error instanceof BadRequestException) {
          const res = error.getResponse() as Record<string, any>;
          attempts.push({
            path,
            statusCode: res?.statusCode,
            statusText: res?.statusText,
          });

          if (res?.statusCode && ![404, 405].includes(Number(res.statusCode))) {
            throw error;
          }
          continue;
        }
        throw error;
      }
    }

    throw new BadRequestException({
      message: "Could not fetch provider calendar/history from Upload-Post.",
      attempts,
      suggestion:
        "Check Upload-Post plan/docs and use the exact schedule/history endpoint for your account.",
    });
  }
  async getProviderCalendarLink(
    user: User,
    query: { platform?: string; redirectUrl?: string },
  ) {
    const platform = this.normalizePlatform(query.platform ?? "facebook");
    const redirectUrl =
      query.redirectUrl?.trim() ||
      this.configService.get<string>("UPLOAD_POST_CALENDAR_REDIRECT_URL") ||
      this.configService.get<string>("FRONTEND_URL") ||
      "http://localhost:5173/social/callback";

    const result = await this.createConnectLinkForUser(user, {
      platform,
      redirectUrl,
      showCalendar: true,
    });

    const connectObj =
      typeof result.connect === "object" && result.connect
        ? (result.connect as Record<string, unknown>)
        : {};

    const calendarLink =
      (connectObj.link as string | undefined) ||
      (connectObj.url as string | undefined) ||
      (connectObj.auth_url as string | undefined) ||
      (connectObj.redirect_url as string | undefined) ||
      null;

    return {
      success: true,
      username: result.username,
      platform,
      calendarLink,
      connect: result.connect,
    };
  }
  status(query: { jobId?: string; requestId?: string }) {
    if (!query.jobId && !query.requestId) {
      throw new BadRequestException("Provide jobId or requestId");
    }

    const qs = query.jobId
      ? `job_id=${encodeURIComponent(query.jobId)}`
      : `request_id=${encodeURIComponent(query.requestId as string)}`;

    return this.api(`/uploadposts/status?${qs}`);
  }
}
