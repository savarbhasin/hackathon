"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Schedule {
  id: string;
  name: string;
  cronExpr: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/schedules", { cache: "no-store" });
    if (response.ok) setSchedules((await response.json()) as Schedule[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/schedules", { cache: "no-store" })
      .then(async (response) => response.ok ? (await response.json()) as Schedule[] : [])
      .then((items) => {
        if (!cancelled) {
          setSchedules(items);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function cancel(id: string) {
    setBusyId(id);
    try {
      const response = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
      if (response.ok) await load();
    } finally {
      setBusyId(null);
    }
  }

  const active = schedules.filter((schedule) => schedule.enabled);
  const inactive = schedules.filter((schedule) => !schedule.enabled);

  return (
    <main className="console-grid flex h-full flex-col overflow-y-auto bg-deck">
      <header className="flex h-16 shrink-0 items-center border-b border-line bg-deck px-5 sm:px-6">
        <div>
          <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">Automation</p>
          <h1 className="mt-0.5 text-[15px] font-semibold tracking-[-0.02em] text-ink">Schedules</h1>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">{active.length} active</span>
          <Link href="/" className="rounded-md border border-line-strong bg-panel-hi px-3 py-2 font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-ink transition-colors hover:border-ink-faint">
            New schedule
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
        {loading ? (
          <p className="font-mono text-xs text-ink-faint">Loading schedules...</p>
        ) : schedules.length === 0 ? (
          <div className="mx-auto mt-[13vh] max-w-xl border-l border-line-strong pl-6 text-left">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-state-working">No scheduled work</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-ink">Put routine work on a clock.</h2>
            <p className="mt-4 max-w-md text-sm leading-7 text-ink-soft">
              Ask the orchestrator to check the board, run research, or prepare a brief on a recurring schedule.
            </p>
            <Link href="/" className="mt-6 inline-flex rounded-md bg-signal px-4 py-2.5 font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-deck">Open command channel</Link>
          </div>
        ) : (
          <div className="space-y-8">
            <ScheduleGroup title="Active" schedules={active} busyId={busyId} onCancel={cancel} />
            {inactive.length > 0 && <ScheduleGroup title="Cancelled" schedules={inactive} busyId={busyId} onCancel={cancel} />}
          </div>
        )}
      </div>
    </main>
  );
}

function ScheduleGroup({
  title,
  schedules,
  busyId,
  onCancel,
}: {
  title: string;
  schedules: Schedule[];
  busyId: string | null;
  onCancel: (id: string) => Promise<void>;
}) {
  if (schedules.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 font-mono text-[8px] font-medium uppercase tracking-[0.2em] text-ink-faint">{title} / {schedules.length}</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        {schedules.map((schedule) => (
          <article key={schedule.id} className={`rounded-md border border-line bg-panel p-4 transition-colors hover:border-line-strong ${schedule.enabled ? "" : "opacity-50"}`}>
            <div className="flex items-start gap-3">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${schedule.enabled ? "bg-state-working led-live" : "bg-state-backlog"}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-ink">{schedule.name}</h3>
                  <code className="rounded border border-line bg-deck px-1.5 py-0.5 font-mono text-[9px] text-ink-soft">{schedule.cronExpr}</code>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{schedule.prompt}</p>
                <p className="mt-3 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                  {schedule.lastRunAt ? `Last ran ${new Date(schedule.lastRunAt).toLocaleString()}` : "Not run yet"}
                </p>
              </div>
              {schedule.enabled && (
                <button
                  onClick={() => void onCancel(schedule.id)}
                  disabled={busyId === schedule.id}
                  className="shrink-0 rounded-md border border-line-strong px-2.5 py-1.5 font-mono text-[8px] font-medium uppercase tracking-[0.12em] text-ink-soft hover:border-ink-faint hover:text-ink disabled:opacity-40"
                >
                  Cancel
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
