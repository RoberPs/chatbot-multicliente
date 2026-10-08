#!/usr/bin/env bash
#
# Fase 5 del plan de despliegue (docs/plan-despliegue-produccion.md): red y HTTPS.
#
# Se ejecuta EN EL VPS, con sudo, y en tres subcomandos que se pueden repetir:
#
#   sudo bash /srv/chatbot/deploy/fase5-red-https.sh imagen
#       Comprueba que la imagen de GHCR esta bajada y es la auditada (digest y etiqueta OCI).
#
#   sudo bash /srv/chatbot/deploy/fase5-red-https.sh arrancar
#       Arranca las dos instancias (aplican migraciones), las comprueba endurecidas y sin
#       puertos publicados, y despues arranca Caddy y espera su certificado de Let's Encrypt.
#
#   sudo bash /srv/chatbot/deploy/fase5-red-https.sh comprobar
#       Solo lee: repite todas las comprobaciones. No cambia nada.
#
# ANTES de `arrancar`, los registros A de Cloudflare ya tienen que resolver al VPS con proxy:
# el certificado se saca por el desafio HTTP-01, que entra por el puerto 80 a traves de
# Cloudflare. Y el modo SSL de Cloudflare tiene que estar en «Full», NO todavia en
# «Full (strict)»: strict exige un certificado valido en el origen, que es justo lo que este
# paso crea. Se sube a strict despues, cuando este script da verde.
set -euo pipefail

BASE=/srv/chatbot
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$DEPLOY/docker-compose.prod.yml"
ENV_COMPOSE="$DEPLOY/.env"
CADDY_ENV="$BASE/caddy.env"
CADDY=chatbot-caddy-1
INSTANCIAS=(instancia-1 instancia-2)

# Digest de la imagen auditada en la fase 0 y subida a GHCR el 2026-10-07. Para una version
# posterior se pasa DIGEST_ESPERADO en el entorno.
DIGEST_ESPERADO="${DIGEST_ESPERADO:-sha256:f52e81af15a8ff3c327fb2555f5f986534e6fc9a303ca3b3a5597374cbb7cc56}"

