/** Máximo de learnings nuevos que el core guarda de cada paso que cierra; el resto se descarta. */
export const MAX_PROPOSED_PER_STEP = 1;

/** El criterio para proponer un learning. Lo ven los agentes que proponen y el filtro de los propuestos. */
export const LEARNING_CRITERIA = `Un learning solo se propone si cumple las cuatro condiciones:
1. Reutilizable: cambia lo que haría un agente en OTRA issue del repo, no solo en esta.
2. No obvio: no se descubre en un minuto leyendo el código, \`AGENTS.md\` o el README.
3. Comprobado: te topaste con eso (un error, un comentario de review, CI rojo); no es una suposición.
4. Una línea en imperativo.

Bueno: "Usa \`doppler run --config dev -- \` para correr tapioca y srb" (se descubrió por un error y sirve en cualquier issue).
Malo: "\`Dashboard::ReportExport::UploadJob\` se mantiene como está" (un dato de esta issue).`;

/** Lo que el prompt de un agente que propone agrega sobre \`learnings\` del reporte. */
export const LEARNING_PROMPT = `Learnings (\`learnings\` del reporte): máximo 1 por corrida; si dudas, no lo propongas y deja el arreglo vacío. El brief trae en \`learnings\` y \`proposedLearnings\` los que ya existen: no repitas ninguno.

${LEARNING_CRITERIA}`;
