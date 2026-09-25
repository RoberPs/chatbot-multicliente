-- 004 canal web (research R2, FR-005): se renombran y añaden columnas sin copiar datos; los
-- clientes y mensajes existentes quedan en el canal whatsapp con sus ids, estados y relaciones.
CREATE TYPE "public"."customer_channel" AS ENUM('whatsapp', 'web', 'playground');--> statement-breakpoint
ALTER TABLE "customer" RENAME COLUMN "phone" TO "channel_user_id";--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "channel" "customer_channel" DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer" ALTER COLUMN "channel" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "customer" DROP CONSTRAINT "customer_phone_unique";--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_channel_user_unique" UNIQUE("channel","channel_user_id");--> statement-breakpoint
ALTER TABLE "message" RENAME COLUMN "wa_message_id" TO "channel_message_id";--> statement-breakpoint
ALTER TABLE "message" RENAME CONSTRAINT "message_wa_message_id_unique" TO "message_channel_message_id_unique";--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "reply_trace" jsonb;--> statement-breakpoint
CREATE TABLE "web_chat_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"privacy_url" text,
	"daily_cap" integer DEFAULT 200 NOT NULL,
	"monthly_cap" integer DEFAULT 3000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "web_chat_settings_singleton" CHECK ("web_chat_settings"."id" = 1),
	CONSTRAINT "web_chat_settings_daily_cap" CHECK ("web_chat_settings"."daily_cap" >= 1),
	CONSTRAINT "web_chat_settings_monthly_cap" CHECK ("web_chat_settings"."monthly_cap" >= "web_chat_settings"."daily_cap")
);
--> statement-breakpoint
CREATE TABLE "web_usage_day" (
	"day" date PRIMARY KEY NOT NULL,
	"replies" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO "web_chat_settings" ("id") VALUES (1);
