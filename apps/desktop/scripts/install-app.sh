#!/bin/sh
# Copia el build a /Applications (ruta fija para Spotlight y el Dock), deja el comando `clanker` en
# ~/.local/bin y abre la app. Corre `npm run install:mac` desde la raíz del repo: construye y llama a este script.
set -e
cd "$(dirname "$0")/.."
SRC="dist/mac-arm64/Clanker Yard.app"
DEST="/Applications/Clanker Yard.app"
BIN="$HOME/.local/bin"
[ -d "$SRC" ] || { echo "no está $SRC: corre npm run build:mac" >&2; exit 1; }
osascript -e 'quit app "Clanker Yard"' 2>/dev/null || true
i=0
while pgrep -f "Clanker Yard.app/Contents/MacOS/Clanker Yard$" >/dev/null && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
rm -rf "$DEST"
ditto "$SRC" "$DEST"
mkdir -p "$BIN"
ln -sfn "$DEST/Contents/Resources/bin/clanker" "$BIN/clanker"
open "$DEST"
echo "instalada en $DEST; comando clanker en $BIN/clanker"
