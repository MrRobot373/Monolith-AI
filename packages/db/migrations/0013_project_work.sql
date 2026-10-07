ALTER TABLE "project" ADD COLUMN "connector_ids" text[];--> statement-breakpoint
ALTER TABLE "work_schedule" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "work_task" ADD COLUMN "shared_to_project" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "work_schedule" ADD CONSTRAINT "work_schedule_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_task_project_idx" ON "work_task" USING btree ("project_id");