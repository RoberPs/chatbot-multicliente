#!/usr/bin/env bash
#
# Fase 4 del plan de despliegue (docs/plan-despliegue-produccion.md): la base de datos y el
# usuario de cada instancia, aplicados por el SOCKET UNIX del cluster de produccion.
#
# Hace falta porque `pnpm instance:db` no puede conectar desde el PC: el cluster arranca con
# `listen_addresses` vacio y no escucha en ningun puerto. En el PC se genera el SQL con
#
#   pnpm instance:db <id> --print-sql --host localhost --port 5432 > <id>.sql
#
# y ese fichero (que lleva el verificador SCRAM, nunca la contraseña en claro) se aplica aqui.
#
#   sudo bash /srv/chatbot/deploy/fase4-bases-datos.sh crear <id> <fichero.sql>
#   sudo bash /srv/chatbot/deploy/fase4-bases-datos.sh comprobar <id>
#   sudo bash /srv/chatbot/deploy/fase4-bases-datos.sh probar <id> <fichero-entorno>
#
# `crear` es seguro de relanzar: si el rol o la base ya existen, aborta sin tocar nada (nunca
# borra ni recrea), asi que las comprobaciones viven aparte en `comprobar`, que solo lee el
# catalogo y se puede repetir siempre. `probar` comprueba, ya con el entorno subido, que el
# usuario de la instancia entra por el socket con su contraseña y no ve las bases de las demas.
set -euo pipefail

BASE=/srv/chatbot
DB=chatbot-db-1

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
  fase4-bases-datos.sh crear <id> <fichero.sql>
  fase4-bases-datos.sh comprobar <id>
  fase4-bases-datos.sh probar <id> <fichero-entorno>
TXT
  exit 2
}

# psql como superusuario por el socket del contenedor. La contraseña va por el entorno del
# proceso (`-e PGPASSWORD` sin valor reenvia la del llamante), nunca por argumentos: `ps` los ve.
psql_admin() {
  PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$BASE/db.env")" \
    docker exec -e PGPASSWORD -i "$DB" psql -U postgres -tAqX "$@"
}

requisitos() {
  [[ $EUID -eq 0 ]] || abortar 'ejecutalo con sudo.'
  command -v docker >/dev/null || abortar 'no hay docker en el PATH.'
  [[ -r $BASE/db.env ]] || abortar "no puedo leer $BASE/db.env (fase 3)."
  local estado
  estado="$(docker inspect -f '{{.State.Health.Status}}' "$DB" 2>/dev/null || true)"
  [[ $estado == 'healthy' ]] || abortar "$DB no esta healthy (estado: ${estado:-no existe})."
}

# Nombre de la base y del usuario, igual que databaseNames() del nucleo: guiones a `_`.
nombres() {
  printf 'chatbot_%s' "${1//-/_}"
}

