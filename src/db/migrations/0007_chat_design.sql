-- 011 diseño del chat web (data-model.md §1): fila única del diseño (sin fila = aspecto original)
-- e imágenes por hueco, borradas en cascada con el diseño. Solo añade.
CREATE TABLE "chat_design" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"primary_color" text NOT NULL,
	"on_primary_color" text NOT NULL,
	"background_color" text NOT NULL,
	"text_color" text NOT NULL,
	"bot_bubble_color" text NOT NULL,
	"shape" text NOT NULL,
	"position" text NOT NULL,
	"size" text NOT NULL,
	"chat_name" text,
	"welcome_text" text,
	"placeholder_text" text,
	"send_label" text,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "chat_design_singleton" CHECK ("chat_design"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "chat_design_image" (
	"slot" text PRIMARY KEY NOT NULL,
	"design_id" smallint NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "chat_design_image_byte_size" CHECK ("chat_design_image"."byte_size" between 1 and 262144),
	CONSTRAINT "chat_design_image_dimensions" CHECK ("chat_design_image"."width" between 16 and 1024 and "chat_design_image"."height" between 16 and 1024)
);
--> statement-breakpoint
ALTER TABLE "chat_design_image" ADD CONSTRAINT "chat_design_image_design_id_chat_design_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."chat_design"("id") ON DELETE cascade ON UPDATE no action;