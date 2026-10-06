-- 012 protección frente a abuso y saturación (data-model.md §1): valores de enum, precios de
-- transcripción, contadores diarios de WhatsApp y de derivaciones, límites de derivación (fila
-- única) y columnas de control en conversation, handoff, model_usage y usage_settings. Solo añade.
-- Los valores de enum nuevos no se usan en esta migración (ADD VALUE no se puede usar en la misma
-- transacción que lo añade).
ALTER TYPE "public"."handoff_end_cause" ADD VALUE 'interrupted';--> statement-breakpoint
ALTER TYPE "public"."message_status" ADD VALUE 'held';--> statement-breakpoint
ALTER TYPE "public"."usage_purpose" ADD VALUE 'transcription';--> statement-breakpoint
CREATE TABLE "handoff_day" (
	"day" date PRIMARY KEY NOT NULL,
	"started" integer DEFAULT 0 NOT NULL,
	"refused" integer DEFAULT 0 NOT NULL,
	"notices" integer DEFAULT 0 NOT NULL,
	"notices_held" integer DEFAULT 0 NOT NULL,
	"refused_logged" boolean DEFAULT false NOT NULL,
	"held_logged" boolean DEFAULT false NOT NULL,
	CONSTRAINT "handoff_day_counters" CHECK ("handoff_day"."started" >= 0 and "handoff_day"."refused" >= 0 and "handoff_day"."notices" >= 0 and "handoff_day"."notices_held" >= 0)
);
--> statement-breakpoint
CREATE TABLE "handoff_limits" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"daily_max" integer DEFAULT 20 NOT NULL,
	"forward_interval_minutes" integer DEFAULT 15 NOT NULL,
	"notices_daily_max" integer DEFAULT 60 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "handoff_limits_singleton" CHECK ("handoff_limits"."id" = 1),
	CONSTRAINT "handoff_limits_daily_max" CHECK ("handoff_limits"."daily_max" between 1 and 200),
	CONSTRAINT "handoff_limits_interval" CHECK ("handoff_limits"."forward_interval_minutes" between 5 and 240),
	CONSTRAINT "handoff_limits_notices" CHECK ("handoff_limits"."notices_daily_max" between 10 and 500)
);
--> statement-breakpoint
CREATE TABLE "transcription_price" (
	"model" text PRIMARY KEY NOT NULL,
	"micros_per_minute" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "transcription_price_non_negative" CHECK ("transcription_price"."micros_per_minute" >= 0)
);
--> statement-breakpoint
CREATE TABLE "whatsapp_usage_day" (
	"day" date PRIMARY KEY NOT NULL,
	"replies" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "whatsapp_usage_day_replies" CHECK ("whatsapp_usage_day"."replies" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "batch_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "process_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handoff" ADD COLUMN "alerts_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handoff" ADD COLUMN "customer_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handoff" ADD COLUMN "last_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "audio_ms" integer;--> statement-breakpoint
ALTER TABLE "usage_settings" ADD COLUMN "whatsapp_daily_cap" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_settings" ADD COLUMN "whatsapp_cap_notified_day" date;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_batch_attempts" CHECK ("conversation"."batch_attempts" between 0 and 5);--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_audio_ms" CHECK ("model_usage"."audio_ms" is null or "model_usage"."audio_ms" >= 0);--> statement-breakpoint
ALTER TABLE "usage_settings" ADD CONSTRAINT "usage_settings_whatsapp_cap" CHECK ("usage_settings"."whatsapp_daily_cap" between 1 and 10000);--> statement-breakpoint
INSERT INTO "handoff_limits" ("id") VALUES (1);--> statement-breakpoint
UPDATE "handoff" SET
	"alerts_sent_at" = "handoff"."started_at",
	"customer_notified_at" = "handoff"."started_at",
	"last_notice_at" = coalesce(
		(SELECT max(n."created_at") FROM "handoff_notice" n WHERE n."handoff_id" = "handoff"."id"),
		"handoff"."started_at"
	);