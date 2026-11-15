import type { Event, EventFilter } from "@clanker/api";
import type { Store } from "../store/store";

/** Cuántos eventos lee el relleno por consulta: una UI nueva no carga toda la tabla de una vez. */
export const BACKFILL_PAGE = 500;

/**
 * Eventos con `seq > after` que cumplen `filter`: primero los que ya están en SQLite y después los
 * que se van confirmando, sin huecos ni duplicados. Termina cuando `signal` se aborta.
 *
 * Suscribe antes de leer la base, así que todo evento confirmado está en el relleno, en el buffer o
 * en los dos; `last` descarta los repetidos. El buffer no tiene tope: un consumidor lento acumula
 * memoria, no pierde eventos.
 */
export async function* eventsAfter(
  store: Store,
  after: number,
  filter: EventFilter,
  signal?: AbortSignal,
): AsyncGenerator<Event, void> {
  const buffer: Event[] = [];
  let wake: (() => void) | undefined;
  const wakeUp = () => wake?.();
  const unsubscribe = store.events.subscribe((event) => {
    buffer.push(event);
    wakeUp();
  }, filter);
  signal?.addEventListener("abort", wakeUp);

  try {
    let last = after;
    for (;;) {
      const page = store.events.since(last, filter, BACKFILL_PAGE);
      for (const event of page) {
        last = event.seq;
        yield event;
      }
      if (page.length < BACKFILL_PAGE) break;
    }
    while (!signal?.aborted) {
      const event = buffer.shift();
      if (event === undefined) {
        await new Promise<void>((resolve) => (wake = resolve));
      } else if (event.seq > last) {
        last = event.seq;
        yield event;
      }
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", wakeUp);
  }
}
