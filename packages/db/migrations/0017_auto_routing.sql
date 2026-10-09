ALTER TABLE "chat" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "routing" jsonb;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "thinking_switch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "routing_settings" jsonb;--> statement-breakpoint
ALTER TABLE "work_task" ADD COLUMN "routing" jsonb;