rojo() { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso() { printf '\n== %s\n' "$*"; }

abortar() {
  rojo "ABORTADO: $*"
  exit 1
}

# --- Requisitos comunes --------------------------------------------------------------------
requisitos() {
  paso "0. Requisitos"
  [[ $EUID -eq 0 ]] || abortar "ejecutalo con sudo."
  command -v docker >/dev/null || abortar "no hay docker en el PATH."
  [[ -f $COMPOSE ]] || abortar "no encuentro $COMPOSE."

  # `.env` junto al compose: de aqui salen CHATBOT_IMAGEN y CHATBOT_VERSION. Tiene que ser un
  # fichero y no variables exportadas, porque `sudo` limpia el entorno del llamante y el
  # compose abortaria por el `:?` de CHATBOT_VERSION.
  [[ -f $ENV_COMPOSE ]] || abortar "falta $ENV_COMPOSE. Creala como operador, sin sudo:
    printf 'CHATBOT_IMAGEN=ghcr.io/roberps/chatbot-multicliente\\nCHATBOT_VERSION=0.1.0\\n' > $ENV_COMPOSE"
  for clave in CHATBOT_IMAGEN CHATBOT_VERSION; do
    grep -qE "^$clave=.+" "$ENV_COMPOSE" || abortar "$ENV_COMPOSE no define $clave."
  done
  IMAGEN="$(sed -n 's/^CHATBOT_IMAGEN=//p' "$ENV_COMPOSE" | tr -d '\r')"
  VERSION="$(sed -n 's/^CHATBOT_VERSION=//p' "$ENV_COMPOSE" | tr -d '\r')"
  REFERENCIA="$IMAGEN:$VERSION"
  [[ $VERSION != "latest" ]] || abortar "CHATBOT_VERSION=latest esta prohibido: siempre X.Y.Z."

  # Los tres valores de Caddy. Si siguen siendo el marcador vacio de la fase 3, Caddy
  # arrancaria sirviendo el dominio literal «{$INSTANCIA_1_DOMINIO}» y pediria un certificado
  # para un nombre que no existe.
  [[ -f $CADDY_ENV ]] || abortar "falta $CADDY_ENV (lo creo la fase 3)."
  for clave in ACME_CORREO INSTANCIA_1_DOMINIO INSTANCIA_2_DOMINIO; do
    grep -qE "^$clave=.+" "$CADDY_ENV" ||
      abortar "$CADDY_ENV no define $clave: sigue siendo el marcador vacio de la fase 3."
  done
  # La leccion de la fase 4: un \r al final del valor se pega al dominio y no se ve.
  (($(tr -cd '\r' <"$CADDY_ENV" | wc -c) == 0)) ||
    abortar "$CADDY_ENV tiene saltos de linea de Windows (CRLF). Arreglalo: sed -i 's/\\r\$//' $CADDY_ENV"
  DOMINIO_1="$(sed -n 's/^INSTANCIA_1_DOMINIO=//p' "$CADDY_ENV")"
  DOMINIO_2="$(sed -n 's/^INSTANCIA_2_DOMINIO=//p' "$CADDY_ENV")"
  # Un solo nivel de subdominio: el certificado gratuito de Cloudflare no cubre dos.
  for dominio in "$DOMINIO_1" "$DOMINIO_2"; do
    (($(tr -cd '.' <<<"$dominio" | wc -c) == 2)) ||
      abortar "«$dominio» no es un subdominio de un solo nivel (esperado sub.dominio.tld)."
  done
  docker compose -f "$COMPOSE" config -q
  verde "  imagen $REFERENCIA · dominios $DOMINIO_1 y $DOMINIO_2"
}

# --- Resolucion DNS ------------------------------------------------------------------------
# No se comprueba que resuelva a la IP del VPS: con el proxy activado, Cloudflare devuelve SUS
# direcciones, que es lo correcto. Solo que resuelva a algo.
comprobar_dns() {
  paso "1. DNS de los dos dominios"
  for dominio in "$DOMINIO_1" "$DOMINIO_2"; do
    local direcciones
    direcciones="$(getent ahostsv4 "$dominio" | awk '{print $1}' | sort -u | tr '\n' ' ')" ||
      abortar "«$dominio» no resuelve todavia. Crea su registro A en Cloudflare y espera."
    [[ -n $direcciones ]] || abortar "«$dominio» no resuelve a ninguna IPv4."
    printf '  %s -> %s\n' "$dominio" "$direcciones"
  done
  verde "  Los dos dominios resuelven."
}

# --- Imagen --------------------------------------------------------------------------------
comprobar_imagen() {
  paso "2. Imagen de GHCR"
  if ! docker image inspect "$REFERENCIA" >/dev/null 2>&1; then
    cat <<TXT
  La imagen no esta bajada. Entra en GHCR con el token de SOLO LECTURA (chatbot-ghcr-pull),
  por la entrada estandar para que no quede en el historial, y bajala:

    sudo docker login ghcr.io -u roberps --password-stdin   # pega el token y Ctrl+D
    sudo docker pull $REFERENCIA
    sudo docker logout ghcr.io

TXT
    abortar "falta la imagen $REFERENCIA."
  fi

  # El digest confirma que es exactamente la imagen auditada en la fase 0, no una reconstruida.
  local digests
  digests="$(docker image inspect -f '{{join .RepoDigests "\n"}}' "$REFERENCIA")"
  if ! grep -q "$DIGEST_ESPERADO" <<<"$digests"; then
    rojo "  digest esperado: $DIGEST_ESPERADO"
    rojo "  digest(s) reales: $digests"
    abortar "la imagen bajada NO es la auditada. No sigas sin averiguar por que."
  fi
  verde "  Digest correcto: $DIGEST_ESPERADO"

  # Etiqueta OCI que puso el `--build-arg CORE_VERSION` de la fase 0.
  local etiqueta
  etiqueta="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$REFERENCIA")"
  [[ $etiqueta == "$VERSION" ]] ||
    abortar "la etiqueta OCI de la imagen es «$etiqueta» y CHATBOT_VERSION es «$VERSION»."
  verde "  Etiqueta OCI org.opencontainers.image.version: $etiqueta"
}

