import { TrueForge } from "@truefoundry/trueforge-sdk";

const globalForTf = globalThis as unknown as { tfClient?: TrueForge };

export function tf(): TrueForge {
  if (!globalForTf.tfClient) {
    globalForTf.tfClient = new TrueForge({
      baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
      timeoutInSeconds: 900,
    });
  }
  return globalForTf.tfClient;
}
