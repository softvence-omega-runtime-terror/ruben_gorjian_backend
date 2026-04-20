import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { authRouter } from "./modules/auth/routes";
import { billingRouter } from "./modules/billing/routes";
import { billingWebhook } from "./modules/billing/webhook";
import { errorHandler } from "./middleware/errorHandler";
import { uploadsRouter } from "./modules/uploads/routes";
import { aiRouter } from "./modules/ai/routes";
import { socialRouter } from "./modules/social/routes";
import { postsRouter } from "./modules/posts/routes";
import { enhancedPostsRouter } from "./modules/posts/enhanced-routes";
import { adminRouter } from "./modules/admin/routes";
import { adminPostRouter } from "./modules/admin/admin-post-routes";
import { contactRouter } from "./modules/contact/routes";
import { notificationsRouter } from "./modules/notifications/routes";
import { onboardingRouter } from "./modules/onboarding/routes";
import { router as brandRouter } from "./modules/brand/routes";
import { dashboardRouter } from "./modules/dashboard/routes";
import { settingsRouter } from "./modules/settings/routes";
import { billingSummaryRouter } from "./modules/billing/summary";
import { smtpTestRouter } from "./modules/smtp/smtp-test";
import submissionsRouter from "./modules/submissions/routes";
import adminSubmissionsRouter from "./modules/submissions/admin-routes";
import debugRouter from "./modules/debug/routes";
import { visitsRouter } from "./modules/visits/routes";
import { logger } from "./lib/logger";
import { uploadPostProviderRouter } from "./modules/providers/upload-post/routes";
import { schedulerRouter } from "./modules/scheduler/routes";
import { onlinePostRouter } from "./modules/onlinePost/onlinePost.route";
import { tiktokRoutes } from "./modules/onlinePost/tiktok/tiktok.routes";
import { virtualAdminRouter } from "./modules/admin/virtual-admin-routes";
import { adminOverviewRouter } from "./modules/admin/overview/routes";
import { faqRouter } from "./modules/faq/routes";
import { caseStudiesRouter } from "./modules/case-studies/routes";

export const app = express();

const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

// Rate limiting (disabled in development)
const limiter =
  env.NODE_ENV === "production"
    ? rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100,
        message: {
          error: "Too many requests from this IP, please try again later.",
        },
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => req.path === "/health" || req.path === "/auth/me",
        handler: (req, res, _next, options) => {
          const msg = options.message ?? { error: "Too many requests" };
          logger.warn("Rate limit hit", { path: req.path });
          res.status(options.statusCode ?? 429).json(msg);
        },
      })
    : noopLimiter;

const allowedOrigins = (env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Stripe webhook needs raw body
app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  billingWebhook,
);

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS origin not allowed"));
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json());
app.use(limiter); // Apply to all routes

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.use("/auth", authRouter);
app.use("/api/auth", authRouter);
app.use("/billing", billingRouter);
app.use("/billing", billingSummaryRouter);
// Also mount under /api/billing so frontend direct API_BASE_URL calls work (summary first so /summary and /invoices match)
app.use("/api/billing", billingSummaryRouter);
app.use("/api/billing", billingRouter);
app.use("/uploads", uploadsRouter);
app.use("/ai", aiRouter);
// Expose social routes under both /social and /api/social to align with OAuth redirect URLs
app.use(["/social", "/api/social"], socialRouter);
app.use("/posts", postsRouter);
app.use("/posts", enhancedPostsRouter);
app.use("/scheduler", schedulerRouter);
app.use("/api/scheduler", schedulerRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin", adminPostRouter);
app.use("/api/admin/overview", adminOverviewRouter);
app.use("/admin", adminRouter);
app.use("/admin", adminPostRouter);
app.use("/admin/overview", adminOverviewRouter);
app.use("/api/admin/virtual-admins", virtualAdminRouter);
app.use("/admin/virtual-admins", virtualAdminRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/contact", contactRouter);
app.use("/api/faq", faqRouter);
app.use("/api/case-studies", caseStudiesRouter);
app.use("/onboarding", onboardingRouter);
app.use("/brand", brandRouter);
app.use("/dashboard", dashboardRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/faq", faqRouter);
app.use("/case-studies", caseStudiesRouter);
app.use("/user/settings", settingsRouter);
app.use("/smtp-test", smtpTestRouter);
app.use("/api/submissions", submissionsRouter);
app.use("/api/admin/submissions", adminSubmissionsRouter);
app.use("/api/visits", visitsRouter);
if (env.NODE_ENV !== "production") {
  app.use("/api/debug", debugRouter);
}
app.use("/api/providers/upload-post", uploadPostProviderRouter);
app.use("/api/admin/upload-post", uploadPostProviderRouter);
app.use("/api/social-media", onlinePostRouter);
app.use("/api/tiktok", tiktokRoutes);
app.use(errorHandler);
