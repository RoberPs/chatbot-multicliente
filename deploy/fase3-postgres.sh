#!/usr/bin/env bash
#
# Fase 3 del plan de despliegue (docs/plan-despliegue-produccion.md): los dos PostgreSQL del VPS.
#
#   1. Estructura de /srv/chatbot con los permisos de la receta (paso 3).
#   2. Ficheros de entorno de los dos PostgreSQL, con contraseñas nuevas (0600, dueño operador).
#   3. Arranca SOLO los servicios `db` y `db-verificacion` del compose de produccion.
#   4. Crea el rol `verificador` (CREATEDB) en el cluster de verificacion (receta, paso 8).
#   5. Comprueba lo que no puede fallar: socket Unix sin TCP y pg_hba sin `trust`.
#
# Se ejecuta en el VPS, con sudo, y es idempotente: si un fichero de entorno ya existe no lo
# toca ni regenera su contraseña, y si el rol ya existe lo deja como esta.
#
#   sudo bash /srv/chatbot/deploy/fase3-postgres.sh
#
# Las contraseñas generadas se imprimen UNA VEZ, al crearlas: van a Bitwarden en ese momento.
# No quedan en el historial de la shell; si, en el buffer del terminal.
set -euo pipefail

BASE=/srv/chatbot
COMPOSE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.prod.yml"
# Nombre de proyecto del compose (`name: chatbot`), que fija los nombres de los contenedores.
DB=chatbot-db-1
DBV=chatbot-db-verificacion-1

