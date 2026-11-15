import { afterEach, expect, test } from "vitest";
import { openStore, type Store } from "../store/store";
import { createLaneSettings, DEFAULT_LANE_CAPACITY } from "./lanes";

let store: Store;
afterEach(() => store.close());

test("mantenimiento 2 y dev 4 por defecto; setLanes cambia solo lo que se pide y sobrevive a un reinicio", () => {
  store = openStore({ path: ":memory:" });
  const lanes = createLaneSettings(store);
  expect(lanes.capacity()).toEqual(DEFAULT_LANE_CAPACITY);
  expect(DEFAULT_LANE_CAPACITY).toEqual({ dev: 4, maintenance: 2 });

  expect(lanes.set({ maintenance: 5 })).toEqual({ dev: 4, maintenance: 5 });
  expect(lanes.set({ dev: 1 })).toEqual({ dev: 1, maintenance: 5 });
  expect(lanes.usage()).toEqual({ dev: { active: 0, capacity: 1 }, maintenance: { active: 0, capacity: 5 } });
  expect(createLaneSettings(store).capacity()).toEqual({ dev: 1, maintenance: 5 });
});
