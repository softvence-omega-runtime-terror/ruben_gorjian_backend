-- Support multiple accepted terms IDs per billing quote
ALTER TABLE "BillingQuote"
ADD COLUMN "acceptedTermsJson" JSONB NOT NULL DEFAULT '[]';

UPDATE "BillingQuote"
SET "acceptedTermsJson" = jsonb_build_array("termsVersionId")
WHERE "termsVersionId" IS NOT NULL;

DROP INDEX IF EXISTS "BillingQuote_termsVersionId_idx";
ALTER TABLE "BillingQuote" DROP CONSTRAINT IF EXISTS "BillingQuote_termsVersionId_fkey";
ALTER TABLE "BillingQuote" DROP COLUMN IF EXISTS "termsVersionId";
