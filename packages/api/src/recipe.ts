import * as z from "zod";

// La receta del repo, `.clanker/recipe.json`: `docs/design.html#d-ops`, "Receta del repo". Es el
// body de las defs de kind `recipe`.

/** `{{slot}}`, `{{slot+N}}`, `{{worktree}}`, `{{branch}}`, `{{files}}` y `{{envKeys}}`. Nada más: sin expresiones. */
const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const KNOWN_VARIABLE = /^(?:slot(?:\+(\d+))?|worktree|branch|files|envKeys)$/;

const unknownVariable = (name: string) =>
  `la variable {{${name}}} no existe: solo {{slot}}, {{slot+N}}, {{worktree}}, {{branch}}, {{files}} y {{envKeys}}, sin expresiones.`;

/** Un string de la receta que admite variables; una desconocida se rechaza al leer la receta, no al correrla. */
const Template = z.string().superRefine((template, ctx) => {
  for (const [, name] of template.matchAll(VARIABLE)) {
    if (!KNOWN_VARIABLE.test(name!)) ctx.addIssue({ code: "custom", message: unknownVariable(name!) });
  }
});

const Commands = z.array(Template).default([]);

export const Recipe = z
  .strictObject({
    version: z.literal(1),
    /** Servicios que el repo necesita y cómo comprobar que están arriba. */
    requires: z.array(z.strictObject({ name: z.string().min(1), check: Template })).default([]),
    /** Tamaño de cada pool de slots: dev usa 1..N y maintenance N+1..N+M. */
    slots: z.strictObject({ dev: z.int().positive(), maintenance: z.int().positive() }).optional(),
    /** `null` o ausente: el directorio de datos de la app. */
    worktreeDir: z.string().min(1).nullable().optional(),
    /** Entorno de todo comando del slot. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "no es un nombre de variable de entorno"), Template).default({}),
    /** Prefijo de todo comando del slot. */
    wrap: Template.optional(),
    setup: z
      .strictObject({
        worktree: Commands,
        slot: Commands,
        /** Archivos cuyo hash dice si hay que repetir `setup.slot`. */
        slotKey: z.array(z.string().min(1)).default([]),
        /** Corre antes de `setup.slot`: si la app no resuelve lo esperado, no se borra nada. */
        guard: z.strictObject({ run: Template, expect: Template }).optional(),
      })
      .optional(),
    /** Nombre -> comando. */
    commands: z.record(z.string().min(1), Template).default({}),
    /** Nombres de `commands` que corre la acción `recipe.check`, en ese orden. */
    checks: z.array(z.string().min(1)).default([]),
    afterRebase: Commands,
  })
  .superRefine((recipe, ctx) => {
    recipe.checks.forEach((name, index) => {
      if (name in recipe.commands) return;
      const known = Object.keys(recipe.commands);
      ctx.addIssue({
        code: "custom",
        path: ["checks", index],
        message: `"${name}" no está en commands (${known.length ? known.join(", ") : "no hay ninguno"}).`,
      });
    });
  });
export type Recipe = z.infer<typeof Recipe>;

export interface TemplateVars {
  /** Sin slot, `{{slot}}` y `{{slot+N}}` fallan. */
  slot?: number;
  worktree: string;
  branch: string;
  files: readonly string[];
  envKeys: readonly string[];
}

/** Los nombres de las variables que usa `template` (`slot+3` es `slot+3`), en orden y sin repetir. */
export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VARIABLE)].map((m) => m[1]!))];
}

/**
 * Sustituye las variables de `template`. Con `shell`, `worktree`, `branch` y cada archivo de `files`
 * se escapan para `sh -c` (un comando); sin `shell` (valores de `env`) van tal cual.
 */
export function renderTemplate(template: string, vars: TemplateVars, opts: { shell: boolean }): string {
  const text = (value: string) => (opts.shell ? shellQuote(value) : value);
  return template.replace(VARIABLE, (_match, name: string) => {
    const known = KNOWN_VARIABLE.exec(name);
    if (!known) throw new Error(unknownVariable(name));
    if (name.startsWith("slot")) {
      if (vars.slot === undefined) {
        throw new Error(`La receta usa {{${name}}} pero este comando no tiene slot: define slots en la receta o pásalo como slot.`);
      }
      return String(vars.slot + Number(known[1] ?? 0));
    }
    switch (name) {
      case "worktree":
        return text(vars.worktree);
      case "branch":
        return text(vars.branch);
      case "files":
        return vars.files.map(text).join(" ");
      default:
        return vars.envKeys.join(",");
    }
  });
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
