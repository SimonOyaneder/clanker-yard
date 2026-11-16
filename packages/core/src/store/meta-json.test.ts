import { afterEach, beforeEach, expect, test } from "vitest";
import * as z from "zod";
import { createLaneSettings } from "../scheduler/lanes";
import { readMetaJson } from "./meta-json";
import { meta } from "./schema";
import { openStore, type Store } from "./store";

let store: Store;
beforeEach(() => {
  store = openStore({ path: ":memory:" });
});
afterEach(() => store.close());

const save = (key: string, value: string) => store.tx((tx) => tx.db.insert(meta).values({ key, value }).run());

test("devuelve lo guardado si cumple el esquema, y undefined si no hay nada, no es JSON o ya no cumple", () => {
  const schema = z.object({ dev: z.int() });
  save("ok", JSON.stringify({ dev: 3 }));
  save("roto", "{no es json");
  save("viejo", JSON.stringify({ dev: "tres" }));

  expect(readMetaJson(store.db, "ok", schema)).toEqual({ dev: 3 });
  expect(readMetaJson(store.db, "falta", schema)).toBeUndefined();
  expect(readMetaJson(store.db, "roto", schema)).toBeUndefined();
  expect(readMetaJson(store.db, "viejo", schema)).toBeUndefined();
});

test("los carriles caen a los defaults si lo guardado ya no tiene la forma esperada", () => {
  save("lanes", JSON.stringify({ dev: "muchos" }));

  expect(createLaneSettings(store).capacity()).toEqual({ dev: 4, maintenance: 2 });
});
