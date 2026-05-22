/*
  Warnings:

  - You are about to drop the column `content` on the `CaseStudy` table. All the data in the column will be lost.
  - You are about to drop the column `createdByAdminId` on the `CaseStudy` table. All the data in the column will be lost.
  - You are about to drop the column `displayOrder` on the `CaseStudy` table. All the data in the column will be lost.
  - You are about to drop the column `summary` on the `CaseStudy` table. All the data in the column will be lost.
  - You are about to drop the column `updatedByAdminId` on the `CaseStudy` table. All the data in the column will be lost.
  - Added the required column `cycleTitle` to the `CaseStudy` table without a default value. This is not possible if the table is not empty.
  - Added the required column `location` to the `CaseStudy` table without a default value. This is not possible if the table is not empty.
  - Added the required column `logoUrl` to the `CaseStudy` table without a default value. This is not possible if the table is not empty.
  - Added the required column `structureTitle` to the `CaseStudy` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tagline` to the `CaseStudy` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "CaseStudy_createdAt_idx";

-- DropIndex
DROP INDEX "CaseStudy_displayOrder_idx";

-- DropIndex
DROP INDEX "CaseStudy_isActive_idx";

-- AlterTable
ALTER TABLE "CaseStudy" DROP COLUMN "content",
DROP COLUMN "createdByAdminId",
DROP COLUMN "displayOrder",
DROP COLUMN "summary",
DROP COLUMN "updatedByAdminId",
ADD COLUMN     "cycleTitle" TEXT NOT NULL,
ADD COLUMN     "images" TEXT[],
ADD COLUMN     "location" TEXT NOT NULL,
ADD COLUMN     "logoUrl" TEXT NOT NULL,
ADD COLUMN     "services" TEXT[],
ADD COLUMN     "structureItems" TEXT[],
ADD COLUMN     "structureTitle" TEXT NOT NULL,
ADD COLUMN     "tagline" TEXT NOT NULL,
ADD COLUMN     "videoTitle" TEXT,
ADD COLUMN     "videoUrl" TEXT;
