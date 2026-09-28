-- 005 derivación al negocio (data-model.md): columnas de contacto y paso previo en la
-- conversación, estado 'forwarded' de los mensajes y tablas handoff, handoff_notice y
-- handoff_alerts. 'forwarded' va en una sentencia propia y no se usa en esta migración.
CREATE TYPE "public"."handoff_action_via" AS ENUM('whatsapp', 'email');--> statement-breakpoint
CREATE TYPE "public"."handoff_end_cause" AS ENUM('business', 'inactivity', 'operator', 'playground');--> statement-breakpoint
CREATE TYPE "public"."handoff_kind" AS ENUM('person', 'unresolved', 'complaint');--> statement-breakpoint
CREATE TYPE "public"."handoff_notice_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."handoff_notice_type" AS ENUM('alert', 'reminder', 'forward');--> statement-breakpoint
CREATE TYPE "public"."handoff_route" AS ENUM('whatsapp', 'email', 'simulated');--> statement-breakpoint
CREATE TYPE "public"."handoff_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."handoff_summary_source" AS ENUM('model', 'fallback');--> statement-breakpoint
ALTER TYPE "public"."message_status" ADD VALUE 'forwarded';--> statement-breakpoint
CREATE TABLE "handoff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" "handoff_kind" NOT NULL,
	"status" "handoff_status" NOT NULL,
	"summary" text NOT NULL,
	"summary_source" "handoff_summary_source" NOT NULL,
	"token_hash" bytea NOT NULL,
	"token_enc" bytea NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_via" "handoff_action_via",
	"reminder_due_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_cause" "handoff_end_cause",
	CONSTRAINT "handoff_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "handoff_ended" CHECK (("handoff"."status" = 'ended') = ("handoff"."ended_at" is not null and "handoff"."end_cause" is not null)),
	CONSTRAINT "handoff_confirmed" CHECK (("handoff"."confirmed_at" is null) = ("handoff"."confirmed_via" is null))
);
--> statement-breakpoint
CREATE TABLE "handoff_alerts" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"whatsapp_phone" text,
	"email" text,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "handoff_alerts_singleton" CHECK ("handoff_alerts"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "handoff_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handoff_id" uuid NOT NULL,
	"type" "handoff_notice_type" NOT NULL,
	"route" "handoff_route" NOT NULL,
	"status" "handoff_notice_status" NOT NULL,
	"failure" text,
	"provider_ref" text,
	"messages_covered" smallint,
	"body" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "handoff_step" jsonb;--> statement-breakpoint
ALTER TABLE "handoff" ADD CONSTRAINT "handoff_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_notice" ADD CONSTRAINT "handoff_notice_handoff_id_handoff_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_one_active_per_conversation" ON "handoff" USING btree ("conversation_id") WHERE "handoff"."status" = 'active';--> statement-breakpoint
CREATE INDEX "handoff_status_reminder_idx" ON "handoff" USING btree ("status","reminder_due_at");--> statement-breakpoint
INSERT INTO "handoff_alerts" ("id") VALUES (1);
