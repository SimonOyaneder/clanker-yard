import type { Lanes, LanesPatch } from "@clanker/api";
import { activeRuns } from "../flows/lanes";
import type { LaneCapacity } from "../flows/lanes";
import { meta } from "../store/schema";
import { readMetaJson } from "../store/meta-json";
import type { Store } from "../store/store";
import * as z from "zod";

/** Mantenimiento: 2 por máquina. Dev: el tope global de la máquina, que cada proyecto acota con su `parallel`. */
export const DEFAULT_LANE_CAPACITY: LaneCapacity = { dev: 4, maintenance: 2 };

/** Lo guardado en `meta`: cada carril que se cambió alguna vez. */
const SavedCapacity = z.object({ dev: z.int().positive(), maintenance: z.int().positive() }).partial();

const META_KEY = "lanes";

export interface LaneSettings {
  /** La capacidad vigente. La leen el motor (cada admisión) y el Scheduler. */
  capacity(): LaneCapacity;
  /** Cambia la capacidad de los carriles presentes y la guarda; devuelve la vigente. */
  set(patch: LanesPatch): LaneCapacity;
  /** La capacidad de cada carril y cuántas corridas lo ocupan hoy. */
  usage(): Lanes;
}

export function createLaneSettings(store: Store): LaneSettings {
  let current: LaneCapacity | undefined;

  function capacity(): LaneCapacity {
    if (current === undefined) {
      current = { ...DEFAULT_LANE_CAPACITY, ...readMetaJson(store.db, META_KEY, SavedCapacity) };
    }
    return current;
  }

  return {
    capacity,
    set(patch) {
      const next: LaneCapacity = { ...capacity(), ...(patch.dev !== undefined && { dev: patch.dev }), ...(patch.maintenance !== undefined && { maintenance: patch.maintenance }) };
      const value = JSON.stringify(next);
      store.tx((tx) => tx.db.insert(meta).values({ key: META_KEY, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run());
      current = next;
      return next;
    },
    usage() {
      const cap = capacity();
      return {
        dev: { active: activeRuns(store.db, "dev"), capacity: cap.dev },
        maintenance: { active: activeRuns(store.db, "maintenance"), capacity: cap.maintenance },
      };
    },
  };
}
