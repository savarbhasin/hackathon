"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Cron } from "croner";

const anyApi = api as unknown as Record<string, any>;

interface Schedule {
  id: string;
  _id?: string;
  name: string;
  cronExpr: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  configRevision: number;
  syncState: string;
  syncError: string | null;
  lastRunStatus: string | null;
  lastRunAt: number | null;
  lastFailureAt: number | null;
  lastFailureMessage: string | null;
  createdAt: number;
  nextRuns: string[];
  calendarRuns: string[];
}

export default function SchedulesPage() {
  const rawSchedules = useQuery(anyApi.schedules.list, { limit: 200, includeDisabled: true });
  const schedules = useMemo(() => normalizeSchedules(rawSchedules), [rawSchedules]);
  const loading = rawSchedules === undefined;
  const [busy, setBusy] = useState<{ id: string; action: "cancel" | "run" | "delete" } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [view, setView] = useState<"jobs" | "calendar">("jobs");
  const requestKeys = useRef(new Map<string, string>());

  function requestKey(action: string, id: string): string {
    const key = `${action}:${id}`;
    const existing = requestKeys.current.get(key);
    if (existing) return existing;
    const value = crypto.randomUUID();
    requestKeys.current.set(key, value);
    return value;
  }

  async function changeEnabled(schedule: Schedule, enabled: boolean) {
    setBusy({ id: schedule.id, action: "cancel" });
    setActionError(null);
    try {
      const response = await fetch(`/api/schedules/${schedule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey(enabled ? "enable" : "disable", schedule.id) },
        body: JSON.stringify({ enabled, configRevision: schedule.configRevision }),
      });
      if (!response.ok) setActionError(await actionMessage(response));
    } finally { requestKeys.current.delete(`${enabled ? "enable" : "disable"}:${schedule.id}`); setBusy(null); }
  }

  async function deleteSchedule(id: string) {
    setBusy({ id, action: "delete" });
    setActionError(null);
    try {
      const response = await fetch(`/api/schedules/${id}`, { method: "DELETE", headers: { "Idempotency-Key": requestKey("delete", id) } });
      if (!response.ok) setActionError(await actionMessage(response));
      else setSelectedSchedule(null);
    } finally { requestKeys.current.delete(`delete:${id}`); setBusy(null); }
  }

  async function runNow(id: string) {
    setBusy({ id, action: "run" });
    setActionError(null);
    try {
      const response = await fetch(`/api/schedules/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey("run", id) },
        body: JSON.stringify({ requestId: requestKey("run", id) }),
      });
      if (!response.ok) setActionError(await actionMessage(response));
      else setActionError((await response.json()).status === "queued" ? "Run admitted and queued. Execution is still in progress." : null);
    } finally { requestKeys.current.delete(`run:${id}`); setBusy(null); }
  }

  async function saveSchedule(id: string, input: Pick<Schedule, "name" | "cronExpr" | "timezone" | "prompt">, configRevision: number): Promise<boolean> {
    const response = await fetch(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey("save", id) },
      body: JSON.stringify({ ...input, configRevision }),
    });
    requestKeys.current.delete(`save:${id}`);
    if (!response.ok) { setActionError(await actionMessage(response)); return false; }
    return true;
  }

  const active = schedules.filter((schedule) => schedule.enabled);
  const inactive = schedules.filter((schedule) => !schedule.enabled);
  const selected = selectedSchedule ? schedules.find((schedule) => schedule.id === selectedSchedule.id) ?? selectedSchedule : null;
  const calendarRuns = useMemo(() => active.flatMap((schedule) => runsInMonth(schedule.cronExpr, month).map((run) => ({ scheduleId: schedule.id, name: schedule.name, run: new Date(run) }))), [active, month]);

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
          <ScheduleGroup title="Active schedules" schedules={active} busy={busy} onToggle={changeEnabled} onDelete={deleteSchedule} onRunNow={runNow} onSelect={setSelectedSchedule} />
          {inactive.length > 0 && <ScheduleGroup title="Disabled" schedules={inactive} busy={busy} onToggle={changeEnabled} onDelete={deleteSchedule} onRunNow={runNow} onSelect={setSelectedSchedule} />}
        </> : <section role="tabpanel" className="rounded-lg border border-line bg-panel/60 p-4 sm:p-5">
          <div className="mb-5 flex items-center justify-between gap-4"><div><p className="font-mono text-[8px] uppercase tracking-[0.18em] text-ink-faint">Run calendar</p><h2 className="mt-1 text-sm font-semibold text-ink">The next scheduled runs</h2></div><div className="flex items-center gap-1"><button type="button" onClick={() => setMonth(addMonths(month, -1))} className="flex h-8 w-8 items-center justify-center rounded border border-line text-ink-soft hover:border-line-strong hover:text-ink" aria-label="Previous month">‹</button><span className="w-32 text-center text-xs font-semibold text-ink">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span><button type="button" onClick={() => setMonth(addMonths(month, 1))} className="flex h-8 w-8 items-center justify-center rounded border border-line text-ink-soft hover:border-line-strong hover:text-ink" aria-label="Next month">›</button></div></div>
          <ScheduleCalendar month={month} runs={calendarRuns} />
          <p className="mt-4 text-[10px] leading-5 text-ink-faint">The calendar shows every run scheduled in this month. Times use this browser&apos;s timezone.</p>
        </section>}
      </div>}
    </div>
    <ScheduleDialog key={selected?.id ?? "none"} schedule={selected} running={busy?.id === selected?.id && busy?.action === "run"} onClose={() => setSelectedSchedule(null)} onRunNow={runNow} onToggle={changeEnabled} onDelete={deleteSchedule} onSave={saveSchedule} />
  </main>;
}

