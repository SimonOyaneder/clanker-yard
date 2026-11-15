import type { Event, EventFilter } from "@clanker/api";
import type { Store } from "../store/store";

/**
 * Eventos con `seq > after` que cumplen `filter`: primero los que ya están en SQLite y después los
 * que se van confirmando, sin huecos ni duplicados. Termina cuando `signal` se aborta.
 *
 * Suscribe y lee la base sin ceder el control entre ambas cosas (las dos son síncronas), así que todo
 * evento confirmado está en el relleno o en el buffer, nunca en los dos. El buffer no tiene tope: un
 * consumidor lento acumula memoria, no pierde eventos.
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
    yield* store.events.since(after, filter);
    while (!signal?.aborted) {
      const event = buffer.shift();
      if (event === undefined) {
        await new Promise<void>((resolve) => (wake = resolve));
      } else {
        yield event;
      }
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", wakeUp);
  }
}
