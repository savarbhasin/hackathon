"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";

function RealtimePanel() {
  const task = useQuery(api.tasks.get);
  const updateStatus = useMutation(api.tasks.updateStatus);
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    if (!task?.updatedAt) return;
    // Both values are epoch milliseconds; this is an approximate local
    // write-to-observation measurement for this browser.
    const timer = window.setTimeout(() => {
      setLatency(Math.max(0, Date.now() - task.updatedAt));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [task?.updatedAt]);

  async function setStatus(status: string) {
    await updateStatus({ status });
  }

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-6 py-16">
      <header className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">Phase 0 spike</p>
        <h1 className="font-display text-4xl font-bold">Convex realtime</h1>
        <p className="text-ink-soft">Open this page in two browsers. A status write should appear in both clients without EventSource or polling.</p>
      </header>
      <section className="rounded-xl border border-line bg-panel p-6" aria-live="polite">
        <div className="flex items-center justify-between gap-4">
          <span className="text-ink-soft">Shared task status</span>
          <strong className="font-mono text-signal">{task?.status ?? "Connecting…"}</strong>
        </div>
        <p className="mt-3 font-mono text-xs text-ink-faint">
          {task ? `Last Convex write: ${new Date(task.updatedAt).toISOString()}` : "Waiting for subscription"}
          {latency !== null ? ` · observed latency: ${latency} ms` : ""}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {["queued", "working", "settled"].map((status) => (
            <button className="rounded-md border border-line-strong px-4 py-2 text-sm transition hover:border-signal hover:text-signal" key={status} onClick={() => void setStatus(status)} type="button">Set {status}</button>
          ))}
        </div>
      </section>
      <p className="font-mono text-xs text-ink-faint">Deployment: {process.env.NEXT_PUBLIC_CONVEX_URL}</p>
    </main>
  );
}

export default function ConvexRealtimeSpikePage() {
  return <RealtimePanel />;
}
