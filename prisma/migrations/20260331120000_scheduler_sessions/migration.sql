-- Create enums for unified scheduler session flow
CREATE TYPE "ScheduleType" AS ENUM ('POSTING', 'PHOTO_SESSION', 'VIDEO_SESSION');
CREATE TYPE "SessionStatus" AS ENUM ('BOOKED', 'COMPLETED', 'FAILED', 'CANCELED');

-- Extend Plan with DB-backed session entitlement + quota config
ALTER TABLE "Plan"
ADD COLUMN "photoSessionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "videoSessionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "photoSessionsPerPeriod" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "videoSessionsPerPeriod" INTEGER NOT NULL DEFAULT 0;

-- Extend Post to support two scheduler flows in same model
ALTER TABLE "Post"
ADD COLUMN "scheduleType" "ScheduleType" NOT NULL DEFAULT 'POSTING',
ADD COLUMN "sessionStatus" "SessionStatus",
ADD COLUMN "sessionTitle" TEXT,
ADD COLUMN "sessionNotes" TEXT,
ADD COLUMN "sessionDurationMinutes" INTEGER,
ADD COLUMN "sessionFailureReason" TEXT;

-- Useful indexes for scheduler queries
CREATE INDEX "Post_scheduleType_idx" ON "Post"("scheduleType");
CREATE INDEX "Post_sessionStatus_idx" ON "Post"("sessionStatus");
