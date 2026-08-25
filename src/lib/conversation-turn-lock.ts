export class ConversationTurnAbortedError extends Error {
  constructor() {
    super("The conversation turn was cancelled.");
    this.name = "ConversationTurnAbortedError";
  }
}

export interface ConversationTurnLock {
  acquire(conversationId: string, signal?: AbortSignal): Promise<() => void>;
}

export function createConversationTurnLock(): ConversationTurnLock {
  const tails = new Map<string, Promise<void>>();

  return {
    async acquire(conversationId: string, signal?: AbortSignal): Promise<() => void> {
      const previous = tails.get(conversationId) ?? Promise.resolve();
      let resolveCurrent: (() => void) | undefined;
      const current = new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
      const tail = previous.then(() => current);
      tails.set(conversationId, tail);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        resolveCurrent?.();
        if (tails.get(conversationId) === tail) tails.delete(conversationId);
      };

      try {
        await waitFor(previous, signal);
      } catch (error) {
        release();
        throw error;
      }

      return release;
    },
  };
}

function waitFor(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new ConversationTurnAbortedError());

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => finish(() => reject(new ConversationTurnAbortedError()));
    const finish = (complete: () => void) => {
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(() => finish(resolve), (error) => finish(() => reject(error)));
  });
}
