ALTER TABLE "model" ADD COLUMN "query_prefix" text;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "document_prefix" text;--> statement-breakpoint
UPDATE "model" SET "query_prefix" = 'task: search result | query: ', "document_prefix" = 'title: {title} | text: ' WHERE "kind" = 'embedding' AND "model_key" ~* 'embedding-?gemma';
