#!/usr/bin/env bash
# Capturas para la documentación (docs/evidencias/), con Chrome de Windows en modo headless.
#
#   scripts/capturar-evidencia.sh url  <url> <salida.png> [ancho] [alto]
#   scripts/capturar-evidencia.sh log  <archivo.log|-> <salida.png> "<título>" [alto]
#
# "log" convierte la salida de una terminal en una imagen con estilo de consola.
# CHROME_HOST_RULES="MAP store.local 127.0.0.1" resuelve hosts del Ingress sin editar
# el archivo hosts de Windows.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME=${CHROME:-"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"}
[ -x "$CHROME" ] || CHROME="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
WIN_TMP=$(wslpath "$(cmd.exe /c 'echo %TEMP%' 2>/dev/null </dev/null | tr -d '\r')" 2>/dev/null || true)
# Si la interoperabilidad con Windows falla, se usa la carpeta temporal del usuario.
if [ -z "$WIN_TMP" ] || [ "$WIN_TMP" = "." ] || [ ! -d "$WIN_TMP" ]; then
  WIN_TMP=$(ls -d /mnt/c/Users/*/AppData/Local/Temp 2>/dev/null | grep -v -E "Default|Public|All Users" | head -1)
fi
[ -d "$WIN_TMP" ] || { echo "No se encontró la carpeta temporal de Windows" >&2; exit 1; }
PROFILE="$WIN_TMP/store-capture-profile"
mkdir -p docs/evidencias "$PROFILE"

shot() { # url salida ancho alto
  local tmp="$WIN_TMP/store-capture-$$.png"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --user-data-dir="$(wslpath -w "$PROFILE")" --virtual-time-budget=8000 \
    ${CHROME_HOST_RULES:+--host-resolver-rules="$CHROME_HOST_RULES"} \
    --window-size="$3,$4" --screenshot="$(wslpath -w "$tmp")" "$1" >/dev/null 2>&1 || true
  [ -s "$tmp" ] || { echo "No se generó la captura de $1" >&2; exit 1; }
  mv "$tmp" "$2"
  echo "captura: $2"
}

case "${1:-}" in
  url)
    shot "$2" "$3" "${4:-1366}" "${5:-1600}"
    ;;
  log)
    src=$2 out=$3 title=${4:-Terminal} height=${5:-900}
    html="$WIN_TMP/store-capture-$$.html"
    {
      printf '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0d1117;font:14px/1.45 Consolas,"Cascadia Mono",monospace;color:#e6edf3}'
      printf '.bar{background:#161b22;padding:8px 14px;color:#8b949e;border-bottom:1px solid #30363d}.bar b{color:#e6edf3}'
      printf 'pre{margin:0;padding:14px 18px;white-space:pre-wrap;word-break:break-word}</style>'
      printf '<div class="bar"><b>%s</b> &nbsp;·&nbsp; %s</div><pre>' "$title" "$(date '+%Y-%m-%d %H:%M')"
      if [ "$src" = "-" ]; then cat; else cat "$src"; fi | sed 's/\x1b\[[0-9;]*m//g; s/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
      printf '</pre>'
    } > "$html"
    shot "file:///$(wslpath -m "$html")" "$out" 1100 "$height"
    rm -f "$html"
    ;;
  *)
    echo "Uso: $0 url <url> <salida.png> [ancho] [alto] | log <archivo|-> <salida.png> \"<título>\" [alto]" >&2
    exit 1
    ;;
esac
