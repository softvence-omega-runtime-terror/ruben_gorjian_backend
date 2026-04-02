import express from "express";
import multer from "multer";
import { requireAuth } from "../../middleware/requireAuth";
import { requireAdmin } from "../../middleware/requireAdmin";
import { OnlinePostController } from "./onlinePost.controller";
import { ApiError } from "../../lib/errors";

const router = express.Router();
const controller = new OnlinePostController();

// const multipartUpload = multer({
//   storage: multer.memoryStorage(),
//   limits: {
//     files: 10,
//     fileSize: 100 * 1024 * 1024,
//   },
// });

const multipartUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 10, // max 10 files
  },
  fileFilter: (_req, file, cb) => {
    // Define allowed MIME types
    const imageMimes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const videoMimes = [
      "video/mp4",
      "video/quicktime",
      "video/mkv",
      "video/webm",
    ];

    // For demonstration, set max sizes
    const maxImageSize = 100 * 1024 * 1024; // 100MB
    const maxVideoSize = 200 * 1024 * 1024; // 200MB

    if (imageMimes.includes(file.mimetype)) {
      if (file.size > maxImageSize) {
        return cb(new ApiError(400, "Image size exceeds 100MB"));
      }
      return cb(null, true);
    } else if (videoMimes.includes(file.mimetype)) {
      if (file.size > maxVideoSize) {
        return cb(new ApiError(400, "Video size exceeds 200MB"));
      }
      return cb(null, true);
    } else {
      return cb(
        new ApiError(
          400,
          "Invalid file type. Only images and videos are allowed.",
        ),
      );
    }
  },
});

// Public
router.get("/me", controller.me);
router.post("/users", controller.createUser);
router.get("/status", controller.status);

// Authenticated (CUSTOMER/ADMIN)
router.post(
  "/platform/connect-link",
  requireAuth,
  controller.connectLinkForLoggedUser,
);
router.post(
  "/platform/disconnect",
  requireAuth,
  controller.disconnectLinkForLoggedUser,
);
router.post("/publish-now", requireAuth, controller.publishNow);
router.post(
  "/publish-now/form-data",
  requireAuth,
  multipartUpload.array("files", 10),
  controller.publishNowMultipart,
);
router.post("/calendar/schedule", requireAuth, controller.schedule);
router.get("/calendar/my", requireAuth, controller.myCalendar);
router.get("/calendar/:id", requireAuth, controller.getScheduledPost);
router.patch(
  "/calendar/:id/reschedule",
  requireAuth,
  controller.rescheduleScheduledPost,
);
router.delete("/calendar/:id", requireAuth, controller.cancelScheduledPost);
router.post("/calendar/:id/retry", requireAuth, controller.retryScheduledPost);
router.get(
  "/platform/get-all-performed-links",
  requireAuth,
  requireAdmin,
  controller.getAllPlatformLinks,
);
router.get(
  "/platform/get-all-posts",
  requireAuth,
  requireAdmin,
  controller.getAllPost,
);
router.get("/platform/my-links", requireAuth, controller.myPlatformLinks);
router.get(
  "/provider/calendar-link",
  requireAuth,
  controller.providerCalendarLink,
);
router.get("/provider/calendar", requireAuth, controller.providerCalendar);

// Admin
router.get(
  "/calendar/admin/client",
  requireAuth,
  requireAdmin,
  controller.clientCalendar,
);
router.patch("/admin/plan", requireAuth, requireAdmin, controller.updatePlan);

export { router as onlinePostRouter };
