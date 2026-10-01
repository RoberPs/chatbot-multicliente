-- 008 exportar e importar la configuración (data-model.md §3): fila única con la configuración
-- que tenía la instancia justo antes de la última importación aplicada. Solo añade.
CREATE TABLE "config_pre_import" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"source_instance" text,
	CONSTRAINT "config_pre_import_singleton" CHECK ("config_pre_import"."id" = 1)
);
