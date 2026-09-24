CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'audio', 'other');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'answered', 'discarded', 'rate_limited', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transcription_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"greeted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"rate_limit_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"wa_message_id" text,
	"body" text,
	"other_type" text,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" "message_status" NOT NULL,
	"transcription" "transcription_status",
	"reply_id" uuid,
	CONSTRAINT "message_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_reply_id_message_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_customer_last_inbound_idx" ON "conversation" USING btree ("customer_id","last_inbound_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_last_message_idx" ON "conversation" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "message_conversation_sent_idx" ON "message" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "message_pending_idx" ON "message" USING btree ("conversation_id") WHERE "message"."direction" = 'inbound' and "message"."status" = 'pending';