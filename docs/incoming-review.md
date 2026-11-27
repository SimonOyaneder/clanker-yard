# Revisar los PRs que te asignan

En **Ajustes → Reviews automáticas**, activa el interruptor del repositorio. El cambio se guarda al instante y no requiere reiniciar. Para detener la automatización, apaga el mismo interruptor. **Mis reviews** sigue mostrando tus asignaciones aunque la automatización esté apagada.

Necesitas un repositorio registrado con remoto de GitHub, una cuenta conectada con permiso de escritura de pull requests y un runtime para el perfil `incoming-medio` (Claude por defecto).

- **Cuándo:** Watch busca solicitudes personales de la cuenta conectada, también las que ya estaban abiertas al activar el repo. Espera cinco minutos desde la primera detección sin ocupar un cupo; con sondeo normal la corrida empieza entre cinco y diez minutos después de la solicitud, si hay cupo de mantenimiento. Una solicitud nueva tiene otra corrida; un push conserva la anterior.
- **Cómo revisa:** el core prepara un checkout detached del head, sin correr la receta. Los especialistas leen el diff y el código; tests y framework solo corren con cambios Ruby. El lead contrasta sus hallazgos con la conversación y las revisiones anteriores. Si está instalada `review-council`, usa sus rúbricas y su voz desde `~/.claude/skills/review-council/references` o `~/.agents/skills/review-council/references`; `incomingReview.references` permite elegir otra carpeta. Sin la skill usa las instrucciones de los roles. El pack puede aportar el lore en `conventions.context` para `incoming-specialist` y la voz para `incoming-lead`.
- **Resultado:** abre **Files changed** en el PR. Yard agrega los comentarios al borrador de tu cuenta; el texto que ya escribiste queda intacto. Sin hallazgos no crea una review. El reporte con la evidencia queda en la corrida `Revisar un PR asignado`. Enviar, aprobar y pedir cambios quedan en GitHub.
- **Si algo cambia:** al perder la solicitud, cerrar el PR o descartar un borrador conocido, Yard deja de escribir. Si cambia el head durante el análisis, vuelve a revisar en la misma corrida. Al reintentar no repone comentarios editados o borrados. Si GitHub no confirma una escritura y no puede saberse si ocurrió, el paso muestra el error y conserva el reporte en Yard.

Este flujo extiende [Watch](design.html#d-ops) con los nodos de revisión y consolidación del [motor de flujos](design.html#d-flows).
