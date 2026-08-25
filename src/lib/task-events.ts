import { db } from "./db";

const PAYLOAD_CAP = 4000;
const RETRYABLE_TRANSACTION_CODES = new Set(["P1008", "P2002", "P2034"]);
const eventQueues = new Map<string, Promise<unknown>>();

function serializePayload(payload: unknown): string {
  const json = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return json.length <= PAYLOAD_CAP ? json : `${json.slice(0, PAYLOAD_CAP)}…[truncated]`;
}

function isRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    RETRYABLE_TRANSACTION_CODES.has(error.code)
  );
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function allocateTaskEvent(taskId: string, type: string, serialized: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const task = await tx.task.update({
          where: { id: taskId },
          data: { lastSeq: { increment: 1 } },
          select: { lastSeq: true },
        });

        return tx.taskEvent.create({
          data: {
            taskId,
            seq: task.lastSeq,
            type,
            payload: serialized,
          },
        });
      });
    } catch (error) {
      if (attempt >= 2 || !isRetryableTransactionError(error)) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}

export function appendTaskEvent(taskId: string, type: string, payload: unknown) {
  const serialized = serializePayload(payload);
  const previous = eventQueues.get(taskId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => allocateTaskEvent(taskId, type, serialized));

  eventQueues.set(taskId, current);
  void current
    .finally(() => {
      if (eventQueues.get(taskId) === current) eventQueues.delete(taskId);
    })
    .catch(() => undefined);

  return current;
}
