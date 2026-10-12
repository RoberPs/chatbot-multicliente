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
| Servidor | VPS nuevo en una cuenta nueva de Hetzner, solo para el chatbot |
| Tamaño | El más pequeño de 2 vCPU y 4 GB (CX22 o su equivalente actual en el catálogo) |
| Sistema | Ubuntu 24.04 |
| Base de datos | PostgreSQL 16 en el mismo VPS (Hetzner no ofrece PostgreSQL gestionado): una BD y un usuario por instancia |
| Red hacia la BD | **Socket Unix** en un volumen compartido (corrige la «ruta A» original: dentro de un contenedor `127.0.0.1` es el propio contenedor). `listen_addresses` vacío: la BD no escucha en ningún puerto. Aviso `database_localhost`, aceptado |
| Verificación de copias | Segundo Postgres solo para `db:verify`, con un único usuario `verificador` (`CREATEDB`) sin acceso a las bases de las instancias |
| Imagen | Se construye en el PC con Docker Desktop, se sube a GHCR privado y el VPS la descarga. Siempre `chatbot:X.Y.Z`, nunca `latest` |
| Proxy y HTTPS | Cloudflare con proxy (nube naranja), SSL **Full (strict)**, y Caddy en el VPS con Let's Encrypt |
| Copias | Cifradas con `BACKUP_KEY`: una local (7 días) y otra fuera del servidor (Storage Box de Hetzner) |
| Clave de Anthropic | **Una por instancia** (dos claves de la misma organización). Corregido el 2026-10-08: compartirla deja la segunda instancia en NO APTO, porque el inventario trata un secreto repetido como error (`duplicate_secret`, ver fase 4) |
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
- **La cuenta ya existe y entra con SSO de Google.** Brevo documenta que su propio 2FA *se salta*
  cuando se entra con Google o Apple, así que el segundo factor efectivo es el de la cuenta de
  Google: ahí es donde tiene que estar activa la verificación en dos pasos y de donde salen los
  códigos de recuperación en papel. Activar el 2FA de Brevo solo aportaría algo añadiendo además una
  contraseña propia de Brevo y entrando por esa vía.
- Al ser una cuenta ya usada, el límite gratuito de 300 correos al día se comparte con lo que
  hubiera antes, y hay que mirar si el dominio ya estaba dado de alta para no duplicarlo.
- Servidor `smtp-relay.brevo.com`, puerto **587** (STARTTLS, o sea `smtp://`). El **login no es el
  correo de la cuenta**: Brevo asigna uno propio del tipo `XXXXXXXXX@smtp-brevo.com`, igual para
  todas las claves de la cuenta; lo que cambia por clave es la contraseña.
- **Una clave SMTP por instancia** (`chatbot-viajes`, `chatbot-restaurante`), para poder revocar la
  de un cliente sin dejar al otro sin avisos. El valor completo solo se ve al crearla.
- **El `@` del usuario**: `SMTP_URL` se lee con `new URL(...)` y la contraseña se pasa por
  `decodeURIComponent` (`src/config/secret-rules.ts:110`). La forma canónica es
  `smtp://XXXXXXXXX%40smtp-brevo.com:CLAVE@smtp-relay.brevo.com:587`. **Corregido el 2026-10-08**:
  escribir el `@` del login sin codificar **no rompe nada** (`new URL` parte el userinfo por el
  último `@` y el usuario por el primer `:`), así que esto no es causa de un fallo de
  autenticación. Lo que sí hay que codificar es un `@`, `:`, `/` o `%` dentro de la **clave**.
- **La clave son 90 caracteres y empieza por `xsmtpsib-`**, sin más símbolos que los guiones. En el
  panel aparece junto al servidor y es fácil copiar las dos cosas: si lo guardado acaba en
  `@smtp-relay.brevo.com`, sobra esa parte (ver fase 6).
- **Bloqueo por IP de las claves SMTP**: Brevo lo ofrece y conviene activarlo, pero **en la fase 6**,
  no antes. Primero el VPS arrancado, su IPv4 en «Seguridad → IPs autorizadas» y un correo de prueba
  que llegue; solo entonces «Activar para claves SMTP». Activarlo sin IP listada corta el envío.

## 3. Arquitectura

| Dirección | Qué es |
|---|---|
| `automatizacionro.work` (y `www`) | Cloudflare Pages: front de `globalviajes2` con el chat de la instancia 1 |
| `viajes.automatizacionro.work` | VPS: instancia 1 (agencia). Panel en `/admin`, chat en `/chat` |
| `restaurante.automatizacionro.work` | VPS: instancia 2 (restaurante). Panel en `/admin` |

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
| `ANTHROPIC_API_KEY` | Consola de Anthropic, **una clave por instancia** (`chatbot-viajes`, `chatbot-restaurante`) | Bitwarden y entorno de su instancia. El **límite de gasto no se pone en la clave**: se fija por *workspace* (siempre menor que el de la organización) o en la organización. Dos claves del mismo *workspace* comparten saldo y límite; lo que se gana es poder revocar la de un cliente sin dejar al otro sin bot. Una clave pertenece al *workspace* donde se crea y no se puede mover después |
| Credenciales SMTP de Brevo | Panel de Brevo | Bitwarden y entorno |
| Clave SSH privada | La generas en tu PC, con passphrase | Solo en tu PC (copia de seguridad cifrada aparte) |
| Token de GHCR | GitHub, con permiso solo de lectura de paquetes para el VPS | Bitwarden |
| Códigos de recuperación de 2FA | Hetzner, Cloudflare, GitHub, Bitwarden y **Google** (que es el 2FA efectivo de Brevo, ver §2.5) | En papel |

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

### Fase 1 · Cuentas (Tú, con mi guía) — **HECHA el 2026-10-07**
- [ ] Bitwarden con 2FA con app; carpeta «chatbot». Criterio: los códigos TOTP viven en la app del
  móvil, **no** en el campo «clave de autenticador» de la bóveda (si no, el segundo factor deja de
  serlo); cada secreto va en un **campo personalizado oculto** con el nombre exacto de su variable.
  **Rehecha el 2026-10-07**: se perdió la contraseña maestra de la primera cuenta, sin pista
  configurada y sin ninguna sesión abierta (ni extensión del navegador ni app del móvil), así que
  era irrecuperable — Bitwarden es de conocimiento cero y nadie puede descifrar la bóveda. Cuenta
  nueva en la región **EU** (`vault.bitwarden.eu`) con un alias `+bw` del correo, porque la vieja no
  se puede borrar sin su maestra. Medidas para que no se repita, todas obligatorias:
  - Maestra como **frase de 4-5 palabras sin relación**, no una cadena corta y compleja.
  - **Dos copias en papel** en sitios distintos de la casa, con la frase, el correo con alias y la
    región. La falta de esto fue la causa real de la pérdida.
  - **Pista configurada** (la cuenta anterior no la tenía: por eso el correo de pista nunca llegaba).
  - Código de recuperación del 2FA, también en papel.
  - **Extensión del navegador con PIN y app del móvil con biometría**, a propósito: una sesión viva
    es la única vía de rescate si se vuelve a olvidar la maestra.
  - La región se anota: pedir la pista en `vault.bitwarden.com` cuando la cuenta está en la `.eu`
    no da error, dice que la ha enviado igualmente y no llega nada.
- [x] Hetzner (cuenta nueva), 2FA. La verificación pedía tarjeta o documento: se hizo con **tarjeta
  y 25 € de saldo**, que no es una tasa sino prepago que se consume con las facturas (solo se
  reembolsa cerrando la cuenta entera; la recarga no lleva factura). Proyecto `chatbot` creado.
- [x] GitHub: repositorio privado `RoberPs/chatbot-multicliente` creado el 2026-10-07 con `main` y la
  etiqueta `v0.1.0` subidas (`origin` por https). Comprobado antes del push que no hay `.env` ni
  claves rastreadas; `.gitignore` cubre `.env*`, `*.pem`, `*.key`, `*.cbak` y `backups/`.
- [x] GitHub: **dos tokens clásicos para GHCR**, creados el 2026-10-07, que `gh` no puede crear (su
  token de sesión solo tiene `gist, read:org, repo, workflow`): `chatbot-ghcr-push` en el PC con
  `write:packages` (90 días) y `chatbot-ghcr-pull` para el VPS con **solo** `read:packages` (1 año).
  Imagen: `ghcr.io/roberps/chatbot-multicliente:X.Y.Z` (GHCR exige el usuario en minúsculas).
  - **El `docker login` falló con «Not enough memory resources are available to process this
    command»**, que no es un problema de Docker ni del token: el Administrador de credenciales de
    Windows estaba lleno. De 210 credenciales, 187 eran `vscodevscode.microsoft-authentication`,
    que la extensión de cuenta Microsoft de VS Code acumula por un fallo conocido. Borradas esas 187
    (quedaron 23), el login funcionó. Si vuelve a pasar, es lo primero que hay que mirar.
  - Se descartó quitar `"credsStore": "desktop"` del `~/.docker/config.json`: eso deja el token de
    escritura en GHCR en base64 en disco, legible por cualquiera con acceso al perfil.
- [x] Brevo: cuenta (ya existía, entra con SSO de Google) y dominio `automatizacionro.work`
  verificado el 2026-10-07. Registros publicados en Cloudflare y comprobados por DNS:
  - TXT `@` → `brevo-code:480512d5…` (propiedad del dominio)
  - TXT `@` → `v=spf1 include:spf.brevo.com mx ~all` (SPF)
  - TXT `_dmarc` → `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com`
  - CNAME `brevo1._domainkey` y `brevo2._domainkey` → `b{1,2}.automatizacionro-work.dkim.brevo.com`,
    con dos claves de 400 caracteres al final de la cadena.
  - **Brevo ya no usa el TXT `brevo._domainkey`** de la documentación antigua, sino esos dos CNAME.
    Buscar el nombre viejo lleva a creer que falta el DKIM cuando está puesto.
  - Los dos TXT de `@` se distinguen solo por su contenido, lo que despista al editarlos en
    Cloudflare: el del SPF es el que empieza por `v=spf1`.
- [x] Anthropic: límite de gasto mensual en la clave.
- [x] Clave SSH con passphrase, **regenerada el 2026-10-07**. La primera
  (`SHA256:D2HjePv+fltmoO2IvouUL5uh/5mH5codvP9ZWuABwZ8`) quedó inservible al perderse la bóveda de
  Bitwarden, que era el único sitio con su passphrase; como el VPS todavía no existía, salía más
  barato regenerar que intentar recuperarla. El par viejo quedó apartado en
  `~/.ssh/chatbot_vps.inutilizable.bak*` y su entrada se borró de Hetzner tras comprobar que su
  huella MD5 (`39:d3:16:…:bd:77`) era la que allí figuraba.
  - Par nuevo: `ssh-keygen -t ed25519 -f ~/.ssh/chatbot_vps -C "chatbot-vps"`, huella
    `SHA256:hcgXHO1pekkBNJJhRvSsSerCqdat9UckjrHf6qyaXTs`
    (MD5 `80:f1:8d:f8:97:a4:a5:82:55:4f:42:95:e6:a9:54:63`). Comprobado que la privada **no** abre
    con contraseña vacía (`ssh-keygen -y -P "" -f …` falla, que es lo que se busca).
  - La privada no sale del PC. La passphrase va en Bitwarden (elemento de **inicio de sesión**, campo
    oculto) **y en papel**: si se pierde otra vez la maestra, la bóveda se lleva la passphrase con
    ella.
  - **No se usa el tipo «Clave SSH» de Bitwarden**: guarda la clave privada dentro de la bóveda, de
    modo que perder la maestra sería perder también el acceso al servidor. Es el fallo del que
    venimos.

