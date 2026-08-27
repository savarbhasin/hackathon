#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/redis-preflight.mjs [--mode local|managed] [--url redis[s]://...]

Reads REDIS_URL from the environment, or .env.local when unset.
  --mode managed   require rediss:// with a password (Upstash and similar)
  --mode local     allow plain redis:// on localhost

Exit codes: 0 pass, 1 check failure or Redis error, 2 configuration/usage error.`;

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const mode = argValue("--mode") ?? "managed";
if (!["local", "managed"].includes(mode)) {
  console.error(`unknown mode ${JSON.stringify(mode)}; expected "local" or "managed"`);
  process.exit(2);
}

let raw = argValue("--url") ?? process.env.REDIS_URL;
if (!raw) {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env.local");
  if (fs.existsSync(envPath)) {
    const line = fs
      .readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("REDIS_URL="));
    if (line) raw = line.slice(line.indexOf("=") + 1).trim();
  }
}
if (!raw) {
  console.error("REDIS_URL is not set (env or .env.local)");
  process.exit(2);
}
raw = raw.replace(/^["']|["']$/g, "");

let url;
try {
  url = new URL(raw);
} catch {
  console.error("REDIS_URL is not a parseable URL");
  process.exit(2);
}

function redact(text) {
  if (!url.password) return text;
  return text.split(decodeURIComponent(url.password)).join("<redacted>");
}

function describeUrl() {
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname}${port}`;
}

const failures = [];
function ok(check) {
  console.log(`PASS ${check}`);
}
function fail(check) {
  failures.push(check);
  console.log(`FAIL ${check}`);
}

if (mode === "managed") {
  url.protocol === "rediss:" ? ok("scheme is rediss://") : fail(`scheme is ${url.protocol}// but managed mode requires rediss://`);
  url.password ? ok("password present in URL") : fail("password missing from URL");
} else if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
  fail(`scheme is ${url.protocol}//`);
} else {
  ok(`scheme is ${url.protocol}//`);
}

// --- Minimal RESP client ---------------------------------------------------

function encodeCommand(parts) {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) out += `$${Buffer.byteLength(String(part))}\r\n${part}\r\n`;
  return out;
}

function parseReply(buf, offset = 0) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const head = buf.subarray(offset + 1, lineEnd).toString();
  const afterLine = lineEnd + 2;
  switch (type) {
    case "+":
    case ",":
      return { value: head, next: afterLine };
    case "-":
      return { value: Object.assign(new Error(head), { redisError: true }), next: afterLine };
    case ":":
      return { value: Number(head), next: afterLine };
    case "$": {
      const len = Number(head);
      if (len === -1) return { value: null, next: afterLine };
      const start = afterLine;
      const end = start + len + 2;
      if (buf.length < end) return null;
      return { value: buf.subarray(start, start + len).toString(), next: end };
    }
    case "*": {
      const n = Number(head);
      if (n === -1) return { value: null, next: afterLine };
      const items = [];
      let cursor = afterLine;
      for (let i = 0; i < n; i += 1) {
        const parsed = parseReply(buf, cursor);
        if (!parsed) return null;
        items.push(parsed.value);
        cursor = parsed.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`unsupported RESP type ${JSON.stringify(type)}`);
  }
}

class RespConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => this.drain(new Error(redact("connection error"))));
    socket.on("close", () => this.drain(new Error("connection closed before reply arrived")));
  }
  onData(chunk) {
    try {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const parsed = parseReply(this.buffer);
        if (!parsed) break;
        this.buffer = this.buffer.subarray(parsed.next);
        const handler = this.pending.shift();
        if (!handler) break;
        if (parsed.value instanceof Error) {
          handler.reject(Object.assign(new Error(parsed.value.message), { redisError: true }));
        } else {
          handler.resolve(parsed.value);
        }
      }
    } catch (err) {
      this.socket.destroy();
      this.drain(err);
    }
  }
  drain(err) {
    while (this.pending.length > 0) this.pending.shift().reject(err);
  }
  command(parts, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.resolve !== resolve);
        const err = new Error(`timed out after ${timeoutMs}ms waiting for ${parts[0]}`);
        err.redisError = true;
        reject(err);
      }, timeoutMs);
      const handler = { resolve, reject, timer };
      this.pending.push(handler);
      this.socket.write(encodeCommand(parts));
    });
  }
  destroy() {
    this.socket.destroy();
  }
}

function connect(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      socket.on("error", () => {});
      resolve(new RespConnection(socket));
    };
    const onError = (err) => {
      clearTimeout(timer);
      reject(new Error(redact(String(err.message))));
    };
    const secure = url.protocol === "rediss:";
    const socket = secure
      ? tls.connect({ host: url.hostname, port: Number(url.port) || 6379, servername: url.hostname, rejectUnauthorized: true }, onConnect)
      : net.connect({ host: url.hostname || "127.0.0.1", port: Number(url.port) || 6379 }, onConnect);
    socket.setNoDelay(true);
    socket.once("error", onError);
    const timer = setTimeout(() => {
      socket.destroy();
      onError(new Error(`connection to ${describeUrl()} timed out`));
    }, timeoutMs);
  });
}

async function readPolicy(conn) {
  try {
    const cfg = await conn.command(["CONFIG", "GET", "maxmemory-policy"]);
    const policy = Array.isArray(cfg) ? cfg[1] : cfg;
    // Some managed providers answer CONFIG but return no data; fall through to INFO.
    if (policy != null) return { policy, via: "CONFIG GET" };
  } catch {
    // Managed providers often deny CONFIG entirely; fall through to INFO.
  }
  // Managed providers often deny CONFIG or answer with no data; fall back to INFO memory.
  const info = await conn.command(["INFO", "memory"]);
  const match = /maxmemory_policy:([^\r\n]+)/.exec(info ?? "");
  if (!match) {
    throw Object.assign(new Error("could not determine maxmemory-policy; INFO memory lacked maxmemory_policy"), { redisError: true });
  }
  return { policy: match[1].trim(), via: "INFO memory" };
}

async function main() {
  const conn = await connect();

  try {
    if (url.password) {
      const authParts =
        url.username && url.username !== "default"
          ? ["AUTH", decodeURIComponent(url.username), decodeURIComponent(url.password)]
          : ["AUTH", decodeURIComponent(url.password)];
      await conn.command(authParts);
      ok("AUTH accepted");
    }

    const pong = await conn.command(["PING"]);
    pong === "PONG" ? ok("PING returned PONG") : fail(`PING returned ${JSON.stringify(pong)}`);

    const { policy, via } = await readPolicy(conn);
    console.log(`INFO maxmemory-policy read via ${via}`);
    policy === "noeviction" ? ok("maxmemory-policy is noeviction") : fail(`maxmemory-policy is ${JSON.stringify(policy)}, expected noeviction`);

    try {
      const info = await conn.command(["INFO", "server"]);
      const version = /redis_version:([^\r\n]+)/.exec(info ?? "")?.[1];
      if (version) console.log(`INFO redis_version ${version}`);
    } catch {
      /* informational only */
    }
  } catch (err) {
    fail(redact(err.message));
  } finally {
    conn.destroy();
  }

  console.log(failures.length === 0 ? `\nredis-preflight: all checks passed against ${describeUrl()} (mode=${mode})` : `\nredis-preflight: ${failures.length} check(s) failed (mode=${mode})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`redis-preflight: ${redact(String(err.message))}`);
  process.exit(2);
});
