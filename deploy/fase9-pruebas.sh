#!/usr/bin/env bash
#
# Fase 9 del plan de despliegue (docs/plan-despliegue-produccion.md): las pruebas de punta a
# punta que se hacen EN EL VPS. Las otras dos (el chat desde la web publica y
# `pnpm instance:versions`) se hacen desde el PC y no estan aqui.
#
# Cuatro subcomandos, todos repetibles:
#
#   sudo bash /srv/chatbot/deploy/fase9-pruebas.sh copias <instancia-1|instancia-2>
#       db:backup, db:backups y db:verify de esa instancia, por los mismos CLI que trae la
#       imagen (dist/src/cli/*.js). El VPS no tiene el repositorio ni pnpm: `pnpm db:backup` es
#       `node dist/src/cli/backup.js` dentro del contenedor. Consume espacio en BACKUP_DIR y
#       crea y borra una base temporal en el cluster de verificacion.
#
#   sudo bash /srv/chatbot/deploy/fase9-pruebas.sh aislamiento
#       Que una instancia no ve datos de la otra, en los tres niveles donde podria verlos: los
#       datos que lee el bot, el catalogo de PostgreSQL y el directorio de copias.
#
#   sudo bash /srv/chatbot/deploy/fase9-pruebas.sh emergencia parar|arrancar
#       Para (y luego arranca) el PostgreSQL de produccion, que es la UNICA forma de que el bot
#       ensene EMERGENCY_CONTACT_PHONE. Lee el aviso del subcomando antes de usarlo.
#
#   sudo bash /srv/chatbot/deploy/fase9-pruebas.sh estado
#       Estado y salud de los cinco contenedores. Para dejarlo comprobado al terminar.
#
# No imprime ningun secreto: las contrasenas se leen de los ficheros de entorno y viajan por el
# entorno del proceso (`docker exec -e PGPASSWORD` sin valor reenvia la del llamante), nunca por
# la linea de ordenes, que `ps` ve.
set -euo pipefail

BASE=/srv/chatbot
DB=chatbot-db-1
DB_VERIFICACION=chatbot-db-verificacion-1

rojo() { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso() { printf '\n== %s\n' "$*"; }

abortar() {
  rojo "ABORTADO: $*"
  exit 1
}

uso() {
  cat >&2 <<'TXT'
Uso:
  sudo bash fase9-pruebas.sh copias <instancia-1|instancia-2>
  sudo bash fase9-pruebas.sh aislamiento
  sudo bash fase9-pruebas.sh emergencia parar|arrancar
  sudo bash fase9-pruebas.sh estado
TXT
  exit 2
}

requisitos() {
  [[ $EUID -eq 0 ]] || abortar 'ejecutalo con sudo.'
  command -v docker >/dev/null || abortar 'no hay docker en el PATH.'
}

# Estado y salud de un contenedor, en una linea: "running healthy".
situacion() {
  docker inspect \
    -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}sin-sonda{{end}}' \
    "$1" 2>/dev/null || echo 'no-existe sin-sonda'
}

exigir_sana() {
  local contenedor="$1" s
  s="$(situacion "$contenedor")"
  [[ $s == 'running healthy' ]] ||
    abortar "$contenedor esta '$s'; arreglalo antes de probar (receta, paso 10)."
}

contenedor_valido() {
  case "${1:-}" in
    instancia-1 | instancia-2) CONTENEDOR="$1" ;;
    *) abortar "la instancia es instancia-1 o instancia-2, no '${1:-}'." ;;
  esac
}

# psql como superusuario por el socket del cluster de produccion (igual que en la fase 4).
psql_admin() {
  PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$BASE/db.env")" \
    docker exec -e PGPASSWORD -i "$DB" psql -U postgres -tAqX "$@"
}

# Lo mismo en el cluster de verificacion de copias, que tiene su propio superusuario.
psql_verificacion() {
  PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$BASE/db-verificacion.env")" \
    docker exec -e PGPASSWORD -i "$DB_VERIFICACION" psql -U postgres -tAqX "$@"
}

