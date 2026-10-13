-- 017 consumo no medido y «sin dato» (data-model.md §2). Dos partes, y la segunda es la ÚNICA
-- excepción de la feature a la convención de solo añadir.
--
-- 1) `unmeasured_calls` es aditiva pura: cuenta las llamadas con respuesta que no informaron ningún
--    token. No vale `calls = 0` como discriminador, porque la migración publicada 0006_usage.sql
--    tiene CHECK (calls >= 1) y una migración publicada no se edita nunca. Todo lo ya registrado
--    queda con `unmeasured_calls = 0`, que es exactamente lo que ocurrió: el histórico no se
--    reinterpreta.
--
-- 2) Se quita el NOT NULL de las dos columnas de caché. POR QUÉ: sin eso, los tres estados que
--    FR-024 exige distinguir no son representables. Con `integer NOT NULL`, «el proveedor no
--    informa de este concepto» y «el proveedor informa y fue cero» aterrizan los dos como `0`, son
--    indistinguibles, y la deducción que el panel necesita —«si en el periodo no hay ni una fila
--    que informe el concepto, sale sin dato»— es imposible de hacer. `unmeasured_calls` no cubre
--    este caso: cuenta llamadas sin NINGÚN dato de consumo, no distingue concepto por concepto.
--
--    Quitar un NOT NULL es una RELAJACIÓN, no una reescritura: no edita ninguna migración
--    publicada, no toca ni una fila existente y no pierde ningún dato; toda fila anterior conserva
--    su valor. Está acotada a estas dos columnas.
--
-- El CHECK `model_usage_tokens` NO se toca: comprueba `cache_write_tokens >= 0`, y con el valor a
-- NULL la expresión da NULL, que un CHECK acepta porque solo rechaza lo que es falso.
--
-- `formatVersion` de src/config-transfer/format.ts NO sube (FR-037): `model_usage` es registro de
-- consumo, no configuración del negocio, y no entra en la transferencia de configuración.

ALTER TABLE "model_usage" ALTER COLUMN "cache_write_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage" ALTER COLUMN "cache_read_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "unmeasured_calls" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_unmeasured" CHECK ("model_usage"."unmeasured_calls" >= 0 and "model_usage"."unmeasured_calls" <= "model_usage"."calls");