# Lote demo · clanker-loop
proyecto: https://linear.app/acme/project/demo-lote-0a1b2c3d4e5f · repos: api (/home/demo/work/api), dashboard, infra (sub-issues de DEMO-3), docs-sdks · ERD: no
slot 3 reservado por la sesión "cola elegibles": no usarlo hasta que avisen.
parallel: 1 para issues nuevas, siempre en el slot 1. El slot 2 queda reservado SOLO para rebases de PRs del loop en CONFLICTING.
## Brief
- Objetivo: mover los helpers de fechas a un módulo propio sin cambiar comportamiento.
- Checks: lint, tipos y specs del área.
## Decisiones y aprendizajes
- El módulo `dates` ya existe en `api`: usarlo antes de crear uno nuevo.
## En curso
## Historial
| ID | estado | perfil | PR | branch | min | $ |
|---|---|---|---|---|---|---|
| DEMO-1 | mergeado | medio | api#101 | demo-1-extract-dates | 20 | 3.50 |
| DEMO-2 | listo (sin squash, pendiente body) | medio | #102 | (worktree api-demo-2) | 30 | 5.00 |
| DEMO-3 | mergeado | medio | dashboard#11 | demo-3-date-picker | 25 | 4.00 |
| DEMO-3 (tf) | cerrado | medio | infra#7 | (worktree infra-demo-3) | - | - |
| DEMO-4 | sin LGTM | alto | api#104 (stacked #102) | demo-4-stacked-dates | 45 | 9.00 |
- #104: se rebaseó sobre main sin conflictos.
## Decisiones a revisar
- DEMO-4 (#104): el bot marcó un caso de zona horaria que no aplica.
## Omitidas