# INSTANCE_ID de un contenedor, leido de su propio entorno (no de los ficheros del anfitrion).
instance_id() {
  docker exec "$1" node -e 'process.stdout.write(process.env.INSTANCE_ID ?? "")'
}

# --- copias --------------------------------------------------------------------------------
# Las tres ordenes de la casilla, en el orden que tiene sentido: crear una copia, listarla y
# comprobar que se restaura. `verify` no toca la instancia: restaura en una base temporal del
# OTRO cluster (BACKUP_VERIFY_URL), compara los recuentos y la borra.
subcomando_copias() {
  contenedor_valido "${1:-}"
  exigir_sana "$CONTENEDOR"
  exigir_sana "$DB"
  exigir_sana "$DB_VERIFICACION"

  local id dir_host fichero salida
  id="$(instance_id "$CONTENEDOR")"
  [[ -n $id ]] || abortar "$CONTENEDOR no tiene INSTANCE_ID en su entorno."
  dir_host="$BASE/${CONTENEDOR}/backups"
  [[ -d $dir_host ]] || abortar "no existe $dir_host (fase 3)."

  paso "1. Copia bajo demanda de $CONTENEDOR (instancia $id)"
  echo '   equivale a `pnpm db:backup`; el motivo queda como `manual`.'
  # --json para poder sacar el nombre del fichero sin adivinarlo. La salida es una sola linea.
  salida="$(docker exec "$CONTENEDOR" node dist/src/cli/backup.js --json)" ||
    abortar "la copia fallo. El JSON de arriba trae el codigo en \"failure\"."
  [[ $salida == *'"ok":true'* ]] || abortar "la copia no salio bien: $salida"
  fichero="$(printf '%s' "$salida" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')"
  [[ -n $fichero ]] || abortar "no he podido leer el nombre del fichero de: $salida"
  verde "  Copia creada: $fichero"

  paso '2. El fichero esta en el volumen del anfitrion'
  # El contenedor tiene la raiz en solo lectura: si la copia estuviera dentro de la imagen y no
  # en el montaje, no habria podido escribirla. Esto confirma que sobrevive al contenedor.
  [[ -f "$dir_host/$fichero" ]] ||
    abortar "la copia no aparece en $dir_host: BACKUP_DIR no apunta al montaje."
  ls -l "$dir_host/$fichero"
  verde "  Persistida fuera del contenedor."

  paso '3. Lista de copias de la instancia'
  echo '   equivale a `pnpm db:backups` (sin --prune: no borra nada).'
  docker exec "$CONTENEDOR" node dist/src/cli/backups.js ||
    abortar 'el listado de copias fallo.'

  paso "4. Comprobacion de la copia: $fichero"
  echo "   equivale a \`pnpm db:verify $fichero\`. Restaura en una base temporal de"
  echo "   $DB_VERIFICACION, compara los recuentos y la borra. Tarda segun el tamano."
  docker exec "$CONTENEDOR" node dist/src/cli/verify.js "$fichero" ||
    abortar 'NO RESTAURABLE, o fallo la verificacion. El motivo y su codigo salen arriba.
    key_missing / decrypt_failed -> la BACKUP_KEY del entorno no es la que cifro la copia.
    db_error                     -> BACKUP_VERIFY_URL o el rol verificador (fase 3).'

  paso '5. No quedan bases temporales en el cluster de verificacion'
  # `verify` las borra al terminar y, al empezar, limpia las huerfanas de una ejecucion cortada
  # (013, contracts/verify-cleanup.md). Si aqui sale mas de 0, alguna verificacion se interrumpio.
  local temporales
  temporales="$(psql_verificacion -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'verify\\_%';" || true)"
  [[ ${temporales:-1} == '0' ]] ||
    rojo "   Quedan $temporales bases 'verify_%' en $DB_VERIFICACION: las borrara la siguiente verificacion."
  [[ ${temporales:-1} != '0' ]] || verde '  Ninguna: la base temporal se ha borrado.'

  printf '\n'
  verde "Instancia $id: copia creada, listada y RESTAURABLE."
  echo 'Recuerda: la copia vive en el mismo disco que la base. La copia fuera del servidor es'
  echo 'la fase 10; hasta entonces, perder el VPS es perder los datos y las copias.'
}

