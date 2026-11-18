import { Profile } from "@clanker/api";

/**
 * Los perfiles de potencia de la plantilla, por slug; son los body de las defs de kind `profile`.
 * `dev-escala` no es un rol sino la entrada que usa `escalate.profileRole` de un flujo: el modelo
 * con el que se reintenta al dev. Sin topes ni TTL de 1 h: son opciones de quien los configure.
 */
const profile = (roles: Record<string, string>): Profile =>
  Profile.parse({
    roles: Object.fromEntries(
      Object.entries(roles).map(([role, spec]) => {
        const [model, effort] = spec.split(":");
        return [role, { model, effort }];
      }),
    ),
  });

export const profiles: Record<string, Profile> = {
  eco: profile({
    dev: "sonnet:high",
    "dev-escala": "opus:high",
    "review-bugs": "sonnet:high",
    "review-tests": "haiku:high",
    "review-patterns": "sonnet:medium",
    "review-lore": "haiku:high",
    committer: "sonnet:medium",
    triage: "sonnet:high",
    "plan-check": "sonnet:medium",
    chat: "sonnet:high",
  }),
  medio: profile({
    dev: "opus:high",
    "dev-escala": "opus:xhigh",
    "review-bugs": "opus:high",
    "review-tests": "sonnet:medium",
    "review-patterns": "sonnet:medium",
    "review-lore": "sonnet:medium",
    committer: "sonnet:high",
    triage: "sonnet:high",
    "plan-check": "sonnet:medium",
    chat: "sonnet:high",
  }),
  alto: profile({
    dev: "opus:xhigh",
    "dev-escala": "fable:high",
    "review-bugs": "opus:xhigh",
    "review-tests": "sonnet:high",
    "review-patterns": "sonnet:high",
    "review-lore": "sonnet:high",
    committer: "opus:high",
    triage: "opus:high",
    "plan-check": "sonnet:high",
    chat: "sonnet:high",
  }),
  max: profile({
    dev: "fable:xhigh",
    "dev-escala": "fable:xhigh",
    "review-bugs": "fable:high",
    "review-tests": "opus:high",
    "review-patterns": "opus:high",
    "review-lore": "opus:high",
    committer: "opus:xhigh",
    triage: "opus:xhigh",
    "plan-check": "sonnet:high",
    chat: "sonnet:high",
  }),
};
