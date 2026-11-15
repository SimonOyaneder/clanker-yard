# Qué mueve el `updated_at` de un PR (decisión #37)

`docs/design.html#d-ops` ("CodeHost: polling con ETags") dejaba por verificar en la fase 2 si una review o un comentario mueven el `updated_at` del PR: si no lo hacen, `GET pulls/{n}` con ETag no vería esos cambios y harían falta detectores aparte con ETag de `/reviews` y `/comments`.

## Resultado (verificado el 2026-11-15 contra la API real de GitHub)

| Evento | ¿Mueve `updated_at` (y con él el ETag de `GET pulls/{n}`)? |
|---|---|
| Review enviada (aprobada, con cambios o comentada) | Sí |
| Comentario de review (en una línea del diff, también una respuesta) | Sí |
| Comentario de la conversación del PR | Sí |
| Un check run o un status que termina | No |
| GitHub calcula `mergeable` (de `unknown` a `clean`) | No |

Por eso Watch no tiene detectores de `/reviews` ni de `/comments`: el ETag de `pulls/{n}` los cubre, y los checks tienen el suyo (`check-runs` y `status` del head). Sin verificar, y cubierto por la reconciliación del sondeo de los waits (cada 10 min): resolver o reabrir un thread de review.

## Cómo se verificó

- Las reviews y los comentarios: en 25 PRs cerrados de un repo público (`cli/cli`, los de actividad más reciente) se comparó el `updated_at` del PR con la fecha del último comentario de la conversación, de la última review y del último comentario de review. En todos los PRs con un evento posterior al cierre el `updated_at` era igual o posterior al evento, y en 14 casos el `updated_at` caía a 0 o 1 s del evento (2 de comentarios de la conversación, 6 de reviews y 6 de comentarios de review), que es lo esperable si el evento lo movió. Solo con lecturas de la API.
- Los checks y `mergeable`: en el PR #109 de este repo, el `updated_at` quedó en la hora de creación (14:30:53Z) aunque los checks terminaron a las 14:31:58Z y 14:34:50Z, y el primer `GET` del PR dio `mergeable_state: unknown` y el segundo, segundos después, `clean`, sin mover `updated_at`. Por eso la relectura de `mergeable: unknown` (10 s, hasta 3 veces) pide el detalle por GraphQL en vez de fiarse del ETag.

El GitHub simulado (`packages/testkit/src/github-sim.ts`) sigue esta tabla: una review, un comentario o una respuesta mueven `updated_at`; un check no. Que resolver un thread tampoco lo mueva es lo que supone el simulador, no algo verificado.
