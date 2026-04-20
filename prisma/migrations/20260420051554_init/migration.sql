/*
  Warnings:

  - You are about to drop the column `notes` on the `EnterprisePlanProposal` table. All the data in the column will be lost.
  - You are about to drop the column `quotedAmountCents` on the `EnterprisePlanProposal` table. All the data in the column will be lost.
  - Added the required column `amount` to the `EnterprisePlanProposal` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EnterprisePlanProposal" DROP COLUMN "notes",
DROP COLUMN "quotedAmountCents",
ADD COLUMN     "amount" DECIMAL(10,2) NOT NULL;
