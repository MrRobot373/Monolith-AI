CREATE TYPE "public"."document_kind" AS ENUM('file', 'note', 'answer');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('chat', 'edit');--> statement-breakpoint
CREATE TYPE "public"."project_visibility" AS ENUM('private', 'workspace');--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"color" text DEFAULT '190' NOT NULL,
	"description" text,
	"instructions" text,
	"visibility" "project_visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_member" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "project_role" DEFAULT 'chat' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "project_source" (
	"project_id" text NOT NULL,
	"document_id" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_source_project_id_document_id_pk" PRIMARY KEY("project_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "shared_to_project" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "kind" "document_kind" DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source" ADD CONSTRAINT "project_source_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source" ADD CONSTRAINT "project_source_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source" ADD CONSTRAINT "project_source_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_ws_idx" ON "project" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "psource_doc_idx" ON "project_source" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_project_idx" ON "chat" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_title_fts_idx" ON "chat" USING gin (to_tsvector('simple', "title"));--> statement-breakpoint
CREATE INDEX "message_fts_idx" ON "message" USING gin (to_tsvector('simple', "content"));