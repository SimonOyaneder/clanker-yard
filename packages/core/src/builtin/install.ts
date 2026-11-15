import type { Defs } from "../defs/defs";
import type { Flows } from "../flows/flows";
import { JUGUETE_FLOW, JUGUETE_PROFILE, JUGUETE_ROLE } from "./juguete";

/**
 * Deja las plantillas que trae el core como defs de scope `builtin`. Se llama en cada arranque:
 * guardar el mismo contenido no suma versiones. Los roles y el perfil van antes que el flujo, porque
 * `flows.save` valida que existan, y las acciones que cita ya deben estar registradas.
 */
export function installBuiltins({ defs, flows }: { defs: Defs; flows: Flows }): void {
  const source = "builtin";
  defs.save({ kind: "role", slug: "juguete", scope: "builtin", body: JUGUETE_ROLE, source });
  defs.save({ kind: "profile", slug: "juguete", scope: "builtin", body: JUGUETE_PROFILE, source });
  flows.save(JUGUETE_FLOW, { scope: "builtin", source });
}