# --- aislamiento ---------------------------------------------------------------------------
# Tres niveles, de arriba abajo. El del medio ya se probo en la fase 4 (`probar`), pero aqui se
# repite con datos de negocio dentro, que es lo que pide la casilla de la fase 9.
subcomando_aislamiento() {
  exigir_sana instancia-1
  exigir_sana instancia-2
  exigir_sana "$DB"

  local id1 id2 datos1 datos2
  id1="$(instance_id instancia-1)"
  id2="$(instance_id instancia-2)"
  [[ -n $id1 && -n $id2 ]] || abortar 'alguna instancia no tiene INSTANCE_ID.'
  [[ $id1 != "$id2" ]] || abortar "las dos instancias tienen el mismo INSTANCE_ID ($id1)."

  paso '1. Lo que lee el bot de cada instancia'
  echo '   Por el mismo camino que una respuesta: KnowledgeReader.getSnapshot() sobre su propia'
  echo '   DATABASE_URL, sin cache. Si una viera los datos de la otra, saldria aqui.'
  # Solo el nombre, el estado y unos recuentos: ni telefonos ni correos ni la carta entera.
  lee_snapshot() {
    docker exec "$1" node --input-type=module -e '
      const { createDb, closeDb } = await import("file:///app/dist/src/db/client.js");
      const { createKnowledgeReader } = await import("file:///app/dist/src/knowledge/snapshot.js");
      const db = createDb(process.env.DATABASE_URL);
      try {
        const s = await createKnowledgeReader(db).getSnapshot();
        console.log(JSON.stringify({
          instancia: process.env.INSTANCE_ID ?? null,
          negocio: s.business.name,
          estado: s.status,
          servicios: s.services.length,
          faq: s.faqs.length,
          franjas: s.openingHours.length,
          cierres: s.closures.length,
        }));
      } finally {
        await closeDb(db);
      }
    '
  }
  datos1="$(lee_snapshot instancia-1)" || abortar 'instancia-1 no ha podido leer su snapshot.'
  datos2="$(lee_snapshot instancia-2)" || abortar 'instancia-2 no ha podido leer su snapshot.'
  printf '   instancia-1: %s\n' "$datos1"
  printf '   instancia-2: %s\n' "$datos2"
  [[ $datos1 != "$datos2" ]] || abortar 'las dos instancias leen exactamente lo mismo.'
  local negocio1 negocio2
  negocio1="$(printf '%s' "$datos1" | sed -n 's/.*"negocio":"\([^"]*\)".*/\1/p')"
  negocio2="$(printf '%s' "$datos2" | sed -n 's/.*"negocio":"\([^"]*\)".*/\1/p')"
  [[ -n $negocio1 && -n $negocio2 && $negocio1 != "$negocio2" ]] ||
    abortar "las dos leen el mismo negocio ('$negocio1' y '$negocio2')."
  verde "  Cada instancia lee su negocio, y no el de la otra."

  paso '2. El catalogo de PostgreSQL: ningun usuario alcanza la base de la otra'
  local bases nombre otra permiso
  bases="$(psql_admin -c "SELECT datname FROM pg_database WHERE datname LIKE 'chatbot\\_%' ORDER BY datname;")"
  [[ $(printf '%s\n' "$bases" | grep -c .) -ge 2 ]] ||
    abortar 'no hay dos bases de instancia en el cluster.'
  while read -r nombre; do
    [[ -n $nombre ]] || continue
    while read -r otra; do
      [[ -n $otra && $otra != "$nombre" ]] || continue
      # `::text` a proposito: `psql -tA` imprime `f`, no `false`, si no se pide el texto.
      permiso="$(psql_admin -c "SELECT has_database_privilege('$nombre', '$otra', 'CONNECT')::text;")"
      [[ $permiso == 'false' ]] || abortar "$nombre PUEDE conectarse a $otra."
      verde "  $nombre no puede conectarse a $otra."
    done <<<"$bases"
  done <<<"$bases"

  paso '3. Y no es solo el permiso: la conexion cruzada falla de verdad'
  # Con las credenciales REALES de una instancia contra la base de la otra. El permiso del paso
  # anterior lo dice el catalogo; esto lo comprueba intentandolo.
  local clave quien
  cruzada() {
    local entorno="$1" base_otra="$2" url
    url="$(sed -n 's/^DATABASE_URL=//p' "$entorno" | tail -n 1)"
    [[ -n $url ]] || abortar "$entorno no tiene DATABASE_URL."
    local usuario
    usuario="${url#*://}"
    usuario="${usuario%%:*}"
    clave="${url#*://"$usuario":}"
    clave="${clave%%@*}"
    [[ $clave =~ ^[A-Za-z0-9_-]+$ ]] ||
      abortar 'la contrasena de la DATABASE_URL lleva caracteres codificados: comprueba a mano.'
    if quien="$(PGPASSWORD="$clave" docker exec -e PGPASSWORD -i "$DB" \
      psql -U "$usuario" -d "$base_otra" -tAqX -c 'SELECT current_user;' 2>&1)"; then
      abortar "$usuario ha ENTRADO en $base_otra: el aislamiento esta roto."
    fi
    verde "  $usuario rechazado en $base_otra."
    printf '     motivo: %s\n' "$(printf '%s' "$quien" | head -n 1)"
  }
  cruzada "$BASE/instancia-1.env" "chatbot_${id2//-/_}"
  cruzada "$BASE/instancia-2.env" "chatbot_${id1//-/_}"

  paso '4. Directorios de copias separados'
  # Las dos instancias tienen el mismo BACKUP_DIR (la ruta DENTRO del contenedor), y el compose
  # monta en ella un directorio distinto del anfitrion. Es el aviso `shared_backup_dir` del
  # inventario, inofensivo por eso mismo; aqui se comprueba que de verdad lo son.
  local dir ajenas
  for dir in instancia-1 instancia-2; do
    [[ -d "$BASE/$dir/backups" ]] || abortar "no existe $BASE/$dir/backups."
    stat -c '   %n  dueno %U:%G  modo %a' "$BASE/$dir/backups"
  done
  comprobar_dir() {
    local dir="$1" propio="$2"
    ajenas="$(find "$BASE/$dir/backups" -maxdepth 1 -name '*.cbak' -printf '%f\n' |
      grep -v "^${propio}__" || true)"
    [[ -z $ajenas ]] || abortar "$BASE/$dir/backups tiene copias que no son de $propio:
$ajenas"
    verde "  $dir/backups: solo copias de $propio."
  }
  comprobar_dir instancia-1 "$id1"
  comprobar_dir instancia-2 "$id2"

  printf '\n'
  verde 'Aislamiento comprobado en los tres niveles: datos, catalogo y copias.'
}

# --- emergencia ----------------------------------------------------------------------------
# EMERGENCY_CONTACT_PHONE no es el telefono de los avisos: es el que el bot ENSENA al cliente
# cuando no puede leer la informacion del negocio (FR-029). Con el negocio activo y sus vias de
# contacto puestas, el chat da el contacto del NEGOCIO, no este
# (src/conversation/templates.ts:168, `unavailableContact`). Para verlo hace falta que el
# snapshot no se pueda leer, y eso es parar la base de datos.
#
# Las dos frases se distinguen sin mirar el numero, que aqui es el mismo en los dos sitios:
#   negocio:    "Para hablar con una persona de <nombre>: ..."
#   emergencia: "Si necesitas hablar con una persona: telefono 600 000 000."
subcomando_emergencia() {
  case "${1:-}" in
    parar)
      exigir_sana "$DB"
      cat <<'TXT'

AVISO. Esto para el PostgreSQL de produccion. Mientras este parado:
  - las DOS instancias se quedan sin datos (es un cluster compartido),
  - los dos paneles /admin dejan de funcionar,
  - los dos contenedores pasaran a `unhealthy` (Docker NO los reinicia, es lo que se quiere),
  - un mensaje nuevo en el chat NO se guarda: no hay riesgo de perder ni corromper nada.
Los datos no se tocan: `stop` no es `down -v`.

Haz la prueba con el chat YA ABIERTO y con una conversacion en marcha: la sesion del chat se
firma y no consulta la base, pero pedir una nueva (POST /session) si, y con la base parada
fallaria antes de poder escribir.

TXT
      local respuesta
      read -rp '¿Paro la base de datos? (escribe PARAR) ' respuesta
      [[ $respuesta == 'PARAR' ]] || abortar 'no se ha parado nada.'
      paso "Parando $DB"
      docker stop "$DB"
      verde "  $DB parado."
      cat <<'TXT'

Ahora, en el chat que ya tenias abierto, escribe un mensaje. Tiene que responder:

  "Ahora mismo no puedo atenderte por este chat."
  "Si necesitas hablar con una persona: telefono 600 000 000."

Esa segunda linea es EMERGENCY_CONTACT_PHONE (src/channels/web/api.ts:304). Si en su lugar
sale "Para hablar con una persona de <nombre del negocio>", es el contacto del negocio: el
mensaje no llego a la recepcion y la prueba no vale.

Cuando lo tengas, vuelve aqui y arranca la base:
  sudo bash /srv/chatbot/deploy/fase9-pruebas.sh emergencia arrancar
TXT
      ;;
    arrancar)
      paso "Arrancando $DB"
      docker start "$DB"
      echo 'Esperando a que las dos instancias vuelvan a healthy (hasta 120 s)...'
      local i s1 s2
      for i in $(seq 1 24); do
        sleep 5
        s1="$(situacion instancia-1)"
        s2="$(situacion instancia-2)"
        printf '  %3ss  instancia-1: %-18s instancia-2: %s\n' "$((i * 5))" "$s1" "$s2"
        [[ $s1 == 'running healthy' && $s2 == 'running healthy' ]] && break
      done
      exigir_sana "$DB"
      exigir_sana instancia-1
      exigir_sana instancia-2
      verde '  Base de datos y las dos instancias, sanas otra vez.'
      echo 'Comprueba tambien el chat y /admin antes de dar la casilla por buena. Las sesiones'
      echo 'del panel siguen valiendo: no se ha reiniciado ninguna instancia (la epoca de'
      echo 'sesion solo se regenera al arrancar el proceso).'
      ;;
    *) uso ;;
  esac
}

# --- estado --------------------------------------------------------------------------------
subcomando_estado() {
  paso 'Contenedores del despliegue'
  docker ps --filter 'label=com.docker.compose.project=chatbot' \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  echo
  echo 'chatbot-caddy-1 sale sin (healthy) a proposito: caddy:2-alpine no trae HEALTHCHECK.'
  paso 'Puertos a la escucha en el anfitrion'
  ss -ltn | grep -v '127.0.0.53' || true
  echo
  echo 'Lo esperado: 22 (SSH) y los 80 y 443 de Caddy. Ningun 3000 ni 5432.'
}

requisitos
case "${1:-}" in
  copias) subcomando_copias "${2:-}" ;;
  aislamiento) subcomando_aislamiento ;;
  emergencia) subcomando_emergencia "${2:-}" ;;
  estado) subcomando_estado ;;
  *) uso ;;
esac
