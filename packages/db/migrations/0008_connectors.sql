CREATE TYPE "public"."connector_auth" AS ENUM('none', 'token', 'oauth');--> statement-breakpoint
CREATE TABLE "connector_account" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"connector_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"label" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "catalog_id" text;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "auth" "connector_auth" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "oauth_client_secret_enc" text;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "oauth_scopes" text;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "oauth_meta" jsonb;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "vision" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_account" ADD CONSTRAINT "connector_account_connector_id_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_account" ADD CONSTRAINT "connector_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_account_user_idx" ON "connector_account" USING btree ("connector_id","user_id");--> statement-breakpoint
UPDATE "connector" SET "auth" = 'token' WHERE "headers_enc" IS NOT NULL;
