# Plan de despliegue a producción (2 instancias de prueba)

Documento de arranque para la próxima sesión. Recoge lo decidido el 2026-10-06, lo que falta por
decidir y el orden de trabajo. **Fase 0 hecha el 2026-10-07** (rama `015-despliegue-produccion`, etiqueta `v0.1.0`); aún no se
ha ejecutado nada contra Hetzner, Cloudflare ni ningún servidor. La receta técnica de referencia es la [sección 2.5 de operacion-multicliente.md](operacion-multicliente.md#25-despliegue).

## 1. Objetivo

Subir el chatbot a un entorno real para comprobar que todo funciona de punta a punta, antes de
venderlo:

- 2 instancias ficticias, cada una con su panel, su base de datos y sus secretos: una **agencia de
  viajes** y un **restaurante**.
- Un front de prueba (`globalviajes2`) con el chat web de la instancia de la agencia.
- Al terminar, una spec nueva de **modo oscuro del panel** (núcleo) para comprobar que se puede
  ampliar y actualizar las instancias ya desplegadas.

## 2. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Dominio | `automatizacionro.work` (Cloudflare, plan Free, límite de 200 registros DNS; usados: 1) |
| Raíz del dominio | Front de `globalviajes2`, en Cloudflare Pages, con el chat de la instancia 1 |
| Paneles y backend | Un subdominio por instancia, de **un solo nivel** (el certificado gratuito de Cloudflare no cubre dos) |
| Instancia 1 | Agencia de viajes, datos ficticios a partir de la homepage de `globalviajes2` |
| Instancia 2 | Restaurante, datos ficticios a partir de `ProjectoRestaurante` (carta, etc.) |
| Prueba del chat del restaurante | Página `test-restaurante.html` en el mismo proyecto de Pages, con su origen permitido en la instancia 2 |
| Servidor | VPS nuevo en una cuenta nueva de Hetzner, solo para el chatbot (el de n8n se abandona) |
| Tamaño | El más pequeño de 2 vCPU y 4 GB (CX22 o su equivalente actual en el catálogo) |
| Sistema | Ubuntu 24.04 |
| Base de datos | PostgreSQL 16 en el mismo VPS (Hetzner no ofrece PostgreSQL gestionado): una BD y un usuario por instancia |
| Red hacia la BD | **Socket Unix** en un volumen compartido (corrige la «ruta A» original: dentro de un contenedor `127.0.0.1` es el propio contenedor). `listen_addresses` vacío: la BD no escucha en ningún puerto. Aviso `database_localhost`, aceptado |
| Verificación de copias | Segundo Postgres solo para `db:verify`, con un único usuario `verificador` (`CREATEDB`) sin acceso a las bases de las instancias |
| Imagen | Se construye en el PC con Docker Desktop, se sube a GHCR privado y el VPS la descarga. Siempre `chatbot:X.Y.Z`, nunca `latest` |
| Proxy y HTTPS | Cloudflare con proxy (nube naranja), SSL **Full (strict)**, y Caddy en el VPS con Let's Encrypt |
| Copias | Cifradas con `BACKUP_KEY`: una local (7 días) y otra fuera del servidor (Storage Box de Hetzner) |
| Clave de Anthropic | La tuya, compartida por las 2 instancias. Con clientes reales, una por cliente |
| Modelo | Sonnet 5.5 (`claude-sonnet-5-5`); se actualiza `.env.example` en la fase 0 |
| WhatsApp | Implementado pero **apagado** hasta que un cliente lo pida |
| Audio | Apagado (`AUDIO_TRANSCRIPTION=off`) |
| Correo | **Brevo** con el dominio `automatizacionro.work` |
| Contacto de emergencia | Tu número real en las 2 instancias (fase 7) |
| Contraseñas | Una por instancia, en Bitwarden con 2FA con app |
| Monitorización | `/health`, `HEALTHCHECK` de la imagen y `pnpm instance:versions` |
| Cierre | Spec de modo oscuro cuando todo funcione |

### Sobre Brevo (SMTP)
- Sirve para 1 o para 10 clientes. El plan gratuito da **300 correos al día en total por cuenta**,
  no por cliente.
- Con una sola cuenta, cada instancia usa su propio `SMTP_FROM`. Si un cliente real genera mucho
  volumen, conviene su propia cuenta o un plan de pago.
- Hay que verificar el dominio en Brevo y crear en Cloudflare los registros que pida (SPF, DKIM y
  DMARC). Esos registros **no** deben ir con nube naranja.
- El formato de `SMTP_URL` está documentado en [.env.example](../.env.example) (líneas 60-70).
  Compruébalo antes de rellenarlo.

## 3. Arquitectura

| Dirección | Qué es |
|---|---|
| `automatizacionro.work` (y `www`) | Cloudflare Pages: front de `globalviajes2` con el chat de la instancia 1 |
| `viajes.automatizacionro.work` | VPS: instancia 1 (agencia). Panel en `/admin`, chat en `/chat` |
| `restaurante.automatizacionro.work` | VPS: instancia 2 (restaurante). Panel en `/admin` |
| `n8n.automatizacionro.work` | Registro `A` heredado de `91.99.98.230`. **Se elimina** (fase 5, con tu OK) |

```
Navegador ─► Cloudflare (proxy, TLS) ─► Caddy (VPS, :443) ─► 127.0.0.1:PORT ─► contenedor de la instancia
                                                                        │
                                                                        └─► PostgreSQL (127.0.0.1)
```

- Las instancias **no publican ningún puerto**: Caddy las alcanza por la red interna de Docker,
  que es la segunda vía que admite el paso 6 de la receta. Las dos usan `PORT=3000`. El VPS solo
  tiene escuchando el 80 y el 443 de Caddy.
- El chat se incrusta con `<script src="https://viajes.automatizacionro.work/chat/widget.js" defer>`.
- Los orígenes permitidos del chat se configuran **desde el panel** de cada instancia (máximo 10).
  La agencia permite `https://automatizacionro.work` (y `https://www.…` si se usa); el restaurante,
  el origen de la página de prueba.

## 4. Secretos y credenciales

Reglas: nada de esto va a git ni se pega en el chat. Los ficheros de entorno viven en el VPS fuera
del repositorio, con dueño `operador` y modo `0600` (receta, paso 2).

| Secreto | Cómo se obtiene | Dónde se guarda |
|---|---|---|
| Contraseña del operador (una por instancia) | La eliges; `pnpm operator:hash-password` genera el hash | Contraseña en Bitwarden; el hash en `OPERATOR_PASSWORD_HASH` |
| `SESSION_SECRET`, `HEALTH_SECRET`, `BACKUP_KEY` | `pnpm instance:new` | Fichero de entorno + Bitwarden (la `BACKUP_KEY` además, copia offline: sin ella las copias no se abren) |
| Usuario y contraseña de la BD de cada instancia | `pnpm instance:db` | Fichero de entorno + Bitwarden |
| Contraseña del `verificador` | La eliges al crear el rol | Bitwarden y `BACKUP_VERIFY_URL` |
| `INSTANCE_INVENTORY_KEY` | La eliges | Bitwarden. **Nunca en el VPS** |
| `ANTHROPIC_API_KEY` | Consola de Anthropic | Bitwarden y entorno de las 2 instancias. **Pon un límite de gasto mensual** |
| Credenciales SMTP de Brevo | Panel de Brevo | Bitwarden y entorno |
| Clave SSH privada | La generas en tu PC, con passphrase | Solo en tu PC (copia de seguridad cifrada aparte) |
| Token de GHCR | GitHub, con permiso solo de lectura de paquetes para el VPS | Bitwarden |
| Códigos de recuperación de 2FA | Hetzner, Cloudflare, GitHub, Bitwarden, Brevo | En papel |

### Variables por instancia (ver [.env.example](../.env.example))
- **Obligatorias**: `DATABASE_URL`, `OPERATOR_USER`, `OPERATOR_PASSWORD_HASH`, `SESSION_SECRET`,
  `PORT`, `TRUST_PROXY=1`, `NODE_ENV=production`, `PUBLIC_BASE_URL` (https del subdominio),
  `INSTANCE_ID`, `BACKUP_DIR`, `BACKUP_KEY`, `HEALTH_SECRET`, `ANTHROPIC_API_KEY`, `LLM_MODEL`,
  `EMERGENCY_CONTACT_PHONE`.
- **Regionales**: `DEFAULT_PHONE_REGION=ES`, `DEFAULT_TIMEZONE=Europe/Madrid`, `DEFAULT_CURRENCY=EUR`.
- **Correo**: `SMTP_URL`, `SMTP_FROM`.
- **Vacías o apagadas por ahora**: `WHATSAPP_*`, `STT_API_KEY`, `AUDIO_TRANSCRIPTION=off`.
- **Copias**: `BACKUP_VERIFY_URL` (segundo Postgres), `BACKUP_RETENTION_DAYS=7`.
- **Modelo decidido: Sonnet 5.5** (`LLM_MODEL=claude-sonnet-5-5`). `.env.example` trae hoy
  `claude-sonnet-5`, así que se cambia en la fase 0 (ver más abajo). Un nombre de modelo inexistente
  deja el bot sin respuesta.

## 5. Fases

Leyenda: **Yo** = Claude prepara ficheros y comprueba salidas. **Tú** = acción en cuentas o
servidores externos. Nada externo se ejecuta sin tu confirmación.

### Fase 0 · Preparación local (Yo; reversible) — **HECHA el 2026-10-07**
- [x] `pnpm lint && pnpm typecheck && pnpm test` en verde: 2028 unitarios y 629 de integración.
- [x] Modelo a Sonnet 5.5 en [.env.example](../.env.example), en el valor por defecto de
  `src/config/env.ts`, en sus tests y fixtures y en `README.md`. **Ojo**: `claude-sonnet-5` también
  existe y sigue en servicio, así que una errata en ese nombre **no da error**: responde el modelo
  anterior en silencio. Comprobado contra la API que `claude-sonnet-5-5` atiende y acepta los
  parámetros del núcleo (pensamiento adaptativo, `output_config` con `effort` y `json_schema`).
- [x] Etiqueta Git `v0.1.0` sobre la fusión de `015-despliegue-produccion`.
- [x] `docker build --build-arg CORE_VERSION=0.1.0 -t chatbot:0.1.0 .`: etiqueta OCI `0.1.0` y
  `HEALTHCHECK` sobre `dist/src/cli/healthcheck.js`.
- [x] Trivy, `pnpm audit --prod`, `osv-scanner` y `gitleaks` (resultados en la sección 8.1).
- [x] Imagen arrancada con la arquitectura de producción (socket Unix, contenedor endurecido):
  `healthy` en 12 s, 9 migraciones aplicadas, copia creada sola, `/health` con `{"status":"ok"}`,
  `/admin` redirige al login con cookie `HttpOnly; Secure; SameSite=Strict`, y `instance:check`
  **APTO con salida 0**.
- [x] Comprobado cómo se enlaza el puerto dentro del contenedor (sección 8).
- [x] `deploy/docker-compose.prod.yml` y `deploy/Caddyfile`, validados con `docker compose config`
  y `caddy validate`.

### Fase 1 · Cuentas (Tú, con mi guía)
- [ ] Bitwarden con 2FA con app; carpeta «chatbot».
- [ ] Hetzner (cuenta nueva; puede pedir verificación de identidad), 2FA.
- [ ] GitHub: repo privado del chatbot y GHCR; token de lectura de paquetes.
- [ ] Brevo: cuenta y verificación del dominio.
- [ ] Anthropic: límite de gasto mensual en la clave.
- [ ] Clave SSH con passphrase (`ssh-keygen -t ed25519`).

### Fase 2 · Servidor (Tú ejecutas, yo doy los comandos)
- [ ] Crear el VPS (Ubuntu 24.04) con la clave pública SSH.
- [ ] Usuario `operador` sin root; desactivar contraseña y login de root por SSH.
- [ ] Firewall de Hetzner: 22 (solo tu IP si es fija), 80 y 443; el 443 solo desde las IP de
  Cloudflare.
- [ ] Docker Engine 25 o posterior, swap, actualizaciones automáticas de seguridad.
- [ ] Comprobar: `ss -ltn` no muestra `0.0.0.0:3000`; `docker version` ≥ 25.

### Fase 3 · PostgreSQL (Tú ejecutas, yo preparo scripts)
- [ ] Postgres 16 ligado a `127.0.0.1`, con volumen persistente.
- [ ] Segundo Postgres para verificación, con el rol `verificador` (`CREATEDB`) y sin acceso a las
  bases de las instancias (receta, paso 8).

### Fase 4 · Instancias (Los dos)
- [ ] Inventario cifrado: `INSTANCE_INVENTORY` e `INSTANCE_INVENTORY_KEY` (la clave solo en Bitwarden).
- [ ] `pnpm instance:new --id viajes …` y `--id restaurante …`.
- [ ] `pnpm instance:db <id>` (con `--print-sql` si prefieres ejecutar el SQL tú).
- [ ] Completar el entorno y `pnpm instance:check <entorno>` hasta **APTO** con `salida 0`.

### Fase 5 · Red y HTTPS (Yo preparo, tú aplicas)
- [ ] Registros `A` en Cloudflare para `viajes` y `restaurante` hacia la IP del VPS, con proxy.
- [ ] **Con tu OK**: borrar el registro `n8n` y el servidor viejo, si ya no lo usas.
- [ ] Cloudflare: SSL **Full (strict)**.
- [ ] Caddy con certificado propio de Let's Encrypt, que **sustituye** `X-Forwarded-For` por
  `CF-Connecting-IP`.
- [ ] Prueba de la receta, paso 7: 31 peticiones con `X-Forwarded-For` falso dan `429` en la última;
  otra máquina sigue recibiendo `200`.

### Fase 6 · Arranque (Los dos)
- [ ] Subir la imagen a GHCR y bajarla en el VPS.
- [ ] Un contenedor por instancia con los parámetros endurecidos de la receta, paso 5.
- [ ] Comprobaciones de los pasos 5, 6 y 9: contenedor endurecido, puerto solo local y `healthy`.
- [ ] Entrar en `/admin` de cada instancia con la cookie `Secure`.

### Fase 7 · Datos ficticios (Yo preparo, tú revisas)
- [ ] Teléfono y correo reales de contacto y de avisos (los das aquí, no antes).
- [ ] Importar la configuración de la agencia (desde la homepage de `globalviajes2`) y del
  restaurante (desde la carta de `ProjectoRestaurante`), con la importación de `config-transfer`.
- [ ] Horarios, servicios y precios inventados; los revisas en el panel y activas cada negocio.
- [ ] Orígenes permitidos del chat web en cada instancia.
- [ ] Ningún nombre de sector o cliente en `src/`; los datos solo en `tests/fixtures/` o en la
  configuración de la instancia.

### Fase 8 · Frontend (Yo preparo, tú subes)
- [ ] **Copia** de `globalviajes2` en una carpeta nueva (los originales no se tocan).
- [ ] Añadir `<script src="https://viajes.automatizacionro.work/chat/widget.js" defer>`.
- [ ] Crear `test-restaurante.html` con el widget de la instancia 2.
- [ ] Cloudflare Pages: proyecto con la copia, dominio `automatizacionro.work` (y `www`).
- [ ] Teléfono y correo reales aparecen en la web, para comprobar los avisos.
- [ ] Comprobar en la consola del navegador que no hay errores de CORS ni contenido mixto.

### Fase 9 · Pruebas de punta a punta (Los dos)
- [ ] Chat de la agencia desde la raíz y del restaurante desde la página de prueba.
- [ ] Un mensaje que active el contacto de emergencia: aviso a tu teléfono.
- [ ] Un aviso por correo llega a tu correo real vía Brevo.
- [ ] `pnpm db:backup`, `pnpm db:verify <copia>` (`RESTAURABLE`) y `pnpm db:backups`.
- [ ] `pnpm instance:versions` muestra la versión real de las 2 instancias.
- [ ] Reinicio del servidor: las instancias vuelven solas (política de reinicio).
- [ ] Una instancia no ve datos de la otra.

### Fase 10 · Copias fuera del servidor (Los dos)
- [ ] Contratar una Storage Box de Hetzner (unos 4 €/mes) y copiar `BACKUP_DIR` con rsync o rclone
  por SSH, con una tarea programada.
- [ ] Probar una restauración completa en una BD temporal con la copia de la Storage Box.

### Fase 11 · Spec de modo oscuro (Yo)
- [ ] `/speckit-specify`: modo oscuro del panel (**núcleo**, afecta a todos los clientes).
- [ ] Plan, tareas, implementación, nueva etiqueta y despliegue sobre las 2 instancias.
- [ ] Actualizar `README.md` y `docs/operacion-multicliente.md` (§9.1 con fecha, §9.2, secciones
  de operación) según [CLAUDE.md](../CLAUDE.md). Avisar al usuario antes de tocar el README.

## 6. Qué tienes que traer a la próxima sesión
- Las cuentas de la fase 1 creadas, o ganas de crearlas con la guía.
- Tu IP pública fija, si la tienes (para limitar el SSH).
- Tu teléfono y correo reales (para la fase 7).

## 7. Riesgos y puntos a vigilar
- **IP real del cliente**: si Caddy añade en lugar de sustituir la cabecera, cualquiera se salta el
  límite de intentos del login. La prueba de las 31 peticiones es obligatoria.
- **`BACKUP_KEY` perdida = copias inservibles.** Guardarla en dos sitios.
- **Mismo disco no es copia**: sin la Storage Box, perder el VPS es perder todo.
- **Gasto de Anthropic**: una clave compartida por 2 instancias; poner un límite mensual.
- **Docker no reinicia un contenedor `unhealthy`**: mirar por qué antes de reiniciar (receta, paso 10).
- **Brevo gratuito**: 300 correos al día para todas las instancias que compartan la cuenta.
- **Servidor de n8n**: se pierde cuando borres la cuenta vieja; si hay algo que conservar, sácalo antes.
- **Origen del chat**: si el origen no está en la lista del panel, el widget no funciona (CORS).
- **Migraciones publicadas**: no se editan nunca; cualquier cambio de esquema es una migración nueva.

## 8. Comprobado en el código (resuelto en la fase 0)

| Pregunta | Respuesta |
|---|---|
| Dirección y puerto dentro del contenedor | `src/startup.ts` escucha en `0.0.0.0:${PORT}` y el `Dockerfile` hace `EXPOSE 3000`. **No se cambia `PORT`**: se publica con `-p 127.0.0.1:PUERTO:3000`, o nada en absoluto si el proxy va en la misma red de Docker |
| Formato de `SMTP_URL` y `SMTP_FROM` | `smtps://usuario:clave@host:465` o `smtp://usuario:clave@host:587` (STARTTLS); `SMTP_FROM` es una dirección simple. Van las dos o ninguna, y la vía email exige `PUBLIC_BASE_URL` |
| Página `/chat` propia | No hay. Existe el prefijo `/chat` con `/chat/widget.js` y `/chat/frame`: el chat se incrusta. Para el restaurante hace falta la página de prueba (fase 8) |
| Versión y etiquetas | `package.json` en `0.1.0`; no había ninguna etiqueta `v*`. La primera es `v0.1.0` |
| Otras referencias a `claude-sonnet-5` | Estaban en `.env.example`, el valor por defecto de `src/config/env.ts`, su test, los *fallbacks* de `tests/eval/`, fixtures de tests de LLM y `README.md`. Las specs de `002` se dejan como registro histórico |
| `LLM_EFFORT` con Sonnet 5.5 | Funciona sin cambios. Pero sus niveles están **recalibrados** respecto a Sonnet 5 y su valor por defecto es `high`, no `medium`: conviene revisar `LLM_EFFORT=medium` con `pnpm test:eval` |

### 8.1 Resultado de los análisis de seguridad

- `pnpm audit --prod`: sin vulnerabilidades.
- `osv-scanner`: 2 hallazgos, los dos **solo en dependencias de desarrollo** (`esbuild` por
  `drizzle-kit`, `source-map-js` por `vitest`). No viajan en la imagen: hay `pnpm prune --prod`.
  El criterio de la receta solo bloquea por dependencias de producción.
- `gitleaks`: 33 hallazgos, **los 33 falsos positivos**, revisados uno a uno: 31 son valores
  inventados en ficheros de test, uno es un ejemplo en `specs/007/.../inventory-format.md` y el de
  `src/provisioning/secrets.ts` es el alfabeto de generación de contraseñas. Conviene añadir un
  `.gitleaks.toml` que los permita, para que un hallazgo nuevo destaque en vez de perderse.
- Trivy: **17 altas o críticas corregibles**, que bloqueaban. Siete en `perl-base` (3 críticas) y
  una en `libpcre2-8-0`, del sistema base; diez en el `npm` incluido en la imagen.
  - **Subir el digest de `node:22-slim` no servía**: el que fija el `Dockerfile` ya era el último
    publicado, y la imagen al día arrastraba las mismas. La §5 de la guía da por hecho que
    actualizar el digest resuelve los hallazgos del sistema base; aquí el upstream iba por detrás
    de Debian.
  - Corregido en el `Dockerfile`: instalación de `perl-base=5.36.0-7+deb12u4` y
    `libpcre2-8-0=10.42-1+deb12u2` con versión exacta (si Debian las retira, la construcción falla
    ahí, a propósito), y borrado de `npm` y `npx`, que esa etapa no usa. **Trivy queda a 0.**
