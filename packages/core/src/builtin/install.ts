import type { DefKind, FlowDef, Profile, Role } from "@clanker/api";
import type { Defs } from "../defs/defs";
import type { Flows } from "../flows/flows";
import { clankerLoopTemplate } from "../template";
import { JUGUETE_FLOW, JUGUETE_PROFILE, JUGUETE_ROLE } from "./juguete";

/** Los roles, perfiles y flujos de una plantilla; un flujo va después de los que llama. */
interface Template {
  roles: Record<string, Role>;
  profiles: Record<string, Profile>;
  flows: FlowDef[];
}

const TEMPLATES: Template[] = [
  { roles: { juguete: JUGUETE_ROLE }, profiles: { juguete: JUGUETE_PROFILE }, flows: [JUGUETE_FLOW] },
  {
    roles: clankerLoopTemplate.roles,
    profiles: clankerLoopTemplate.profiles,
    flows: [clankerLoopTemplate.flows["pr-feedback"]!, clankerLoopTemplate.flows["techlead-clasico"]!, clankerLoopTemplate.flows["rebase-conflicto"]!],
  },
];

/**
 * Deja las plantillas que trae el core como defs de scope `builtin`. Se llama en cada arranque:
 * guardar el mismo contenido no suma versiones. Los roles y los perfiles van antes que los flujos, porque
 * `flows.save` valida que existan, y las acciones y waits que citan ya deben estar registrados.
 */
export function installBuiltins({ defs, flows }: { defs: Defs; flows: Flows }): void {
  const source = "builtin";
  const archived = (kind: DefKind, slug: string) =>
    defs.list(kind, { includeArchived: true }).some((d) => d.scope === "builtin" && d.slug === slug && d.archivedAt !== null);

  for (const template of TEMPLATES) {
    // Si alguien archivó una def de la plantilla, la plantilla entera queda fuera: `save` no guarda sobre una
    // def archivada, y un flujo cuyo rol está archivado no valida. Lanzar aquí dejaría al core sin arrancar.
    const out =
      Object.keys(template.roles).some((slug) => archived("role", slug)) ||
      Object.keys(template.profiles).some((slug) => archived("profile", slug)) ||
      template.flows.some((flow) => archived("flow", flow.id));
    if (out) continue;
    for (const [slug, body] of Object.entries(template.roles)) defs.save({ kind: "role", slug, scope: "builtin", body, source });
    for (const [slug, body] of Object.entries(template.profiles)) defs.save({ kind: "profile", slug, scope: "builtin", body, source });
    for (const flow of template.flows) flows.save(flow, { scope: "builtin", source });
  }
}
