import { afterEach, expect, test } from "vitest";
import { openStore, type Store } from "../store/store";
import { BACKFILL_PAGE, eventsAfter } from "./event-stream";

let store: Store;
afterEach(() => store.close());

function emit(count: number): void {
  store.tx((tx) => {
    for (let i = 0; i < count; i++) tx.emit({ type: "core.started", origin: "core" });
  });
}

test("el relleno va por páginas y lo confirmado entre páginas no se repite", async () => {
  store = openStore({ path: ":memory:" });
  emit(BACKFILL_PAGE + 2);
  const total = BACKFILL_PAGE + 3;
  const abort = new AbortController();

  const seen: number[] = [];
  for await (const event of eventsAfter(store, 0, {}, abort.signal)) {
    seen.push(event.seq);
    // Llega al buffer y también a la segunda página.
    if (event.seq === 1) emit(1);
    // En vivo, después del relleno.
    if (event.seq === total) emit(1);
    if (event.seq === total + 1) abort.abort();
  }

  expect(seen).toEqual(Array.from({ length: total + 1 }, (_, i) => i + 1));
});
