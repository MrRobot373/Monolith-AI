CREATE TYPE "public"."sso_type" AS ENUM('google', 'microsoft', 'oidc');--> statement-breakpoint
CREATE TABLE "license_state" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"instance_id" text NOT NULL,
	"last_check_in_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"release" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_connection" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"type" "sso_type" NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"tenant_id" text,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_join" boolean DEFAULT false NOT NULL,
	"default_workspace_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "sso_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_connection" ADD CONSTRAINT "sso_connection_default_workspace_id_workspace_id_fk" FOREIGN KEY ("default_workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;