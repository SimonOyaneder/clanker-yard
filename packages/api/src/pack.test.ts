import { describe, expect, test } from "vitest";
import { Pack, packJsonSchema, PackSettings } from "./index";

/** El pack de referencia del diseño (`#d-ops`): cada clave del esquema aparece aquí. */
const reference = {
  id: "acme",
  version: 1,
  activate: { githubOrgs: ["acme-co"], trackerWorkspaces: ["acme"] },
  actors: { ignore: "\\[bot\\]$|^(dependabot)$", silentReviewBody: "^\\s*(lgtm)?[\\s!.]*$" },
  signals: [
    {
      id: "risk",
      source: "label",
      match: "^risk[:/ _-]?(high|mid|medium|low)$",
      flags: "i",
      alias: { medium: "mid" },
      empty: "Sin riesgo",
      levels: { high: { label: "Riesgo alto", tone: "bad", hint: "Label risk:high" } },
    },
  ],
  reviewBot: {
    logins: ["acme-review[bot]"],
    request: { type: "comment", body: "acme review" },
    lgtm: { reviewState: "APPROVED", bodyMatch: "LGTM", sameSha: true },
    timeoutSec: 540,
    resolvableAuthors: ["acme-review[bot]"],
  },
  ciRules: { ignoreChecks: ["merge-queue"], okStates: ["SUCCESS", "SKIPPED", "NEUTRAL"], knownFlaky: ["e2e"] },
  mergeStrategy: {
    type: "comment",
    command: "acme merge",
    queueCheck: "merge-queue",
    appliesWhen: { checkSeenOnDefault: "merge-queue" },
    ready: ["notDraft", "approved", "ciGreen", "baseIsDefault", "noConflict", "noHumanOpenThreads", "notQueued"],
    offer: ["ready", "humanApprover", "noHumanTalk", "noCouncilOpen", "notHold"],
    auto: ["offer", "noHumanResolvedThreads", "noCouncilEver"],
    onOffer: "gate",
    onAuto: "act",
  },
  conventions: {
    commentPrefix: "[clanker] ",
    councilPrefix: "[clanker-council] ",
    commits: "conventional",
    noAiAttribution: true,
    pr: { template: "prompts/pr.md", omitSections: ["Rollback"] },
    context: { committer: ["skill:commit"], "*": ["repo:AGENTS.md"] },
  },
  flows: ["flows/techlead.json"],
  roles: ["roles/review-lore.json"],
};

function issues(input: unknown): string[] {
  const parsed = Pack.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("Pack", () => {
  test("acepta el pack de referencia", () => {
    expect(issues(reference)).toEqual([]);
  });

  test("una referencia de conventions.context con un tipo desconocido se rechaza", () => {
    const bad = { ...reference, conventions: { context: { "*": ["web:https://x"] } } };
    expect(issues(bad)).toEqual([expect.stringContaining("conventions.context.*.0")]);
  });

  test("un pack mínimo toma los defaults neutros", () => {
    const pack = Pack.parse({ id: "min", version: 1, activate: { githubOrgs: ["x"] } });
    expect(pack).toMatchObject({ actors: {}, signals: [], conventions: {}, flows: [], roles: [] });
    expect(pack.reviewBot).toBeUndefined();
    expect(pack.mergeStrategy).toBeUndefined();
  });

  test("PackSettings.parse({}) es la configuración sin pack", () => {
    expect(PackSettings.parse({})).toEqual({ actors: {}, signals: [], conventions: {} });
  });

  test.each([
    ["sin alcance", { ...reference, activate: {} }, "activate"],
    ["alcance con listas vacías", { ...reference, activate: { githubOrgs: [] } }, "activate"],
    ["un id de proyecto mal formado", { ...reference, activate: { projects: ["prj_1"] } }, "activate.projects.0"],
    ["una regex rota en actors", { ...reference, actors: { ignore: "(" } }, "actors.ignore"],
    [
      "unas flags que la regex de la señal no acepta",
      { ...reference, signals: [{ ...reference.signals[0], flags: "zz" }] },
      "signals.0.match",
    ],
    [
      "una señal sin niveles",
      { ...reference, signals: [{ ...reference.signals[0], levels: {} }] },
      "signals.0.levels",
    ],
    [
      "una condición de merge desconocida",
      { ...reference, mergeStrategy: { ...reference.mergeStrategy, ready: ["notDraft", "soyBueno"] } },
      "mergeStrategy.ready.1",
    ],
    ["un flow que sale de la carpeta", { ...reference, flows: ["../fuera.json"] }, "flows.0"],
    ["un role con ruta absoluta", { ...reference, roles: ["/etc/rol.json"] }, "roles.0"],
    ["un flow que no es json", { ...reference, flows: ["flows/a.md"] }, "flows.0"],
    ["una clave que el esquema no tiene", { ...reference, colour: "red" }, ""],
    ["un id con mayúsculas", { ...reference, id: "Acme" }, "id"],
  ])("rechaza %s con la ruta del campo", (_name, input, path) => {
    const found = issues(input);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((line) => line.startsWith(`${path}:`))).toBe(true);
  });
});

describe("packJsonSchema", () => {
  test("tiene cada clave del pack", () => {
    const properties = Object.keys((packJsonSchema as { properties: object }).properties);
    expect(properties.sort()).toEqual(
      ["activate", "actors", "ciRules", "conventions", "flows", "id", "mergeStrategy", "reviewBot", "roles", "signals", "version"].sort(),
    );
    expect((packJsonSchema as { required: string[] }).required.sort()).toEqual(["activate", "id", "version"]);
  });
});
