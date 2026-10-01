CREATE TYPE "public"."license_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "admin_audit" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"admin_id" text,
	"action" text NOT NULL,
	"target" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_session" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_user" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "check_in" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"license_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"version" text,
	"active_seats" integer NOT NULL,
	"usage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"health" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"contact_email" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"customer_id" text NOT NULL,
	"tier" text NOT NULL,
	"seats" integer NOT NULL,
	"sections" text[] NOT NULL,
	"features" text[] NOT NULL,
	"model_mode" text DEFAULT 'self' NOT NULL,
	"workspace_limit" integer,
	"accent" text,
	"check_in_hours" integer DEFAULT 24 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "license_status" DEFAULT 'active' NOT NULL,
	"token" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"last_check_in_at" timestamp with time zone,
	"last_version" text,
	"active_seats" integer,
	"instance_id" text,
	"instance_conflict" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signing_key" (
	"kid" text PRIMARY KEY NOT NULL,
	"private_key_enc" text NOT NULL,
	"public_pem" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_admin_id_admin_user_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_admin_id_admin_user_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_license_id_license_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."license"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_in_license_idx" ON "check_in" USING btree ("license_id","created_at");--> statement-breakpoint
CREATE INDEX "license_customer_idx" ON "license" USING btree ("customer_id");