"use client";

import { useRef, useState } from "react";

interface ChatEvent {
  kind: "delta" | "tool" | "status" | "done";
  text?: string;
  name?: string;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
  status?: string;
  pending?: boolean;
}

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollDown = () =>
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [
      ...m,
      { role: "user", content: text },
      { role: "assistant", content: "", tools: [], pending: true },
    ]);
    scrollDown();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.body) throw new Error("no stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          handleEvent(JSON.parse(payload) as ChatEvent);
        }
      }
    } catch (err) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          pending: false,
          content: `Connection error: ${String(err).slice(0, 200)}`,
        };
        return copy;
      });
    } finally {
      setBusy(false);
      scrollDown();
    }
  }

  function handleEvent(ev: ChatEvent) {
    setMessages((m) => {
      const copy = [...m];
      const last = { ...copy[copy.length - 1] };
      switch (ev.kind) {
        case "delta":
          last.content += ev.text ?? "";
          break;
        case "tool":
          last.tools = [...(last.tools ?? []), ev.name ?? "?"];
          break;
        case "status":
          last.status = ev.text ?? undefined;
          break;
        case "done":
          if (!last.content && ev.text) last.content = ev.text;
          last.pending = false;
          break;
      }
      copy[copy.length - 1] = last;
      return copy;
    });
    scrollDown();
  }

  return (
    <main className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold tracking-tight">Mission Control</span>
          <span className="rounded-full border border-emerald-700 bg-emerald-950 px-2 py-0.5 text-[10px] uppercase tracking-widest text-emerald-400">
            orchestrator online
          </span>
        </div>
        <a
          href="/board"
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition hover:border-neutral-500 hover:text-white"
        >
          Board →
        </a>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="mx-auto mt-24 max-w-lg text-center">
            <h1 className="mb-3 text-2xl font-semibold">Give your fleet a mission.</h1>
            <p className="text-sm leading-relaxed text-neutral-400">
              The orchestrator decomposes work into tasks, dispatches specialist agents,
              and reports back. Try:
            </p>
            <div className="mt-4 space-y-2 text-left text-sm">
              {[
                "Research the top 3 vector databases of 2026 and file a Linear issue summarizing them.",
                "What's on the board right now?",
                "Every weekday at 9am, check the board and summarize stuck tasks.",
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="block w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-2.5 text-left text-neutral-300 transition hover:border-neutral-600 hover:text-white"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mx-auto max-w-2xl space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={msg.role === "user" ? "flex justify-end" : ""}>
              {msg.role === "user" ? (
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-sky-900/60 px-4 py-2.5 text-sm">
                  {msg.content}
                </div>
              ) : (
                <div className="rounded-2xl rounded-bl-sm border border-neutral-800 bg-neutral-900/70 px-4 py-3 text-sm">
                  {(msg.tools?.length ?? 0) > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {msg.tools!.map((t, j) => (
                        <span
                          key={j}
                          className="rounded border border-violet-800 bg-violet-950/60 px-1.5 py-0.5 font-mono text-[10px] text-violet-300"
                        >
                          ⚙ {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                  {msg.pending && (
                    <span className="mt-1 inline-block animate-pulse text-xs text-neutral-500">
                      working…
                    </span>
                  )}
                  {msg.status && !msg.pending && (
                    <div className="mt-2 font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                      {msg.status}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <footer className="border-t border-neutral-800 p-4">
        <div className="mx-auto flex max-w-2xl gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder={busy ? "Orchestrator is working…" : "Assign a mission…"}
            disabled={busy}
            className="flex-1 rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-30"
          >
            Send
          </button>
        </div>
      </footer>
    </main>
  );
}