function EmptyState() { return <div className="mx-auto mt-[13vh] max-w-xl border-l border-line-strong pl-6 text-left"><p className="font-mono text-[9px] uppercase tracking-[0.2em] text-state-working">No scheduled work</p><h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-ink">Put routine work on a clock.</h2><p className="mt-4 max-w-md text-sm leading-7 text-ink-soft">Ask the orchestrator to check the board, run research, or prepare a brief on a recurring schedule.</p><Link href="/" className="mt-6 inline-flex rounded-md bg-signal px-4 py-2.5 font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-deck">Open command channel</Link></div>; }

function ScheduleGroup({ title, schedules, busy, onToggle, onDelete, onRunNow, onSelect }: { title: string; schedules: Schedule[]; busy: { id: string; action: "cancel" | "run" | "delete" } | null; onToggle: (schedule: Schedule, enabled: boolean) => Promise<void>; onDelete: (id: string) => Promise<void>; onRunNow: (id: string) => Promise<void>; onSelect: (schedule: Schedule) => void }) {
  if (schedules.length === 0) return null;
  return <section><div className="mb-3 flex items-center justify-between gap-4"><h2 className="font-mono text-[8px] font-medium uppercase tracking-[0.2em] text-ink-faint">{title} / {schedules.length}</h2>{title === "Active schedules" && <span className="text-[10px] text-ink-faint">Click a job to view or edit it.</span>}</div><div className="grid gap-3 lg:grid-cols-2">{schedules.map((schedule) => <article key={schedule.id} role="button" tabIndex={0} onClick={() => onSelect(schedule)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(schedule); } }} className={`cursor-pointer rounded-lg border border-line bg-panel p-4 outline-none focus-visible:border-signal ${schedule.enabled ? "transition-colors hover:border-line-strong" : "opacity-50"}`}><div className="flex items-start gap-3"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${schedule.enabled ? "bg-state-working led-live" : "bg-state-backlog"}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-ink">{schedule.name}</h3><code className="rounded border border-line bg-deck px-1.5 py-0.5 font-mono text-[9px] text-ink-soft">{schedule.cronExpr}</code><span className="font-mono text-[8px] uppercase text-ink-faint">{schedule.syncState}</span></div><p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{schedule.prompt}</p>{schedule.syncError && <p className="mt-2 text-[10px] text-state-approval">Sync error: {schedule.syncError}</p>}{schedule.enabled && schedule.nextRuns.length > 0 ? <div className="mt-4 grid gap-2 sm:grid-cols-2">{schedule.nextRuns.slice(0, 2).map((run, index) => <div key={run} className="rounded-md border border-line bg-deck/70 px-3 py-2"><p className="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">{index === 0 ? "Next run" : "Then"}</p><p className="mt-1 text-[11px] font-medium text-ink">{formatRun(run)}</p></div>)}</div> : schedule.enabled ? <p className="mt-4 text-[10px] text-state-blocked">This cron expression has no upcoming run.</p> : null}<p className="mt-4 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">{schedule.lastRunAt ? `Last ${schedule.lastRunStatus ?? "run"} ${formatRun(schedule.lastRunAt)}` : "Not run yet"}</p>{schedule.lastFailureAt && <p className="mt-1 text-[10px] text-state-approval">Last failure {formatRun(schedule.lastFailureAt)}{schedule.lastFailureMessage ? `: ${schedule.lastFailureMessage}` : ""}</p>}</div><div className="flex shrink-0 items-center gap-2">{schedule.enabled && <button type="button" onClick={(event) => { event.stopPropagation(); void onRunNow(schedule.id); }} disabled={busy?.id === schedule.id} className="rounded-md border border-signal/60 bg-signal/10 px-2.5 py-1.5 font-mono text-[8px] font-medium uppercase tracking-[0.12em] text-signal transition-colors hover:bg-signal/20 disabled:opacity-40">{busy?.id === schedule.id && busy.action === "run" ? "Queueing..." : "Run now"}</button>}<button type="button" onClick={(event) => { event.stopPropagation(); void onToggle(schedule, !schedule.enabled); }} disabled={busy?.id === schedule.id} className="rounded-md border border-line-strong px-2.5 py-1.5 font-mono text-[8px] font-medium uppercase tracking-[0.12em] text-ink-soft hover:border-ink-faint hover:text-ink disabled:opacity-40">{busy?.id === schedule.id && busy.action === "cancel" ? "Saving" : schedule.enabled ? "Disable" : "Enable"}</button><button type="button" onClick={(event) => { event.stopPropagation(); void onDelete(schedule.id); }} disabled={busy?.id === schedule.id} className="rounded-md border border-line-strong px-2.5 py-1.5 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint hover:border-state-approval hover:text-state-approval disabled:opacity-40">Delete</button></div></div></article>)}</div></section>;
}

function ScheduleDialog({ schedule, running, onClose, onRunNow, onToggle, onDelete, onSave }: { schedule: Schedule | null; running: boolean; onClose: () => void; onRunNow: (id: string) => Promise<void>; onToggle: (schedule: Schedule, enabled: boolean) => Promise<void>; onDelete: (id: string) => Promise<void>; onSave: (id: string, input: Pick<Schedule, "name" | "cronExpr" | "timezone" | "prompt">, configRevision: number) => Promise<boolean> }) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [cronExpr, setCronExpr] = useState(schedule?.cronExpr ?? "");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "UTC");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!schedule) return null;
  const currentSchedule = schedule;
  async function save() {
    if (!name.trim() || !cronExpr.trim() || !prompt.trim() || saving) return;
    setSaving(true); setError(null);
    const saved = await onSave(currentSchedule.id, { name: name.trim(), cronExpr: cronExpr.trim(), timezone: timezone.trim() || "UTC", prompt: prompt.trim() }, currentSchedule.configRevision);
    setSaving(false);
    if (saved) onClose(); else setError("Could not save this job.");
  }
  return <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
    <section role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" className="max-h-[min(720px,calc(100vh-32px))] w-full max-w-2xl overflow-y-auto rounded-xl border border-line-strong bg-panel p-5 shadow-2xl sm:p-6">
      <div className="sticky top-0 z-10 -mx-5 -mt-5 flex items-start justify-between gap-4 border-b border-line bg-panel px-5 pb-4 pt-5 sm:-mx-6 sm:-mt-6 sm:px-6"><div><p className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-signal">Scheduled job</p><h2 id="schedule-dialog-title" className="mt-2 text-xl font-semibold tracking-[-0.025em] text-ink">{schedule.name}</h2></div><button type="button" onClick={onClose} disabled={saving} className="flex h-8 w-8 items-center justify-center rounded border border-line text-ink-faint hover:border-line-strong hover:text-ink" aria-label="Close job details">×</button></div>
      <div className="grid gap-3 pt-5 sm:grid-cols-4"><Detail label="Status" value={schedule.enabled ? "Active" : "Disabled"} /><Detail label="Sync" value={schedule.syncState} /><Detail label="Created" value={new Date(schedule.createdAt).toLocaleDateString()} /><Detail label="Last run" value={schedule.lastRunAt ? formatRun(schedule.lastRunAt) : "Not run yet"} /></div>
      {schedule.syncError && <p className="mt-4 text-xs text-state-approval">Sync error: {schedule.syncError}</p>}
      {schedule.lastFailureAt && <p className="mt-2 text-xs text-state-approval">Last failure {formatRun(schedule.lastFailureAt)}{schedule.lastFailureMessage ? `: ${schedule.lastFailureMessage}` : ""}</p>}
      <label className="mt-5 block"><span className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Job name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="mt-2 w-full rounded-md border border-line-strong bg-deck px-3 py-2.5 text-sm text-ink outline-none focus:border-signal" /></label>
      <div className="mt-5 grid gap-3 sm:grid-cols-2"><label><span className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Cron expression</span><input value={cronExpr} onChange={(event) => setCronExpr(event.target.value)} maxLength={200} className="mt-2 w-full rounded-md border border-line-strong bg-deck px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-signal" /></label><label><span className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Timezone</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} maxLength={100} className="mt-2 w-full rounded-md border border-line-strong bg-deck px-3 py-2.5 text-sm text-ink outline-none focus:border-signal" /></label></div>
      <label className="mt-5 block"><span className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Instruction</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} maxLength={4000} className="mt-2 w-full resize-y rounded-md border border-line-strong bg-deck px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-signal" /></label>
      {schedule.nextRuns.length > 0 && <div className="mt-5"><p className="font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Coming up (browser projection)</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{schedule.nextRuns.map((run) => <div key={run} className="rounded-md border border-line bg-deck/65 px-3 py-2"><p className="text-xs font-medium text-ink">{formatRun(run)}</p></div>)}</div></div>}
      {error && <p className="mt-4 text-xs text-state-approval">{error}</p>}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2"><button type="button" onClick={() => void onRunNow(currentSchedule.id)} disabled={saving || running || !schedule.enabled} className="rounded-md border border-signal/60 bg-signal/10 px-3 py-2 text-xs font-semibold text-signal hover:bg-signal/20 disabled:opacity-40">{running ? "Queueing..." : "Run now"}</button><button type="button" onClick={() => void onToggle(currentSchedule, !currentSchedule.enabled)} disabled={saving} className="rounded-md border border-line-strong px-3 py-2 text-xs font-semibold text-ink-soft hover:border-ink-faint hover:text-ink">{schedule.enabled ? "Disable" : "Enable"}</button><button type="button" onClick={() => void onDelete(currentSchedule.id)} disabled={saving} className="rounded-md border border-line-strong px-3 py-2 text-xs font-semibold text-state-approval">Delete</button></div><div className="flex gap-2"><button type="button" onClick={onClose} disabled={saving} className="rounded-md border border-line-strong px-3 py-2 text-xs font-semibold text-ink-soft hover:border-ink-faint hover:text-ink disabled:opacity-40">Close</button><button type="button" onClick={() => void save()} disabled={saving || !name.trim() || !cronExpr.trim() || !prompt.trim()} className="rounded-md bg-signal px-3 py-2 text-xs font-semibold text-deck hover:brightness-110 disabled:opacity-40">{saving ? "Saving..." : "Save changes"}</button></div></div>
    </section>
  </div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="rounded-md border border-line bg-deck/45 px-3 py-2.5"><p className="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">{label}</p><p className="mt-1 text-[11px] text-ink">{value}</p></div>; }

