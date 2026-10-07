CREATE TABLE "user_group" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"token_limit" bigint,
	"member_token_limit" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_group_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_group_member" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_group_member_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_group_model" (
	"group_id" text NOT NULL,
	"model_id" text NOT NULL,
	CONSTRAINT "user_group_model_group_id_model_id_pk" PRIMARY KEY("group_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_group_id_user_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_model" ADD CONSTRAINT "user_group_model_group_id_user_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_model" ADD CONSTRAINT "user_group_model_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ugm_user_idx" ON "user_group_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_group_time_idx" ON "usage_event" USING btree ("group_id","created_at");