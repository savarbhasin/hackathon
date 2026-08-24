import { getBoard } from "@/lib/engine";

export const runtime = "nodejs";
export const maxDuration = 3600;

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastHash = "";

      const push = async () => {
        try {
          const board = await getBoard();
          const json = JSON.stringify(board);
          if (json !== lastHash) {
            lastHash = json;
            controller.enqueue(encoder.encode(`data: ${json}\n\n`));
          }
        } catch {
          /* transient db error — keep stream alive */
        }
      };

      void push();
      timer = setInterval(() => void push(), 1000);

      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