function ScheduleCalendar({ month, runs }: { month: Date; runs: Array<{ scheduleId: string; name: string; run: Date }> }) {
  const first = startOfMonth(month); const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => { const day = new Date(gridStart); day.setDate(gridStart.getDate() + index); return day; });
  return <div className="overflow-hidden rounded-md border border-line"><div className="grid grid-cols-7 border-b border-line bg-deck/70">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} className="px-2 py-2 text-center font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">{day}</span>)}</div><div className="grid grid-cols-7">{days.map((day) => { const dayRuns = runs.filter((item) => sameDay(item.run, day)); const currentMonth = day.getMonth() === month.getMonth(); return <div key={day.toISOString()} className={`min-h-20 border-b border-r border-line p-2 last:border-r-0 sm:min-h-24 ${currentMonth ? "bg-panel/30" : "bg-deck/45"}`}><span className={`text-[10px] ${isToday(day) ? "rounded-full bg-signal px-1.5 py-0.5 font-semibold text-deck" : currentMonth ? "text-ink-soft" : "text-ink-faint"}`}>{day.getDate()}</span><div className="mt-1 space-y-1">{dayRuns.slice(0, 2).map((item) => <p key={`${item.scheduleId}-${item.run.toISOString()}`} title={`${item.name} at ${item.run.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`} className="truncate rounded bg-signal/10 px-1 py-0.5 text-[8px] text-signal">{item.run.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} {item.name}</p>)}{dayRuns.length > 2 && <p className="px-1 text-[8px] text-ink-faint">+{dayRuns.length - 2} more</p>}</div></div>; })}</div></div>;
}

