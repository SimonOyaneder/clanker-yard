import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConnections, type Connections } from "../connections/connections";
import { startFakeLinear, type FakeLinear } from "../linear/fake-linear";
import { createLinearTracker } from "../linear/tracker";
import { createFileSecrets } from "../secrets/encrypted-file";
import { openStore, type Store } from "../store/store";
import type { Tracker } from "./tracker";
import { createTrackers, TrackerAccountError } from "./trackers";

const CLIENT_ID = "test-client-id";
const states = JSON.parse(readFileSync(new URL("../linear/fixtures/states.clanker-yard.json", import.meta.url), "utf8")) as { name: string; type: string }[];

let dir: string;
let store: Store;
const fakes = new Map<string, FakeLinear>();
let connections: Connections;

/** Conecta el workspace `urlKey` (un Linear falso propio) en el mismo core. */
async function connect(urlKey: string) {
  const linear = await startFakeLinear({ clientId: CLIENT_ID, workspace: urlKey });
  fakes.set(urlKey, linear);
  const own = createConnections(store, createFileSecrets({ dir: join(dir, "secrets") }), {
    linear: { clientId: CLIENT_ID, redirectPort: 0, endpoints: linear.endpoints },
  });
  const { url, done } = await own.linearAuth("ui");
  const authorize = await fetch(url, { redirect: "manual" });
  await fetch(authorize.headers.get("location")!);
  await done;
  connections = own;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-trackers-"));
  store = openStore({ path: join(dir, "clanker.db") });
});

afterEach(async () => {
  await Promise.all([...fakes.values()].map((f) => f.close()));
  fakes.clear();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const local = { id: "local" } as Tracker;
const trackersOf = () =>
  createTrackers({
    local,
    connections: { list: () => connections.list() },
    linear: (account) =>
      createLinearTracker({ connections, account, endpoint: fakes.get(account)!.endpoints.graphql }),
  });
const linearProject = (slug: string, trackerAccount: string | null) => ({ slug, tracker: "linear" as const, trackerAccount });

describe("el tracker de un proyecto", () => {
  test("con dos workspaces conectados, cada proyecto lee la cola de su cuenta", async () => {
    await connect("acme");
    await connect("clanker-yard");
    for (const [urlKey, title] of [["acme", "issue de acme"], ["clanker-yard", "issue de clanker yard"]] as const) {
      const w = fakes.get(urlKey)!.workspace;
      w.addIssue({ team: w.addTeam("CLA", states), title, project: w.addProject("Cola") });
    }
    const trackers = trackersOf();

    const queueOf = async (account: string) => {
      const tracker = trackers(linearProject(account, account))!;
      const [project] = await tracker.listProjects();
      return (await tracker.listIssues({ tracker: "linear", id: project!.ref.id }, {})).map((i) => i.title);
    };

    expect(await queueOf("acme")).toEqual(["issue de acme"]);
    expect(await queueOf("clanker-yard")).toEqual(["issue de clanker yard"]);
  });

  test("un proyecto sin cuenta usa la única conectada; con varias, el error manda a Ajustes", async () => {
    await connect("acme");
    expect(trackersOf()(linearProject("viejo", null))).toBeDefined();

    await connect("clanker-yard");
    expect(() => trackersOf()(linearProject("viejo", null))).toThrow(TrackerAccountError);
    expect(() => trackersOf()(linearProject("viejo", null))).toThrow(/viejo.*acme, clanker-yard.*Ajustes|viejo.*clanker-yard, acme.*Ajustes/);
  });

  test("sin Linear conectado un proyecto de Linear sin cuenta dice que lo conecte; local no pregunta por cuentas", () => {
    const trackers = createTrackers({ local, connections: { list: () => [] }, linear: () => local });

    expect(() => trackers(linearProject("viejo", null))).toThrow(/no hay una cuenta de Linear conectada/);
    expect(trackers({ slug: "l", tracker: "local", trackerAccount: null })).toBe(local);
    expect(trackers({ slug: "j", tracker: "jira", trackerAccount: null })).toBeUndefined();
  });
});
