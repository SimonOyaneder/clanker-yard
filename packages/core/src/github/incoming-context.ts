import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Las referencias de la skill instalada son optativas; una ruta configurada que falta sí es un error. */
export function councilReferences(configured?: string) {
  if (configured) return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  return ["claude", "agents"].map((home) => join(homedir(), `.${home}`, "skills/review-council/references")).find(existsSync);
}

/** Reportes manuales del mismo repo y PR/issue. El encabezado confirma el owner para repos homónimos. */
export async function manualReviews(repo: string, number: number, issue: string | null, directory: string) {
  if (!existsSync(directory)) return [];
  const name = repo.split("/")[1]!;
  const latest = new Map<number, string>();
  const files = (await readdir(directory)).filter((file) =>
    file.startsWith(`${name}-`) && /-\d+-(medio|eco|alto)-\d{8}-\d{4,6}\.md$/.test(file))
    .sort((a, b) => b.slice(-16).localeCompare(a.slice(-16)));
  for (const file of files) {
    const n = Number(file.slice(name.length + 1).split("-")[0]);
    if (latest.has(n) || (n !== number && (!issue || latest.size >= 5))) continue;
    const text = await readFile(join(directory, file), "utf8");
    const header = text.split("\n", 1)[0] ?? "";
    if (!header.startsWith(`# review council · ${repo}#${n} · `)) continue;
    if (n === number || (issue && header.toUpperCase().match(/\b[A-Z]+-\d+\b/g)?.includes(issue))) latest.set(n, text);
  }
  return [...latest.values()];
}
