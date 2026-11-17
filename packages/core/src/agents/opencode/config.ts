import type { JsonSchema } from "@clanker/api";
import { pickEnv } from "../../procs/env";
import type { RunSpec } from "../runtime";

/** El agente de opencode con que corren las sesiones del core: uno propio, para que el `build` del usuario no le cambie el prompt. */
export const OPENCODE_AGENT = "clanker";

/** La herramienta con que el agente entrega su reporte: la registra el plugin del core (`report-plugin.ts`). */
export const REPORT_TOOL = "clanker_report";

/** Va al final del prompt de sistema: opencode 2 no tiene salida estructurada, el reporte es la entrada de `REPORT_TOOL`. */
export const REPORT_INSTRUCTION = `Cuando termines, entrega tu reporte llamando a la herramienta ${REPORT_TOOL} una sola vez, con el formato que pide. Es lo último que haces: después no respondas nada más.`;

/**
 * Lo único que se hereda del entorno del core. Las `XDG_*` porque opencode guarda ahí sus credenciales y sesiones:
 * sin ellas, con un XDG propio, no las encontraría. Nunca `GH_TOKEN`, `LINEAR_*`, `SSH_AUTH_SOCK` ni las API keys de
 * proveedores: opencode usa las que guardó `opencode auth login`.
 */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

/** El nombre de una herramienta de Claude Code (`ToolPolicy` de un rol) como acción de permiso de opencode 2. */
const CLAUDE_TOOL_ACTIONS: Record<string, string> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "shell",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Task: "subagent",
  Skill: "skill",
};

/** Las acciones de opencode 2 que gobiernan herramientas (`docs/permissions`): una lista `allow` niega las demás una por una. */
const TOOL_ACTIONS = ["read", "edit", "glob", "grep", "shell", "subagent", "skill", "webfetch", "websearch"] as const;

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

const actionOf = (tool: string) => CLAUDE_TOOL_ACTIONS[tool] ?? tool.toLowerCase();
const rule = (action: string, effect: PermissionRule["effect"], resource = "*"): PermissionRule => ({ action, resource, effect });

/**
 * Las reglas del agente, en orden (gana la última que calza). Libertad total salvo lo que el rol acote; nunca se niega
 * `*`, porque la herramienta del reporte cae bajo `*`: un rol de solo lectura niega cada acción con nombre. `question`
 * no se pregunta: no hay nadie para contestar. Sin `native`, ninguna skill; con una lista, solo esas.
 */
export function permissionsFor(spec: Pick<RunSpec, "tools" | "native">): PermissionRule[] {
  const rules = [rule("*", "allow"), rule("question", "deny")];
  if (spec.tools !== "all") {
    const allowed = spec.tools.allow?.map(actionOf);
    if (allowed) for (const action of TOOL_ACTIONS) if (!allowed.includes(action)) rules.push(rule(action, "deny"));
    for (const tool of spec.tools.deny ?? []) rules.push(rule(actionOf(tool), "deny"));
  }
  const skills = spec.native?.skills ?? [];
  if (skills !== "all" && !rules.some((r) => r.action === "skill" && r.effect === "deny")) {
    rules.push(rule("skill", "deny"), ...skills.map((name) => rule("skill", "allow", name)));
  }
  return rules;
}

/**
 * `OPENCODE_CONFIG_CONTENT` (formato nativo de opencode 2): se suma a la config del usuario (proveedores, MCP) y gana
 * sobre ella. El agente `clanker` lleva el prompt del rol y los archivos de contexto; el plugin del reporte recibe el
 * esquema del modo. Sin los hooks del rol, se apagan los plugins del usuario y quedan los de opencode (`opencode.*`,
 * que incluye a los proveedores) y el del core.
 */
export function configFor(spec: Pick<RunSpec, "tools" | "native" | "hooks" | "systemPrompt" | "references" | "outputSchema">, reportPlugin: string): Record<string, unknown> {
  const plugin = { package: reportPlugin, options: { schema: reportSchema(spec.outputSchema) } };
  return {
    $schema: "https://opencode.ai/config.json",
    update: "disable",
    agents: { [OPENCODE_AGENT]: { mode: "primary", description: "Agente de Clanker Yard", system: systemFor(spec), permissions: permissionsFor(spec) } },
    plugins: spec.hooks ? [plugin] : ["-*", "opencode.*", plugin],
  };
}

/** De `baseEnv`, solo lo que opencode necesita para encontrar sus credenciales, sus sesiones y los comandos. */
export const inheritedEnv = (baseEnv: Record<string, string | undefined>): Record<string, string> => pickEnv(INHERITED_ENV, baseEnv);

export interface ServerEnvInput {
  baseEnv: Record<string, string | undefined>;
  /** Carpeta vacía: `gh` no encuentra sesión. */
  ghConfigDir: string;
  /** Config global de git generado por el core (solo identidad y `credential.helper` vacío). */
  gitConfig: string;
  /** La contraseña de `opencode serve` (`OPENCODE_PASSWORD`): sin ella cualquier proceso local le habla al servidor. */
  password: string;
  config: Record<string, unknown>;
}

/** El entorno de `opencode serve`, que es también el de los comandos del agente: lista blanca, igual que el de Claude. */
export function serverEnv({ baseEnv, ghConfigDir, gitConfig, password, config }: ServerEnvInput): Record<string, string> {
  return {
    ...inheritedEnv(baseEnv),
    GH_CONFIG_DIR: ghConfigDir,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
}

/** Un servidor propio del run, no el servicio en segundo plano del usuario. */
export const SERVE_ARGS = ["serve", "--hostname", "127.0.0.1", "--port", "0"];

/** El modelo de un perfil de opencode es `proveedor/modelo` (`openai/gpt-6.1-terra`); el modelo puede traer más `/`. */
export function parseModel(model: string): { providerID: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1 || model.includes("#")) {
    throw new Error(`El modelo "${model}" no sirve para opencode: va como proveedor/modelo (p. ej. openai/gpt-6.1-terra), y el esfuerzo aparte. Elígelo en el perfil.`);
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** El prompt del rol, los archivos de contexto detrás (el mismo orden que el prefijo de Claude) y cómo entregar el reporte. */
export function systemFor(spec: Pick<RunSpec, "systemPrompt" | "references">): string {
  const references = spec.references.map((r) => `# ${r.label}\n\n${r.content}`);
  return [spec.systemPrompt, ...references, REPORT_INSTRUCTION].join("\n\n");
}

/** El esquema del reporte sin `$schema`: el que declara `z.toJSONSchema` (2020-12) no lo resuelve todo validador. */
export function reportSchema(schema: JsonSchema): JsonSchema {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}
