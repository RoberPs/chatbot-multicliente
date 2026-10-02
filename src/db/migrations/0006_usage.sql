-- 010 consumo y coste por instancia (data-model.md §1): registro de consumo sin textos, precios
-- por modelo y ajustes de consumo (fila única, tope desactivado). Solo añade.
CREATE TYPE "public"."usage_purpose" AS ENUM('reply', 'handoff_summary');--> statement-breakpoint
CREATE TABLE "model_price" (
	"model" text PRIMARY KEY NOT NULL,
	"input_micros_per_mtok" bigint NOT NULL,
	"output_micros_per_mtok" bigint NOT NULL,
	"cache_write_micros_per_mtok" bigint NOT NULL,
	"cache_read_micros_per_mtok" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "model_price_non_negative" CHECK ("model_price"."input_micros_per_mtok" >= 0 and "model_price"."output_micros_per_mtok" >= 0 and "model_price"."cache_write_micros_per_mtok" >= 0 and "model_price"."cache_read_micros_per_mtok" >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"channel" "customer_channel" NOT NULL,
	"purpose" "usage_purpose" NOT NULL,
	"model" text NOT NULL,
	"calls" smallint NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cost_pico" bigint,
	"currency" char(3),
	CONSTRAINT "model_usage_calls" CHECK ("model_usage"."calls" >= 1),
	CONSTRAINT "model_usage_tokens" CHECK ("model_usage"."input_tokens" >= 0 and "model_usage"."output_tokens" >= 0 and "model_usage"."cache_write_tokens" >= 0 and "model_usage"."cache_read_tokens" >= 0),
	CONSTRAINT "model_usage_cost" CHECK ("model_usage"."cost_pico" is null or "model_usage"."cost_pico" >= 0),
	CONSTRAINT "model_usage_cost_currency" CHECK (("model_usage"."cost_pico" is null) = ("model_usage"."currency" is null))
);
--> statement-breakpoint
CREATE TABLE "usage_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"cap_enabled" boolean DEFAULT false NOT NULL,
	"monthly_cap_cents" integer,
	"cap_notified_month" date,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "usage_settings_singleton" CHECK ("usage_settings"."id" = 1),
	CONSTRAINT "usage_settings_cap" CHECK (not "usage_settings"."cap_enabled" or ("usage_settings"."monthly_cap_cents" is not null and "usage_settings"."monthly_cap_cents" > 0))
);
--> statement-breakpoint
CREATE INDEX "model_usage_day_idx" ON "model_usage" USING btree ("day");--> statement-breakpoint
INSERT INTO "usage_settings" ("id") VALUES (1);