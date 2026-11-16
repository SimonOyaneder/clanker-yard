/** Una cola con un solo consumidor: los eventos se acumulan aunque nadie itere todavía. */
export function createEventQueue<T extends object>() {
  const buffer: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  return {
    push(item: T) {
      if (closed) return;
      buffer.push(item);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
      for (;;) {
        const next = buffer.shift();
        if (next !== undefined) {
          yield next;
        } else if (closed) {
          return;
        } else {
          await new Promise<void>((resolve) => (wake = resolve));
        }
      }
    },
  };
}
