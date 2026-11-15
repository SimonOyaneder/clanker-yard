import { parseArgs } from "node:util";
import type { Client, ClankerProject } from "@clanker/api";
import type { Command } from "./cli";
import { formatTable } from "./format";

export const projectsList: Command = {
  usage: "clanker projects list [--json]",
  async run(args, ctx) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const projects = await (await ctx.client()).projects.list();

    if (values.json) return ctx.write(JSON.stringify(projects, null, 2));
    if (projects.length === 0) return ctx.write("No hay proyectos.");
    ctx.write(
      formatTable([
        ["Slug", "Nombre", "Tracker", "Estado", "Flujo", "Cupo"],
        ...projects.map((p) => [p.slug, p.name, p.tracker, p.status, p.defaultFlowId ?? "-", String(p.parallel)]),
      ]),
    );
  },
};

/** El proyecto con ese slug; falla con un mensaje claro si no existe. */
export async function projectBySlug(client: Pick<Client, "projects">, slug: string): Promise<ClankerProject> {
  const project = (await client.projects.list()).find((p) => p.slug === slug);
  if (!project) throw new Error(`No existe el proyecto "${slug}" en Clanker Yard.`);
  return project;
}