# --- Instancias ----------------------------------------------------------------------------
esperar_sanos() {
  local segundos="$1" estado
  printf 'Esperando a que las dos instancias esten healthy (hasta %ss, las migraciones tardan)' "$segundos"
  for ((i = 0; i < segundos; i += 3)); do
    estado="$(docker inspect -f '{{.State.Health.Status}}' "${INSTANCIAS[@]}" 2>/dev/null | sort -u | tr '\n' ' ')"
    [[ $estado == "healthy " ]] && break
    printf '.'
    sleep 3
  done
  printf '\n'
  [[ ${estado:-} == "healthy " ]] || {
    docker inspect -f '{{.Name}} {{.State.Health.Status}}' "${INSTANCIAS[@]}" 2>/dev/null || true
    abortar "las instancias no se han puesto healthy (estado: ${estado:-desconocido}). Mira los registros: sudo docker compose -f $COMPOSE logs instancia-1 instancia-2 ; si sale migration_blocked o migration_failed, ve a la seccion 5.4 de operacion-multicliente.md."
  }
  verde "  instancia-1 e instancia-2: healthy."
}

comprobar_instancias() {
  paso "3. Instancias endurecidas y sin puertos (receta, pasos 5, 6 y 9)"
  for c in "${INSTANCIAS[@]}"; do
    docker inspect "$c" >/dev/null 2>&1 || abortar "el contenedor $c no existe: ejecuta antes el subcomando arrancar."
    local endurecido
    endurecido="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' "$c")"
    [[ $endurecido == "true [ALL] [no-new-privileges:true]" ]] ||
      abortar "$c no esta endurecido como pide la receta: $endurecido"
    # `docker port` no imprime nada cuando no hay ningun puerto publicado (la leccion de la
    # fase 3: `.NetworkSettings.Ports` muestra el EXPOSE de la imagen y despista).
    local publicados
    publicados="$(docker port "$c")"
    [[ -z $publicados ]] || abortar "$c publica puertos en el anfitrion: $publicados"
    printf '  %s: solo lectura, sin capacidades, sin escalada, sin puertos publicados.\n' "$c"
  done
  # Ni 0.0.0.0:3000 ni 127.0.0.1:3000: las instancias solo se alcanzan por la red de Docker.
  if ss -ltnH | grep -q ':3000'; then
    ss -ltn | grep ':3000'
    abortar "hay algo escuchando en el 3000 del anfitrion; no deberia haber nada."
  fi
  verde "  Nada escuchando en el 3000 del anfitrion."
  esperar_sanos 30
}

# --- Caddy y el certificado ----------------------------------------------------------------
esperar_certificados() {
  paso "5. Certificado de Let's Encrypt"
  local segundos=180 pendiente ruta
  printf 'Esperando el certificado de los dos dominios (hasta %ss)' "$segundos"
  for ((i = 0; i < segundos; i += 5)); do
    pendiente=""
    for dominio in "$DOMINIO_1" "$DOMINIO_2"; do
      ruta="/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$dominio/$dominio.crt"
      docker exec "$CADDY" test -f "$ruta" || pendiente="$dominio"
    done
    [[ -z $pendiente ]] && break
    printf '.'
    sleep 5
  done
  printf '\n'
  [[ -z ${pendiente:-} ]] || {
    docker logs --tail 40 "$CADDY" 2>&1 | grep -iE 'error|challenge|obtain' || true
    cat <<TXT

  Sin certificado para «$pendiente». Las tres causas, en orden de probabilidad:
    1. El registro A de ese dominio no existe en Cloudflare o no esta proxificado.
    2. «Always Use HTTPS» esta ACTIVADO en Cloudflare: redirige el desafio HTTP-01 en el
       borde y nunca llega al origen. Desactivalo y reinicia Caddy.
    3. El cortafuegos de Hetzner no deja entrar el 80 desde algun rango de Cloudflare.
TXT
    abortar "no hay certificado para $pendiente."
  }
  verde "  Certificado de Let's Encrypt para los dos dominios."
}

