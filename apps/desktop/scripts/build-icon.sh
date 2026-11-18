#!/bin/sh
# Regenera build/icon.icns (el de la app empaquetada) y build/icon.png (el del Dock con `npm run dev`) desde build/icon.svg.
# Solo macOS: renderiza el SVG con Quick Look (`qlmanage`) y arma el .icns con `sips` e `iconutil`.
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
qlmanage -t -s 1024 -o "$TMP" build/icon.svg >/dev/null
SRC="$TMP/icon.svg.png"
[ -f "$SRC" ] || { echo "qlmanage no generó $SRC" >&2; exit 1; }
SET="$TMP/icon.iconset"
mkdir "$SET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$SRC" --out "$SET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$SRC" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns -o build/icon.icns "$SET"
cp "$SRC" build/icon.png
echo "listo: build/icon.icns y build/icon.png"
