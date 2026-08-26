import { createAndEnqueueDurableRun } from "../src/lib/queue/producer";
import type { AgentRunKind } from "../src/lib/queue/types";

function value(name: string): string {
  const index = process.argv.indexOf(name);
  const result = index >= 0 ? process.argv[index + 1] : undefined;
  if (!result || result.startsWith("--")) throw new Error(`${name} is required`);
  return result;
}

async function main(): Promise<void> {
  const externalId = value("--external-id");
  const kind = value("--kind") as AgentRunKind;
  const agentName = value("--agent");
  const message = value("--message");
  if (!["orchestrator", "specialist", "schedule"].includes(kind)) throw new Error("--kind must be orchestrator, specialist, or schedule");

  const result = await createAndEnqueueDurableRun({
    externalId,
    kind,
    input: { agentName, items: [{ type: "user.message", content: message }] },
  });
  // Deliberately print IDs/status only; prompts and connection settings are never logged.
  console.log(JSON.stringify({ enabled: result.enabled, runId: result.run?._id ?? null, queue: result.queue }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : "enqueue failed" }));
  process.exitCode = 1;
});