### Fase 2 · Servidor (Tú ejecutas, yo doy los comandos) — **HECHA el 2026-10-07**

> **Aquí se retoma.** Valores ya decididos para el formulario de Hetzner: ubicación **Falkenstein o
> Nuremberg** (UE, ~30-40 ms desde España); imagen **Ubuntu 24.04**; tipo **CX22** u otro **x86** de
> 2 vCPU y 4 GB — **nunca CAX (ARM)**, porque la imagen se construye en un PC x86 y no arrancaría;
> **IPv4 + IPv6** (la IPv4 la necesita el registro `A` de Cloudflare); clave **`chatbot-vps`**
> marcada, que es lo que evita que Hetzner genere contraseña de root. Sin copias de Hetzner (ya hay
> copias propias cifradas), sin volúmenes, sin *cloud config* y **sin cortafuegos todavía**.
>
> **IP pública: dinámica** (comprobado el 2026-10-07: `83.39.35.164`, cuyo PTR
> `164.red-83-39-35.dynamicip.rima-tde.net` lo dice explícitamente; Telefónica AS3352). El puerto 22
> no se puede atar a una IP concreta: se limita al rango `83.36.0.0/14` del operador y se refuerza
> con clave SSH obligatoria y `fail2ban`. Si el router cambia a una IP de otro rango, la consola web
> de Hetzner sigue dando acceso, así que la regla estrecha no deja a nadie fuera.

- [x] Crear el VPS (Ubuntu 24.04) con la clave pública SSH. Hecho el 2026-10-07: `chatbot-prod`,
  CX23 x86 (2 vCPU, 4 GB, 40 GB), Núremberg, `91.99.107.86` / `2a01:4f8:1c16:aa63::1`, 7,25 €/mes
  (6,64 del servidor + 0,61 de la IPv4). **El catálogo ya no tiene CX22**; el CX23 es su equivalente.
  Ojo en el formulario: la imagen que ofrece por defecto es **Ubuntu 26.04**, hay que bajarla a la
  24.04 en el desplegable de la tarjeta, y el nombre que propone describe el hardware
  (`ubuntu-4gb-nbg1-1`), no la función.
- [x] Usuario `operador` sin root; desactivar contraseña y login de root por SSH. Hecho con un
  fichero `/etc/ssh/sshd_config.d/00-endurecimiento.conf`: el prefijo `00-` es necesario porque en
  SSH **gana la primera aparición** de cada opción y la imagen trae un `50-cloud-init.conf`.
  Validado con `sshd -t` antes de recargar, y comprobado que root recibe `Permission denied` y
  `operador` sigue entrando **antes** de cerrar la sesión de root.
- [x] Swap de 2 GB (el servidor viene sin nada) con `vm.swappiness=10`, `unattended-upgrades`,
  `fail2ban` y Docker 29.8.2 desde el repositorio oficial.
  - **fail2ban en Ubuntu 24.04 necesita `backend = systemd`**: ya no existe `/var/log/auth.log`, los
    registros van a journald, y sin esa línea arranca sin vigilar nada.
  - **Incidente**: tras el reinicio, SSH dejó de responder (timeout) aunque el ping llegaba. No era
    un fallo de arranque — `ss -ltn` mostraba `0.0.0.0:22` escuchando y `ssh` activo —: **fail2ban
    había baneado la IP del propio administrador**. Con `maxretry = 4`, los intentos fallidos de las
    pruebas (el de root, que debía ser rechazado, más alguna passphrase mal tecleada) agotaron el
    margen. Se resolvió con `fail2ban-client set sshd unbanip <ip>` desde la consola web de Hetzner
    y se subió `maxretry` a 6. Síntoma distintivo: **timeout, no «connection refused»**, porque
    fail2ban descarta los paquetes en silencio.
  - Para entrar en la consola web hubo que generar una contraseña de root (pestaña **Rescue** o el
    icono del candado), porque ni `root` ni `operador` tienen contraseña. Se vuelve a bloquear
    después con `passwd -l root`.
  - Conviene usar `ssh-agent` (`eval $(ssh-agent)` + `ssh-add`) para no teclear la passphrase en
    cada conexión: es lo que provoca los baneos.
- [x] Firewall de Hetzner `chatbot-fw`, aplicado a `chatbot-prod` el 2026-10-07, con cuatro reglas de
  entrada (la salida queda abierta, que es el valor por defecto de Hetzner):
  - **TCP 22** solo desde `83.36.0.0/14`, el rango de Telefónica, por la IP dinámica. Sin IPv6: si
    alguna vez la conexión sale por IPv6, hay que forzar `ssh -4`.
  - **ICMP** desde `0.0.0.0/0` y `::/0`. Permitir el ping no añade riesgo y distingue «servidor
    caído» de «puerto bloqueado», que es justo lo que costó ver en el incidente de fail2ban.
  - **TCP 80** y **TCP 443** solo desde los 22 rangos de Cloudflare (15 IPv4 + 7 IPv6, de
    `curl -s https://api.cloudflare.com/client/v4/ips`). Así nadie alcanza el origen saltándose el
    proxy. Hay que meterlos **todos**: si falta alguno, Cloudflare entra por unas IP y por otras no,
    y el fallo sale intermitente.
  - Comprobado desde fuera: 22 responde desde la IP del administrador; 80 y 443 quedan filtrados.
- [x] `fail2ban` para el puerto 22, porque el rango permitido es amplio.
- [x] Comprobado: `ss -ltn` solo muestra el 22 y el 53 local de `systemd-resolved` —ningún
  `0.0.0.0:3000`, que es lo esperado porque todavía no hay instancias— y `docker version` da
  **29.8.2**, muy por encima del 25 que pide la receta.

### Fase 3 · PostgreSQL (Tú ejecutas, yo preparo scripts) — **HECHA el 2026-10-07**

Todo en un script idempotente, [deploy/fase3-postgres.sh](../deploy/fase3-postgres.sh), que crea la
estructura, los entornos de los dos clústeres, los arranca, crea el rol `verificador` y comprueba lo
que no puede fallar. No toca nada que ya exista: si un fichero de entorno está, no regenera su
contraseña, lo que permite relanzarlo las veces que haga falta. Al VPS se llevan solo los tres
ficheros de `deploy/` (el repositorio entero no hace falta: la imagen viene de GHCR y no se
construye allí), a `~/deploy` con `scp` y de ahí a `/srv/chatbot/deploy/`.

El script usa `sudo docker` y **no** se añade `operador` al grupo `docker`: pertenecer a ese grupo
equivale a ser root sin pasar por `sudo` ni dejar rastro en sus registros. Todas las órdenes de
Docker de las fases siguientes van con `sudo`.

- [x] Postgres 16 **sin TCP** (`listen_addresses` vacío, socket Unix en el volumen `pg-socket`), con
  volumen persistente. Corrige la «ruta A» original: `127.0.0.1` dentro de un contenedor es el
  propio contenedor.
- [x] Segundo Postgres para verificación, con el rol `verificador` (`CREATEDB`) y sin acceso a las
  bases de las instancias (receta, paso 8); las de producción están en **otro clúster**, cuyo socket
  no se monta en su contenedor.
- [x] Directorios de copias `0700` con dueño UID 1000 (receta, paso 3) y ficheros de entorno `0600`
  con dueño `operador` (paso 2).
- [x] Marcadores vacíos de `instancia-1.env`, `instancia-2.env` (fase 4) y `caddy.env` (fase 5):
  **el compose carga todos los `env_file` del proyecto aunque solo se arranque un servicio**, así
  que sin ellos ni `docker compose config` pasa. Comprobado en local antes de subirlo.
- [x] Comprobaciones, todas en verde en la ejecución final:
  - `listen_addresses` vacío y `password_encryption=scram-sha-256` en los dos clústeres.
  - **`pg_hba.conf` sin ninguna regla `trust`.** Es la crítica: `POSTGRES_INITDB_ARGS` solo actúa en
    el primer arranque, y si el volumen ya existía, `initdb` dejó `local all all trust` y cualquier
    contenedor que monte el socket entraría como superusuario sin contraseña.
  - `verificador` con `CREATEDB` pero sin `SUPERUSER` ni `CREATEROLE`.
  - Ningún puerto publicado por los contenedores y nada escuchando en el `5432` del anfitrión. A la
    escucha quedan solo `0.0.0.0:22`, `[::]:22` y el `53` local de `systemd-resolved`.
- [x] A Bitwarden: las dos `POSTGRES_PASSWORD`, la del `verificador` y la `BACKUP_VERIFY_URL`
  completa.

**Lo que salió mal, para no repetirlo:**

- **Las órdenes `ssh`/`scp` se lanzan desde el PC, no dentro del VPS.** Pegadas en la sesión del
  servidor, este intenta conectarse a sí mismo y pide aceptar su propia huella. Regla simple: si el
  comando empieza por `ssh` o `scp`, va en el PC; si no, dentro del servidor.
- `ssh -i $env:USERPROFILE\.ssh\chatbot_vps` es sintaxis de **PowerShell**; en Git Bash la ruta es
  `~/.ssh/chatbot_vps`. Con la forma equivocada, `ssh` avisa de que no puede leer la clave y acaba en
  `Permission denied (publickey)`, que despista hacia el servidor. Un `~/.ssh/config` con un alias
  `Host vps` evita el problema en las dos terminales.
- **`Connection closed by … port 22` es la passphrase mal tecleada**, no un baneo ni un fallo de
  configuración: el servidor cierra tras agotar los intentos de esa conexión. Se distingue con
  `ssh -v`, que muestra `Server accepts key` justo antes. Un baneo de fail2ban da **timeout**.
- El `sudo` del servidor no pide contraseña, así que `ssh -t` no hizo falta al final; se deja porque
  no estorba y sin terminal `sudo` fallaría con «no tty present».
- **Dos errores míos en las comprobaciones del script**, los dos corregidos y vueltos a pasar:
  `rolcreatedb || ' ' || rolsuper` en PostgreSQL da `true false false`, no `t f f`; y
  `.NetworkSettings.Ports` muestra `{"5432/tcp":null}` por el `EXPOSE` de la imagen, con `null` por
  enlace, así que un puerto publicado se comprueba con `docker port`, que no imprime nada cuando no
  hay ninguno.
- **Rotación de contraseñas.** Las primeras se pegaron en el chat en una captura, así que se
  rotaron: `docker compose down -v`, borrar los dos `.env` y relanzar. Es gratis mientras no haya
  datos, pero **a partir de la fase 4 ese `-v` borraría las bases de las instancias**. La del
  `verificador` no vive en ningún fichero (el servidor solo guarda su verificador SCRAM), así que
  perderla obliga a un `ALTER ROLE verificador PASSWORD …` con una nueva; se comprueba con
  `psql -U verificador -d postgres -c 'select current_user'`.

**Dos avisos para la fase 4**, consecuencia del socket Unix:

- `pnpm instance:db` **no puede conectar desde el PC**, porque el clúster no escucha en ningún
  puerto. Se usa `--print-sql` y el SQL se aplica en el VPS por el socket.
- La `DATABASE_URL` que escribe es de TCP (`buildDatabaseUrl` pone el servidor como nombre de
  host); hay que dejarla a mano en forma de socket, que el núcleo clasifica como local
  (`src/config/database-url.ts`):
  `postgres://chatbot_<id>:<clave>@/chatbot_<id>?host=/var/run/postgresql`

### Fase 4 · Instancias (Los dos) — **HECHA el 2026-10-08**

