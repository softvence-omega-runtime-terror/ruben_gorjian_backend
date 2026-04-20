/*
  Warnings:

  - A unique constraint covering the columns `[proposalId]` on the table `EnterprisePlanInvite` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `proposalId` to the `EnterprisePlanInvite` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "EnterpriseProposalStatus" AS ENUM ('PENDING', 'VIEWED', 'SIGNED_UP', 'EXPIRED', 'CANCELED');

-- AlterTable
ALTER TABLE "EnterprisePlanInvite" ADD COLUMN     "proposalId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "isCustomEnterprise" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EnterprisePlanProposal" (
    "id" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "socialPlatforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reelsPerMonth" INTEGER,
    "microReelsPerMonth" INTEGER,
    "proPhotoShootFrequency" TEXT,
    "proPhotoShootLength" TEXT,
    "captionHashtags" BOOLEAN,
    "scheduling" BOOLEAN,
    "quotedAmountCents" INTEGER NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "notes" TEXT,
    "status" "EnterpriseProposalStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "viewedAt" TIMESTAMP(3),
    "signedUpAt" TIMESTAMP(3),
    "createdUserId" TEXT,
    "createdByAdminId" TEXT NOT NULL,
    "createdByAdminEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnterprisePlanProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnterprisePlanProposal_planCode_key" ON "EnterprisePlanProposal"("planCode");

-- CreateIndex
CREATE INDEX "EnterprisePlanProposal_email_idx" ON "EnterprisePlanProposal"("email");

-- CreateIndex
CREATE INDEX "EnterprisePlanProposal_status_idx" ON "EnterprisePlanProposal"("status");

-- CreateIndex
CREATE INDEX "EnterprisePlanProposal_expiresAt_idx" ON "EnterprisePlanProposal"("expiresAt");

-- CreateIndex
CREATE INDEX "EnterprisePlanProposal_createdByAdminId_idx" ON "EnterprisePlanProposal"("createdByAdminId");

-- CreateIndex
CREATE UNIQUE INDEX "EnterprisePlanInvite_proposalId_key" ON "EnterprisePlanInvite"("proposalId");

-- AddForeignKey
ALTER TABLE "EnterprisePlanInvite" ADD CONSTRAINT "EnterprisePlanInvite_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "EnterprisePlanProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnterprisePlanProposal" ADD CONSTRAINT "EnterprisePlanProposal_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnterprisePlanProposal" ADD CONSTRAINT "EnterprisePlanProposal_createdUserId_fkey" FOREIGN KEY ("createdUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnterprisePlanProposal" ADD CONSTRAINT "EnterprisePlanProposal_planCode_fkey" FOREIGN KEY ("planCode") REFERENCES "Plan"("code") ON DELETE CASCADE ON UPDATE CASCADE;
