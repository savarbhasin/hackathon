#!/usr/bin/env npx tsx
/**
 * Detached-subscriber recovery probe for TrueForge turns.
 *
 * The state file is the only handoff between invocations. It intentionally
 * contains IDs, cursors, and compact event metadata rather than model content.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";

type Command = "start" | "resume" | "reconcile" | "inspect" | "concurrent" | "stale-selector";
type Args = Record<string, string | boolean>;

type ProbeEvent = {
  phase: "start" | "resume";
  observedAt: string;
  sseId: string | null;
  sequenceNumber: number | null;
  providerEventId: string | null;
  type: string;
  stateStatus: string | null;
  threadId: string | null;
  toolCallIds: string[];
  duplicateSseId: boolean;
};

type Attempt = {
  phase: "start" | "resume" | "reconcile" | "inspect" | "concurrent" | "stale-selector";
  startedAt: string;
  endedAt?: string;
  afterSequenceNumber?: number | null;
  result?: string;
  error?: string;
};

type State = {
  formatVersion: 1;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  agent?: string;
  input?: { type: "user.message"; characterCount: number };
  sessionId?: string;
  turnId?: string;
  providerCursor?: { sseId: string; sequenceNumber: number | null; observedAt: string };
  events: ProbeEvent[];
  attempts: Attempt[];
  terminal?: { source: "stream" | "getTurn"; observedAt: string; state: Record<string, unknown> };
  reconciliation?: {
    observedAt: string;
    turnState?: Record<string, unknown>;
    persistedEvents?: { count: number; typeCounts: Record<string, number>; hasTurnDone: boolean };
    errors?: string[];
  };
  inspection?: {
    observedAt: string;
    session?: { id: string; createdAt: string; updatedAt: string };
    turn?: Record<string, unknown>;
    persistedEvents?: { count: number; typeCounts: Record<string, number>; hasTurnDone: boolean };
    errors?: string[];
  };
  concurrentTurn?: Record<string, unknown>;
  staleSelector?: Record<string, unknown>;
  verdict?:
    | "detached_ready_for_resume"
    | "terminal_before_detach"
    | "recovered_to_terminal"
    | "terminal_reconciled_without_sse"
    | "still_running"
    | "unable_to_resume"
    | "start_failed";
};

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/spikes/trueforge-recovery.ts start --state <file> --agent <name> --message <prompt> [--detach-after-events <n>]
  npx tsx scripts/spikes/trueforge-recovery.ts resume --state <file> [--max-wait-ms <n>]
  npx tsx scripts/spikes/trueforge-recovery.ts reconcile --state <file>
  npx tsx scripts/spikes/trueforge-recovery.ts inspect --state <file>
  npx tsx scripts/spikes/trueforge-recovery.ts concurrent --state <file> --confirm-concurrent
  npx tsx scripts/spikes/trueforge-recovery.ts stale-selector --state <file> [--thread-id <id> --tool-call-id <id> --source-turn-id <id>] --confirm-stale-selector

Environment:
  TRUEFORGE_BASE_URL  (default: http://localhost:8790)

start deliberately aborts its subscriber after N events (default 1). Run resume
from a separate process to verify replay after the persisted exclusive cursor.`);
  process.exit(2);
}

function parseArgs(argv: string[]): { command: Command; args: Args } {
  const [candidate, ...rest] = argv;
  if (candidate !== "start" && candidate !== "resume" && candidate !== "reconcile" && candidate !== "inspect" && candidate !== "concurrent" && candidate !== "stale-selector") usage();
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) usage();
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return { command: candidate, args };
}

function stringArg(args: Args, name: string, required = false): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) usage();
  return undefined;
}

function positiveInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function now(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function compactState(value: unknown): Record<string, unknown> {
  const state = value as Record<string, unknown>;
  const status = typeof state?.status === "string" ? state.status : "unknown";
  const compact: Record<string, unknown> = { status };
  for (const key of ["completedAt", "reason", "message"] as const) {
    if (typeof state?.[key] === "string") compact[key] = state[key];
  }
  if (Array.isArray(state?.requiredActions)) compact.requiredActionCount = state.requiredActions.length;
  const output = state?.output as Record<string, unknown> | null | undefined;
  if (output && typeof output === "object") {
    compact.output = {
      id: typeof output.id === "string" ? output.id : null,
      type: typeof output.type === "string" ? output.type : null,
      contentLength: typeof output.content === "string" ? output.content.length : null,
    };
  }
  return compact;
}

function compactEvent(event: unknown, phase: ProbeEvent["phase"], sseId: string | undefined, priorSseIds: Set<string>): ProbeEvent {
  const raw = event as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : null;
  const type = typeof raw.type === "string" ? raw.type : "unknown";
  const parsedSequence = sseId && /^\d+$/.test(sseId) ? Number(sseId) : null;
  const sequenceNumber = Number.isSafeInteger(parsedSequence) ? parsedSequence : null;
  const threadId = typeof raw.threadId === "string" ? raw.threadId : null;
  const toolCallIds = Array.isArray(raw.toolCalls)
    ? raw.toolCalls.flatMap((call) => typeof (call as Record<string, unknown>)?.id === "string" ? [(call as Record<string, unknown>).id as string] : [])
    : [];
  return {
    phase,
    observedAt: now(),
    sseId: sseId ?? null,
    sequenceNumber,
    providerEventId: id,
    type,
    stateStatus: raw.state && typeof raw.state === "object" && typeof (raw.state as Record<string, unknown>).status === "string"
      ? (raw.state as Record<string, unknown>).status as string
      : null,
    threadId,
    toolCallIds,
    duplicateSseId: sseId ? priorSseIds.has(sseId) : false,
  };
}

async function saveState(path: string, state: State): Promise<void> {
  state.updatedAt = now();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function loadState(path: string): Promise<State> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read probe state ${path}: ${errorText(error)}`);
  }
  const state = parsed as Partial<State>;
  if (state.formatVersion !== 1 || !Array.isArray(state.events) || !Array.isArray(state.attempts)) {
    throw new Error(`Probe state ${path} is not a formatVersion 1 recovery state file`);
  }
  return state as State;
}

function client(baseUrl: string): TrueForge {
  return new TrueForge({ baseUrl, timeoutInSeconds: 30, maxRetries: 0 });
}

function compactError(error: unknown): Record<string, unknown> {
  const candidate = error as { name?: unknown; message?: unknown; statusCode?: unknown };
  return {
    name: typeof candidate?.name === "string" ? candidate.name : "UnknownError",
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
    statusCode: typeof candidate?.statusCode === "number" ? candidate.statusCode : null,
  };
}

function persistedEventSummary(events: Array<{ type?: unknown }>): { count: number; typeCounts: Record<string, number>; hasTurnDone: boolean } {
  const typeCounts: Record<string, number> = {};
  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "unknown";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }
  return { count: events.length, typeCounts, hasTurnDone: (typeCounts["turn.done"] ?? 0) > 0 };
}

async function inspectRetainedState(tf: TrueForge, state: State, statePath: string): Promise<void> {
  if (!state.sessionId || !state.turnId) throw new Error("State has no sessionId/turnId to inspect");
  const attempt: Attempt = { phase: "inspect", startedAt: now() };
  state.attempts.push(attempt);
  const inspection: NonNullable<State["inspection"]> = { observedAt: now() };
  const errors: string[] = [];
  try {
    const { data: session } = await tf.sessions.get(state.sessionId);
    inspection.session = { id: session.id, createdAt: session.createdAt, updatedAt: session.updatedAt };
  } catch (error) {
    errors.push(`getSession: ${errorText(error)}`);
  }
  try {
    const { data: turn } = await tf.sessions.getTurn(state.sessionId, state.turnId);
    inspection.turn = compactState(turn.state);
  } catch (error) {
    errors.push(`getTurn: ${errorText(error)}`);
  }
  try {
    const page = await tf.sessions.listTurnEvents(state.sessionId, state.turnId, { limit: 100, order: "asc" });
    inspection.persistedEvents = persistedEventSummary(page.data as Array<{ type?: unknown }>);
  } catch (error) {
    errors.push(`listTurnEvents: ${errorText(error)}`);
  }
  if (errors.length > 0) inspection.errors = errors;
  state.inspection = inspection;
  attempt.endedAt = now();
  attempt.result = errors.length === 0 ? "retained_state_present" : "retained_state_missing_or_unavailable";
  await saveState(statePath, state);
}

async function probeConcurrentTurn(tf: TrueForge, state: State, statePath: string, confirmed: boolean): Promise<void> {
  if (!state.sessionId || !state.turnId) throw new Error("State has no sessionId/turnId for concurrent-turn probe");
  const attempt: Attempt = { phase: "concurrent", startedAt: now() };
  state.attempts.push(attempt);
  const evidence: Record<string, unknown> = { observedAt: now(), requestedPreviousTurnId: "auto" };
  if (!confirmed) {
    evidence.outcome = "blocked_confirmation_required";
    evidence.note = "Pass --confirm-concurrent to create a second provider turn while the first is active.";
    state.concurrentTurn = evidence;
    attempt.endedAt = now();
    attempt.result = "blocked_confirmation_required";
    await saveState(statePath, state);
    return;
  }
  try {
    const { data: original } = await tf.sessions.getTurn(state.sessionId, state.turnId);
    evidence.originalBefore = compactState(original.state);
    if (original.state.status !== "running") {
      evidence.outcome = "blocked_original_not_running";
    } else {
      try {
        const { data: competing } = await tf.sessions.createTurn(state.sessionId, {
          input: [{ type: "user.message", content: "Reply with exactly: concurrent-turn-probe" }] as never,
          previousTurnId: "auto" as never,
        });
        evidence.create = { outcome: "accepted", turnId: competing.id, initialState: compactState(competing.state) };
        // Read both states immediately: a cancellation caused by auto chaining should be visible here.
        const [{ data: originalAfter }, { data: competingAfter }] = await Promise.all([
          tf.sessions.getTurn(state.sessionId, state.turnId),
          tf.sessions.getTurn(state.sessionId, competing.id),
        ]);
        evidence.originalAfter = compactState(originalAfter.state);
        evidence.competingAfter = compactState(competingAfter.state);
        evidence.autoEffect = originalAfter.state.status === "cancelled"
          ? "active_turn_cancelled_after_auto"
          : "no_immediate_active_turn_cancellation_observed";
        evidence.outcome = "second_turn_accepted";
      } catch (error) {
        const details = compactError(error);
        evidence.create = { outcome: "rejected", error: details };
        evidence.outcome = details.statusCode === 412 ? "rejected_precondition_failed_412" : "rejected_other";
      }
    }
  } catch (error) {
    evidence.outcome = "blocked_original_turn_unavailable";
    evidence.error = compactError(error);
  }
  state.concurrentTurn = evidence;
  attempt.endedAt = now();
  attempt.result = String(evidence.outcome);
  await saveState(statePath, state);
}

async function probeStaleSelector(tf: TrueForge, state: State, statePath: string, args: Args): Promise<void> {
  if (!state.sessionId) throw new Error("State has no sessionId for stale-selector probe");
  const attempt: Attempt = { phase: "stale-selector", startedAt: now() };
  state.attempts.push(attempt);
  const latestPause = [...state.events].reverse().find((event) =>
    (event.type === "tool.approval_required" || event.type === "tool.response_required") && event.threadId && event.toolCallIds.length > 0
  );
  const threadId = stringArg(args, "thread-id") ?? latestPause?.threadId;
  const toolCallId = stringArg(args, "tool-call-id") ?? latestPause?.toolCallIds[0];
  const sourceTurnId = stringArg(args, "source-turn-id") ?? state.turnId;
  const kind = stringArg(args, "kind") ?? (latestPause?.type === "tool.response_required" ? "response" : "approval");
  const evidence: Record<string, unknown> = {
    observedAt: now(), threadId: threadId ?? null, toolCallId: toolCallId ?? null, sourceTurnId: sourceTurnId ?? null, kind,
  };
  if (!threadId || !toolCallId || !sourceTurnId) {
    evidence.outcome = "blocked_no_pause_fixture";
    evidence.note = "No saved approval/response selector. Supply --thread-id, --tool-call-id, and --source-turn-id from a known paused turn.";
  } else if (kind !== "approval" && kind !== "response") {
    evidence.outcome = "blocked_invalid_kind";
  } else {
    try {
      const turns = await tf.sessions.listTurns(state.sessionId, { limit: 25 });
      const ids: string[] = [];
      for await (const turn of turns) ids.push(turn.id);
      evidence.retainedTurnIds = ids;
      if (!ids.includes(sourceTurnId)) {
        evidence.outcome = "blocked_source_turn_not_retained";
      } else if (ids[0] === sourceTurnId) {
        evidence.outcome = "blocked_selector_not_yet_stale";
        evidence.note = "Create and finish a later turn on this session before testing a selector from the earlier source turn.";
      } else if (args["confirm-stale-selector"] !== true) {
        evidence.outcome = "blocked_confirmation_required";
        evidence.note = "Pass --confirm-stale-selector to submit the old selector in a new turn. Approval probes submit deny, never allow.";
      } else {
        const input = kind === "approval"
          ? { type: "user.tool_approval", threadId, toolCallId, approval: { status: "deny", reason: "stale-selector recovery probe" } }
          : { type: "user.tool_response", threadId, toolCallId, content: stringArg(args, "content") ?? "stale-selector recovery probe" };
        try {
          const { data: turn } = await tf.sessions.createTurn(state.sessionId, { input: [input] as never, previousTurnId: "auto" as never });
          evidence.outcome = "provider_accepted_stale_selector";
          evidence.createdTurn = { id: turn.id, initialState: compactState(turn.state) };
        } catch (error) {
          evidence.outcome = "provider_rejected_stale_selector";
          evidence.error = compactError(error);
        }
      }
    } catch (error) {
      evidence.outcome = "blocked_cannot_list_turns";
      evidence.error = compactError(error);
    }
  }
  state.staleSelector = evidence;
  attempt.endedAt = now();
  attempt.result = String(evidence.outcome);
  await saveState(statePath, state);
}

async function reconcile(tf: TrueForge, state: State, statePath: string): Promise<boolean> {
  if (!state.sessionId || !state.turnId) throw new Error("State has no sessionId/turnId to reconcile");
  const attempt: Attempt = { phase: "reconcile", startedAt: now() };
  state.attempts.push(attempt);
  const errors: string[] = [];
  const result: NonNullable<State["reconciliation"]> = { observedAt: now() };

  try {
    const { data: turn } = await tf.sessions.getTurn(state.sessionId, state.turnId);
    result.turnState = compactState(turn.state);
    if (turn.state.status !== "running" && !state.terminal) {
      state.terminal = { source: "getTurn", observedAt: now(), state: result.turnState };
    }
  } catch (error) {
    errors.push(`getTurn: ${errorText(error)}`);
  }

  try {
    const page = await tf.sessions.listTurnEvents(state.sessionId, state.turnId, { limit: 100, order: "asc" });
    const typeCounts: Record<string, number> = {};
    for (const event of page.data as Array<{ type?: unknown }>) {
      const type = typeof event.type === "string" ? event.type : "unknown";
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }
    result.persistedEvents = {
      count: page.data.length,
      typeCounts,
      hasTurnDone: (typeCounts["turn.done"] ?? 0) > 0,
    };
  } catch (error) {
    errors.push(`listTurnEvents: ${errorText(error)}`);
  }

  if (errors.length > 0) result.errors = errors;
  state.reconciliation = result;
  attempt.endedAt = now();
  attempt.result = errors.length === 0 ? "reconciled" : "reconciled_with_errors";
  await saveState(statePath, state);
  return result.turnState?.status !== undefined && result.turnState.status !== "running";
}

async function consumeSubscription(
  tf: TrueForge,
  state: State,
  statePath: string,
  phase: "start" | "resume",
  options: { detachAfterEvents?: number; maxWaitMs?: number }
): Promise<{ detached: boolean; streamError?: string }> {
  if (!state.sessionId || !state.turnId) throw new Error("State has no sessionId/turnId to subscribe to");
  const previousCursor = state.providerCursor?.sequenceNumber ?? null;
  const attempt: Attempt = { phase, startedAt: now(), afterSequenceNumber: previousCursor };
  state.attempts.push(attempt);
  await saveState(statePath, state);

  const controller = new AbortController();
  let timedOut = false;
  const timeout = options.maxWaitMs
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.maxWaitMs)
    : undefined;
  let detached = false;
  let streamError: string | undefined;

  try {
    const stream = await tf.sessions.subscribeToTurn(
      state.sessionId,
      state.turnId,
      previousCursor === null ? {} : { afterSequenceNumber: previousCursor },
      // Disabling reconnect makes the intentional abort a clean, reproducible detach.
      { abortSignal: controller.signal, stream: { reconnectionEnabled: false } }
    );
    for await (const metadata of stream.withMetadata()) {
      const priorSseIds = new Set(state.events.map((event) => event.sseId).filter((id): id is string => id !== null));
      const event = compactEvent(metadata.data, phase, metadata.id, priorSseIds);
      state.events.push(event);
      if (event.sseId) {
        state.providerCursor = {
          sseId: event.sseId,
          sequenceNumber: event.sequenceNumber,
          observedAt: event.observedAt,
        };
      }
      const raw = metadata.data as unknown as Record<string, unknown>;
      if (event.type === "turn.done" && raw.state && typeof raw.state === "object") {
        state.terminal = { source: "stream", observedAt: now(), state: compactState(raw.state) };
      }
      await saveState(statePath, state);

      if (event.type === "turn.done") break;
      if (options.detachAfterEvents !== undefined && state.events.filter((item) => item.phase === phase).length >= options.detachAfterEvents) {
        detached = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!(controller.signal.aborted && (detached || timedOut))) streamError = errorText(error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  attempt.endedAt = now();
  attempt.result = detached ? "detached_after_checkpoint" : state.terminal ? "terminal_event_observed" : timedOut ? "wait_timed_out" : streamError ? "stream_error" : "stream_ended";
  if (streamError) attempt.error = streamError;
  await saveState(statePath, state);
  return { detached, streamError };
}

function printSummary(statePath: string, state: State): void {
  console.log(JSON.stringify({
    stateFile: statePath,
    verdict: state.verdict ?? null,
    sessionId: state.sessionId ?? null,
    turnId: state.turnId ?? null,
    providerCursor: state.providerCursor ?? null,
    terminal: state.terminal ?? null,
    reconciliation: state.reconciliation ?? null,
  }, null, 2));
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  const stateFile = stringArg(args, "state", true)!;
  const statePath = resolve(stateFile);
  const baseUrl = stringArg(args, "base-url") ?? process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";

  if (command === "start") {
    const agent = stringArg(args, "agent", true)!;
    const message = stringArg(args, "message", true)!;
    const detachAfterEvents = positiveInteger(stringArg(args, "detach-after-events"), 1);
    try {
      await readFile(statePath, "utf8");
      throw new Error(`Refusing to overwrite existing state file ${statePath}; choose a new --state path`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
    }

    const state: State = {
      formatVersion: 1,
      baseUrl,
      createdAt: now(),
      updatedAt: now(),
      agent,
      input: { type: "user.message", characterCount: message.length },
      events: [],
      attempts: [],
    };
    const tf = client(baseUrl);
    const startAttempt: Attempt = { phase: "start", startedAt: now() };
    state.attempts.push(startAttempt);
    await saveState(statePath, state);
    try {
      const { data: session } = await tf.sessions.create({ agent: { name: agent } });
      state.sessionId = session.id;
      // This write closes the session-creation crash window before turn creation.
      await saveState(statePath, state);
      const { data: turn } = await tf.sessions.createTurn(session.id, {
        input: [{ type: "user.message", content: message }] as never,
        previousTurnId: "none" as never,
      });
      state.turnId = turn.id;
      startAttempt.endedAt = now();
      startAttempt.result = "session_and_turn_persisted";
      // This write is intentionally before any long-lived SSE consumption.
      await saveState(statePath, state);
    } catch (error) {
      startAttempt.endedAt = now();
      startAttempt.result = "start_failed";
      startAttempt.error = errorText(error);
      state.verdict = "start_failed";
      await saveState(statePath, state);
      printSummary(statePath, state);
      process.exitCode = 1;
      return;
    }
    await consumeSubscription(tf, state, statePath, "start", { detachAfterEvents });
    state.verdict = state.terminal ? "terminal_before_detach" : "detached_ready_for_resume";
    await saveState(statePath, state);
    printSummary(statePath, state);
    return;
  }

  const state = await loadState(statePath);
  const tf = client(stringArg(args, "base-url") ?? state.baseUrl ?? baseUrl);
  if (command === "reconcile") {
    const terminal = await reconcile(tf, state, statePath);
    if (state.verdict !== "recovered_to_terminal") {
      state.verdict = terminal ? "terminal_reconciled_without_sse" : "still_running";
    }
    await saveState(statePath, state);
    printSummary(statePath, state);
    return;
  }
  if (command === "inspect") {
    await inspectRetainedState(tf, state, statePath);
    printSummary(statePath, state);
    return;
  }
  if (command === "concurrent") {
    await probeConcurrentTurn(tf, state, statePath, args["confirm-concurrent"] === true);
    printSummary(statePath, state);
    return;
  }
  if (command === "stale-selector") {
    await probeStaleSelector(tf, state, statePath, args);
    printSummary(statePath, state);
    return;
  }

  const result = await consumeSubscription(tf, state, statePath, "resume", {
    maxWaitMs: positiveInteger(stringArg(args, "max-wait-ms"), 120_000),
  });
  if (state.terminal?.source === "stream") {
    state.verdict = "recovered_to_terminal";
  } else {
    const terminal = await reconcile(tf, state, statePath);
    state.verdict = terminal ? "terminal_reconciled_without_sse" : result.streamError ? "unable_to_resume" : "still_running";
  }
  await saveState(statePath, state);
  printSummary(statePath, state);
}

main().catch((error) => {
  console.error(JSON.stringify({ probeError: errorText(error) }));
  process.exitCode = 1;
});
