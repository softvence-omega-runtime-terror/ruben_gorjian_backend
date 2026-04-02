DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CalendlySyncStatus') THEN
    CREATE TYPE "CalendlySyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');
  END IF;
END $$;

ALTER TABLE "Post"
  ADD COLUMN IF NOT EXISTS "calendlySyncStatus" "CalendlySyncStatus",
  ADD COLUMN IF NOT EXISTS "calendlyEventUri" TEXT,
  ADD COLUMN IF NOT EXISTS "calendlyInviteeUri" TEXT,
  ADD COLUMN IF NOT EXISTS "calendlySyncError" TEXT,
  ADD COLUMN IF NOT EXISTS "calendlyLastSyncedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Post_calendlySyncStatus_idx" ON "Post"("calendlySyncStatus");
