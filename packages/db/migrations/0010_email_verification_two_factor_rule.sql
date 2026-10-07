ALTER TABLE "invitation" ADD COLUMN "emailed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "two_factor_required" boolean DEFAULT false NOT NULL;