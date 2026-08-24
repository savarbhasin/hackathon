"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

interface Schedule { id: string; name: string; cronExpr: string; prompt: string; enabled: boolean; lastRunAt: string | null; createdAt: string; nextRuns: string[]; calendarRuns: string[] }

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<{ id: string; action: "cancel" | "run" } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [view, setView] = useState<"jobs" | "calendar">("jobs");
  const load = useCallback(async (calendarMonth?: Date) => {
    const response = await fetch(scheduleUrl(calendarMonth), { cache: "no-store" });
    if (response.ok) setSchedules((await response.json()) as Schedule[]);
    setLoading(false);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/schedules", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as Schedule[] : [])
      .then((items) => { if (!cancelled) { setSchedules(items); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (view !== "calendar") return;
    let cancelled = false;
    void fetch(scheduleUrl(month), { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as Schedule[] : [])
      .then((items) => { if (!cancelled) setSchedules(items); });
    return () => { cancelled = true; };
  }, [month, view]);
  async function cancel(id: string) {
    setBusy({ id, action: "cancel" });
    try { if ((await fetch(`/api/schedules/${id}`, { method: "DELETE" })).ok) await load(view === "calendar" ? month : undefined); }
    finally { setBusy(null); }
  }
  async function runNow(id: string) {
    setBusy({ id, action: "run" });
    setActionError(null);
    try {
      const response = await fetch(`/api/schedules/${id}`, { method: "POST" });
      if (response.ok) {
        const updated = await response.json() as Partial<Schedule>;
        setSchedules((current) => current.map((schedule) => schedule.id === id ? { ...schedule, ...updated } : schedule));
        setSelectedSchedule((current) => current?.id === id ? { ...current, ...updated } : current);
        await load(view === "calendar" ? month : undefined);
      } else {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setActionError(body?.error === "runner_unavailable" ? "The Mission Control runner is offline. Start the MCP server, then try again." : "Could not start this scheduled job.");
      }
    } finally { setBusy(null); }
  }
  async function saveSchedule(id: string, input: Pick<Schedule, "name" | "prompt">): Promise<boolean> {
    const response = await fetch(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) return false;
    const updated = await response.json() as Schedule;
    setSchedules((current) => current.map((schedule) => schedule.id === id ? { ...schedule, ...updated } : schedule));
    setSelectedSchedule((current) => current?.id === id ? { ...current, ...updated } : current);
    return true;
  }

  const active = schedules.filter((schedule) => schedule.enabled);
  const inactive = schedules.filter((schedule) => !schedule.enabled);
  const calendarRuns = useMemo(() => active.flatMap((schedule) => schedule.calendarRuns.map((run) => ({ scheduleId: schedule.id, name: schedule.name, run: new Date(run) }))), [active]);

  return <main className="console-grid flex h-full flex-col overflow-y-auto bg-deck">
    <header className="flex h-16 shrink-0 items-center border-b border-line bg-deck px-5 sm:px-6">
      <div><p className="font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">Automation</p><h1 className="mt-0.5 text-[15px] font-semibold tracking-[-0.02em] text-ink">Schedules</h1></div>
      <div className="ml-auto flex items-center gap-4"><span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">{active.length} active</span><Link href="/" className="rounded-md border border-line-strong bg-panel-hi px-3 py-2 font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-ink transition-colors hover:border-ink-faint">New schedule</Link></div>
    </header>
    <div className="mx-auto w-full max-w-6xl p-5 sm:p-8">
      {loading ? <p className="font-mono text-xs text-ink-faint">Loading schedules...</p> : schedules.length === 0 ? <EmptyState /> : <div className="space-y-6">
        <div role="tablist" aria-label="Schedule view" className="inline-flex rounded-md border border-line bg-panel/70 p-1">
          <button type="button" role="tab" aria-selected={view === "jobs"} onClick={() => setView("jobs")} className={`rounded px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] transition-colors ${view === "jobs" ? "bg-signal text-deck" : "text-ink-faint hover:text-ink"}`}>Jobs</button>
          <button type="button" role="tab" aria-selected={view === "calendar"} onClick={() => setView("calendar")} className={`rounded px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] transition-colors ${view === "calendar" ? "bg-signal text-deck" : "text-ink-faint hover:text-ink"}`}>Calendar</button>
        </div>
        {actionError && <p role="alert" className="text-xs text-state-approval">{actionError}</p>}
        {view === "jobs" ? <>
          <ScheduleGroup title="Active schedules" schedules={active} busy={busy} onCancel={cancel} onRunNow={runNow} onSelect={setSelectedSchedule} />
          {inactive.length > 0 && <ScheduleGroup title="Cancelled" schedules={inactive} busy={busy} onCancel={cancel} onRunNow={runNow} onSelect={setSelectedSchedule} />}
        </> : <section role="tabpanel" className="rounded-lg border border-line bg-panel/60 p-4 sm:p-5">
          <div className="mb-5 flex items-center justify-between gap-4"><div><p className="font-mono text-[8px] uppercase tracking-[0.18em] text-ink-faint">Run calendar</p><h2 className="mt-1 text-sm font-semibold text-ink">The next scheduled runs</h2></div><div className="flex items-center gap-1"><button type="button" onClick={() => setMonth(addMonths(month, -1))} className="flex h-8 w-8 items-center justify-center rounded border border-line text-ink-soft hover:border-line-strong hover:text-ink" aria-label="Previous month">‹</button><span className="w-32 text-center text-xs font-semibold text-ink">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span><button type="button" onClick={() => setMonth(addMonths(month, 1))} className="flex h-8 w-8 items-center justify-center rounded border border-line text-ink-soft hover:border-line-strong hover:text-ink" aria-label="Next month">›</button></div></div>
          <ScheduleCalendar month={month} runs={calendarRuns} />
          <p className="mt-4 text-[10px] leading-5 text-ink-faint">The calendar shows every run scheduled in this month. Times use this browser&apos;s timezone.</p>
        </section>}
      </div>}
    </div>
    <ScheduleDialog key={selectedSchedule?.id ?? "none"} schedule={selectedSchedule} running={busy?.id === selectedSchedule?.id && busy?.action === "run"} onClose={() => setSelectedSchedule(null)} onRunNow={runNow} onSave={saveSchedule} />
  </main>;
}

function EmptyState() { return <div className="mx-auto mt-[13vh] max-w-xl border-l border-line-strong pl-6 text-left"><p className="font-mono text-[9px] uppercase tracking-[0.2em] text-state-working">No scheduled work</p><h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-ink">Put routine work on a clock.</h2><p className="mt-4 max-w-md text-sm leading-7 text-ink-soft">Ask the orchestrator to check the board, run research, or prepare a brief on a recurring schedule.</p><Link href="/" className="mt-6 inline-flex rounded-md bg-signal px-4 py-2.5 font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-deck">Open command channel</Link></div>; }

function ScheduleGroup({ title, schedules, busy, onCancel, onRunNow, onSelect }: { title: string; schedules: Schedule[]; busy: { id: string; action: "cancel" | "run" } | null; onCancel: (id: string) => Promise<void>; onRunNow: (id: string) => Promise<void>; onSelect: (schedule: Schedule) => void }) {
  if (schedules.length === 0) return null;
  return <section><div className="mb-3 flex items-center justify-between gap-4"><h2 className="font-mono text-[8px] font-medium uppercase tracking-[0.2em] text-ink-faint">{title} / {schedules.length}</h2>{title === "Active schedules" && <span className="text-[10px] text-ink-faint">Click a job to view or edit it.</span>}</div><div className="grid gap-3 lg:grid-cols-2">{schedules.map((schedule) => <article key={schedule.id} role="button" tabIndex={0} onClick={() => onSelect(schedule)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(schedule); } }} className={`cursor-pointer rounded-lg border border-line bg-panel p-4 outline-none focus-visible:border-signal ${schedule.enabled ? "transition-colors hover:border-line-strong" : "opacity-50"}`}><div className="flex items-start gap-3"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${schedule.enabled ? "bg-state-working led-live" : "bg-state-backlog"}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-ink">{schedule.name}</h3><code className="rounded border border-line bg-deck px-1.5 py-0.5 font-mono text-[9px] text-ink-soft">{schedule.cronExpr}</code></div><p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{schedule.prompt}</p>{schedule.enabled && schedule.nextRuns.length > 0 ? <div className="mt-4 grid gap-2 sm:grid-cols-2">{schedule.nextRuns.slice(0, 2).map((run, index) => <div key={run} className="rounded-md border border-line bg-deck/70 px-3 py-2"><p className="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">{index === 0 ? "Next run" : "Then"}</p><p className="mt-1 text-[11px] font-medium text-ink">{formatRun(run)}</p></div>)}</div> : schedule.enabled ? <p className="mt-4 text-[10px] text-state-blocked">This cron expression has no upcoming run.</p> : null}<p className="mt-4 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">{schedule.lastRunAt ? `Last ran ${formatRun(schedule.lastRunAt)}` : "Not run yet"}</p></div>{schedule.enabled && <div className="flex shrink-0 items-center gap-2"><button type="button" onClick={(event) => { event.stopPropagation(); void onRunNow(schedule.id); }} disabled={busy?.id === schedule.id} className="rounded-md border border-signal/60 bg-signal/10 px-2.5 py-1.5 font-mono text-[8px] font-medium uppercase tracking-[0.12em] text-signal transition-colors hover:bg-signal/20 disabled:opacity-40">{busy?.id === schedule.id && busy.action === "run" ? "Running..." : "Run now"}</button><button type="button" onClick={(event) => { event.stopPropagation(); void onCancel(schedule.id); }} disabled={busy?.id === schedule.id} className="rounded-md border border-line-strong px-2.5 py-1.5 font-mono text-[8px] font-medium uppercase tracking-[0.12em] text-ink-soft hover:border-ink-faint hover:text-ink disabled:opacity-40">{busy?.id === schedule.id && busy.action === "cancel" ? "Cancelling" : "Cancel"}</button></div>}</div></article>)}</div></section>;
}

function ScheduleDialog({ schedule, running, onClose, onRunNow, onSave }: { schedule: Schedule | null; running: boolean; onClose: () => void; onRunNow: (id: string) => Promise<void>; onSave: (id: string, input: Pick<Schedule, "name" | "prompt">) => Promise<boolean> }) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!schedule) return null;
  const currentSchedule = schedule;
  async function save() {
    if (!name.trim() || !prompt.trim() || saving) return;
    setSaving(true);
    setError(null);
    const saved = await onSave(currentSchedule.id, { name: name.trim(), prompt: prompt.trim() });
    setSaving(false);
    if (saved) onClose();
    else setError("Could not save this job.");
  }

  return <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
    <section role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" className="max-h-[min(720px,calc(100vh-32px))] w-full max-w-2xl overflow-y-auto rounded-xl border border-line-strong bg-panel p-5 shadow-2xl sm:p-6">
      <div className="sticky top-0 z-10 -mx-5 -mt-5 flex items-start justify-between gap-4 border-b border-line bg-panel px-5 pb-4 pt-5 sm:-mx-6 sm:-mt-6 sm:px-6"><div><p className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-signal">Scheduled job</p><h2 id="schedule-dialog-title" className="mt-2 text-xl font-semibold tracking-[-0.025em] text-ink">{schedule.name}</h2></div><button type="button" onClick={onClose} disabled={saving} className="flex h-8 w-8 items-center justify-center rounded border border-line text-ink-faint hover:border-line-strong hover:text-ink" aria-label="Close job details">×</button></div>
      <div className="grid gap-3 pt-5 sm:grid-cols-3"><Detail label="Status" value={schedule.enabled ? "Active" : "Cancelled"} /><Detail label="Created" value={new Date(schedule.createdAt).toLocaleDateString()} /><Detail label="Last run" value={schedule.lastRunAt ? formatRun(schedule.lastRunAt) : "Not run yet"} /></div>
      <div className="mt-5 rounded-md border border-line bg-deck/65 px-3 py-2.5"><p className="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">Timing</p><p className="mt-1 font-mono text-xs text-ink">{schedule.cronExpr}</p><p className="mt-1 text-[10px] leading-5 text-ink-faint">Timing is fixed when the job is created. Cancel it and ask the Squad Lead for a new schedule to change the cadence.</p></div>
      <label className="mt-5 block"><span className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Job name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="mt-2 w-full rounded-md border border-line-strong bg-deck px-3 py-2.5 text-sm text-ink outline-none focus:border-signal" /></label>
      <label className="mt-5 block"><span className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Instruction</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} maxLength={4000} className="mt-2 w-full resize-y rounded-md border border-line-strong bg-deck px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-signal" /></label>
      {schedule.nextRuns.length > 0 && <div className="mt-5"><p className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Coming up</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{schedule.nextRuns.map((run) => <div key={run} className="rounded-md border border-line bg-deck/65 px-3 py-2"><p className="text-xs font-medium text-ink">{formatRun(run)}</p></div>)}</div></div>}
      {error && <p className="mt-4 text-xs text-state-approval">{error}</p>}
      <div className="mt-6 flex items-center justify-between gap-3"><button type="button" onClick={() => void onRunNow(currentSchedule.id)} disabled={saving || running || !schedule.enabled} className="rounded-md border border-signal/60 bg-signal/10 px-3 py-2 text-xs font-semibold text-signal hover:bg-signal/20 disabled:opacity-40">{running ? "Running..." : "Run now"}</button><div className="flex gap-2"><button type="button" onClick={onClose} disabled={saving} className="rounded-md border border-line-strong px-3 py-2 text-xs font-semibold text-ink-soft hover:border-ink-faint hover:text-ink disabled:opacity-40">Cancel</button><button type="button" onClick={() => void save()} disabled={saving || !name.trim() || !prompt.trim()} className="rounded-md bg-signal px-3 py-2 text-xs font-semibold text-deck hover:brightness-110 disabled:opacity-40">{saving ? "Saving..." : "Save changes"}</button></div></div>
    </section>
  </div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="rounded-md border border-line bg-deck/45 px-3 py-2.5"><p className="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">{label}</p><p className="mt-1 text-[11px] text-ink">{value}</p></div>; }

function ScheduleCalendar({ month, runs }: { month: Date; runs: Array<{ scheduleId: string; name: string; run: Date }> }) {
  const first = startOfMonth(month); const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => { const day = new Date(gridStart); day.setDate(gridStart.getDate() + index); return day; });
  return <div className="overflow-hidden rounded-md border border-line"><div className="grid grid-cols-7 border-b border-line bg-deck/70">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} className="px-2 py-2 text-center font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">{day}</span>)}</div><div className="grid grid-cols-7">{days.map((day) => { const dayRuns = runs.filter((item) => sameDay(item.run, day)); const currentMonth = day.getMonth() === month.getMonth(); return <div key={day.toISOString()} className={`min-h-20 border-b border-r border-line p-2 last:border-r-0 sm:min-h-24 ${currentMonth ? "bg-panel/30" : "bg-deck/45"}`}><span className={`text-[10px] ${isToday(day) ? "rounded-full bg-signal px-1.5 py-0.5 font-semibold text-deck" : currentMonth ? "text-ink-soft" : "text-ink-faint"}`}>{day.getDate()}</span><div className="mt-1 space-y-1">{dayRuns.slice(0, 2).map((item) => <p key={`${item.scheduleId}-${item.run.toISOString()}`} title={`${item.name} at ${item.run.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`} className="truncate rounded bg-signal/10 px-1 py-0.5 text-[8px] text-signal">{item.run.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} {item.name}</p>)}{dayRuns.length > 2 && <p className="px-1 text-[8px] text-ink-faint">+{dayRuns.length - 2} more</p>}</div></div>; })}</div></div>;
}

function formatRun(value: string): string { return new Date(value).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function startOfMonth(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), 1); }
function addMonths(date: Date, amount: number): Date { return new Date(date.getFullYear(), date.getMonth() + amount, 1); }
function sameDay(left: Date, right: Date): boolean { return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate(); }
function isToday(date: Date): boolean { return sameDay(date, new Date()); }
function scheduleUrl(month?: Date): string { return month ? `/api/schedules?month=${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}` : "/api/schedules"; }
