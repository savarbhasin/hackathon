import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./mcp-core";

type Env = {
  CONVEX_URL: string;
  REDIS_URL: string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    process.env.CONVEX_URL = env.CONVEX_URL;
    process.env.REDIS_URL = env.REDIS_URL;

    const { pathname } = new URL(request.url);
    if (pathname === "/health") return json({ ok: true });
    if (pathname !== "/mcp") return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "stateless server: POST only" }, 405);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      const server = buildServer();
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      console.error("[mcp] error", error);
      await transport.close().catch(() => undefined);
      return json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, 500);
    }
  },
};

export default worker;
