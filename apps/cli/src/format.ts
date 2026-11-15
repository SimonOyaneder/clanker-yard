/**
 * Filas con columnas alineadas, separadas por dos espacios; la primera fila es el encabezado. Las
 * columnas desde `rightAlignedFrom` se alinean a la derecha (números), las demás a la izquierda.
 */
export function formatTable(rows: readonly (readonly string[])[], rightAlignedFrom = Infinity): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i >= rightAlignedFrom ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
