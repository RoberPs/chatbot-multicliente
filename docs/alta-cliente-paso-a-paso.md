# Alta de un cliente, paso a paso (receta del VPS)

Guion práctico para dar de alta un cliente nuevo en el VPS de producción, tal como se hizo con
**Centro SISU** (instancia `sisu`, contenedor `instancia-3`, 30/10/2026). Es la versión ejecutable
de [operacion-multicliente.md §2](operacion-multicliente.md#2-alta-de-un-cliente-nuevo): aquí va
el orden, las órdenes reales de esta infraestructura y lo que salió mal; el porqué de cada regla
está en §2 y en el [plan de despliegue](plan-despliegue-produccion.md).

En los ejemplos, `<id>` es el identificador de la instancia (`sisu`), `instancia-N` su contenedor
(`instancia-3`) y `<dominio>` el subdominio (`sisu.automatizacionro.work`).

## Infraestructura de referencia

| Pieza | Dónde |
|---|---|
| VPS | Hetzner, `91.99.107.86`, alias ssh `vps`, usuario `operador`, todo con `sudo docker` |
| Compose y Caddy | `/srv/chatbot/deploy/` (copia de `deploy/` del repo; se sube con `scp`) |
| Entornos de las instancias | `/srv/chatbot/instancia-N.env` (`operador`, `0600`) |
| Copias de cada instancia | `/srv/chatbot/instancia-N/backups` (UID 1000, `0700`) |
| PostgreSQL | Contenedor sin TCP, solo socket Unix; otro clúster aparte para verificar copias |
| DNS, TLS y proxy | Cloudflare (registro `A` con proxy) → Caddy en el VPS |
| Correo de avisos | Brevo, una clave SMTP por instancia, remitente `<id>@automatizacionro.work` |
| Modelo | Anthropic, una clave por instancia con tope de gasto en la consola |
| Inventario | `C:\Users\makor\.chatbotasesor\inventory.json` + `INSTANCE_INVENTORY_KEY` (Bitwarden) |
| Webs de demostración | Cloudflare Pages, subida directa desde el panel, protegidas con Cloudflare Access |

En el VPS **no hay repositorio ni pnpm**: los CLI se lanzan con
`sudo docker exec instancia-N node dist/src/cli/<orden>.js`.

## Antes de empezar: datos y decisiones

- [ ] **¿Prueba o cliente que paga?** Una instancia de prueba usa tu clave de Anthropic, tu
      Brevo, tu email como destino de avisos y estado `testing` en el inventario. Si el cliente
      contrata, se reutiliza la misma instancia (cambian URL, clave de Anthropic, SMTP y destino
      de avisos; ver [Paso a cliente definitivo](#paso-a-cliente-definitivo)).
- [ ] `<id>` (minúsculas, cifras y guiones), número de contenedor libre (`instancia-N`) y
      subdominio de **un solo nivel** (el certificado de Cloudflare no cubre dos).
- [ ] Datos del negocio para el panel: horarios, servicios, precios (o «a consultar»), FAQ,
      políticas, tono, dirección y teléfono, enlace a su política de privacidad.
- [ ] Webs donde irá el chat (la del cliente, y la demo si la hay; caben 10).
- [ ] Con un cliente real: contrato de encargo del tratamiento firmado (§2.1).

## 1. Preparar la configuración en local (opcional, recomendable)

Para no teclear la configuración en producción, se prepara en una instancia local y se exporta.

1. Levanta una instancia local con su BD propia (`chatbot_<id>`), en otro puerto (con sisu, el
   3001) y con Mailpit para ver los correos sin enviarlos.
2. Rellena en su panel todo el negocio y el **Diseño del chat** (011): colores, forma, logo,
   avatar, icono.
3. Prueba con `pnpm bot:chat` o «Probar el bot» las preguntas típicas y las trampas (precio no
   registrado, «quiero hablar con una persona», dar nombre y teléfono sin que se pidan).
4. **Exportar** la configuración (sin destinos de avisos). El fichero se importa en el paso 7.

La limpieza de esta instancia local va al final ([paso 10](#10-cierre)).

## 2. Entorno, en el PC (PowerShell, en la carpeta del repo)

Carga la clave del inventario **en la misma ventana** donde vas a trabajar (no se escribe en el
comando; al ejecutar la primera línea te la pide sin mostrarla):

```powershell
$s = Read-Host "Clave del inventario" -AsSecureString
$env:INSTANCE_INVENTORY_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
```

Si cierras la ventana, se pierde y hay que repetirlo. Al terminar:
`Remove-Item Env:INSTANCE_INVENTORY_KEY; Remove-Variable s`.

1. **Alta** (muestra secretos una sola vez: no redirijas la salida):

   ```powershell
   pnpm instance:new --id <id> --client "<Cliente> (prueba)" --url https://<dominio> --timezone Europe/Madrid --region ES --currency EUR --emergency-phone "+34 600 000 000"
   ```

   A Bitwarden: la contraseña del operador y la `BACKUP_KEY` (esta, también fuera del VPS). El
   teléfono real se pone después en `EMERGENCY_CONTACT_PHONE` del fichero, no por argumento.

2. **SQL de la base de datos** (una sola vez por instancia: cada ejecución genera otra contraseña):

   ```powershell
   pnpm --silent instance:db <id> --print-sql --host localhost --port 5432 | Set-Content -Encoding ascii <id>.sql
   ```

   Comprueba que la primera línea del `.sql` es SQL y no la cabecera de pnpm (`> chatbotasesor@…`).

3. **Completar el entorno** (`C:\Users\makor\.chatbotasesor\envs\<id>.env`):
   - `DATABASE_URL` en forma de **socket**, conservando la contraseña que escribió `instance:db`:
     `postgres://chatbot_<id>:<clave>@/chatbot_<id>?host=/var/run/postgresql`
   - `BACKUP_VERIFY_URL`: la del verificador (Bitwarden), igual que en las otras instancias.
   - `ANTHROPIC_API_KEY`: **clave nueva** solo para esta instancia (consola de Anthropic, nombre
     `chatbot-<id>`, con su tope mensual). Una clave repetida da `duplicate_secret` y NO APTO.
   - `SMTP_URL`: clave nueva de Brevo para esta instancia, con el login en forma `%40`:
     `smtp://882a5d001%40smtp-brevo.com:<clave>@smtp-relay.brevo.com:587`
   - `SMTP_FROM=<id>@automatizacionro.work` (uno distinto por instancia: el filtro de reenvío de
     Gmail va por remitente).
   - Guarda con saltos de línea **LF**, no CRLF (VS Code, abajo a la derecha). Un `\r` al final de
     los valores rompe la conexión a la BD y `instance:check` no lo detecta.

   **Nunca pegues una clave en el chat ni en una captura.** Si pasa, rótala (con sisu hubo que
   rotar la de Brevo).

4. **Validar**:

   ```powershell
   pnpm instance:check C:\Users\makor\.chatbotasesor\envs\<id>.env
   ```

   Tiene que dar **APTO**. Advertencias esperadas: `database_localhost`, las de `WHATSAPP_*` y
   `shared_backup_dir` (inofensiva: cada contenedor monta su propia carpeta del anfitrión).

## 3. Repositorio: dar de alta el contenedor

En `deploy/`, siguiendo lo que se hizo para `instancia-3` (commit `1fe7f41`):

| Fichero | Cambio |
|---|---|
| `docker-compose.prod.yml` | Servicio `instancia-N` (copia el de la anterior: su `env_file` con `format: raw`, los dos sockets y su carpeta de copias) y añádelo al `depends_on` de `caddy` |
| `Caddyfile` | Bloque `{$INSTANCIA_N_DOMINIO} { import instancia instancia-N }` y su línea en el comentario de cabecera |
| `fase6-correo.sh` | Aceptar `instancia-N` en el `case` y en el texto de uso |
| `descargar-copias.ps1` | Añadir `instancia-N` a `$Instancias` (la tarea programada usa esta lista por defecto, no hay que tocarla) |

Commit en la rama de trabajo.

## 4. VPS: base de datos, entorno y arranque

1. **Subir** los ficheros (al home de `operador` y de ahí con `sudo` a su sitio):

   ```powershell
   scp deploy\docker-compose.prod.yml deploy\Caddyfile deploy\fase6-correo.sh vps:deploy/
   scp <id>.sql vps:
   scp C:\Users\makor\.chatbotasesor\envs\<id>.env vps:instancia-N.env
   ```

   ```bash
   # en el VPS (ssh vps)
   sudo cp ~/deploy/* /srv/chatbot/deploy/
   sudo mv ~/instancia-N.env /srv/chatbot/instancia-N.env
   sudo chown operador: /srv/chatbot/instancia-N.env && sudo chmod 600 /srv/chatbot/instancia-N.env
   sudo install -d -o 1000 -g 1000 -m 700 /srv/chatbot/instancia-N/backups
   ```

2. **Base de datos** por el socket, y comprobación:

   ```bash
   sudo bash /srv/chatbot/deploy/fase4-bases-datos.sh crear <id> ~/<id>.sql
   sudo bash /srv/chatbot/deploy/fase4-bases-datos.sh probar <id> /srv/chatbot/instancia-N.env
   rm ~/<id>.sql      # y bórralo también del PC
   ```

3. **Dominio para Caddy**: añade `INSTANCIA_N_DOMINIO=<dominio>` a `/srv/chatbot/caddy.env`.

4. **DNS**: en Cloudflare, registro `A` `<subdominio>` → `91.99.107.86`, **con proxy** (nube
   naranja). Comprueba que resuelve a una IP de Cloudflare, no a la del VPS.

5. **Arrancar** la instancia y recrear Caddy para que lea el Caddyfile y `caddy.env` nuevos:

   ```bash
   cd /srv/chatbot/deploy
   sudo docker compose -f docker-compose.prod.yml up -d instancia-N
   sudo docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
   sudo docker inspect -f '{{.State.Health.Status}}' instancia-N     # healthy en < 2 min
   ```

   Comprobación: en las instancias, `https://<dominio>/admin` da 302 (al login) y `/health` da 200;
   repítelo en las demás instancias, porque Caddy se ha recreado.

6. **Correo**:

   ```bash
   sudo bash /srv/chatbot/deploy/fase6-correo.sh probar instancia-N <tu email>
   ```

   Tiene que llegar. Si Gmail lo manda a spam, márcalo como «No es spam».

## 5. Web de demostración (Cloudflare Pages + Access)

Solo si se enseña el chat sobre una copia de la web del cliente.

1. **Copia de la web** fuera del repo (`C:\Users\makor\Downloads\chatbot-<id>\front`). Antes de
   subirla, comprueba que **todo lo que enlazan las páginas existe** en la copia: con sisu faltaba
   la carpeta `assets/` entera (CSS, JS, imágenes) y la demo salió sin estilos. Lo que falte en la
   web original (con sisu, `assets/img/logo.png`) se deja como está.
2. Quita cualquier otro chat que traiga la web (dos burbujas se solapan en la misma esquina).
3. Añade antes de `</body>` en cada página:
   `<script src="https://<dominio>/chat/widget.js" defer></script>`
4. **Pages**: Workers & Pages → crear proyecto → subida directa → arrastra la carpeta (con
   `index.html` en la raíz). Límites: 1.000 ficheros y 25 MiB por fichero. Para actualizar:
   proyecto → *Create deployment* → producción → arrastra la carpeta entera de nuevo.
5. **Dominio**: engancha `demo-<id>.automatizacionro.work` **desde el proyecto de Pages** (crea él
   el `CNAME`).
6. **Access**: Zero Trust → Access → aplicación *self-hosted* para `demo-<id>…` con una política
   que solo deje entrar a tu email (y al del cliente cuando toque). Así la demo no queda pública.
7. Comprueba con Ctrl+F5: estilos, imágenes, y en DevTools → Network sin 404 nuevos; el chat abre
   y responde.

## 6. Panel de producción

En `https://<dominio>/admin` con la contraseña del operador:

1. **Importar** la configuración del paso 1 (o rellenarla a mano). Revisa la vista previa y
   confirma.
2. **Consumo**: precio del modelo (`claude-sonnet-5-5`: 2 / 10 / 2,5 / 0,2 USD) y **tope mensual**
   (con sisu, 10 USD), activo.
3. **Destino de avisos de derivación**: tu email mientras sea prueba o el cliente no esté al tanto.
   Para reenviárselos después, el filtro de Gmail de
   [§2.6.1](operacion-multicliente.md#261-reenviar-los-avisos-al-cliente-con-un-filtro-de-gmail)
   (no lo prepares antes de avisarle: Google le manda un código).
4. **Tono**: el estilo del negocio. **Solo con un núcleo anterior a la 0.1.4**, añade al final este
   párrafo, que evita que el bot diga que ha guardado datos que no ha guardado (pasó en las
   pruebas de sisu: «He anotado tus datos para que el centro se ponga en contacto contigo», sin
   derivación detrás). Desde la 0.1.4 (018) esa regla está en el núcleo y no hace falta:

   ```
   Nunca digas que has anotado, guardado, registrado o pasado los datos del cliente, ni que el centro le llamará o se pondrá en contacto con él: eso solo lo confirma el sistema cuando avisa de verdad al centro. Si el cliente te da su nombre o su teléfono sin que se los hayas pedido, no comentes nada sobre ellos y remítele al centro.
   ```

5. Resuelve los avisos críticos y pasa el negocio a **activo**.
6. **Chat web**: webs permitidas (la del cliente, su `www` si la usa, y la demo), enlace de
   privacidad, topes, y activar.
7. **Diseño del chat**: si se importó, ya viene. Desde la 0.1.4 (018) el icono propio rellena
   todo el botón con un borde fino del color principal: sube como icono un logo cuadrado y con
   resolución suficiente (con un núcleo anterior se ve a la mitad del botón).

## 7. Pruebas desde el chat real

Desde la demo o la web del cliente, nunca solo desde «Probar el bot» (sus avisos son simulados):

1. Preguntas típicas y una sin dato registrado: responde solo con lo registrado y ofrece contacto.
2. Nombre y teléfono **sin que los pida**: no dice que los ha anotado (párrafo del tono).
3. «Quiero hablar con una persona» → acepta → nombre y teléfono → «He avisado a…»: el aviso llega
   al destino del paso 6.3 y la derivación aparece en `/admin/handoffs`. **Márcala como
   «Terminado»** («Le atiendo» no la cierra).

**Empezar una conversación nueva**: el chat la recuerda en el navegador (clave `chat.session` del
almacenamiento de `https://<dominio>`). Para reiniciarla: ventana privada; o F12 → Application →
Local storage → `https://<dominio>` → borrar `chat.session` → F5. La demo (`demo-<id>.automatizacionro.work`)
comparte ese almacenamiento por ser del mismo sitio; la web del cliente en otro dominio, no.

## 8. Copia de seguridad y verificación (§2.7)

```bash
# en el VPS
sudo docker exec instancia-N node dist/src/cli/backup.js
f=$(sudo docker exec instancia-N sh -c 'ls -t /var/lib/chatbot/backups/*.cbak | head -1')
sudo docker exec instancia-N node dist/src/cli/verify.js "$f" --json > ~/v-<id>.json
```

Tiene que decir `"restorable":true`. Después, en el PC (con la clave del inventario cargada):

```powershell
scp vps:v-<id>.json "$HOME\.chatbotasesor\v-<id>.json"
ssh vps "rm -f ~/v-<id>.json"
pnpm instance:verified <id> "$HOME\.chatbotasesor\v-<id>.json"
```

## 9. Inventario

```powershell
pnpm instance:update <id> --status testing --image 0.1.3 --llm-workspace "Anthropic · cuenta de Roberto · clave chatbot-<id>"
pnpm instance:list
```

- `--status`: `testing` para una prueba; `active` solo para un cliente que paga (con `active`,
  `instance:list` avisa si pasa más de un mes sin verificar una copia).
- `--llm-workspace` es una descripción de dónde está la clave, nunca la clave, y no puede ir vacía.
- `--image`: la versión desplegada (compruébala con `pnpm instance:versions --only <id>`).

## 10. Cierre

- [ ] Instancia local del paso 1 retirada: contenedor de Mailpit, proceso del puerto local, BD
      `chatbot_<id>` local y su carpeta de entorno local.
- [ ] Ficheros temporales borrados: `<id>.sql` (PC y VPS), `v-<id>.json` del VPS.
- [ ] Commit de `deploy/` y de la documentación: fila nueva en el plan de despliegue y, si cambia
      el estado de alguna feature, `README.md` (avisando antes).
- [ ] La tarea programada «Chatbot - descargar copias del VPS» baja ya la nueva instancia (usa la
      lista por defecto de `descargar-copias.ps1`); compruébalo al día siguiente en
      `C:\multiagente-backups`.

## Paso a cliente definitivo

Cuando una instancia de prueba pasa a cliente que paga, se reutiliza tal cual:

1. **Dominio del cliente** (p. ej. `chat.<su-dominio>`): su DNS apunta al VPS o a Cloudflare; se
   cambia `PUBLIC_BASE_URL` en el entorno y `INSTANCIA_N_DOMINIO` en `caddy.env`, y se añade el
   dominio nuevo a las webs permitidas si cambia la web.
2. **Clave de Anthropic del cliente** (su cuenta, su tope) en `ANTHROPIC_API_KEY`.
3. **SMTP**: el suyo, o una clave de Brevo con un `SMTP_FROM` de su dominio (SPF/DKIM de su lado).
4. `instance:check` → subir el entorno → `docker compose up -d instancia-N` (y Caddy si cambió el
   dominio) → `pnpm instance:sync <id> <entorno>`.
5. **Destino de avisos**: su email; borra el filtro de reenvío de Gmail si lo había.
6. Entrega del fragmento `<script>` con la URL nueva, tras una derivación de prueba desde su web.
7. Inventario: `pnpm instance:update <id> --status active --client "<Cliente>" --llm-workspace "<su cuenta>"`.
8. Pide al cliente que marque el primer aviso como «No es spam».

## Lo que salió mal con sisu (para no repetirlo)

- **Demo sin estilos**: la copia de la web no tenía la carpeta `assets/`. Antes de subir a Pages,
  comprobar los enlaces locales.
- **Clave SMTP expuesta en el chat**: hubo que rotarla en Brevo. Los secretos no se pegan en
  ningún sitio; de un secreto se dice solo si está relleno.
- **`INSTANCE_INVENTORY_KEY` sin cargar**: las órdenes del inventario fallan con «falta
  INSTANCE_INVENTORY_KEY». Se carga con `Read-Host -AsSecureString` en la misma ventana.
- **`--llm-workspace ""` falla**: necesita entre 1 y 200 caracteres.
- **El bot dijo «he anotado tus datos»** sin derivación: párrafo del tono del paso 6.4 y, desde
  la 0.1.4, regla del núcleo (018).
- **El icono del botón flotante se veía pequeño** y no se podía agrandar desde el panel ni desde
  la web (el botón vive dentro del iframe del chat, en otro origen): resuelto en el núcleo con la
  0.1.4 (018).
