#!/usr/bin/env bash
#
# Fase 6 del plan de despliegue (docs/plan-despliegue-produccion.md): correo de prueba por
# Brevo, antes y despues de activar el bloqueo por IP de las claves SMTP.
#
# Se ejecuta EN EL VPS, con sudo, en dos subcomandos repetibles:
#
#   sudo bash /srv/chatbot/deploy/fase6-correo.sh ip <instancia-1|instancia-2|instancia-3>
#       Imprime la IPv4 publica con la que SALE ese contenedor. Es la que hay que listar en
#       Brevo, y no se da por supuesta: el contenedor sale por la red bridge de Docker con
#       SNAT, no directamente por la interfaz del VPS.
#
#   sudo bash /srv/chatbot/deploy/fase6-correo.sh probar <instancia> <destinatario>
#       Manda un correo de prueba usando el SMTP_URL y el SMTP_FROM de ESA instancia (cada
#       una tiene su propia clave de Brevo), por el mismo codigo que usa la via de avisos.
#
# Por que desde dentro del contenedor y no con swaks desde el anfitrion: la IP que Brevo
# compara es la de salida del proceso que envia. El anfitrion tiene IPv6 y podria salir por
# ella (smtp-relay.brevo.com publica AAAA), con lo que la prueba pasaria y los avisos de
# verdad fallarian, o al contrario. Esto prueba la ruta real.
#
# No imprime ningun secreto: el entorno se lee dentro del contenedor y de los fallos solo se
# muestran el codigo y la respuesta del servidor.
set -euo pipefail

CONSUMO_DIARIO="300 correos al dia en el plan gratuito, compartidos por toda la cuenta"

rojo() { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso() { printf '\n== %s\n' "$*"; }

abortar() {
  rojo "ABORTADO: $*"
  exit 1
}

requisitos() {
  [[ $EUID -eq 0 ]] || abortar "ejecutalo con sudo."
  command -v docker >/dev/null || abortar "no hay docker en el PATH."
  case "${1:-}" in
    instancia-1 | instancia-2 | instancia-3) ;;
    *) abortar "la instancia es instancia-1, instancia-2 o instancia-3, no '${1:-}'." ;;
  esac
  CONTENEDOR="$1"
  docker inspect -f '{{.State.Status}}' "$CONTENEDOR" >/dev/null 2>&1 ||
    abortar "el contenedor $CONTENEDOR no existe."
  local estado salud
  estado="$(docker inspect -f '{{.State.Status}}' "$CONTENEDOR")"
  salud="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-sonda{{end}}' "$CONTENEDOR")"
  [[ $estado == running ]] || abortar "$CONTENEDOR esta en estado '$estado'."
  [[ $salud == healthy ]] || abortar "$CONTENEDOR esta '$salud'; arreglalo antes de probar el correo."
}

# --- ip ------------------------------------------------------------------------------------
# Un servicio ajeno, pero solo devuelve la IP y no recibe nada nuestro. Si no se quiere salida
# a terceros, la alternativa es mirar en Brevo el error de IP no autorizada, que la nombra.
subcomando_ip() {
  requisitos "${1:-}"
  paso "IPv4 de salida de $CONTENEDOR"
  docker exec "$CONTENEDOR" node --input-type=module -e '
    const r = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(10000) });
    console.log((await r.text()).trim());
  ' || abortar "no se pudo averiguar la IP de salida."
  echo
  echo "Esa es la direccion que va en Brevo -> Seguridad -> IPs autorizadas."
  echo "Si no coincide con la IPv4 del VPS, NO listes la del VPS: lista esta."
}

