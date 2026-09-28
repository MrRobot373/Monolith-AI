CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."document_scope" AS ENUM('private', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."model_kind" AS ENUM('chat', 'embedding');--> statement-breakpoint
CREATE TABLE "chat_document" (
	"chat_id" text NOT NULL,
	"document_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_document_chat_id_document_id_pk" PRIMARY KEY("chat_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"scope" "document_scope" DEFAULT 'private' NOT NULL,
	"status" "document_status" DEFAULT 'processing' NOT NULL,
	"error" text,
	"page_count" integer,
	"chunk_count" integer,
	"char_count" integer,
	"embedding_model_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunk" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"document_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"page" integer,
	"content" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
	"embedding" vector
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "citations" jsonb;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "kind" "model_kind" DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "embedding_model_id" text;--> statement-breakpoint
ALTER TABLE "chat_document" ADD CONSTRAINT "chat_document_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_document" ADD CONSTRAINT "chat_document_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_ws_idx" ON "document" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "chunk_doc_idx" ON "document_chunk" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "chunk_tsv_idx" ON "document_chunk" USING gin ("tsv");