rojo() { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso() { printf '\n== %s\n' "$*"; }

abortar() {
  rojo "ABORTADO: $*"
  exit 1
}

# --- 0. Requisitos -------------------------------------------------------------------------
paso '0. Requisitos'
[[ $EUID -eq 0 ]] || abortar 'ejecutalo con sudo.'
id operador >/dev/null 2>&1 || abortar 'no existe el usuario `operador` (fase 2).'
command -v docker >/dev/null || abortar 'no hay docker en el PATH.'
[[ -f $COMPOSE ]] || abortar "no encuentro $COMPOSE (copia deploy/ al VPS)."
command -v openssl >/dev/null || abortar 'falta openssl.'
verde "docker $(docker version -f '{{.Server.Version}}') · compose $COMPOSE"

# --- 1. Estructura de /srv/chatbot ---------------------------------------------------------
paso '1. Estructura de /srv/chatbot'
install -d -o operador -g operador -m 750 "$BASE"
# Volumenes de copias: dueño UID 1000 (el usuario `node` de la imagen) y modo 0700, porque los
# escribe el proceso de dentro del contenedor y no el operador (receta, paso 3).
for i in 1 2; do
  install -d -o operador -g operador -m 750 "$BASE/instancia-$i"
  install -d -o 1000 -g 1000 -m 700 "$BASE/instancia-$i/backups"
done
stat -c '%n  %U:%G  %a' "$BASE" "$BASE"/instancia-*/backups

# --- 2. Ficheros de entorno ----------------------------------------------------------------
# `crear_env <fichero> <clave> [<contraseña>]`: solo si no existe. Imprime lo que haya que
# guardar en Bitwarden.
crear_env() {
  local fichero="$BASE/$1" clave="$2" valor="${3-}"
  if [[ -e $fichero ]]; then
    printf '  %s ya existe: no se toca.\n' "$1"
    return 0
  fi
  [[ -n $valor ]] || valor="$(openssl rand -hex 24)"
  # umask antes de escribir: el fichero nunca existe con permisos abiertos, ni un instante.
  (
    umask 077
    printf '# Fase 3 del despliegue. No se versiona. Copia en Bitwarden.\n%s=%s\n' \
      "$clave" "$valor" >"$fichero"
  )
  chown operador:operador "$fichero"
  verde "  $1 creado → Bitwarden: $clave=$valor"
}

# Marcador de posicion: el compose carga TODOS los `env_file` del proyecto aunque solo se
# arranque un servicio, asi que estos tienen que existir ya. Se rellenan en sus fases.
crear_marcador() {
  local fichero="$BASE/$1"
  if [[ -e $fichero ]]; then
    printf '  %s ya existe: no se toca.\n' "$1"
    return 0
  fi
  (
    umask 077
    printf '# PENDIENTE: lo rellena la fase %s del plan de despliegue.\n' "$2" >"$fichero"
  )
  chown operador:operador "$fichero"
  printf '  %s creado vacio (fase %s).\n' "$1" "$2"
}

paso '2. Ficheros de entorno (0600, dueño operador)'
crear_env db.env POSTGRES_PASSWORD
crear_env db-verificacion.env POSTGRES_PASSWORD
crear_marcador instancia-1.env 4
crear_marcador instancia-2.env 4
crear_marcador caddy.env 5
stat -c '%n  %U:%G  %a' "$BASE"/*.env

# --- 3. Arranque de los dos PostgreSQL -----------------------------------------------------
paso '3. Arranque de db y db-verificacion'
# CHATBOT_VERSION solo lo exige la imagen de las instancias, que aqui no se arrancan; el
# compose lo pide al cargar el fichero, asi que se le da un valor inofensivo.
export CHATBOT_VERSION="${CHATBOT_VERSION:-0.1.0}"
docker compose -f "$COMPOSE" config -q
docker compose -f "$COMPOSE" up -d db db-verificacion

printf 'Esperando a que los dos clusteres esten healthy'
for _ in $(seq 60); do
  estado="$(docker inspect -f '{{.State.Health.Status}}' "$DB" "$DBV" 2>/dev/null | sort -u | tr '\n' ' ')"
  [[ $estado == 'healthy ' ]] && break
  printf '.'
  sleep 2
done
printf '\n'
[[ ${estado:-} == 'healthy ' ]] || abortar "no se han puesto healthy (estado: ${estado:-desconocido}). Mira \`docker compose -f $COMPOSE logs db db-verificacion\`."
verde 'db y db-verificacion: healthy'

# --- 4. Comprobaciones del cluster ---------------------------------------------------------
# La contraseña se pasa por el entorno del proceso (`-e PGPASSWORD` sin valor reenvia la del
# llamante), nunca como argumento: los argumentos se ven en `ps`.
psql_en() {
  local contenedor="$1" fichero="$2" sql="$3"
  PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$BASE/$fichero")" \
    docker exec -e PGPASSWORD -i "$contenedor" psql -U postgres -tAqX -c "$sql"
}

paso '4. Comprobaciones del cluster'
for par in "$DB:db.env" "$DBV:db-verificacion.env"; do
  contenedor="${par%%:*}"
  fichero="${par#*:}"
  printf '\n  %s\n' "$contenedor"

  escuchas="$(psql_en "$contenedor" "$fichero" 'SHOW listen_addresses;')"
  [[ -z $escuchas ]] || abortar "$contenedor escucha en TCP (listen_addresses='$escuchas'); se esperaba vacio."
  verde '    listen_addresses vacio: solo socket Unix.'

  cifrado="$(psql_en "$contenedor" "$fichero" 'SHOW password_encryption;')"
  [[ $cifrado == 'scram-sha-256' ]] || abortar "$contenedor usa password_encryption=$cifrado."
  verde '    password_encryption: scram-sha-256.'

  # LA COMPROBACION CRITICA. Si el volumen de datos existia de antes, POSTGRES_INITDB_ARGS no
  # se aplico e initdb dejo `local all all trust`: cualquier contenedor que monte el socket
  # entraria como superusuario sin contraseña, saltandose el aislamiento entre instancias.
  reglas="$(psql_en "$contenedor" "$fichero" \
    "SELECT string_agg(type || ' ' || auth_method, ', ' ORDER BY line_number) FROM pg_hba_file_rules WHERE error IS NULL;")"
  printf '    pg_hba: %s\n' "$reglas"
  if grep -q 'trust' <<<"$reglas"; then
    abortar "$contenedor tiene una regla \`trust\` en pg_hba.conf. Corrigela a mano (pg_hba.conf del volumen) y recarga con \`SELECT pg_reload_conf();\` antes de seguir."
  fi
  verde '    pg_hba sin trust.'
done

# --- 5. Rol `verificador` en el cluster de verificacion ------------------------------------
paso '5. Rol verificador (receta, paso 8)'
existe="$(psql_en "$DBV" db-verificacion.env "SELECT 1 FROM pg_roles WHERE rolname = 'verificador';")"
if [[ $existe == '1' ]]; then
  printf '  El rol `verificador` ya existe: no se toca su contraseña.\n'
else
  VERIFICADOR_PW="$(openssl rand -hex 24)"
  # Por la entrada estandar, no por argumentos: la contraseña no pasa por `ps` ni por el
  # historial. `log_statement` esta en `none` por omision, asi que no va al registro.
  PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$BASE/db-verificacion.env")" \
    docker exec -e PGPASSWORD -i "$DBV" psql -U postgres -v ON_ERROR_STOP=1 -qX <<SQL
SET password_encryption = 'scram-sha-256';
CREATE ROLE verificador LOGIN CREATEDB PASSWORD '$VERIFICADOR_PW';
SQL
  verde "  Rol creado → Bitwarden: VERIFICADOR_PW=$VERIFICADOR_PW"
  cat <<TXT

  BACKUP_VERIFY_URL de las dos instancias (fase 4), con esa contraseña:

    postgres://verificador:$VERIFICADOR_PW@/postgres?host=/var/run/postgresql-verificacion

TXT
fi

# Comprobaciones del rol: CREATEDB si, superusuario no, y no alcanza las bases de produccion
# (viven en otro cluster, al que no llega ningun socket montado en su contenedor).
# `boolean` concatenado da 'true'/'false', no 't'/'f'.
atributos="$(psql_en "$DBV" db-verificacion.env \
  "SELECT rolcreatedb || ' ' || rolsuper || ' ' || rolcreaterole FROM pg_roles WHERE rolname = 'verificador';")"
[[ $atributos == 'true false false' ]] || abortar "el rol \`verificador\` tiene atributos inesperados (createdb/super/createrole: $atributos)."
verde '  verificador: CREATEDB, sin superusuario y sin CREATEROLE.'

# --- 6. Comprobaciones del anfitrion -------------------------------------------------------
paso '6. Comprobaciones del anfitrion'
# `docker port` no imprime nada si no hay ningun puerto publicado. No se mira
# `.NetworkSettings.Ports`: ahi aparece `{"5432/tcp":null}`, que es el EXPOSE de la imagen (un
# metadato) con `null` por enlace, es decir, sin publicar.
for contenedor in "$DB" "$DBV"; do
  publicados="$(docker port "$contenedor")"
  [[ -z $publicados ]] || abortar "$contenedor publica puertos en el anfitrion: $publicados"
done
verde '  Ningun puerto publicado por los contenedores.'

if ss -ltnH | grep -q ':5432'; then
  ss -ltn | grep ':5432'
  abortar 'hay algo escuchando en el 5432 del anfitrion.'
fi
verde '  Nada escuchando en el 5432: la base de datos no es alcanzable por red.'
printf '\n  Puertos a la escucha en el anfitrion (se esperan solo el 22 y el 53 local):\n'
ss -ltnH | awk '{printf "    %s\n", $4}' | sort -u

cat <<'TXT'

== Fase 3 terminada.

A Bitwarden, si se han creado en esta ejecucion:
  - POSTGRES_PASSWORD del cluster de produccion (db.env)
  - POSTGRES_PASSWORD del cluster de verificacion (db-verificacion.env)
  - VERIFICADOR_PW y la BACKUP_VERIFY_URL completa

Siguiente: fase 4 (instancias). Dos avisos del socket Unix, para que no sorprendan:
  - `pnpm instance:db` NO puede conectar desde el PC (el cluster no escucha en ningun puerto):
    se usa `--print-sql` y el SQL se aplica aqui, por el socket.
  - La DATABASE_URL que escribe es TCP; hay que dejarla en la forma de socket:
      postgres://chatbot_<id>:<clave>@/chatbot_<id>?host=/var/run/postgresql
TXT
