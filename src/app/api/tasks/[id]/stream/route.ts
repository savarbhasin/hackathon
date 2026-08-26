import { getTaskDetail } from "@/lib/task-detail";

export const runtime = "nodejs";
export const maxDuration = 3600;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = "";
      let inFlight = false;
      const push = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const task = await getTaskDetail(id);
          if (!task) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "not_found" })}\n\n`));
            controller.close();
            return;
          }
          const json = JSON.stringify(task);
          if (json !== last) {
            last = json;
            controller.enqueue(encoder.encode(`data: ${json}\n\n`));
          }
        } catch { /* keep the subscription alive across transient sqlite locks */ }
        finally { inFlight = false; }
      };
      void push();
      timer = setInterval(() => void push(), 500);
      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() { if (timer) clearInterval(timer); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
