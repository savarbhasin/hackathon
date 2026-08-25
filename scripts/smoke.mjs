import { TrueForge } from "@truefoundry/trueforge-sdk";

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
  timeoutInSeconds: 600,
});

const { data: session } = await client.sessions.create({
  agent: {
    spec: {
      model: { name: "openai/gpt-5-6-luna" },
      instructions: "You are a concise assistant. Answer in at most two sentences.",
    },
  },
});
console.log("session:", session.id);

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: "user.message", content: "In two sentences, what is TrueForge?" }],
});

for await (const { data: event } of stream.withMetadata()) {
  if (event.type === "model.message.delta") process.stdout.write(event.content ?? "");
  if (event.type === "tool.approval_required")
    console.log("\n[approval required]", JSON.stringify(event));
  if (event.type === "turn.done") console.log("\n\nstatus:", event.state.status);
}
