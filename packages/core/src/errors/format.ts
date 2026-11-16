/** El texto de un error para un evento o un mensaje: su `message` si es un `Error`, si no lo que sea como texto. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Un problema de validación: el de zod (`path` como arreglo) o el de un validador del core (`path` ya unido con puntos). */
export interface IssueLike {
  path: string | readonly PropertyKey[];
  message: string;
}

/** La ruta de un problema dentro del valor validado (`nodes.sync.on`), o `(raíz)` si es el valor entero. */
export function issuePath(path: IssueLike["path"]): string {
  const joined = typeof path === "string" ? path : path.map(String).join(".");
  return joined === "" ? "(raíz)" : joined;
}

/** Los problemas en una sola línea, separados por `; `: para un evento o el error de un paso. */
export function issuesInline(issues: readonly IssueLike[]): string {
  return issues.map((i) => `${issuePath(i.path)}: ${i.message}`).join("; ");
}

/** Los problemas uno por línea y con sangría: para el mensaje de un error que se lanza con un encabezado. */
export function issuesAsLines(issues: readonly IssueLike[]): string {
  return issues.map((i) => `  ${issuePath(i.path)}: ${i.message}`).join("\n");
}
