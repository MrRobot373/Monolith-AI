CREATE TYPE "public"."source_label" AS ENUM('confirmed', 'assumption', 'tbd');--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "temporary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "leaf_message_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "label" "source_label";--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "superseded_by_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_superseded_by_id_document_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_parent_id_message_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_parent_idx" ON "message" USING btree ("parent_id");--> statement-breakpoint
-- Existing chats are one straight line: each message's parent is the one before it.
UPDATE "message" m SET "parent_id" = p.prev FROM (
  SELECT "id", lag("id") OVER (PARTITION BY "chat_id" ORDER BY "created_at", "id") AS prev FROM "message"
) p WHERE p."id" = m."id" AND p.prev IS NOT NULL;--> statement-breakpoint
UPDATE "chat" c SET "leaf_message_id" = l."id" FROM (
  SELECT DISTINCT ON ("chat_id") "chat_id", "id" FROM "message" ORDER BY "chat_id", "created_at" DESC, "id" DESC
) l WHERE l."chat_id" = c."id";
