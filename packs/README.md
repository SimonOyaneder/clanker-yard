# Packs de fábrica

Cada subcarpeta con un `pack.json` es un pack que viene con la app (`docs/design.html#packs`, esquema `Pack` en `packages/api/src/pack.ts`). Hoy no trae ninguno: el pack de una organización vive en su propio repo y se instala desde Ajustes > Packs con la ruta de su carpeta, o se copia a `<datos>/packs/<id>`.

`packages/testkit/fixtures/packs/example` es un pack completo de ejemplo (bot de review, merge por comentario con cola, señal de riesgo por label) que usan los tests y el core de demo.
