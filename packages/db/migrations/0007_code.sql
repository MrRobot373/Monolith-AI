CREATE TYPE "public"."code_workspace_status" AS ENUM('ready', 'cloning', 'failed');--> statement-breakpoint
CREATE TABLE "code_user" (
	"user_id" text PRIMARY KEY NOT NULL,
	"uid" integer DEFAULT nextval('work_uid_seq') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_workspace" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"git_url" text,
	"status" "code_workspace_status" DEFAULT 'ready' NOT NULL,
	"error" text,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_task" ADD COLUMN "code_workspace_id" text;--> statement-breakpoint
ALTER TABLE "code_user" ADD CONSTRAINT "code_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_workspace" ADD CONSTRAINT "code_workspace_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_workspace" ADD CONSTRAINT "code_workspace_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_workspace_user_slug_idx" ON "code_workspace" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "code_workspace_ws_idx" ON "code_workspace" USING btree ("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "work_task" ADD CONSTRAINT "work_task_code_workspace_id_code_workspace_id_fk" FOREIGN KEY ("code_workspace_id") REFERENCES "public"."code_workspace"("id") ON DELETE cascade ON UPDATE no action;