# --- probar --------------------------------------------------------------------------------
subcomando_probar() {
  requisitos "${1:-}"
  local destino="${2:-}"
  [[ $destino == *@*.* ]] || abortar "falta el destinatario, o no parece un correo: '${destino}'."

  paso "Correo de prueba de $CONTENEDOR a $destino"
  echo "Consumo: 1 correo ($CONSUMO_DIARIO)."

  # --input-type=module para poder importar el modulo del nucleo y usar EXACTAMENTE el mismo
  # transporte que la via de avisos (requireTLS con smtp://, plazos de 10/14 s).
  # El destinatario entra por argv, no por el entorno, y el SMTP_URL no se copia a ningun
  # sitio: se lee del entorno que ya tiene el contenedor.
  docker exec "$CONTENEDOR" node --input-type=module -e '
    const { smtpTransport } = await import("file:///app/dist/src/mail/smtp-mailer.js");
    const url = process.env.SMTP_URL;
    const from = process.env.SMTP_FROM;
    const to = process.argv[1];
    const id = process.env.INSTANCE_ID ?? "sin-id";
    if (!url || !from) {
      console.error("faltan SMTP_URL o SMTP_FROM en el entorno de la instancia");
      process.exit(2);
    }
    const t = smtpTransport(url);
    try {
      await t.verify();
      console.log("autenticacion y STARTTLS: correctos");
      const info = await t.sendMail({
        from,
        to,
        subject: `Prueba SMTP de la instancia ${id}`,
        text: [
          `Correo de prueba de la instancia ${id}, enviado desde el VPS por Brevo.`,
          "Si ha llegado, ya se puede activar el bloqueo por IP de las claves SMTP.",
          `Fecha: ${new Date().toISOString()}`,
        ].join("\n"),
      });
      console.log("aceptados por el servidor:", info.accepted?.length ?? 0);
      console.log("rechazados:", info.rejected?.length ?? 0);
      console.log("respuesta:", String(info.response ?? "").slice(0, 120));
    } catch (e) {
      // Solo el codigo y la respuesta: nunca el SMTP_URL, que lleva la clave.
      console.error("FALLO:", e.code ?? "", e.responseCode ?? "", String(e.response ?? e.message).slice(0, 200));
      process.exit(1);
    } finally {
      t.close();
    }
  ' "$destino" || abortar "el envio fallo. Lee el codigo de arriba:
    EAUTH / 535  -> clave SMTP mal copiada, o el @ del login sin codificar como %40.
    550 / 553    -> el SMTP_FROM no esta en el dominio verificado de Brevo.
    'unauthorized IP' o 'not authorized' -> el bloqueo por IP ya esta activo y esta IP no
                     figura en la lista: anadela (subcomando 'ip') o desactiva el bloqueo.
    ETIMEDOUT    -> salida al 587 cortada. La salida de Hetzner esta abierta por defecto."

  verde "OK: el servidor de Brevo acepto el mensaje."
  echo "Aceptado NO es entregado: confirma en la bandeja de $destino antes de seguir."
  echo "Si no llega en 2-3 minutos, mira Brevo -> Transaccional -> Registros (y la carpeta de spam)."
}

