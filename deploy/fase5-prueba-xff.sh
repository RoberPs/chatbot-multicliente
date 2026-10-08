#!/usr/bin/env bash
#
# Prueba del paso 7 de la receta (docs/operacion-multicliente.md, seccion 2.5) y del riesgo
# principal de la seccion 7 del plan de despliegue: que el proxy SUSTITUYA X-Forwarded-For en
# vez de añadirla. Si la añade, cualquiera se salta el limite de intentos del login mandando
# una cabecera inventada.
#
# Se ejecuta DESDE TU PC, en Git Bash, NO en el VPS: la prueba necesita venir de fuera, porque
# lo que se cuenta es la direccion real de quien llama.
#
#   bash deploy/fase5-prueba-xff.sh viajes.automatizacionro.work
#
# Manda 31 peticiones a /health, cada una con un X-Forwarded-For falso DISTINTO. El limite de
# /health es 30 por minuto y por direccion (src/channels/health/routes.ts, HEALTH_RATE_LIMIT).
#
#   Esperado:  las 30 primeras en 200 y la 31 en 429.
#              -> la instancia cuenta la direccion real y descarta la cabecera falsa.
#   Si fallan: las 31 en 200 -> el proxy AÑADE en vez de sustituir, o TRUST_PROXY cuenta saltos
#              de mas. Es un fallo de seguridad: no se pasa a la fase 6 sin arreglarlo.
#
# La segunda mitad de la prueba no se puede automatizar desde aqui: hay que comprobar, en ESE
# MISMO MINUTO y desde otra maquina en otra red (el movil con datos moviles, no el wifi de
# casa, que sale por la misma IP), que /health sigue dando 200. Eso demuestra que el limite es
# por direccion y no global.
set -euo pipefail

DOMINIO="${1-}"
[[ -n $DOMINIO ]] || {
  printf 'Uso: bash %s <subdominio.dominio.tld>\n' "$0" >&2
  exit 2
}

URL="https://$DOMINIO/health"
printf 'Prueba del paso 7 contra %s\n' "$URL"
printf 'Tu direccion publica: %s\n\n' "$(curl -s --max-time 10 https://api.ipify.org || echo 'desconocida')"

codigos=()
for i in $(seq 31); do
  # --max-time para que una peticion colgada no estire la prueba por encima del minuto, que es
  # la ventana del limite. Cabecera falsa distinta en cada vuelta.
  codigo="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "X-Forwarded-For: 10.9.8.$i" "$URL" || echo '000')"
  codigos+=("$codigo")
  printf '%3d  %s\n' "$i" "$codigo"
done

printf '\nResumen: '
printf '%s\n' "${codigos[@]}" | sort | uniq -c | awk '{printf "%s×%s  ", $1, $2}'
printf '\n\n'

ultimo="${codigos[30]}"
doscientos=0
for c in "${codigos[@]:0:30}"; do [[ $c == '200' ]] && ((doscientos++)) || true; done

if [[ $ultimo == '429' && $doscientos -eq 30 ]]; then
  printf '\033[32m%s\033[0m\n' "CORRECTO: 30 en 200 y la 31 en 429."
  printf 'El proxy sustituye X-Forwarded-For y la instancia cuenta tu direccion real.\n\n'
  printf 'Queda la otra mitad, AHORA (dentro de este minuto), desde el movil con datos:\n'
  printf '  curl -s -o /dev/null -w "%%{http_code}\\n" %s   -> tiene que dar 200\n' "$URL"
  exit 0
fi

printf '\033[31m%s\033[0m\n' "LA PRUEBA NO PASA."
if [[ $doscientos -eq 30 && $ultimo == '200' ]]; then
  cat <<'TXT'
Las 31 dieron 200: el proxy esta AÑADIENDO la cabecera en vez de sustituirla, o TRUST_PROXY
cuenta mas saltos de los que hay. Revisa, en este orden:
  1. deploy/Caddyfile: la linea `header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}`
     tiene que estar dentro del reverse_proxy, y Caddy haberla recargado.
  2. TRUST_PROXY=1 en los dos ficheros de entorno del VPS (un solo salto: Caddy).
No sigas a la fase 6: cualquiera podria saltarse el limite de intentos del login.
TXT
elif printf '%s\n' "${codigos[@]}" | grep -q '000'; then
  cat <<'TXT'
Hubo peticiones sin respuesta (000): no es la prueba lo que falla, es la conexion. Mira si el
dominio resuelve, si Cloudflare esta proxificando y si el cortafuegos de Hetzner deja entrar el
443 desde todos los rangos de Cloudflare.
TXT
elif printf '%s\n' "${codigos[@]:0:5}" | grep -qE '52[0-9]'; then
  cat <<'TXT'
Codigos 52x: los devuelve Cloudflare, no la instancia. 521 = el origen rechaza la conexion;
522 = no responde; 526 = el certificado del origen no valida (eso pasa si subiste el modo SSL a
«Full (strict)» antes de que Caddy tuviera su certificado).
TXT
else
  cat <<'TXT'
Mezcla inesperada. Si el 429 aparece ANTES de la peticion 31, probablemente quedaban peticiones
contadas del minuto anterior: espera un minuto entero y repite la prueba.
TXT
fi
exit 1