> **Terminal del PC: Git Bash**, decidido el 2026-10-08 tras mezclar las dos sintaxis. Ahí la
> clave es `~/.ssh/chatbot_vps` (no `$env:USERPROFILE\.ssh\…`, que es de PowerShell y da
> «Permission denied (publickey)» despistando hacia el servidor), el proyecto está en
> `/c/Rober/.../chatbotasesor`, la clave del inventario se pone con
> `export INSTANCE_INVENTORY_KEY=…` y las redirecciones con `>` salen en UTF-8 sin BOM y con
> saltos de línea Unix, que es justo lo que no hacía PowerShell.
>
> **Aquí se retoma.** Decidido el 2026-10-07: inventario en la **ruta por defecto**
> (`~/.chatbotasesor/inventory.json`, en el PC; en Windows,
> `C:\Users\makor\.chatbotasesor\`), identificadores **`viajes`** y **`restaurante`**, y sin
> `--whatsapp`. Nada de esto está ejecutado todavía.

- [x] Inventario cifrado: lo crea la primera `instance:new` al escribir `crear`. La
  `INSTANCE_INVENTORY_KEY` se muestra **una sola vez** → Bitwarden, **nunca al VPS**; hay que
  exportarla en la terminal antes de la segunda alta y de cualquier orden posterior.
- [x] Las dos altas, en una terminal sin redirigir la salida (muestra secretos una vez):

  ```bash
  pnpm instance:new --id viajes --client "Agencia de viajes (prueba)" --url https://viajes.automatizacionro.work \
    --timezone Europe/Madrid --region ES --currency EUR --emergency-phone "+34 600 000 000"
  pnpm instance:new --id restaurante --client "Restaurante (prueba)" --url https://restaurante.automatizacionro.work \
    --timezone Europe/Madrid --region ES --currency EUR --emergency-phone "+34 600 000 000"
  ```

  `--emergency-phone` lleva un número de relleno: es obligatorio y debe ser E.164 válido. El real
  se puede poner ya, editando `EMERGENCY_CONTACT_PHONE` en el fichero de cada instancia: no se
  huella en el inventario, así que cambiarlo a mano no afecta ni al inventario ni a
  `instance:check`. Mejor por el fichero que por `--emergency-phone`, que dejaría el número en el
  historial de la terminal. A Bitwarden, de cada instancia: contraseña del operador y
  `BACKUP_KEY` (esta además, copia fuera).
- [x] `pnpm instance:db <id> --print-sql --host localhost --port 5432`: **no puede conectar desde el
  PC**, porque el clúster solo escucha en el socket Unix. `--print-sql` **exige `--host` y
  `--port`** (si no, falla con `print_sql_needs_host`); se le dan `localhost` y `5432`, que son los
  que quedan anotados en el inventario y describen bien un socket local. La orden escribe la
  `DATABASE_URL` en el entorno, anota la instancia en el inventario e imprime el SQL, que lleva el
  **verificador SCRAM, nunca la contraseña**: se puede guardar en un fichero y copiar al VPS.
  - **Se ejecuta una sola vez por instancia**: cada ejecución genera una contraseña distinta y la
    segunda falla con `database_already_registered`, así que el SQL hay que aplicarlo tal cual.
  - **Dos trampas al guardarlo en Windows, las dos vistas el 2026-10-08.** La primera: el `>` de
    PowerShell 5.1 escribe UTF-16 y `Out-File -Encoding utf8` añade BOM; se usa
    `| Set-Content -Encoding ascii` (el SQL es ASCII salvo dos tildes de un comentario). La
    segunda, que sí ocurrió: **pnpm imprime su cabecera (`> paquete@version script`) por la salida
    estándar** y acaba dentro del fichero, donde `psql` falla en la primera línea. Como el SQL no
    se puede regenerar, las dos líneas se quitan a mano. El script de la fase 4 rechaza las dos
    cosas antes de tocar la base de datos.
- [x] Aplicar el SQL en el VPS por el socket con
  [deploy/fase4-bases-datos.sh](../deploy/fase4-bases-datos.sh) (`crear`), que comprueba antes que
  el SQL es el de esa instancia y que ni el rol ni la base existen, y después que el usuario no es
  superusuario, que la base es suya y que `PUBLIC` no puede conectarse.
- [x] Dejar la `DATABASE_URL` en forma de socket, que el núcleo clasifica como local
  (`src/config/database-url.ts`), conservando la contraseña que escribió `instance:db`:
  `postgres://chatbot_<id>:<clave>@/chatbot_<id>?host=/var/run/postgresql`
  - Comprobado el 2026-10-08 en local, con el ciclo completo (alta, `instance:db --print-sql`,
    cambio a socket y `check`): el entorno sigue dando **APTO con salida 0**. El cambio a mano no
    descoloca el inventario, porque la instancia se sigue reconociendo por las huellas que no
    cambian (la de la contraseña de la base, entre otras) y una URL de socket no produce huella de
    servidor (`databaseIdentity` devuelve `null` sin nombre de host). No hace falta
    `instance:sync`.
- [x] Completar el entorno. `instance:new` ya deja puestos `LLM_MODEL=claude-sonnet-5-5`,
  `TRUST_PROXY=1`, `AUDIO_TRANSCRIPTION=off`, `PORT=3000`, `BACKUP_DIR` y
  `BACKUP_RETENTION_DAYS=7`; a mano quedan solo las que marca como `# PENDIENTE` más
  `BACKUP_VERIFY_URL`, que la plantilla deja vacía: la de la fase 3 (en Bitwarden), la
  `ANTHROPIC_API_KEY` **propia de esa instancia** y el correo:

  ```
  SMTP_URL=smtp://882a5d001%40smtp-brevo.com:<clave>@smtp-relay.brevo.com:587
  ```

  **Cuidado al editar el entorno desde PowerShell**: `[System.IO.File]::WriteAllLines` escribe los
  saltos de línea de Windows (CRLF), y el `env_file` de Docker puede dejar entonces un `\r` al
  final de cada valor; pegado a la `DATABASE_URL` da un fallo de conexión ilegible.
  `instance:check` no lo detecta (dio APTO con el fichero en CRLF). Se arregla con
  `sed -i 's/\r$//'` y se comprueba con `tr -cd '\r' < fichero | wc -c`, que tiene que dar 0.
  **No sirve `grep -c '\r'`**: en grep básico `\r` es la letra `r` y cuenta casi todas las líneas.

  El `@` del login va como `%40` o `new URL(...)` parte mal la cadena
  (`src/config/secret-rules.ts:110`). Una clave SMTP por instancia, las dos ya creadas en Brevo y
  guardadas en Bitwarden.
- [x] `pnpm instance:check <entorno>` hasta **APTO** con `salida 0`, con la
  `INSTANCE_INVENTORY_KEY` exportada. Las **dos advertencias esperadas** (no bloquean) son
  `database_localhost`, ya aceptada en §2, y la de `WHATSAPP_*` vacías.
- [x] Subir los dos entornos al VPS como `/srv/chatbot/instancia-1.env` (viajes) y
  `instancia-2.env` (restaurante), sustituyendo los marcadores vacíos de la fase 3, con dueño
  `operador` y modo `0600`.
- [x] Con el entorno ya subido, `fase4-bases-datos.sh probar <id> <entorno>`: comprueba que el
  usuario entra por el socket con su contraseña y que no puede conectarse a la base de la otra
  instancia (adelanta la comprobación de aislamiento de la fase 9).

**Dos cosas comprobadas en local el 2026-10-08, antes de ejecutar nada:**

- **Una `ANTHROPIC_API_KEY` repetida es error, no aviso.** El inventario compara las huellas de los
  secretos y da `duplicate_secret`, así que con la clave compartida `instance:check restaurante`
  sale **NO APTO con salida 1** aunque la instancia arrancaría igual (el arranque no consulta el
  inventario). De ahí la corrección de §2: **una clave por instancia**. Lo mismo valdría para
  `SESSION_SECRET`, `BACKUP_KEY` o `HEALTH_SECRET`, que ya genera distintos `instance:new`.
- **`BACKUP_DIR` igual en las dos es solo una advertencia** (`shared_backup_dir`), y aquí es
  inofensiva: las dos valen `/var/lib/chatbot/backups`, que es la ruta **dentro** del contenedor, y
  el compose monta en ella un directorio distinto del anfitrión por instancia
  (`/srv/chatbot/instancia-{1,2}/backups`). El inventario no puede saberlo: compara rutas.

**Brevo, comprobado el 2026-10-07** en el panel: las dos claves existen y están **activas**,
`chatbot-viajes` y `chatbot-restaurante`, con caducidad el 7 de octubre de 2027. Servidor
`smtp-relay.brevo.com`, puerto `587`, login común `882a5d001@smtp-brevo.com`; lo que cambia por
clave es la contraseña. El bloqueo por IP sigue **desactivado**, que es lo correcto hasta la fase 6.

**Lo que salió mal en la fase 4, para no repetirlo:**

- **Mezclar PowerShell y Git Bash.** De ahí la decisión de arriba: todo el trabajo del PC va en
  Git Bash. `$env:USERPROFILE\.ssh\…` en Git Bash da «Permission denied (publickey)», que parece
  un problema del servidor y no lo es; y `pnpm` lanzado desde `C:\Users\makor` falla con
  `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`, porque el repositorio está en otro sitio.
- **La `INSTANCE_INVENTORY_KEY` vive en la ventana, no en el disco.** Al cambiar de terminal,
  `instance:check` dejó de comparar y daba NO APTO por `inventory_key_missing`. Se reconoce en la
  primera línea del resultado: «sin comparar con otras instancias» en vez de «comparado con 1».
- **pnpm escribe su cabecera en la salida estándar** y se coló dentro de los dos `.sql`. Como el
  SQL no se puede regenerar, hubo que quitar esas dos líneas a mano.
- **`[System.IO.File]::WriteAllLines` escribe CRLF**, que el `env_file` de Docker puede dejar
  pegado al final de cada valor. No lo detecta `instance:check`.
- **Dos errores míos en las comprobaciones, los mismos de siempre con los booleanos.**
  `psql -tA` imprime `t`, no `false`, salvo que se concatene o se pida `::text`; y
  `has_database_privilege('public', …)` **no vale** para saber si PUBLIC puede conectarse, porque
  `public` no es un rol: hay que mirar el ACL de la base (`datacl`), contando además el caso de
  `datacl` nulo, que son los permisos por omisión y también dejan entrar. El `REVOKE` estaba bien
  desde el principio. Por eso las comprobaciones viven ahora en un subcomando propio,
  `comprobar <id>`, que solo lee y se puede repetir: `crear` no se puede relanzar.

### Fase 5 · Red y HTTPS (Yo preparo, tú aplicas) — **HECHA el 2026-10-08**

> **Corrección de orden, descubierta al empezar.** La fase 5 **no se puede cerrar sin arrancar
> las instancias**: la prueba del paso 7 va contra el `/health` de la instancia, y además
> `docker compose up -d caddy` arrastra `instancia-1` e `instancia-2` por su `depends_on`, que
> exigen la imagen bajada. Así que esta fase absorbió los dos primeros puntos de la fase 6
> (bajar la imagen de GHCR y arrancar los contenedores). Todo ello en
> [deploy/fase5-red-https.sh](../deploy/fase5-red-https.sh), con tres subcomandos repetibles:
> `imagen`, `arrancar` y `comprobar`.

- [x] Registros `A` en Cloudflare para `viajes` y `restaurante` hacia `91.99.107.86`, con proxy.
  Sin `AAAA` a propósito (una sola vía que verificar). Comprobado que resuelven a direcciones de
  Cloudflare (`188.114.96.x`), no a la del VPS: si saliera la del VPS, la nube estaría gris y el
  cortafuegos bloquearía todo.
- [x] Borrado el registro `A` heredado de `n8n`. Ni el servidor ni la cuenta vieja de Hetzner
  existen ya, así que apuntaba a una IP que Hetzner puede reasignar a otro cliente.
- [x] Cloudflare: SSL **Full (strict)**, puesto **al final**, no al principio (ver más abajo).
- [x] Caddy con certificado propio de Let's Encrypt, que **sustituye** `X-Forwarded-For` por
  `CF-Connecting-IP`.
- [x] Prueba de la receta, paso 7, superada: 30 peticiones en `200` y la **31 en `429`**, y el
  móvil con datos (otra dirección) en `{"status":"ok"}` dentro del mismo minuto. Automatizada en
  [deploy/fase5-prueba-xff.sh](../deploy/fase5-prueba-xff.sh), que se ejecuta **en el PC**.

**Lo que salió mal, para no repetirlo:**

- **Compose interpola los `$` que hay DENTRO de los `env_file`.** Es el fallo gordo de la fase.
  Un hash Argon2id es `$argon2id$v=19$m=65536,...$sal$digest`, y Compose trató cada `$…` como una
  variable suya, avisando con `WARN[0000] The "argon2id" variable is not set` y sustituyéndola por
  cadena vacía. A la instancia le llegó el hash destrozado, Zod lo rechazó
  (`src/config/env.ts:46`, que exige el prefijo `$argon2id$`) y los dos contenedores se quedaron
  **`unhealthy`** reintentando. Se corrige con `format: raw` en los `env_file`
  (Compose ≥ 2.30), aplicado a los **cinco** del compose, porque cualquier contraseña futura
  puede llevar un `$`.
  - **Los avisos `WARN` son el síntoma y además filtran el secreto**: imprimen los trozos del
    hash como nombres de variable. Si aparecen, hay un valor con `$` sin proteger.
  - **Contrapartida de `raw`: tampoco quita las comillas.** `src/provisioning/env-file.ts:40`
    entrecomilla los valores con espacios, así que habría que dejarlos sin comillas. Comprobado
    que aquí no afectaba: `instance:new` normaliza el teléfono a E.164 compacto y el único valor
    con `$` en los dos entornos era `OPERATOR_PASSWORD_HASH`.
  - Las bases de datos no se tocaron: la validación del entorno ocurre **antes** de las
    migraciones.
- **La zona estaba en «SSL/TLS automático», que había elegido «Full (strict)» por su cuenta.**
  Puesto así, Cloudflare exige un certificado válido en el origen antes de que Caddy pueda
  sacarlo: devuelve 526 y bloquea el propio desafío. El orden correcto es **Full** → Caddy saca
  el certificado → **Full (strict) a mano**. No se vuelve al modo automático: podría volver a
  cambiar el cifrado solo, en mitad de una renovación.
- **«Always Use HTTPS» queda apagada de forma permanente.** Redirige el desafío HTTP-01 en el
  borde y no llega al origen. No es solo cosa de hoy: la renovación de dentro de 60 días pasa por
  el mismo desafío. Caddy ya redirige 80→443 por su cuenta, así que no se pierde nada.
- **TLS-ALPN-01 no puede funcionar detrás del proxy**: ese desafío se resuelve en el saludo TLS y
  con la nube naranja el 443 lo termina Cloudflare. Caddy lo intenta primero y acaba cayendo al
  HTTP-01, pero tras minutos de errores que parecen un fallo real. Desactivado explícitamente con
  `cert_issuer acme { disable_tlsalpn_challenge }`, con el `email` repetido dentro: al nombrar un
  emisor explícito se deja de usar la plantilla por omisión.
- **El token de GHCR se quemó por pegarlo dentro del texto del `read`.** La orden era
  `read -rsp 'Token: ' GHCR_TOKEN`, y el token se escribió **dentro de las comillas de la
  etiqueta**, con lo que acabó en la línea de órdenes, en pantalla, en el historial y en el chat.
  Se revocó, se creó otro con solo `read:packages` y se limpió el historial con
  `history -c && history -w`. El prompt de `read -s` no muestra nada mientras se teclea, y eso es
  justo lo que lleva a «arreglarlo» metiendo el valor en la orden.
- **El nombre de la imagen va en variable, no con `docker tag`.** El compose usa
  `${CHATBOT_IMAGEN:-chatbot}:${CHATBOT_VERSION}`; reetiquetar deja un estado que solo vive en
  ese disco y se pierde con un `docker image prune`. Las dos variables van en un **fichero `.env`
  junto al compose**, no exportadas: todas las órdenes de Docker van con `sudo`, y **`sudo` limpia
  el entorno del llamante**, así que un `export` se pierde y el compose aborta por su `:?`.
- **521 y 522 de Cloudflare no son lo mismo**, y la diferencia es útil antes de arrancar Caddy:
  **521** es que el origen rechazó la conexión (llega el paquete, no hay nada escuchando) y
  **522** que no respondió (lo que daría un cortafuegos descartando en silencio). Ver 521 confirmó
  que los rangos de Cloudflare entran bien por el cortafuegos de Hetzner.
- **La IP dinámica del administrador cambió** de `83.39.35.164` a `83.39.36.113` entre la fase 2 y
  la 5, dentro del mismo `83.36.0.0/14`. Es el escenario por el que se eligió el rango del
  operador en vez de una IP suelta.
- El script comprueba el **digest** de la imagen bajada contra el auditado en la fase 0
  (`sha256:f52e81af…`), no solo la etiqueta: una etiqueta se puede mover, un digest no.

### Fase 6 · Arranque (Los dos) — **HECHA el 2026-10-08**
- [x] Subir la imagen a GHCR: hecho el 2026-10-07.
  `ghcr.io/roberps/chatbot-multicliente:0.1.0`, digest
  `sha256:f52e81af15a8ff3c327fb2555f5f986534e6fc9a303ca3b3a5597374cbb7cc56`. Queda confirmar a mano
  que el paquete figura como **privado**: la sesión de `gh` no tiene `read:packages` y la API
  responde 403.
- [x] Bajarla en el VPS con el token `chatbot-ghcr-pull`. **Adelantado a la fase 5**, que no podía
  arrancar sin ella. Resuelto el nombre con una variable, `CHATBOT_IMAGEN`, en vez de `docker tag`
  (ver fase 5).
- [x] Un contenedor por instancia con los parámetros endurecidos de la receta, paso 5.
  **Adelantado a la fase 5.**
- [x] Comprobaciones de los pasos 5, 6 y 9: contenedor endurecido, puerto solo local y `healthy`.
  **Adelantadas a la fase 5**, dentro de `fase5-red-https.sh`.
- [x] Entrar en `/admin` de cada instancia con la cookie `Secure`. Hecho el 2026-10-08 en las dos,
  con la contraseña de Bitwarden. El login ya se veía desde fuera con HTTPS de punta a punta.
  Recordatorio para la próxima vez: el login admite **5 intentos por minuto y por IP**
  (`src/admin/auth/routes.ts:24`), así que un `429` al teclear varias veces no es un fallo de
  configuración; y reiniciar un contenedor invalida las sesiones abiertas, porque la época de
  sesión se regenera en cada arranque (`src/admin/auth/plugin.ts`).
- [x] Brevo: IPv4 del VPS en «Seguridad → IPs autorizadas», correo de prueba recibido desde las
  **dos** instancias y, después, bloqueo por IP de las claves SMTP activado y vuelto a probar.
  Hecho el 2026-10-08 con [deploy/fase6-correo.sh](../deploy/fase6-correo.sh), que tiene tres
  subcomandos repetibles: `ip` (IPv4 de salida del contenedor), `probar` (envío real por la vía
  de avisos) y `forma` (describe la forma de `SMTP_URL` **sin mostrar el valor**).
  - La prueba va **desde dentro del contenedor**, no con `swaks` desde el anfitrión: la IP que
    Brevo compara es la del proceso que envía, y el anfitrión tiene IPv6 (`smtp-relay.brevo.com`
    publica AAAA), así que una prueba desde el host podría salir por una dirección que en
    producción no se usa nunca. Comprobado que el contenedor sale por la IPv4 del VPS.

**Lo que salió mal en la fase 6, para no repetirlo:**

- **La clave SMTP se copió con el servidor pegado detrás.** En Brevo, el valor de la clave y el
  host `smtp-relay.brevo.com` están juntos en la misma pantalla y se arrastran de una vez. Lo
  guardado en Bitwarden era `xsmtpsib-…@smtp-relay.brevo.com`, así que la `SMTP_URL` acababa con
  el host dos veces y la contraseña que viajaba llevaba basura. La clave real son **90
  caracteres**: `xsmtpsib-` + hexadecimal + `-` + un bloque corto, **sin ningún símbolo** salvo
  los guiones. Si dentro de lo que crees que es la clave hay un `@`, un `:` o un `/`, te has
  pasado de corte.
- **Un `535 Authentication failed` no distingue entre credencial mala y bloqueo por IP.** El
  bloqueo estaba activado desde el principio (contra lo que dice §2.5), así que el primer fallo
  admitía las dos explicaciones. Se desenreda **desactivando el bloqueo para claves SMTP**: si
  entonces envía, era la IP; si sigue en 535, es la credencial. La pestaña «Direcciones IP no
  autorizadas» marcaba **0** pese a estar rechazando, así que no sirve para descartar.
- **El aviso del `%40` de §2.5 es inofensivo, no es causa de nada.** Comprobado contra el propio
  parser el 2026-10-08: `new URL` parte el userinfo por el **último** `@` y el usuario por el
  **primer** `:`, de modo que `882a5d001@smtp-brevo.com` se lee igual con `%40` que sin él.
  Codificarlo no estorba, pero buscar ahí la causa de un 535 es perder el rato.
- **Editar el `.env` no basta: hay que recrear el contenedor.** Docker lee el `env_file` al
  crearlo, no en caliente. El indicador está en la salida del `up -d`: `Running` significa que
  Compose no vio cambios (el contenido del `env_file` entra en su hash de configuración) y
  `Started`/`Recreated` que sí. Dos rondas de diagnóstico se fueron en leer huellas idénticas
  sin caer en que el fichero no se había tocado.
- **`nano` sin `-w` invita a romper la línea.** Ajusta visualmente las URL largas y parecen
  varias líneas; al «limpiar» lo sobrante se fue el `smtp://…@` entero en una instancia y
  quedó `smtp:` pegado a la clave en la otra. Con `sudo nano -w` la línea se desplaza en
  horizontal y se ve que es una sola.
- **Una `SMTP_URL` inválida deja el contenedor en `Restarting`, no en `unhealthy`.** El proceso
  arranca, Zod lo rechaza (`src/config/env.ts:151`) y la política de reinicio lo relanza. El
  mensaje nombra la variable y **no** el valor, así que esos registros se pueden leer sin
  filtrar secretos. Como en la fase 5, la validación ocurre antes que las migraciones: las bases
  de datos no corren ningún riesgo.
- **Un error mío en el script de reparación.** Un `for … else` en Python ejecuta el `else`
  cuando el bucle termina **sin** `break`, que era justo el caso bueno; el `continue` de ese
  `else` se saltaba la escritura. Imprimía el resultado correcto y no guardaba nada. Se arregló
  con un indicador explícito.

### Fase 7 · Datos ficticios (Yo preparo, tú revisas) — **HECHA el 2026-10-08**

> **Un paso que el plan no tenía: el consumo.** En producción hay **dos avisos críticos de
> protección** desde el primer arranque, y hasta que se quitan **no se puede activar el negocio**
> (`activateBusiness` mete los avisos de protección en el mismo saco que los de la configuración,
> `src/knowledge/services/business-status.ts:14`) y los canales de clientes responden **solo con
> el contacto** (`canCallModel`). Son `SPEND_CAP_REQUIRED` (el tope de gasto es obligatorio en
> producción y viene desactivado) y `MODEL_UNPRICED` (`claude-sonnet-5-5` no tiene precio). Se
> arreglan en `/admin/usage` de **cada** instancia, y **el orden no es opcional**:
>
> 1. **Moneda de coste: `USD`** (el valor por defecto). Tiene que quedar antes que los precios:
>    cambiarla después exige vaciar la tabla de precios (`currencyLockedMessage`).
> 2. **Precio de `claude-sonnet-5-5`** por millón de tokens: entrada `2`, salida `10`, escritura
>    en caché `2.50`, lectura de caché `0.20`. La escritura es 1,25 × la entrada porque el núcleo
>    usa caché efímera de 5 minutos (`src/llm/anthropic-chat-model.ts:67`, `ephemeral` sin `ttl`).
> 3. **Tope mensual** (10 USD por instancia en esta prueba). Activarlo **sin precio del modelo
>    falla** con `capWithoutPriceMessage` (FR-014); de ahí el orden.
>
> Los **límites de derivación** de la misma página no hay que tocarlos: la migración
> `0008_abuse_protection.sql` siembra la fila con 20 derivaciones nuevas al día, 15 minutos entre
> avisos y 60 avisos al día, y nunca producen un aviso crítico.

- [x] Teléfono y correo de contacto y de avisos. Decidido el 2026-10-08: **el teléfono se queda
  con el de relleno** `+34600000000` en las dos instancias, porque `EMERGENCY_CONTACT_PHONE` no
  recibe ningún aviso —solo se imprime en la respuesta del bot, `src/conversation/responder.ts`—
  y lo mismo valen `business.phone` y el canal `phone` de derivación: son texto que el bot da al
  cliente. Consecuencia útil: **la fase 7 no toca el servidor**, no hay que editar ningún `.env`
  ni recrear contenedores, así que tampoco se invalidan las sesiones del panel.
  - El correo sí es real y va **repartido**: `info@automatizacionro.work` en `business.email` y
    en el canal `email` de derivación (lo público, que se verá en la web de la fase 8), y el
    correo personal **solo** en `alertDestinations.email`, que es el único campo que entrega
    (`src/handoff/routes-provider.ts:29`). Así el chat público no enseña una dirección personal.
  - `info@automatizacionro.work` **no es un buzón**: hoy no recibe nada. Pendiente de la fase 8
    si se quiere que reenvíe (Cloudflare Email Routing, gratuito, dos registros MX).
- [x] Importada la configuración de las dos instancias con un fichero de `config-transfer` v2,
  escrito a partir del contenido **real** de las dos webs de origen: los precios por destino de
  `globalviajes2` y la carta entera de `ProjectoRestaurante`, con descripciones propias porque
  las de la web son *lorem ipsum*. Los dos ficheros se validaron en local **antes** de subirlos,
  con el propio `parseConfigFile` y con `computeWarnings` sobre el estado resultante: **ACEPTADOS
  y sin avisos críticos**, es decir, activables sin que la escritura protegida los revierta.
  - Agencia: 11 franjas de horario, 6 cierres, 23 servicios (12 destinos con precio «desde», 5 a
    consultar, 4 experiencias y 2 citas reservables), 2 asesores y 11 preguntas frecuentes.
  - Restaurante: 8 franjas, 4 cierres, 36 servicios (31 platos con su precio, 4 menús de grupo y
    la reserva de mesa, que es la reservable), 3 recursos (sala, terraza y reservado) y 13
    preguntas frecuentes.
  - **El horario del restaurante cruza medianoche** («sábados y domingos de 8:00 a 1:00») y el
    dominio no admite una franja con fin ≤ inicio (`refineWeeklySlots`). Se parte en sáb
    08:00–23:59, dom 00:00–01:00 y 08:00–23:59, y **lun 00:00–01:00**, que es la cola de la noche
    del domingo. Efecto visible: el lunes, día de descanso, figura abierto de 00:00 a 01:00. Es
    correcto y lo explica una pregunta frecuente.
- [x] Datos revisados en el panel y los **dos negocios activados**, cada uno con un solo aviso
  normal: `HANDOFF_ALERTS_SINGLE`, «los avisos solo llegan por email», esperado con WhatsApp
  apagado.
- [x] Orígenes permitidos del chat web (`https://automatizacionro.work` y su `www`), que sí
  viajan en el fichero, y **chat web activado a mano** en las dos: `enabled` está en
  `EXCLUDED_COLUMNS` y nunca se importa.
- [x] Ningún nombre de sector ni de cliente en `src/`. Los dos ficheros de configuración se
  quedan **fuera del repositorio** (`~/Downloads/chatbot-fase7/`), que es lo que pide esta misma
  casilla: los datos solo en `tests/fixtures/` o en la configuración de la instancia.

**Lo que salió mal en la fase 7, para no repetirlo:**

- **La casilla «Importar también los destinos de los avisos» se escapó en las dos instancias.**
  Es la única sección que depende de ella; todo lo demás se importa igual, así que la
  importación parece correcta. El síntoma es desconcertante: un cliente pide que le llamen, el
  bot recoge nombre y teléfono, y **la derivación se crea y se borra en el acto**, sin dejar
  rastro en el panel. Lo hace a propósito `src/handoff/service.ts:693-700` («ninguna vía entregó:
  la derivación no llega a existir»), porque sin destino no hay vía (`routes-provider.ts:29`) y
  con WhatsApp apagado el email era la única. En el registro queda `handoff_not_started` con
  `reason: 'delivery_failed'`.
  - **La señal estaba en el panel desde el principio**: el aviso decía `HANDOFF_ALERTS_NONE`, «no
    hay ninguna vía para avisar al negocio», en vez del `HANDOFF_ALERTS_SINGLE` esperado. La
    diferencia entre esos dos textos es lo que hay que mirar al terminar de importar.
  - Se arregla **sin reimportar**: el campo «Email para avisos» de `/admin/handoffs`.
- **El playground no sirve para probar los avisos.** Con `simulate` la lista de vías es una sola
  vía falsa que siempre «entrega» y no manda nada (`routes-provider.ts:22`); la traza del panel
  lo dice, «vías: simulada enviada» y «Aviso al negocio (simulado)». Además, las derivaciones del
  playground **se excluyen a propósito** de «Derivaciones activas»
  (`repositories/handoff.ts:239`, `ne(customer.channel, 'playground')`). Conclusión: desde el
  playground el correo no sale ni antes ni después de configurar el destino, y su ausencia de la
  lista no significa nada.
- **El chat de verdad se puede probar sin front, antes de la fase 8**, abriendo en el navegador
  `https://<instancia>/chat/frame`. Funciona porque al teclear la URL el navegador no manda
  `Referer` y `refererAllowed` deja pasar cuando no llega (`channels/web/guards.ts:43-49`), y
  porque los `POST` a `/chat/api` exigen `Origin` igual al de la instancia
  (`guards.ts:78`), que se cumple siempre al servirse el frame desde ella. `frame-ancestors` solo
  restringe la incrustación, no la navegación directa. Exige el chat web activado.

### Fase 8 · Frontend (Yo preparo, tú subes) — **HECHA el 2026-10-09**

> **Decidido el 2026-10-09**, al empezar la fase: se crea `politica.html` en la copia (en vez de
> vaciar el enlace del panel), se añade el origen de `pages.dev` a los orígenes permitidos de las
> dos instancias para poder probar antes de enganchar el dominio, la subida a Pages es **directa
> desde el panel** (sin repositorio ni wrangler) y `info@automatizacionro.work` pasa a ser buzón
> con Cloudflare Email Routing.
>
> **El front no genera ningún CORS.** Comprobado en el código: el chat vive entero dentro del
> iframe y sus `POST` a `/chat/api` son **del mismo origen** que el frame
> (`src/channels/web/guards.ts:78`). Lo único que cruza orígenes es la **incrustación** del
> iframe, y eso lo gobierna `frame-ancestors` de la CSP del frame
> (`src/channels/web/routes.ts:276`), no CORS. Consecuencia práctica: si el origen no está
> permitido **no hay error de CORS en la consola**; no se ve nada en absoluto, porque el
> fragmento inserta el iframe con `visibility: hidden` y solo lo muestra cuando el chat se
> anuncia (`widget.js:52`). Buscar un error de CORS que no existe es la trampa de esta fase.

- [x] **Copia** de `globalviajes2` en `~/Downloads/chatbot-fase8/front/` (fuera del repositorio,
  como los ficheros de la fase 7). Los originales de
  `proyectos-ro/proyectos-web-frontend/globalviajes2` no se tocan: 228 ficheros antes y después.
- [x] `<script src="https://viajes.automatizacionro.work/chat/widget.js" defer>` antes de
  `</body>` en las **nueve** páginas de la agencia (las 7 originales más `politica.html` y
  `cookies.html`).
- [x] `test-restaurante.html` con el widget de la instancia 2, **autónoma**: estilos propios, sin
  la cabecera de la agencia y **sin** el widget de viajes, porque dos burbujas caen en la misma
  esquina (las dos son `position: fixed; right: 16px; bottom: 16px`, `widget.js:41-43`).
- [x] `politica.html` (con el aviso legal dentro, en `#aviso-legal`) y `cookies.html`, escritas con
  la cabecera, el pie y el CSS reales del sitio. La primera es la que pide el `privacyUrl` de las
  dos instancias; la segunda la enlazaba ya el aviso de cookies de `index.html` y **daba 404**.
- [x] Teléfono y correo de la web, coherentes con lo que responde el bot: el `916784565` de la
  cabecera de las 7 páginas y los dos teléfonos de `contacto.html` pasan a `600 000 000`, y
  `global@viales.eu` a `info@automatizacionro.work` con su `mailto:`. Los tres enlaces legales del
  pie, que eran `href="#"`, ya apuntan a las páginas nuevas.
- [x] Cloudflare Pages por **subida directa**, el 2026-10-09: un ZIP con los 229 ficheros y
  `index.html` en la raíz del archivo (Cloudflare lo descomprime; el panel admite ZIP, hasta
  1.000 ficheros y 25 MiB por fichero, y el mayor de la copia son 1,6 MB). El nombre pedido no
  quedó libre y el proyecto salió como **`viajes-ckv`**, o sea
  **`https://viajes-ckv.pages.dev`**. Los proyectos de Pages **no se pueden renombrar**, pero da
  igual: `pages.dev` es solo el alias de pruebas. Comprobadas desde fuera las 10 páginas en
  `200`, sin contenido mixto, con el fragmento del chat correcto en cada una (el de viajes en
  las 9 de la agencia, el del restaurante solo en su página).
- [x] Dominios `automatizacionro.work` y `www.automatizacionro.work` enganchados en el proyecto
  de Pages el 2026-10-09, los dos en **Active**. Comprobado desde fuera: las 10 páginas en `200`
  por el dominio definitivo y por `www`, y el chat se deja incrustar desde los dos orígenes en
  las dos instancias.
  - **El registro DNS no se crea a mano.** Lo añade Pages al enganchar el dominio **desde el
    proyecto**. La zona DNS, mientras tanto, muestra un aviso azul que pide «añade un registro
    A, AAAA o CNAME»: hacerle caso es justo lo que rompe el enganche. El aviso desaparece solo.
- [x] Orígenes permitidos: `https://viajes-ckv.pages.dev` añadido el 2026-10-09 en el panel de
  las **dos** instancias, junto a los dos que ya había. Comprobado desde fuera leyendo la
  cabecera `Content-Security-Policy` de `/chat/frame` con el `Referer` de cada origen, que es la
  forma de verificarlo **sin navegador**: las dos devuelven los tres orígenes, y un origen ajeno
  recibe `frame-ancestors 'none'`. El tamaño del frame distingue los dos estados: ~1,46 kB es la
  vista de «no disponible» y ~1,73 kB la del chat activo.
- [ ] **Aplazado por decisión del 2026-10-09**: Cloudflare Email Routing para
  `info@automatizacionro.work`, con el SPF fusionado a mano. Consecuencias que se asumen: `info@`
  **no recibe nada**, los remitentes de los avisos (`viajes@`, `restaurante@`) son buzones
  inexistentes, y el dominio sigue **sin ningún MX**. Cuando se haga, el SPF tiene que quedar en
  **un solo** registro: `v=spf1 include:spf.brevo.com include:_spf.mx.cloudflare.net mx ~all`.
- [x] Consola del navegador: sin contenido mixto (comprobado sobre las 10 páginas ya servidas) y
  sin errores; los dos avisos que salió a ver una vez no se repitieron.

**Lo que hay que vigilar en esta fase, visto al prepararla:**

- **La URL de pruebas de Pages no vale tal cual.** Los orígenes permitidos de las dos instancias
  son solo `https://automatizacionro.work` y su `www`, así que en `*.pages.dev` el chat no
  aparece. Se añade el alias **estable** de producción (`viajes-ckv.pages.dev`); los
  despliegues de vista previa tienen un subdominio propio por despliegue
  (`<hash>.viajes-ckv.pages.dev`) y esos seguirán bloqueados. Caben 10 orígenes y hay 2.
- **El `Referer` también se comprueba.** Además de `frame-ancestors`, el servidor rechaza servir
  el frame si el `Referer` llega y no es de una web permitida (`routes.ts:238`,
  `refererAllowed`). Por eso el mismo origen hay que añadirlo una sola vez y sirve para las dos
  comprobaciones.
- **Email Routing y el SPF de Brevo chocan.** La zona tiene hoy **un** TXT de SPF,
  `v=spf1 include:spf.brevo.com mx ~all`, y el asistente de Email Routing propone añadir el
  suyo, `v=spf1 include:_spf.mx.cloudflare.net ~all`. **Dos registros SPF en la misma etiqueta
  son un error de protocolo** (`permerror`), y el que se rompe es el de Brevo, que es por donde
  salen los avisos de derivación de la fase 9. Hay que dejar **uno solo**, fusionado:
  `v=spf1 include:spf.brevo.com include:_spf.mx.cloudflare.net mx ~all`.
- **Email Routing sustituye los MX de la zona.** Aquí no hay conflicto porque hoy **no hay
  ningún MX** (comprobado por DNS el 2026-10-09; el ápice solo tiene los dos TXT de Brevo, y
  `www` no existe todavía). Si alguna vez se pone correo de verdad en el dominio, esto hay que
  mirarlo antes.
- **El ápice está libre para Pages.** Sin `A`, `AAAA` ni `CNAME` en `@`, no hay registro que
  borrar: Pages añade su `CNAME` aplanado y los TXT de Brevo conviven, que son de otro tipo.
- **`globalviajes2` traía otro chat.** `index.html` cargaba un widget de **Voiceflow**, que
  habría puesto una segunda burbuja encima de la nuestra. Quitado de la copia.
- **Los formularios de la web no llevan a ninguna parte.** `contacto.html`, `cuenta.html` y
  `login.html` hacen `POST` a páginas que no existen (`formulario_contacto.html`,
  `crearCuenta.html`, `loginSesion.html`, `recuperar_pass.html`), y en Pages un `POST` a una ruta
  estática sin función responde **405**. Ya estaban rotos en el original y no se arreglan en esta
  fase; el camino que se enseña es el chat. Tenerlo presente antes de enseñar la web a nadie.
- **Pages sirve el HTML sin extensión y redirige el `.html`.** `/politica.html` responde
  **308** hacia `/politica`, y lo mismo las demás. No rompe nada —el navegador sigue la
  redirección y el `privacyUrl` de las instancias
  (`https://automatizacionro.work/politica.html`) funciona—, pero conviene saberlo antes de
  dar por rota una ruta que responde 308 en vez de 200.
- **Un 522 en `*.pages.dev` recién creado significa «proyecto sin desplegar».** El nombre
  resuelve en DNS en cuanto se crea el proyecto, antes de que haya nada publicado detrás, así
  que un 522 ahí no es una caída: es que falta pulsar **Deploy site**. Mismo código que en la
  fase 5, distinta causa.
- **Los dos widgets no pueden solaparse, así que no hay que desactivar ninguno para probar.**
  Cada página carga uno solo: el de la agencia en sus 9 páginas y el del restaurante únicamente
  en `test-restaurante.html`, que por eso se hizo autónoma. Desactivar el chat de una instancia
  para «probar la otra» no hace falta y deja esa instancia sin chat también en el dominio real.
- **El origen hay que añadirlo en los dos paneles, no en uno.** Son dos instancias con su
  configuración y su contraseña; es fácil hacer el cambio dos veces en el mismo panel y creer
  que están las dos. El síntoma es un `'none'` en la instancia que faltó.
- **`pages.dev` no tiene variante `www`.** Añadir `https://www.<proyecto>.pages.dev` por
  analogía con el par del dominio propio no rompe nada, pero gasta uno de los 10 huecos con un
  origen que no existe.
- **Los avisos de derivación llegan a spam en Gmail, y no es un fallo de configuración.**
  Comprobadas las cabeceras del correo real del restaurante el 2026-10-09: **SPF `PASS`** (IP
  `77.32.148.26`, de Brevo), **DKIM `PASS`** alineado con `automatizacionro.work` y **DMARC
  `PASS`**. Con los tres en verde lo que queda es **reputación**: dominio recién creado y sin
  historial, IP compartida del plan gratuito de Brevo, dominio que no puede recibir correo (sin
  MX) y `DMARC p=none`. Lo que de verdad lo arregla en el propio buzón es marcar **«No es
  spam»** y añadir el remitente a contactos; después, los MX del Email Routing y, con
  historial, subir el DMARC a `p=quarantine`.
  - **Riesgo del producto, no de esta prueba**: para un cliente real, un aviso de derivación en
    spam es la funcionalidad caída en silencio. El alta de un cliente debería incluir que marque
    el primer aviso como «No es spam».
- **«Le atiendo» no cierra nada; cierra «Terminado».** Comprobado en las dos instancias el
  2026-10-09, y es lo que dice el código (`src/handoff/service.ts:521`): `attend` solo confirma
  quién la coge. Solo «Terminado» saca la derivación de «Derivaciones activas» y quita la
  franja del chat del cliente, esta última en hasta 60 s por el sondeo. Si parece que una
  instancia se comporta distinto de la otra, lo primero que hay que mirar es qué botón se pulsó
  en cada una.
- **Las páginas nuevas llevan `noindex`** y un aviso visible de que el negocio es ficticio: es
  una web de demostración en un dominio público, y no debe parecer una empresa real.

### Fase 9 · Pruebas de punta a punta (Los dos) — **COMPLETA el 2026-10-12**
(pasada el 2026-10-09 con dos bloqueos; los dos se cerraron el 2026-10-12 con la 0.1.1)

> Las pruebas que se hacen en el VPS están en [deploy/fase9-pruebas.sh](../deploy/fase9-pruebas.sh),
> con cuatro subcomandos repetibles: `copias`, `aislamiento`, `emergencia parar|arrancar` y
> `estado`. Las otras dos (el chat desde la web pública y `pnpm instance:versions`) se hacen desde
> el PC. **En el VPS no hay repositorio ni pnpm**: `pnpm db:backup` allí es
> `docker exec instancia-N node dist/src/cli/backup.js`, que son los mismos CLI compilados en la
> imagen.
>
> **Resultado: cuatro casillas cerradas y dos bloqueadas por sendos fallos del núcleo** (ver «Lo
> que salió mal», más abajo). Los dos se arreglan en la spec de corrección que sale de aquí y van
> en la **0.1.1**; ninguno es de configuración, así que no hay nada que tocar en el VPS.

- [x] Chat de la agencia desde la raíz y del restaurante desde la página de prueba.
- [x] Un mensaje que active el contacto de emergencia: el bot **muestra** tu número en su
  respuesta. **BLOQUEADA el 2026-10-09**: la respuesta existe y es correcta, pero es
  **inalcanzable** porque el proceso de la instancia se muere antes de poder darla (fallo 1 de
  los de abajo). Corregido el 2026-10-08: `EMERGENCY_CONTACT_PHONE` no recibe ningún aviso; es el
  teléfono que el bot da al cliente cuando no puede leer la información del negocio, cuando el
  negocio está desactivado o cuando se supera el límite (`src/conversation/processor.ts`). Los
  avisos que sí salen son los de derivación, configurados en el panel, y con WhatsApp apagado van
  por correo.
  - **Con el negocio activo no hay ningún mensaje que lo active**, y esto el plan no lo decía.
    `unavailableContact` (`src/conversation/templates.ts:168`) da el contacto **del negocio**
    siempre que el snapshot se lea y tenga vías; el de emergencia es solo el respaldo de cuando
    no se puede leer. La única forma de provocarlo es parar PostgreSQL, que es lo que hace
    `emergencia parar`. Las dos frases se distinguen sin mirar el número, que aquí es el mismo
    en los dos sitios: «Para hablar con una persona de \<nombre\>: …» frente a «Si necesitas
    hablar con una persona: teléfono …».
  - **DESBLOQUEADA el 2026-10-12**, con la 0.1.1 en las dos instancias. Corte real de
    PostgreSQL de 6 min 22 s (11:44:55–11:51:17), por encima del umbral de 5 min de SC-002.
    Durante el corte: las dos instancias en `Up` y, además, **`healthy`** —la sonda consulta
    `/health`, que responde **200** con `db_unavailable`, así que Docker no tiene motivo para
    reiniciarlas—, `RestartCount` **0** en las dos y la hora de arranque sin cambiar. Por el
    chat web, las dos respondieron «Ahora mismo el chat no está disponible. Si necesitas hablar
    con una persona: teléfono +34 600 00 00 00», que es la frase del contacto de **emergencia**,
    no la del negocio. En el registro, una sola `db_outage_started`, una `db_outage_ongoing` al
    pasar de los 5 min y una `db_outage_recovered` con `durationMs` y `failures: 2`, sin
    direcciones ni credenciales. Al volver la base, la **misma conversación** siguió atendiendo
    con datos reales, sin reiniciar nada ni pedir sesión nueva.
  - **La mitad de WhatsApp no se pudo hacer, y no es un olvido**: las seis variables
    `WHATSAPP_*` están vacías en las dos instancias (comprobado comparando la huella de cada
    valor con la de la cadena vacía, sin leer ninguno), tal y como da por supuesto este mismo
    plan cuando dice que los avisos «con WhatsApp apagado van por correo». El escenario 6 del
    quickstart de la 016 pedía escribir «por WhatsApp y por el chat web»; se ha corregido allí.
    El camino degradado de WhatsApp y el aviso una sola vez por cliente y corte (FR-014) tienen
    cobertura automática en la suite; lo que solo se puede verificar en producción es la forma
    de dirección por socket, y esa va por `db:verify`.
- [x] Un aviso por correo llega a tu correo real vía Brevo. **Adelantado al 2026-10-08**, al
  cerrar la fase 7, desde el chat web real del restaurante (`/chat/frame`). El ciclo entero
  comprobado: un cliente pide que le llamen y da nombre y teléfono → llega el correo de aviso →
  el enlace «Le atiendo» abre la página de confirmación con el identificador en la ruta → queda
  «Anotado: atiende a <nombre>» → la derivación aparece en «Derivaciones activas» pendiente de
  terminar y el chat muestra su franja superior. Se repetirá en la fase 9 desde la web pública.
- [x] `pnpm db:backup`, `pnpm db:verify <copia>` (`RESTAURABLE`) y `pnpm db:backups`.
  **Dos de tres el 2026-10-09**, en las dos instancias: la copia se crea, aparece en el montaje
  del anfitrión (o sea, sobrevive al contenedor, que tiene la raíz en solo lectura) y se lista
  bien. **`db:verify` está bloqueada** por el fallo 2 de los de abajo: la copia se crea y se
  guarda, pero **no se puede comprobar que sirva**, que es el riesgo de verdad en producción.
  - **DESBLOQUEADA el 2026-10-12**, con la 0.1.1: `RESTAURABLE` en las dos instancias, con los
    recuentos de las 33 tablas iguales a los de la copia y la base temporal borrada después. Es
    la única verificación real de la forma de dirección por **socket Unix literal** (FR-006,
    SC-004 de la 016): su prueba se salta en Windows y no hay integración continua en Linux.
- [x] `pnpm instance:versions` muestra la versión real de las 2 instancias. Hecho el 2026-10-09:
  las dos en `0.1.0`, esquema `0008_abuse_protection`, estado «Correcto» y tope de gasto
  «normal», que de paso confirma el límite de la fase 7.
  - **La primera pasada sale con salida 1 y «anotada —», y no es un fallo**: `imageVersion` no
    se había anotado nunca en el inventario, y una fila sin coincidencia cuenta como «a revisar»
    (`src/provisioning/versions.ts`, `review = !(ok && matches)`). Se cierra con
    `instance:versions --annotate` (pide confirmación por teclado) y una segunda pasada, que ya
    da **salida 0**. El `--annotate` también termina en 1: su informe es el del momento de la
    consulta, anterior a la anotación.
- [x] Reinicio del servidor: las instancias vuelven solas (política de reinicio). **Adelantado al
  2026-10-08**, al cerrar la fase 6 y tras editar a mano los dos entornos. Los cinco contenedores
  volvieron solos en dos minutos y `fase5-red-https.sh comprobar` dio todo en verde, con el
  certificado recuperado del volumen `caddy-datos` (no se pidió uno nuevo, que gastaría cupo de
  Let's Encrypt). Se repetirá en la fase 9 ya con datos de negocio.
  - `chatbot-caddy-1` aparece sin `(healthy)` en `docker ps`: la imagen `caddy:2-alpine` no trae
    `HEALTHCHECK` y el compose no le define ninguno. Su salud la mide el paso 6 del script.
  - Al entrar, Ubuntu ofrece `do-release-upgrade` a la 26.04. **No se hace**: la 24.04 es LTS con
    soporte hasta 2029 y es la decisión de la fase 2. El aviso sale en cada login.
- [x] Una instancia no ve datos de la otra. Comprobado el 2026-10-09 en los tres niveles donde
  podría verlos, con `fase9-pruebas.sh aislamiento` y ya con datos de negocio dentro:
  - **Lo que lee el bot**: `getSnapshot()` sobre la `DATABASE_URL` de cada contenedor da negocios
    distintos («Global Viajes» con 23 servicios y 11 FAQ; «Taste Restaurante» con 36 y 13).
  - **El catálogo de PostgreSQL**, en las dos direcciones, y una **conexión cruzada real** con las
    credenciales de cada instancia contra la base de la otra: rechazada con
    `FATAL: permission denied for database`, o sea el `REVOKE CONNECT` de la fase 4 actuando
    **antes** de abrir la base. No es que entre y no vea nada: es que no entra.
  - **Los directorios de copias**: cada uno solo tiene ficheros con su propio `INSTANCE_ID`. El
    aviso `shared_backup_dir` del inventario sigue siendo inofensivo por esto mismo.

**Lo que salió mal en la fase 9, para no repetirlo.** Los dos son **fallos del núcleo**, no de la
configuración ni del despliegue, y los dos tienen el mismo origen: qué hace el programa cuando la
base de datos no está. Los destapó esta fase porque es la primera que prueba el sistema montado
como está en producción (dos clústeres por socket Unix y una caída de verdad).

- **1. Un corte de la base de datos mata el proceso de la instancia** (grave). `createDb`
  (`src/db/client.ts:38-52`) crea los pools **sin `pool.on('error')`**. Es el único sitio del
  código que no lo lleva: `backup/locks.ts:35`, `backup/service.ts:97` y `:835`,
  `cli/backup-common.ts:153`, `provisioning/database.ts:201` y `health/report.ts:137` sí lo
  ponen, y este último hasta lleva el comentario que lo explica. Al parar PostgreSQL, las
  conexiones ociosas emiten `error` sin nadie escuchando, Node lo trata como excepción no
  capturada y el proceso cae; `restart: unless-stopped` lo relanza, el arranque intenta las
  migraciones, la base sigue parada y vuelve a caer. Bucle de reinicio, y Caddy devolviendo
  **502** porque no hay nadie detrás.
  - **Lo serio no es la caída: es que deja inalcanzable toda la resiliencia de la 012.** El 503
    «ocupado» del pool agotado, el R-ERR con el contacto de emergencia y la disculpa al abandonar
    un lote están bien escritos y nunca llegan a ejecutarse. De ahí que la casilla del contacto
    de emergencia no se pueda cerrar.
  - **Síntoma en el navegador**: el chat se queda en «escribiendo…» para siempre. No es que esté
    pensando: `frame.js:413` pinta ese texto **antes** de enviar y solo lo quita cuando la
    respuesta encaja en alguna de sus ramas; un 500 o un 502 no encajan en ninguna. El código
    real está en la consola (F12), no en la burbuja.
  - **Síntoma en el servidor**: `docker ps` con las instancias en `restarting`, y
    `docker inspect -f '{{.RestartCount}}'` por encima de 0. Se recuperan solas al volver la
    base, pero con el retroceso exponencial de Docker pueden tardar más de los 120 s que espera
    el script; no es que sigan rotas.
  - **Las sesiones de los dos paneles se pierden**, porque la época de sesión se regenera en cada
    arranque (`src/admin/auth/plugin.ts`). Hay que volver a entrar en los dos.
- **2. `db:verify` no funciona con una URL de socket**, o sea nunca ha funcionado en esta
  arquitectura. `withDatabase` (`src/backup/service.ts:720`) construye la dirección de la base
  temporal con `new URL(url)` a pelo, y **`new URL` rechaza cualquier URL de Postgres con
  credenciales y host vacío** — la forma `postgres://usuario:clave@/base?host=/var/run/postgresql`
  que usa todo este despliegue, incluida la `DATABASE_URL` que lleva funcionando desde la fase 4.
  El propio núcleo ya conoce la limitación y la rodea con un host postizo en
  `src/config/database-url.ts:33-45`; `withDatabase` se quedó fuera de esa lección.
  - **Se manifiesta como `verify_db_unavailable`, que despista**: el mensaje dice «no se pudo
    crear la base de datos temporal», pero la conexión y el `create database` **sí** funcionan.
    Falla el paso siguiente, conectarse a la base recién creada, y el `finally` la borra, así que
    no queda ni rastro. La pista que lo distingue es lo que **no** sale: si la conexión hubiera
    fallado, `orphansLine()` habría impreso «no se ha podido comprobar el servidor».
  - Afecta solo a `db:verify`. `db:backup`, `db:backups` y `db:restore` no pasan por ahí
    (`restore` trabaja sobre `DATABASE_URL` sin reescribirla).
- **Los dos se podían haber cazado antes, y conviene no contarse lo contrario.** El de
  `withDatabase` es un test unitario de tres líneas, sin base de datos: pasarle una URL de socket.
  El de los pools es un test de integración con Testcontainers, parando el contenedor en mitad de
  la prueba. No se cazaron porque **los tests simulan el fallo justo donde el código lo espera**:
  los de la 012 inyectan fallos en la capa de datos y comprueban las respuestas, nunca cortan la
  base por debajo, y ningún test usa una URL de socket. La spec de corrección lleva los dos
  arreglos **y sus dos tests de regresión**; si no, el siguiente despliegue los redescubre igual.
  Conviene mirar de paso si hay más sitios que den por hecha una URL con nombre de servidor.
- **Mis dos diagnósticos equivocados, por el mismo motivo.** Al mirar `BACKUP_VERIFY_URL` usé
  `new URL` para describirla y concluí que el fichero estaba mal; era mi comprobación la que no
  podía leer una URL de socket, igual que el fallo que estaba buscando. Y di por hecho que el
  `POST` del chat devolvería el 503 con el contacto de emergencia, sin caer en que el proceso ya
  no estaba vivo para devolverlo. Regla que queda: **antes de dar por malo un valor, comprobar
  que la herramienta con la que lo miras admite su forma**.

**Cuatro cosas que parecen fallos y no lo son** (las cuatro vistas el 2026-10-08):

- **El login admite 5 intentos por minuto y por IP** (`src/admin/auth/routes.ts:24`): un `429` al
  teclear varias veces no es un fallo de configuración.
- **«Probar el bot» nunca se corta** (010 FR-019) y **sus avisos son simulados**. Si el chat
  público responde solo con el contacto y el playground contesta bien, lo que falla no es el bot:
  es el tope de gasto o el precio del modelo.
- **Entre avisos de una misma derivación pasan 15 minutos.** Tras el primero, los mensajes
  siguientes quedan pendientes y se agrupan (`handoff_forward_deferred`,
  `src/handoff/service.ts:775`); no se pierden. Para probar dos avisos seguidos hay que usar una
  **conversación nueva**, o bajar el intervalo a 5 minutos en `/admin/usage` y devolverlo a 15.
- **«Terminado» no limpia el panel al instante, y «Le atiendo» no termina nada.** Son dos pasos a
  propósito. Al terminar, la derivación sale de «Derivaciones activas» (`listActive` filtra por
  `status = 'active'`), pero `/admin/handoffs` **no se refresca solo**: hay que recargar. En el
  chat del cliente la franja sí se quita sola, en hasta **60 segundos**
  (`channels/web/assets/frame.js`, `HANDOFF_POLL_MS`). Y lo que el cliente escribió durante la
  derivación **queda retenido**, no se contesta en diferido: aparece en «Mensajes retenidos» para
  que lo lea una persona (`service.ts:323-338`).

### Fase 10 · Copias fuera del servidor (Los dos)
- [ ] Contratar una Storage Box de Hetzner (unos 4 €/mes) y copiar `BACKUP_DIR` con rsync o rclone
  por SSH, con una tarea programada.
- [ ] Probar una restauración completa en una BD temporal con la copia de la Storage Box.

### Fase 11 · Specs de núcleo y ciclo de actualización (Yo)
- [x] **Primero, la spec de corrección de los dos fallos de la fase 9** (**núcleo**), decidida el
  2026-10-09. Se adelanta al modo oscuro porque uno de los dos deja la instancia en bucle de
  reinicio ante cualquier corte de la base de datos y el otro deja las copias sin poder
  comprobarse. Alcance: `pool.on('error')` en `src/db/client.ts`, `withDatabase` con URL de
  socket en `src/backup/service.ts`, y **los dos tests de regresión**. Sale la **0.1.1**, imagen
  nueva a GHCR y actualización de las dos instancias, que es además el ensayo real del ciclo de
  actualización que esta fase quería hacer con el modo oscuro. Al terminar, se repiten las dos
  casillas que quedaron bloqueadas en la fase 9.
  - **Hecha: feature 016, implementada el 2026-10-09** (`016-db-outage-resilience`). El alcance
    creció respecto a lo previsto, porque la auditoría de la propia spec destapó que los dos
    fallos eran casos particulares de dos descuidos sistemáticos: hubo que poner el oyente de
    `error` en los **ocho** puntos que abren conexiones (dos no lo tenían y uno lo tenía después
    de conectar, con una ventana sin él) y pasar al intérprete tolerante de direcciones **todos**
    los puntos que las leen, lo que además devolvió dos comprobaciones de seguridad del operador
    que la forma de dirección de producción silenciaba sin avisar. Añadido también el estado
    `db_unavailable` de `/health` con **200**, para que ninguna política de reinicio tenga motivo
    durante un corte, y el fin del «escribiendo…» eterno del chat web.
  - **Hecho en el VPS el 2026-10-12**: imagen `0.1.1` construida con `CORE_VERSION=0.1.1`,
    publicada en GHCR (`sha256:b1c55ebe…`, digest comprobado al descargarla en el servidor) y
    desplegada por tandas —primero `instancia-1` (viajes), comprobada, y después `instancia-2`
    (restaurante)—. Las dos quedan en `Correcto`, núcleo `0.1.1`, esquema `0008_abuse_protection`
    (sin migración), y el inventario anotado con `instance:versions --annotate`: segunda pasada
    con «Coincide: sí» y código 0. **Las dos casillas de la fase 9 quedan desbloqueadas**, así
    que la forma de dirección por socket Unix literal ya tiene su verificación real (FR-006,
    SC-004). `pnpm test:eval` se saltó a propósito por decisión del usuario, por coste; queda
    anotado aquí como salto consciente de la puerta de 5.1.
  - **Lo que salió mal, para no repetirlo** (todo del equipo y del procedimiento, nada del
    núcleo):
    - **La IP del VPS había cambiado y no estaba escrita en ninguna parte.** `~/.ssh/config` y
      `known_hosts` apuntaban a `188.245.83.124`, que Hetzner ya ha reasignado a otra máquina:
      respondía con tres claves de anfitrión desconocidas. El servidor es `chatbot-prod`,
      **91.99.107.86**, huella ED25519 `SHA256:Ir9eRo/9NKhfWd9ERuW/qwVhH9nhPOm/PPdM3/aARDM`,
      verificada por la consola web de Hetzner (la única vía que no pasa por la red que se está
      verificando). Si no se hubiera comprobado, el despliegue habría ido con secretos a un
      servidor ajeno. **La huella del servidor queda anotada aquí**: era el dato que faltaba.
    - **El usuario de acceso es `operador`, no `root`**, y estaba escrito en la fase 2 pero no
      donde se usa. Los intentos como `root` agotaron el `maxretry` de `fail2ban` y banearon la
      IP del administrador: el mismo incidente que ya documenta la fase 2, repetido. Se resolvió
      con `fail2ban-client set sshd unbanip <ip>` desde la consola. Alias `vps` en
      `~/.ssh/config` con `User operador` para que no vuelva a pasar.
    - **Avast bloqueaba la construcción.** Su «análisis HTTPS» sustituye el certificado de
      `registry.npmjs.org` por uno propio (`Avast Web/Mail Shield Root`); Windows se fía porque
      tiene esa raíz instalada, pero el contenedor no, y `corepack` moría con
      `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Se desactiva el análisis HTTPS mientras se construye.
      **No se mete esa raíz en la imagen**: acabaría en producción fiándose de un certificado de
      interceptación de un portátil. Es un requisito del equipo de construcción que no estaba
      escrito.
    - **El VPS no guarda la sesión de GHCR** (su `/root/.docker/config.json` está vacío: se
      cierra sesión tras cada descarga, que es lo correcto). Hay que volver a entrar con
      `sudo docker login ghcr.io -u roberps` y el token `chatbot-ghcr-pull` antes de cada
      despliegue, y cerrarla después.
    - **Las copias locales de los entornos estaban desfasadas** respecto al VPS en `SMTP_URL`
      (la corrección de Brevo del 2026-10-08 nunca volvió a `~/.chatbotasesor/envs/`). Las otras
      60 claves coincidían. Se arregla con `pnpm instance:sync <id> <fichero>`.
    - **`deploy/fase9-pruebas.sh` del repositorio describía como vivo el fallo que la 016
      arregla** y su aviso decía que los contenedores pasan a `unhealthy` durante el corte, algo
      que con la 0.1.1 ya no ocurre. Corregido en el repositorio y en el VPS, que vuelven a
      coincidir byte a byte.
- [ ] `/speckit-specify`: modo oscuro del panel (**núcleo**, afecta a todos los clientes).
- [ ] Después, la spec del **proveedor del modelo configurable** (ver §6), que es la que lleva la
  instancia 2 a Gemini. Va detrás del modo oscuro a propósito: el modo oscuro es un cambio pequeño
  y visible, mejor primera prueba del ciclo de actualización sobre instancias ya desplegadas.
- [ ] Plan, tareas, implementación, nueva etiqueta y despliegue sobre las 2 instancias.
- [ ] Actualizar `README.md` y `docs/operacion-multicliente.md` (§9.1 con fecha, §9.2, secciones
  de operación) según [CLAUDE.md](../CLAUDE.md). Avisar al usuario antes de tocar el README.

## 6. Qué tienes que traer a la próxima sesión

Actualizado el 2026-10-09, al pasar la fase 9. Lo siguiente es la **spec de corrección** de los dos
fallos que destapó esa fase (ver fase 11), y **no necesita ningún dato nuevo tuyo**. Lo que hay que
tener presente:

- **La fase 9 está pasada salvo dos casillas**, las dos bloqueadas por fallos del núcleo y
  ninguna por configuración: `db:verify` (las copias se crean y se listan, pero no se pueden
  comprobar) y el contacto de emergencia (la respuesta es correcta pero inalcanzable). Se repiten
  las dos sobre la 0.1.1, cuando esté la corrección.
- **Ojo al probar el corte de la base de datos**: hoy deja las dos instancias en bucle de
  reinicio y los dos paneles pidiendo credenciales otra vez. Se recupera solo al arrancar la
  base, pero puede tardar más de dos minutos por el retroceso de Docker.
- **`info@automatizacionro.work` sigue sin ser un buzón**, por la decisión de aplazar el Email
  Routing. La web y el bot la dan como contacto y nadie lee lo que se escriba ahí. No afecta a
  los avisos de derivación, que van al correo personal.
- **Los avisos de derivación pueden caer en spam**, con SPF, DKIM y DMARC los tres en `PASS`
  (ver fase 8). Antes de dar por fallida una prueba de la fase 9, **mirar la carpeta de spam**.
- El **teléfono de las dos webs es el de relleno** `+34 600 000 000`, por la decisión de la fase
  7. Es coherente con lo que responde el bot, pero conviene tenerlo presente antes de enseñar la
  web a nadie.
- Las **dos claves SMTP de Brevo** quedan funcionando y probadas de punta a punta. **Corrige lo
  guardado en Bitwarden**: el valor incluía el servidor pegado a la clave, que es lo que costó
  toda la fase 6. Solo el token `xsmtpsib-…` de 90 caracteres, y el host aparte.
- Siguen **los commits de `main` sin subir**, por decisión: se sube todo al terminar las fases.
  Incluyen las anotaciones de las fases 7, 8 y 9 y el script de pruebas; el recuento exacto lo da
  `git log origin/main..HEAD --oneline`.

### Proveedor del modelo configurable, decidido el 2026-10-08 y ampliado el 2026-10-12

> **Ampliación del 2026-10-12**: la spec (la **017**, siguiente número libre: el 015 se gastó en
> un commit de tarea sin carpeta) lleva **los tres proveedores —Anthropic, Gemini y OpenAI—
> elegibles por instancia**, no solo Gemini, para que cada cliente pueda usar el modelo que
> prefiera. Consecuencias de la ampliación, decidida con ellas sobre la mesa:
>
> - La costura (`LLM_PROVIDER` + una variable de clave por proveedor) se paga una vez; lo que se
>   multiplica por tres es el adaptador, el mapeo de parámetros, el medidor de tokens y el
>   verificador de respuestas.
> - **`pnpm test:eval` deja de ser opcional en esta spec**: es la única red que detecta que el
>   bot responde peor con otro modelo, y `LLM_EFFORT=medium` se calibró contra Sonnet 5. Hay que
>   presupuestar su coste, por proveedor.
> - Adelanta a **P7** en la cola de propuestas de `operacion-multicliente.md` §9.2; queda por
>   anotar allí con su razón al cerrar la 014.
> - Hoy el esquema de entorno (`src/config/env.ts`) **no conoce** `GEMINI_API_KEY` ni
>   `OPENAI_API_KEY`: si aparecen en algún `.env`, se ignoran. Lo único de OpenAI que usa el
>   núcleo es la transcripción de audios (`STT_API_KEY`, `STT_MODEL`), apagada en las dos
>   instancias.


Se planteó dar a la instancia 2 una `GEMINI_API_KEY`. **No se puede hoy**: el núcleo solo habla con
la API de Anthropic. Se despliega con dos claves de Anthropic y se hace después una **spec de
núcleo** que añada el proveedor; entonces la instancia 2 se pasa a Gemini con una actualización, lo
que además sirve de prueba del ciclo de ampliación de la fase 11.

Alcance que tendría esa spec, medido en el código el 2026-10-08:

- A favor: ya existe el puerto `ChatModel` (`src/conversation/ports.ts`) y los dos adaptadores de
  Anthropic son pequeños (`src/llm/anthropic-chat-model.ts`, 109 líneas, y el resumidor, 58). El
  proveedor nuevo entra ahí, sin tocar el dominio.
- En contra: no hay adaptador ni dependencia de Google; `ANTHROPIC_API_KEY` está cableada en 10
  ficheros de `src/` y 27 de tests (arranque del bot, esquema de entorno, reglas de secretos,
  `instance:check`, huella del inventario y generación de entornos), así que hacen falta un
  `LLM_PROVIDER` y una variable de clave por proveedor; y el adaptador usa parámetros propios de
  Anthropic (`thinking: adaptive`, `output_config` con `effort` y `json_schema`) que en Gemini
  tienen equivalentes pero no mapean 1:1, igual que el medidor de tokens y el verificador de
  respuestas.
- **Trampa a evitar**: poner la clave de Gemini en `ANTHROPIC_API_KEY` **pasa `instance:check`**
  (el formato `sk-ant-` solo es advertencia, `src/provisioning/secrets.ts:72`), pero el SDK llama a
  `api.anthropic.com` y recibe un 401: el chat contestaría siempre «no disponible» sin ningún error
  en las comprobaciones. Es el mismo fallo silencioso que un nombre de modelo equivocado.

Decisiones abiertas, ninguna bloqueante:

- Si el núcleo debe **registrar el modelo que atiende de verdad** (el campo `model` de cada
  respuesta, que hoy se descarta): spec pequeña antes de desplegar, comprobación a mano en la
  fase 9, o propuesta en la cola de `operacion-multicliente.md` §9.2.
- Si se lanza `pnpm test:eval` ahora que el modelo cambió: `LLM_EFFORT=medium` se calibró contra
  Sonnet 5, y en Sonnet 5.5 los niveles están recalibrados y el valor por defecto es `high`.
- Añadir un `.gitleaks.toml` que permita los 33 falsos positivos revisados, para que un hallazgo
  nuevo destaque en vez de perderse entre ellos.

## 7. Riesgos y puntos a vigilar
- **IP real del cliente**: si Caddy añade en lugar de sustituir la cabecera, cualquiera se salta el
  límite de intentos del login. La prueba de las 31 peticiones es obligatoria.
- **`BACKUP_KEY` perdida = copias inservibles.** Guardarla en dos sitios.
- **Mismo disco no es copia**: sin la Storage Box, perder el VPS es perder todo.
- **Gasto de Anthropic**: una clave compartida por 2 instancias; poner un límite mensual.
- **Docker no reinicia un contenedor `unhealthy`**: mirar por qué antes de reiniciar (receta, paso 10).
- **Brevo gratuito**: 300 correos al día para todas las instancias que compartan la cuenta.
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