crear() {
  local id="$1" sql="$2" nombre
  nombre="$(nombres "$id")"
  [[ -r $sql ]] || abortar "no puedo leer $sql."

  paso '0. El fichero es texto plano sin marca de orden de bytes'
  # Windows: `>` de PowerShell 5.1 escribe UTF-16LE y `Out-File -Encoding utf8` añade BOM. En los
  # dos casos psql falla en la primera linea con un error de sintaxis que no dice por que, y los
  # filtros de abajo no encontrarian nada. Se genera con `Set-Content -Encoding ascii` o desde
  # Git Bash.
  case "$(head -c 3 "$sql" | od -An -tx1 | tr -d ' ')" in
    efbbbf*) abortar "$sql empieza con una marca BOM de UTF-8: vuelve a generarlo con \`Set-Content -Encoding ascii\`." ;;
    fffe* | feff*) abortar "$sql esta en UTF-16 (lo escribio \`>\` de PowerShell): vuelve a generarlo con \`Set-Content -Encoding ascii\`." ;;
  esac
  grep -qP '\x00' "$sql" 2>/dev/null &&
    abortar "$sql tiene bytes nulos: no es texto plano."
  verde '  Texto plano sin BOM.'

  paso "1. El SQL es el de esta instancia ($nombre)"
  # El fichero viene del PC: se comprueba que crea lo que se espera y nada mas. `DROP`, `ALTER`
  # o `GRANT` no tienen por que estar ahi.
  grep -qE "CREATE ROLE \"?$nombre\"? LOGIN PASSWORD 'SCRAM-SHA-256\\\$" "$sql" ||
    abortar "$sql no crea el rol $nombre con un verificador SCRAM."
  grep -qE "CREATE DATABASE \"?$nombre\"? OWNER \"?$nombre\"?" "$sql" ||
    abortar "$sql no crea la base $nombre con ese propietario."
  grep -qE "REVOKE CONNECT, TEMPORARY ON DATABASE \"?$nombre\"? FROM PUBLIC" "$sql" ||
    abortar "$sql no retira el acceso general a la base."
  if grep -qiE '^[[:space:]]*(DROP|ALTER|GRANT|COPY|\\!)' "$sql"; then
    abortar "$sql contiene sentencias que esta fase no espera (DROP/ALTER/GRANT/COPY): revisalo."
  fi
  # Toda linea no vacia tiene que ser una de las que imprime `instance:db`. Lo normal que se
  # cuela aqui es la cabecera de pnpm (`> paquete@version script`), que va por la salida
  # estandar y acaba dentro del fichero al redirigirlo: psql falla entonces en la primera linea.
  local intrusas
  intrusas="$(grep -vcE '^(--|SELECT 1 FROM |CREATE |REVOKE |[[:space:]]*$)' "$sql" || true)"
  if [[ ${intrusas:-0} -gt 0 ]]; then
    rojo "  Lineas que no deberian estar en el SQL:"
    grep -nvE '^(--|SELECT 1 FROM |CREATE |REVOKE |[[:space:]]*$)' "$sql" >&2
    abortar "$sql tiene $intrusas linea(s) que no imprime \`instance:db\`. Quitalas y vuelve a intentarlo (NO regeneres el SQL: \`instance:db\` no se puede repetir)."
  fi
  verde "  El SQL crea el rol $nombre, su base y retira el acceso general."

  paso '2. Nada de esto existe ya'
  [[ "$(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname = '$nombre';")" != '1' ]] ||
    abortar "el rol $nombre ya existe. No se toca nada: si la instancia es nueva, el SQL se genero dos veces (cada \`instance:db\` crea una contraseña distinta)."
  [[ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$nombre';")" != '1' ]] ||
    abortar "la base $nombre ya existe. No se toca nada."
  verde '  Ni el rol ni la base existen.'

  paso '3. Aplicando el SQL'
  # `CREATE DATABASE` no puede ir en una transaccion, asi que no hay `--single-transaction`:
  # ON_ERROR_STOP para en la primera sentencia que falle y el paso 4 dice que ha quedado.
  PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$BASE/db.env")" \
    docker exec -e PGPASSWORD -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -qX <"$sql"
  verde '  SQL aplicado.'

  comprobar "$id"

  cat <<TXT

== Base de datos de $id lista.

Siguiente: sube su fichero de entorno con la DATABASE_URL en forma de socket

  postgres://$nombre:<clave>@/$nombre?host=/var/run/postgresql

y comprueba la conexion con:

  sudo bash $BASE/deploy/fase4-bases-datos.sh probar $id $BASE/instancia-<N>.env
TXT
}

# Comprobaciones de lo creado. Separadas de `crear` porque esta no se puede relanzar (aborta si
# el rol ya existe) y las comprobaciones si: solo leen el catalogo.
#
# Todos los booleanos van con `::text`. `psql -tA` imprime un booleano suelto como `t`/`f`, no
# como `true`/`false`; con `::text` (o concatenando, que es lo que hace el caso de abajo) se
# obtiene la forma larga. Es la misma trampa que ya mordio en la fase 3.
comprobar() {
  local id="$1" nombre atributos propietario publico
  nombre="$(nombres "$id")"

  paso "Comprobaciones de $nombre"
  [[ "$(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname = '$nombre';")" == '1' ]] ||
    abortar "no existe el rol $nombre."
  [[ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$nombre';")" == '1' ]] ||
    abortar "no existe la base $nombre."

  atributos="$(psql_admin -c "SELECT rolsuper || ' ' || rolcreatedb || ' ' || rolcreaterole FROM pg_roles WHERE rolname = '$nombre';")"
  [[ $atributos == 'false false false' ]] ||
    abortar "el rol $nombre tiene atributos inesperados (super/createdb/createrole: $atributos)."
  verde '  Usuario sin superusuario, sin CREATEDB y sin CREATEROLE.'

  propietario="$(psql_admin -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$nombre';")"
  [[ $propietario == "$nombre" ]] || abortar "la base $nombre pertenece a $propietario."
  verde "  Base $nombre creada, propietario $nombre."

  # `has_database_privilege` no acepta PUBLIC como nombre de rol, asi que se mira el ACL de la
  # base: una entrada `=…c…/` (concedida a PUBLIC, el lado izquierdo vacio) es CONNECT abierto.
  # Un `datacl` nulo tambien lo es: significa los permisos por omision, que incluyen CONNECT.
  publico="$(psql_admin -c "SELECT CASE WHEN datacl IS NULL THEN 'abierto por omision' WHEN EXISTS (SELECT 1 FROM unnest(datacl) a WHERE a::text LIKE '=%c%/%') THEN 'abierto a PUBLIC' ELSE 'cerrado' END FROM pg_database WHERE datname = '$nombre';")"
  [[ $publico == 'cerrado' ]] ||
    abortar "PUBLIC todavia puede conectarse a $nombre ($publico): el REVOKE no ha surtido efecto."
  verde '  PUBLIC no puede conectarse a esa base.'
}

probar() {
  local id="$1" entorno="$2" nombre url clave quien otras
  nombre="$(nombres "$id")"
  [[ -r $entorno ]] || abortar "no puedo leer $entorno."

  paso "1. DATABASE_URL de $entorno"
  url="$(sed -n 's/^DATABASE_URL=//p' "$entorno" | tail -n 1)"
  [[ -n $url ]] || abortar "$entorno no tiene DATABASE_URL."
  case $url in
    *"host=/var/run/postgresql"*) ;;
    *) abortar 'la DATABASE_URL no usa el socket (falta host=/var/run/postgresql).' ;;
  esac
  [[ $url == *"://$nombre:"* ]] || abortar "la DATABASE_URL no es la del usuario $nombre."
  [[ $url == *"@/$nombre?"* ]] || abortar "la DATABASE_URL no apunta a la base $nombre."
  verde "  Socket Unix, usuario $nombre, base $nombre."

  # La clave se saca a una variable y de ahi al entorno del `docker exec`: no pasa por `ps`.
  # `instance:db` la genera en base64url (24 bytes), que no lleva nada codificado en la URL; si
  # trae otros caracteres es que se ha editado a mano y habria que descodificarla antes.
  clave="${url#*://$nombre:}"
  clave="${clave%%@*}"
  [[ $clave =~ ^[A-Za-z0-9_-]+$ ]] ||
    abortar 'la contraseña de la DATABASE_URL no es la generada por instance:db (lleva caracteres codificados): compruebala a mano.'

  paso '2. El usuario entra por el socket con su contraseña'
  quien="$(PGPASSWORD="$clave" docker exec -e PGPASSWORD -i "$DB" \
    psql -U "$nombre" -d "$nombre" -tAqX -c 'SELECT current_user;')"
  [[ $quien == "$nombre" ]] || abortar "la conexion ha entrado como $quien."
  verde "  Conecta como $nombre."

  paso '3. No alcanza las bases de las demas instancias'
  otras="$(psql_admin -c "SELECT datname FROM pg_database WHERE datname LIKE 'chatbot\\_%' AND datname <> '$nombre';")"
  if [[ -z $otras ]]; then
    printf '  Todavia no hay otra base de instancia con la que comparar.\n'
  else
    local otra permiso
    while read -r otra; do
      [[ -n $otra ]] || continue
      # `::text` por lo mismo que arriba: `-tA` imprime `f`, no `false`.
      permiso="$(psql_admin -c "SELECT has_database_privilege('$nombre', '$otra', 'CONNECT')::text;")"
      [[ $permiso == 'false' ]] || abortar "$nombre puede conectarse a $otra."
      verde "  $nombre no puede conectarse a $otra."
    done <<<"$otras"
  fi

  printf '\n== Instancia %s: base de datos comprobada.\n' "$id"
}

[[ $# -ge 1 ]] || uso
case "$1" in
  crear)
    [[ $# -eq 3 ]] || uso
    requisitos
    crear "$2" "$3"
    ;;
  comprobar)
    [[ $# -eq 2 ]] || uso
    requisitos
    comprobar "$2"
    printf '\n== Instancia %s: base de datos y usuario correctos.\n' "$2"
    ;;
  probar)
    [[ $# -eq 3 ]] || uso
    requisitos
    probar "$2" "$3"
    ;;
  *) uso ;;
esac
