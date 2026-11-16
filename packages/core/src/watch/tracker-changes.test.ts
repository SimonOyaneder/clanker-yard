import type { ClankerProject } from "@clanker/api";
import { trackersByKind } from "../tracker/trackers";
import { describe, expect, test, vi } from "vitest";
import { createErrorReporter } from "./report";
import { createTrackerChanges, TRACKER_EVERY_MS } from "./tracker-changes";
import { openStore } from "../store/store";
import type { Tracker } from "../tracker/tracker";

const tracker = { id: "linear" } as Tracker;
const project = (slug: string, status: ClankerProject["status"] = "active") =>
  ({ id: `prj_${slug}`, slug, status, tracker: "linear", trackerRef: slug }) as unknown as ClankerProject;

function setup(projects: ClankerProject[], hasChanges: (id: string) => Promise<boolean>) {
  const store = openStore({ path: ":memory:" });
  const onChanges = vi.fn();
  const changes = createTrackerChanges({
    projects: { list: () => projects },
    trackers: trackersByKind({ linear: tracker }),
    issues: { hasChanges: (_, { project: ref }) => hasChanges(ref.id) },
    onChanges,
    errors: createErrorReporter(store),
  });
  return { store, onChanges, changes, errors: () => store.events.since(0, { types: ["error"] }).map((e) => e.payload) };
}

describe("cambios del tracker", () => {
  test("despierta al Scheduler cuando hay cambios y pregunta de nuevo solo pasado el intervalo", async () => {
    const hasChanges = vi.fn(() => Promise.resolve(true));
    const { changes, onChanges, store } = setup([project("alfa")], hasChanges);

    await changes.poll(0);
    await changes.poll(TRACKER_EVERY_MS - 1);
    expect(hasChanges).toHaveBeenCalledTimes(1);
    expect(onChanges).toHaveBeenCalledTimes(1);

    await changes.poll(TRACKER_EVERY_MS);
    expect(hasChanges).toHaveBeenCalledTimes(2);
    expect(onChanges).toHaveBeenCalledTimes(2);
    store.close();
  });

  test("sin cambios no despierta a nadie, y un proyecto que no está activo no se pregunta", async () => {
    const hasChanges = vi.fn(() => Promise.resolve(false));
    const { changes, onChanges, store } = setup([project("alfa"), project("beta", "paused")], hasChanges);

    await changes.poll(0);

    expect(hasChanges).toHaveBeenCalledTimes(1);
    expect(hasChanges).toHaveBeenCalledWith("alfa");
    expect(onChanges).not.toHaveBeenCalled();
    store.close();
  });

  test("un tracker caído se anota una vez y no frena a los demás proyectos", async () => {
    const down = new Error("Linear no responde");
    const { changes, onChanges, errors, store } = setup([project("alfa"), project("beta")], (id) => (id === "alfa" ? Promise.reject(down) : Promise.resolve(true)));

    await changes.poll(0);
    await changes.poll(TRACKER_EVERY_MS);

    expect(onChanges).toHaveBeenCalledTimes(2);
    expect(errors()).toEqual([{ scope: "watch.tracker alfa", message: "Linear no responde" }]);
    store.close();
  });
});
