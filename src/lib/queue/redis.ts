import IORedis from "ioredis";
import { redisUrl } from "./env";

export type RedisRole = "producer" | "worker" | "events" | "cache";

/**
 * Workers and QueueEvents must use null here: both run blocking commands and
 * BullMQ's lock renewal needs command retries through temporary Redis
 * disconnections. Producers and cache reads fail quickly so callers can retry
 * or fall back to the source of truth.
 */
export function createRedisConnection(role: RedisRole): IORedis {
  return new IORedis(redisUrl(), {
    maxRetriesPerRequest: role === "producer" || role === "cache" ? 1 : null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}
