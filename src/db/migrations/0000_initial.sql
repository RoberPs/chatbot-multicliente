CREATE TYPE "public"."address_form" AS ENUM('informal', 'formal');--> statement-breakpoint
CREATE TYPE "public"."business_status" AS ENUM('draft', 'active');--> statement-breakpoint
CREATE TYPE "public"."handoff_channel_type" AS ENUM('phone', 'whatsapp', 'email');--> statement-breakpoint
CREATE TYPE "public"."price_type" AS ENUM('fixed', 'from', 'on_request');--> statement-breakpoint
CREATE TABLE "business" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"address" text,
	"directions" text,
	"phone" text,
	"email" text,
	"timezone" text NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "business_status" DEFAULT 'draft' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "business_singleton" CHECK ("business"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time(0) NOT NULL,
	"end_time" time(0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "business_hours_weekday" CHECK ("business_hours"."weekday" between 1 and 7),
	CONSTRAINT "business_hours_range" CHECK ("business_hours"."end_time" > "business_hours"."start_time")
);
--> statement-breakpoint
CREATE TABLE "closure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_time" time(0),
	"end_time" time(0),
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "closure_dates" CHECK ("closure"."end_date" >= "closure"."start_date"),
	CONSTRAINT "closure_both_times" CHECK (("closure"."start_time" is null) = ("closure"."end_time" is null)),
	CONSTRAINT "closure_times" CHECK ("closure"."start_time" is null or "closure"."end_time" > "closure"."start_time")
);
--> statement-breakpoint
CREATE TABLE "faq" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoff_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" smallint DEFAULT 1 NOT NULL,
	"type" "handoff_channel_type" NOT NULL,
	"value" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "handoff_channel_type_value_unique" UNIQUE("type","value")
);
--> statement-breakpoint
CREATE TABLE "handoff_contact" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "handoff_contact_singleton" CHECK ("handoff_contact"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "handoff_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" smallint DEFAULT 1 NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time(0) NOT NULL,
	"end_time" time(0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "handoff_hours_weekday" CHECK ("handoff_hours"."weekday" between 1 and 7),
	CONSTRAINT "handoff_hours_range" CHECK ("handoff_hours"."end_time" > "handoff_hours"."start_time")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"cancellation_text" text,
	"cancellation_notice_minutes" integer,
	"min_advance_minutes" integer,
	"max_advance_minutes" integer,
	"payment_methods" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "policies_singleton" CHECK ("policies"."id" = 1),
	CONSTRAINT "policies_notice" CHECK ("policies"."cancellation_notice_minutes" is null or "policies"."cancellation_notice_minutes" >= 0),
	CONSTRAINT "policies_min" CHECK ("policies"."min_advance_minutes" is null or "policies"."min_advance_minutes" >= 0),
	CONSTRAINT "policies_max" CHECK ("policies"."max_advance_minutes" is null or "policies"."max_advance_minutes" > 0),
	CONSTRAINT "policies_min_max" CHECK ("policies"."min_advance_minutes" is null or "policies"."max_advance_minutes" is null or "policies"."min_advance_minutes" <= "policies"."max_advance_minutes")
);
--> statement-breakpoint
CREATE TABLE "resource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_absence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_time" time(0),
	"end_time" time(0),
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "resource_absence_dates" CHECK ("resource_absence"."end_date" >= "resource_absence"."start_date"),
	CONSTRAINT "resource_absence_both_times" CHECK (("resource_absence"."start_time" is null) = ("resource_absence"."end_time" is null)),
	CONSTRAINT "resource_absence_times" CHECK ("resource_absence"."start_time" is null or "resource_absence"."end_time" > "resource_absence"."start_time")
);
--> statement-breakpoint
CREATE TABLE "resource_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time(0) NOT NULL,
	"end_time" time(0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "resource_hours_weekday" CHECK ("resource_hours"."weekday" between 1 and 7),
	CONSTRAINT "resource_hours_range" CHECK ("resource_hours"."end_time" > "resource_hours"."start_time")
);
--> statement-breakpoint
CREATE TABLE "resource_service" (
	"resource_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "resource_service_resource_id_service_id_pk" PRIMARY KEY("resource_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_type" "price_type" NOT NULL,
	"price_cents" integer,
	"duration_minutes" integer,
	"bookable" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "service_price" CHECK ("service"."price_cents" is null or "service"."price_cents" >= 0),
	CONSTRAINT "service_duration" CHECK ("service"."duration_minutes" is null or "service"."duration_minutes" between 1 and 1440)
);
--> statement-breakpoint
CREATE TABLE "tone" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"address_form" "address_form" NOT NULL,
	"style_description" text,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "tone_singleton" CHECK ("tone"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "handoff_channel" ADD CONSTRAINT "handoff_channel_contact_id_handoff_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."handoff_contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_hours" ADD CONSTRAINT "handoff_hours_contact_id_handoff_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."handoff_contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_absence" ADD CONSTRAINT "resource_absence_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_hours" ADD CONSTRAINT "resource_hours_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_service" ADD CONSTRAINT "resource_service_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_service" ADD CONSTRAINT "resource_service_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_name_lower_idx" ON "resource" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "service_name_lower_idx" ON "service" USING btree (lower("name"));