-- CreateEnum
CREATE TYPE "EnterpriseInviteStatus" AS ENUM ('PENDING', 'VIEWED', 'SIGNED_UP', 'EXPIRED', 'CANCELED');

-- CreateTable
CREATE TABLE "EnterprisePlanInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "companyName" TEXT,
    "socialPlatforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reelsPerMonth" INTEGER,
    "microReelsPerMonth" INTEGER,
    "proPhotoShootFrequency" TEXT,
    "proPhotoShootLength" TEXT,
    "captionHashtags" BOOLEAN,
    "scheduling" BOOLEAN,
    "planCode" TEXT NOT NULL,
    "inviteToken" TEXT NOT NULL,
    "status" "EnterpriseInviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "viewedAt" TIMESTAMP(3),
    "signedUpAt" TIMESTAMP(3),
    "sentByAdminId" TEXT NOT NULL,
    "sentByAdminEmail" TEXT NOT NULL,
    "createdUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnterprisePlanInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnterprisePlanInvite_inviteToken_key" ON "EnterprisePlanInvite"("inviteToken");

-- CreateIndex
CREATE INDEX "EnterprisePlanInvite_email_idx" ON "EnterprisePlanInvite"("email");

-- CreateIndex
CREATE INDEX "EnterprisePlanInvite_planCode_idx" ON "EnterprisePlanInvite"("planCode");

-- CreateIndex
CREATE INDEX "EnterprisePlanInvite_status_idx" ON "EnterprisePlanInvite"("status");

-- CreateIndex
CREATE INDEX "EnterprisePlanInvite_expiresAt_idx" ON "EnterprisePlanInvite"("expiresAt");

-- CreateIndex
CREATE INDEX "EnterprisePlanInvite_sentByAdminId_idx" ON "EnterprisePlanInvite"("sentByAdminId");

-- AddForeignKey
ALTER TABLE "EnterprisePlanInvite" ADD CONSTRAINT "EnterprisePlanInvite_sentByAdminId_fkey" FOREIGN KEY ("sentByAdminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnterprisePlanInvite" ADD CONSTRAINT "EnterprisePlanInvite_createdUserId_fkey" FOREIGN KEY ("createdUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
