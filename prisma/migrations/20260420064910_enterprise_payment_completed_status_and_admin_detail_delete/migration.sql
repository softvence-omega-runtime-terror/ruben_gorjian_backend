-- AlterEnum
ALTER TYPE "EnterpriseInviteStatus" ADD VALUE 'PAYMENT_COMPLETED';

-- AlterEnum
ALTER TYPE "EnterpriseProposalStatus" ADD VALUE 'PAYMENT_COMPLETED';

-- AlterTable
ALTER TABLE "EnterprisePlanInvite" ADD COLUMN     "paidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EnterprisePlanProposal" ADD COLUMN     "paidAt" TIMESTAMP(3);
