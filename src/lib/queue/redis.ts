import IORedis from "ioredis";
import { redisUrl } from "./env";

export type RedisRole = "producer" | "worker" | "events";

/**
 * Workers and QueueEvents must use null here: both run blocking commands and
 * BullMQ's lock renewal needs command retries through temporary Redis
 * disconnections. Producers fail quickly so a caller or queued-run reconciler
 * can retry safely.
 */
export function createRedisConnection(role: RedisRole): IORedis {
  return new IORedis(redisUrl(), {
    maxRetriesPerRequest: role === "producer" ? 1 : null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}
