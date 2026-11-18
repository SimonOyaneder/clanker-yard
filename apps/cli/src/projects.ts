import { parseArgs } from "node:util";
import type { Client, ClankerProject } from "@clanker/api";
import type { Command } from "./command";
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

export const projectsArchive: Command = {
  usage: "clanker projects archive <slug>",
  async run(args, ctx) {
    const { positionals } = parseArgs({ args, allowPositionals: true });
    const [slug, ...extra] = positionals;
    if (!slug?.trim() || extra.length > 0) throw new Error(`Indica un solo slug de proyecto.\nUso: ${projectsArchive.usage}`);

    const client = await ctx.client();
    const { id } = await projectBySlug(client, slug);
    const project = await client.projects.archive({ id });
    ctx.write(`Proyecto "${project.slug}" archivado. Se conserva su historial.`);
  },
};

/** El proyecto con ese slug; falla con un mensaje claro si no existe. */
export async function projectBySlug(client: Pick<Client, "projects">, slug: string): Promise<ClankerProject> {
  const project = (await client.projects.list()).find((p) => p.slug === slug);
  if (!project) throw new Error(`No existe el proyecto "${slug}" en Clanker Yard.`);
  return project;
}
