import { parseArgs } from "node:util";
import { contract, type Client, type ContractMeta } from "@clanker/api";
import type { CliContext, Command } from "./command";

export const jsonInputOptions = {
  input: { type: "string" },
  "input-file": { type: "string" },
} as const;

export const JSON_INPUT_USAGE = "--input '<objeto JSON>' | --input-file <ruta>";

type JsonInput = Record<string, unknown>;

/** Lee una sola fuente de entrada; `undefined` significa que no se indicó ninguna. */
export function readJsonInput(
  { input, "input-file": file }: { input?: string; "input-file"?: string },
  { readFile }: Pick<CliContext, "readFile">,
): JsonInput | undefined {
  if (input !== undefined && file !== undefined) throw new Error("Usa solo uno de --input y --input-file.");
  const source = file === undefined ? "--input" : `--input-file ${JSON.stringify(file)}`;
  let text = input;
  if (file !== undefined) {
    try {
      text = readFile(file);
    } catch (error) {
      throw new Error(`No se pudo leer ${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  if (text === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${source} no contiene JSON válido.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} debe contener un objeto JSON.`);
  }
  return value as JsonInput;
}

/** La parte del esquema del contrato que usa la CLI, sin importar Zod directamente. */
interface InputSchema<Output = unknown> {
  "~standard": {
    validate(input: unknown): Validation<Output> | Promise<Validation<Output>>;
  };
  toJSONSchema?(options: { io: "input" }): unknown;
}

type Validation<Output> =
  | { value: Output; issues?: undefined }
  | { issues: readonly { path?: readonly (PropertyKey | { key: PropertyKey })[]; message: string }[] };

export async function validateInput<T>(schema: InputSchema<T>, input: JsonInput): Promise<T> {
  const result = await schema["~standard"].validate(input);
  if (!result.issues) return result.value;
  const issues = result.issues.map(({ path, message }) => {
    const field = path?.map((part) => String(typeof part === "object" ? part.key : part)).join(".");
    return `  ${field ? `${field}: ` : ""}${message}`;
  });
  throw new Error(`Entrada inválida:\n${issues.join("\n")}`);
}

export function inputHelp(schema: InputSchema | undefined): string {
  if (!schema) return "No recibe campos de entrada.";
  try {
    if (schema.toJSONSchema) return `Esquema de entrada (JSON Schema):\n${JSON.stringify(schema.toJSONSchema({ io: "input" }), null, 2)}`;
  } catch {
    // Algunos tipos de Zod no se pueden representar como JSON Schema.
  }
  return "Usa --input o --input-file para pasar los campos de entrada como un objeto JSON.";
}

interface ContractProcedure {
  "~orpc": { meta: ContractMeta; inputSchema?: InputSchema };
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** El cliente usa las mismas rutas del contrato; solo se llama con keys de un procedimiento marcado. */
type RpcClient = Record<string, Record<string, (input: JsonInput | undefined, options: { signal: AbortSignal }) => Promise<unknown>>>;

export function rpcCommands(): Map<string, Command> {
  const commands = new Map<string, Command>();
  for (const [namespace, procedures] of Object.entries(contract)) {
    for (const [procedure, definition] of Object.entries<ContractProcedure>(procedures)) {
      const { meta: { mcp }, inputSchema } = definition["~orpc"];
      if (!mcp) continue;
      const name = `${namespace} ${kebab(procedure)}`;
      const kinds = "tool" in mcp && typeof mcp.kind !== "string" ? mcp.kind : undefined;
      const description = "action" in mcp ? mcp.description : undefined;
      const kindHelp = kinds && `Valores de kind en la CLI: ${kinds.join(", ")}.`;
      const command: Command = {
        usage: `clanker ${name}${inputSchema ? ` [${JSON_INPUT_USAGE}]` : ""}`,
        help: () => [description, kindHelp, inputHelp(inputSchema)].filter(Boolean).join("\n\n"),
        async run(args, ctx) {
          const { values } = parseArgs({ args, options: jsonInputOptions });
          const input = readJsonInput(values, ctx) ?? {};
          if (inputSchema) {
            // Valida sin arrancar el core, pero envía el objeto original: el servidor aplica defaults y transformaciones.
            await validateInput(inputSchema, input);
          } else if (Object.keys(input).length) {
            throw new Error("Este comando no recibe campos de entrada.");
          }
          if (kinds && !kinds.some((kind) => kind === input.kind)) throw new Error(kindHelp);

          const client: Client = await ctx.client();
          const result = await (client as unknown as RpcClient)[namespace]![procedure]!(
            inputSchema ? input : undefined,
            { signal: ctx.signal },
          );
          ctx.write(JSON.stringify(result ?? null, null, 2));
        },
      };
      commands.set(name, command);
    }
  }
  return commands;
}
