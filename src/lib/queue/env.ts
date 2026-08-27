function requiredUrl(name: string, allowedProtocols: string[], suppliedValue?: string): string {
  const value = suppliedValue ?? process.env[name];
  if (!value) throw new Error(`${name} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!allowedProtocols.includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${name} must use ${allowedProtocols.join(" or ")} and include a hostname`);
  }
  return value;
}

export function redisUrl(): string {
  const value = process.env.REDIS_URL;
  if (!value) throw new Error("REDIS_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("REDIS_URL must be a valid URL");
  }
  if (parsed.protocol === "rediss:" && parsed.hostname && parsed.password) return value;
  const localHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol === "redis:" && localHost && process.env.NODE_ENV !== "production") return value;
  throw new Error("REDIS_URL must be a credentialed rediss:// TCP/TLS URL (or local redis:// outside production), not an Upstash REST URL");
}

export function convexUrl(): string {
  return requiredUrl("CONVEX_URL", ["https:", "http:"]);
}

export function trueForgeBaseUrl(): string {
  return requiredUrl("TRUEFORGE_BASE_URL", ["https:", "http:"], process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790");
}

export function requireWorkerEnvironment(): { redisUrl: string; convexUrl: string; trueForgeBaseUrl: string } {
  return { redisUrl: redisUrl(), convexUrl: convexUrl(), trueForgeBaseUrl: trueForgeBaseUrl() };
}
