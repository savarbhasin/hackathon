import { existsSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const localEnv = resolve(".env.local");
const hiddenEnv = resolve(".env.local.cloudflare-build");

if (existsSync(hiddenEnv)) {
  throw new Error(`${hiddenEnv} already exists; restore or remove it before building`);
}

function readPublicConvexUrl() {
  const inherited = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (inherited) return inherited;
  if (!existsSync(localEnv)) return undefined;

  const match = readFileSync(localEnv, "utf8").match(/^NEXT_PUBLIC_CONVEX_URL\s*=\s*(.+?)\s*$/m);
  return match?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
}

const publicConvexUrl = readPublicConvexUrl();
if (!publicConvexUrl) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL is required to build the Cloudflare web app");
}

const hadLocalEnv = existsSync(localEnv);
if (hadLocalEnv) renameSync(localEnv, hiddenEnv);

try {
  const cli = resolve("node_modules/@opennextjs/cloudflare/dist/cli/index.js");
  const childEnv = { ...process.env, NEXT_PUBLIC_CONVEX_URL: publicConvexUrl };
  for (const name of ["REDIS_URL", "CONVEX_URL", "CONVEX_SITE_URL", "TRUEFORGE_BASE_URL"]) {
    delete childEnv[name];
  }

  const result = spawnSync(process.execPath, [cli, "build"], {
    stdio: "inherit",
    env: childEnv,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (hadLocalEnv) renameSync(hiddenEnv, localEnv);
}
