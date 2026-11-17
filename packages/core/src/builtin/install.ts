import type { DefKind, FlowDef, Profile, Role } from "@clanker/api";
import type { Defs } from "../defs/defs";
import type { Flows } from "../flows/flows";
import { clankerLoopTemplate } from "../template";

/** Los roles, perfiles y flujos de una plantilla; un flujo va después de los que llama. */
export interface BuiltinTemplate {
  roles: Record<string, Role>;
  profiles: Record<string, Profile>;
  flows: FlowDef[];
}

const TEMPLATES: BuiltinTemplate[] = [
  {
    roles: clankerLoopTemplate.roles,
    profiles: clankerLoopTemplate.profiles,
    flows: [
      clankerLoopTemplate.flows["pr-feedback"]!,
      clankerLoopTemplate.flows["techlead-clasico"]!,
      clankerLoopTemplate.flows["rebase-conflicto"]!,
      clankerLoopTemplate.flows["rebase-conflicto-local"]!,
      clankerLoopTemplate.flows["restack-feedback"]!,
      clankerLoopTemplate.flows["promote-local"]!,
      clankerLoopTemplate.flows["restack"]!,
      clankerLoopTemplate.flows["restack-rewritten"]!,
      clankerLoopTemplate.flows.council!,
      clankerLoopTemplate.flows["republish-pr"]!,
    ],
  },
];

/**
 * Deja las plantillas que trae el core como defs de scope `builtin`. Se llama en cada arranque:
 * guardar el mismo contenido no suma versiones. Los roles y los perfiles van antes que los flujos, porque
 * `flows.save` valida que existan, y las acciones y waits que citan ya deben estar registrados.
 *
 * Un flujo que no valida no tumba el arranque: queda en los errores que devuelve y conserva su versión anterior. Pasa
 * cuando un pack reemplaza un rol con una versión vieja (sin un outcome que el flujo nuevo usa); el core lo vuelve a
 * intentar después de recargar los packs.
 */
export function installBuiltins({ defs, flows, extra = [] }: { defs: Defs; flows: Flows; extra?: readonly BuiltinTemplate[] }): Error[] {
  const errors: Error[] = [];
  const source = "builtin";
  const archived = (kind: DefKind, slug: string) =>
    defs.list(kind, { includeArchived: true }).some((d) => d.scope === "builtin" && d.slug === slug && d.archivedAt !== null);

  for (const template of [...TEMPLATES, ...extra]) {
    // Si alguien archivó una def de la plantilla, la plantilla entera queda fuera: `save` no guarda sobre una
    // def archivada, y un flujo cuyo rol está archivado no valida. Lanzar aquí dejaría al core sin arrancar.
    const out =
      Object.keys(template.roles).some((slug) => archived("role", slug)) ||
      Object.keys(template.profiles).some((slug) => archived("profile", slug)) ||
      template.flows.some((flow) => archived("flow", flow.id));
    if (out) continue;
    for (const [slug, body] of Object.entries(template.roles)) defs.save({ kind: "role", slug, scope: "builtin", body, source });
    for (const [slug, body] of Object.entries(template.profiles)) defs.save({ kind: "profile", slug, scope: "builtin", body, source });
    for (const flow of template.flows) {
      try {
        flows.save(flow, { scope: "builtin", source });
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  return errors;
}
