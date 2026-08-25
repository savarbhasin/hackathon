/** Runs asynchronous work one at a time, in the order it was requested. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    let release: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release!();
    }
  }
}
