export function workerLog(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  // Do not pass connection strings, prompts, tool arguments, or provider output here.
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "agent-runs-worker", event, ...fields }));
}

export function safeError(error: unknown): { name: string; code: string | null; statusCode: number | null } {
  const candidate = error as { name?: unknown; code?: unknown; statusCode?: unknown };
  return {
    name: typeof candidate?.name === "string" ? candidate.name : "Error",
    code: typeof candidate?.code === "string" ? candidate.code : null,
    statusCode: typeof candidate?.statusCode === "number" ? candidate.statusCode : null,
  };
}