function normalizeSchedules(raw: unknown): Schedule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const id = typeof row._id === "string" ? row._id : typeof row.id === "string" ? row.id : "";
    if (!id || typeof row.name !== "string" || typeof row.cronExpr !== "string" || typeof row.prompt !== "string") return [];
    const schedule: Schedule = {
      id, _id: typeof row._id === "string" ? row._id : undefined, name: row.name, cronExpr: row.cronExpr,
      timezone: typeof row.timezone === "string" ? row.timezone : "UTC", prompt: row.prompt,
      enabled: row.enabled !== false, configRevision: typeof row.configRevision === "number" ? row.configRevision : 1,
      syncState: typeof row.syncState === "string" ? row.syncState : "pending", syncError: typeof row.syncError === "string" ? row.syncError : null,
      lastRunStatus: typeof row.lastRunStatus === "string" ? row.lastRunStatus : null,
      lastRunAt: typeof row.lastRunAt === "number" ? row.lastRunAt : null, lastFailureAt: typeof row.lastFailureAt === "number" ? row.lastFailureAt : null,
      lastFailureMessage: typeof row.lastFailureMessage === "string" ? row.lastFailureMessage : null,
      createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(), nextRuns: [], calendarRuns: [],
    };
    if (schedule.enabled) {
      try { schedule.nextRuns = new Cron(schedule.cronExpr).nextRuns(4).map((run) => run.toISOString()); } catch { schedule.nextRuns = []; }
      schedule.calendarRuns = runsInMonth(schedule.cronExpr, startOfMonth(new Date()));
    }
    return [schedule];
  });
}

function runsInMonth(cronExpr: string, month: Date): string[] {
  try {
    const cron = new Cron(cronExpr); const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    let cursor = new Date(month.getTime() - 1_000); const runs: string[] = [];
    for (let count = 0; count < 1_000; count += 1) { const next = cron.nextRun(cursor); if (!next || next >= end) break; runs.push(next.toISOString()); cursor = next; }
    return runs;
  } catch { return []; }
}

async function actionMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string; reason?: string } | null;
  if (body?.error === "enqueue_failed") return "Run admitted but still queued; Redis delivery is unavailable. Retry with the same action.";
  if (body?.error === "conflict") return body.reason === "stale_revision" ? "This schedule changed elsewhere. Reopen it and try again." : "This schedule conflicts with another change.";
  if (body?.error === "disabled") return "This schedule is disabled.";
  return body?.error ? `Could not update schedule (${body.error}).` : "Could not update schedule.";
}

function formatRun(value: string | number): string { return new Date(value).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function startOfMonth(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), 1); }
function addMonths(date: Date, amount: number): Date { return new Date(date.getFullYear(), date.getMonth() + amount, 1); }
function sameDay(left: Date, right: Date): boolean { return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate(); }
function isToday(date: Date): boolean { return sameDay(date, new Date()); }
