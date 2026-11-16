#!/bin/sh
# Copia el build a /Applications (ruta fija para Spotlight y el Dock), deja el comando `clanker` en
# ~/.local/bin y abre la app. Corre `npm run install:mac` desde la raíz del repo: construye y llama a este script.
set -e
cd "$(dirname "$0")/.."
SRC="dist/mac-arm64/Clanker Yard.app"
DEST="/Applications/Clanker Yard.app"
BIN="$HOME/.local/bin"
[ -d "$SRC" ] || { echo "no está $SRC: corre npm run build:mac" >&2; exit 1; }
# Igual que el menú "Instalar comando clanker…": un `clanker` que no es symlink es de otro y no se pisa.
if [ -e "$BIN/clanker" ] && [ ! -L "$BIN/clanker" ]; then
  echo "$BIN/clanker ya existe y no es un symlink: bórralo o muévelo y vuelve a correr npm run install:mac" >&2
  exit 1
fi
osascript -e 'quit app "Clanker Yard"' 2>/dev/null || true
i=0
while pgrep -f "Clanker Yard.app/Contents/MacOS/Clanker Yard$" >/dev/null && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
# Cerrar la app deja vivo su core, y la versión nueva lo reutiliza si tiene el mismo apiMajor (AGENTS.md, Empaquetado).
old_core=$(pgrep -f "$DEST/Contents/Resources/core/dist/main.js" || true)
rm -rf "$DEST"
ditto "$SRC" "$DEST"
mkdir -p "$BIN"
ln -sfn "$DEST/Contents/Resources/bin/clanker" "$BIN/clanker"
open "$DEST"
echo "instalada en $DEST; comando clanker en $BIN/clanker"
if [ -n "$old_core" ]; then
  echo "ojo: sigue corriendo el core de la instalación anterior; para que corra el nuevo, Archivo > Salir y detener agentes y vuelve a abrir la app"
fi