comprobar_tls() {
  paso "6. El certificado del origen es valido (lo que exige Full (strict))"
  # Se entra por 127.0.0.1 saltandose Cloudflare, para mirar el certificado DEL ORIGEN y no el
  # del borde. Sin --insecure a proposito: si el certificado no es valido y del nombre correcto,
  # curl falla, y eso es exactamente lo que Cloudflare hara en modo strict.
  for dominio in "$DOMINIO_1" "$DOMINIO_2"; do
    local codigo
    codigo="$(curl -s --max-time 15 --resolve "$dominio:443:127.0.0.1" \
      -o /dev/null -w '%{http_code}' "https://$dominio/health")" ||
      abortar "el certificado del origen para «$dominio» no valida. Cloudflare en Full (strict) daria 526."
    [[ $codigo == "200" ]] ||
      abortar "https://$dominio/health respondio $codigo desde el propio VPS (se esperaba 200)."
    printf '  %s: certificado valido y /health en 200.\n' "$dominio"
  done
  verde "  Las dos instancias responden por HTTPS con certificado valido."

  paso "7. Puertos a la escucha en el anfitrion"
  ss -ltnH | awk '{print $4}' | sort -u
  for puerto in ':80' ':443'; do
    ss -ltnH | grep -q "$puerto" || abortar "Caddy no escucha en $puerto."
  done
  verde "  80 y 443 de Caddy escuchando; el resto, como en la fase 3."
}

arrancar() {
  requisitos
  comprobar_dns
  comprobar_imagen

  paso "3. Arranque de las dos instancias"
  # Al arrancar aplican sus migraciones y crean el negocio vacio «En preparacion».
  docker compose -f "$COMPOSE" up -d instancia-1 instancia-2
  esperar_sanos 180
  comprobar_instancias

  paso "4. Arranque de Caddy"
  docker compose -f "$COMPOSE" up -d caddy
  sleep 5
  [[ "$(docker inspect -f '{{.State.Running}}' "$CADDY")" == "true" ]] ||
    abortar "Caddy no esta en marcha. Mira: sudo docker logs $CADDY"
  verde "  Caddy en marcha."

  esperar_certificados
  comprobar_tls

  cat <<TXT

$(verde "Fase 5 lista en el servidor.") Lo que queda, y en este orden:

  1. En Cloudflare, subir el modo SSL de «Full» a «Full (strict)». Ahora si: el origen ya
     tiene un certificado valido, que es lo que strict comprueba.
  2. Desde tu PC (Git Bash), la prueba del paso 7 de la receta:
       bash deploy/fase5-prueba-xff.sh $DOMINIO_1
  3. Desde otra maquina y otra red (el movil con datos, no por el wifi de casa), en ese mismo
     minuto, comprobar que /health sigue dando 200.
TXT
}

comprobar() {
  requisitos
  comprobar_dns
  comprobar_imagen
  comprobar_instancias
  docker inspect "$CADDY" >/dev/null 2>&1 ||
    abortar "el contenedor $CADDY no existe: ejecuta antes el subcomando arrancar."
  esperar_certificados
  comprobar_tls
  printf '\n'
  verde "Todas las comprobaciones de la fase 5, en verde."
}

case "${1-}" in
imagen)
  requisitos
  comprobar_imagen
  printf '\n'
  verde "Imagen correcta."
  ;;
arrancar) arrancar ;;
comprobar) comprobar ;;
*)
  cat <<TXT
Uso: sudo bash $0 <subcomando>

  imagen      Comprueba que la imagen de GHCR esta bajada y es la auditada.
  arrancar    Arranca las instancias y Caddy, y espera el certificado.
  comprobar   Repite todas las comprobaciones sin cambiar nada.
TXT
  exit 2
  ;;
esac