# --- forma ---------------------------------------------------------------------------------
# Diagnostico de un 535 sin pedir que nadie pegue el SMTP_URL en ningun sitio. Describe la
# FORMA del valor (cuantas arrobas, longitudes, prefijos conocidos), nunca el valor.
#
# NOTA, comprobada el 2026-10-08 contra el propio parser: el `@` del login SIN codificar NO
# rompe la URL. `new URL` parte el userinfo por el ULTIMO `@` y el usuario por el PRIMER `:`,
# asi que `882a5d001@smtp-brevo.com` se lee igual de bien con %40 que sin el. El aviso del plan
# (§2.5) es inofensivo pero no es causa de un 535. Lo que si lo es, por orden de probabilidad:
# una clave de API (xkeysib-) en vez de la clave SMTP (xsmtpsib-), una clave incompleta, un
# retorno de carro pegado al valor, o el bloqueo por IP ya activado antes de tiempo.
subcomando_forma() {
  requisitos "${1:-}"
  paso "Forma de SMTP_URL y SMTP_FROM en $CONTENEDOR (sin mostrar secretos)"
  docker exec "$CONTENEDOR" node --input-type=module -e '
    const crypto = await import("node:crypto");
    const crudo = process.env.SMTP_URL ?? "";
    const from = process.env.SMTP_FROM ?? "";
    if (!crudo) { console.error("SMTP_URL no esta definida"); process.exit(2); }

    const huella = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
    const si = (b) => (b ? "SI" : "no");

    console.log("comillas alrededor:", si(/^["\x27]|["\x27]$/.test(crudo)), "(debe ser no: env_file va en format raw)");
    console.log("espacio o retorno de carro al final:", si(/[\s\r]$/.test(crudo)), "(debe ser no)");
    console.log("longitud total del valor:", crudo.length);
    console.log("(el %40 del login es indiferente: new URL lee igual `@` y `%40`)");

    let u;
    try { u = new URL(crudo); } catch { console.error("new URL() no puede leerla"); process.exit(1); }
    const usuario = decodeURIComponent(u.username);
    const clave = decodeURIComponent(u.password);
    console.log("protocolo:", u.protocol, " host:", u.hostname, " puerto:", u.port || "(por defecto)");
    console.log("usuario: longitud", usuario.length, "| acaba en @smtp-brevo.com:", si(usuario.endsWith("@smtp-brevo.com")));
    console.log("  huella del usuario:", huella(usuario), "(igual en las dos instancias: correcto)");
    console.log("clave: longitud", clave.length,
      "| empieza por xsmtpsib-:", si(clave.startsWith("xsmtpsib-")),
      "| parece clave de API (xkeysib-):", si(clave.startsWith("xkeysib-")));
    console.log("  huella de la clave:", huella(clave), "(DISTINTA en cada instancia: correcto)");
    console.log("  caracteres raros en la clave:", si(/[^A-Za-z0-9.\x2d_]/.test(clave)), "(si es SI, hay que codificarlos)");
    console.log("SMTP_FROM: dominio", from.split("@")[1] ?? "(ninguno)");

    // Cruce con los demas secretos del entorno: si la contraseña SMTP resulta ser otro valor
    // traspapelado al copiar, aqui sale. Solo se comparan huellas, nunca valores.
    const otros = {
      SESSION_SECRET: process.env.SESSION_SECRET,
      BACKUP_KEY: process.env.BACKUP_KEY,
      HEALTH_SECRET: process.env.HEALTH_SECRET,
      OPERATOR_PASSWORD_HASH: process.env.OPERATOR_PASSWORD_HASH,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
      BACKUP_VERIFY_URL: process.env.BACKUP_VERIFY_URL,
    };
    for (const [n, v] of Object.entries(otros)) {
      if (!v) continue;
      // El valor entero y, en las URL, solo su contraseña.
      let pass = null;
      if (n.endsWith("_URL")) { try { pass = decodeURIComponent(new URL(v).password); } catch {} }
      if (huella(v) === huella(clave)) console.log("  !! la clave SMTP es EXACTAMENTE", n);
      else if (pass && huella(pass) === huella(clave)) console.log("  !! la clave SMTP es la contraseña de", n);
    }
    console.log("  cruce con los demas secretos: terminado (sin avisos = no coincide con ninguno)");
  ' || abortar "no se pudo leer el entorno de $CONTENEDOR."
}

case "${1:-}" in
  ip) subcomando_ip "${2:-}" ;;
  probar) subcomando_probar "${2:-}" "${3:-}" ;;
  forma) subcomando_forma "${2:-}" ;;
  *)
    cat <<'USO'
Uso:
  sudo bash fase6-correo.sh ip <instancia-1|instancia-2|instancia-3>
  sudo bash fase6-correo.sh probar <instancia-1|instancia-2|instancia-3> <destinatario>
  sudo bash fase6-correo.sh forma <instancia-1|instancia-2|instancia-3>
USO
    exit 1
    ;;
esac
