import IORedis from "ioredis";
import { redisUrl } from "./env";

export type RedisRole = "producer" | "worker" | "events" | "cache";

type RedisGlobals = {
  producerRedis?: IORedis;
};

const globalForRedis = globalThis as unknown as RedisGlobals;

/**
 * Workers and QueueEvents must use null here: both run blocking commands and
 * BullMQ's lock renewal needs command retries through temporary Redis
 * disconnections. Producers and cache reads fail quickly so callers can retry
 * or fall back to the source of truth.
 *
 * The non-blocking producer connection is process-global so Next.js requests
 * reuse the established socket. BullMQ recognizes a supplied IORedis instance
 * as shared, so closing a short-lived Queue wrapper does not close this pool.
 */
export function createRedisConnection(role: RedisRole): IORedis {
  if (role === "producer" && globalForRedis.producerRedis && globalForRedis.producerRedis.status !== "end") {
    return globalForRedis.producerRedis;
  }
  const connection = new IORedis(redisUrl(), {
    maxRetriesPerRequest: role === "producer" || role === "cache" ? 1 : null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  if (role === "producer") {
    // Keep a listener attached between Queue wrappers so a transient socket
    // error is reported through operations rather than as an unhandled event.
    connection.on("error", () => undefined);
    globalForRedis.producerRedis = connection;
  }
  return connection;
}

/** Explicit shutdown for one-shot producers and the worker process. */
export async function closeProducerRedisConnection(): Promise<void> {
  const connection = globalForRedis.producerRedis;
  delete globalForRedis.producerRedis;
  if (!connection || connection.status === "end") return;
  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
}
