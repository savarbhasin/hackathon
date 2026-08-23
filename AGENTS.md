# Mission Control — Agent Fleet Control Center

Hackathon build for **The Agent Harness Hackathon** (WeMakeDevs × TrueFoundry, Aug 24–30 2026).
A Next.js control center where an **Orchestrator** agent decomposes missions into tasks on a kanban board, specialist agents (running on TrueForge) execute them, and every irreversible action pauses as a "⚠ Licence Required" card until a human approves.

## Architecture

```
Browser
  ├─ /            Orchestrator chat (SSE stream from POST /api/chat)
  └─ /board       Kanban (SSE from GET /api/stream, 1s DB diff poll)
        │ fetch
        ▼
Next.js (port 3000)                      TrueForge server (port 8790)
  ├─ src/lib/engine.ts     dispatch/pump/watcher    ▲ SDK (@truefoundry/trueforge-sdk)
  ├─ src/lib/orchestrator  chat turns               │ sessions/turns/events
  └─ Prisma → SQLite                               │ MCP tools
                                                    │
MCP server (port 3100, `server/mcp.ts`, tsx watch) ─┘ registered as connector "mission-control"
  tools: mark_done, list_board, get_task, create_mission, create_task,
         dispatch_task, dispatch_ready, create/list/cancel_schedule
```

- **One SQLite file shared by two processes**: `mission-control/prisma/dev.db`. The board can never drift from what agents did — all state changes flow through it.
- TrueForge has its own separate SQLite (`~/Library/Application Support/trueforge/db/`) — never touch it; go through the SDK/API.
- Orchestrator session id is persisted in the `Setting` table (`orchestrator_session_id`) so conversation history survives restarts.

## Running

```bash
cd mission-control
npm run dev        # Next.js on :3000
npm run dev:mcp    # MCP server on :3100 (tsx watch)
```

Prereqs: TrueForge running (`npx @truefoundry/trueforge` → :8790), model provider configured in its Settings, connectors `exa` + `linear` + `mission-control` registered.

## File structure

```
mission-control/
├── server/mcp.ts              # Express + @modelcontextprotocol/sdk, stateless StreamableHTTP at /mcp
├── prisma/schema.prisma       # Mission, Task, TaskEvent, Schedule, Setting
├── scripts/smoke.mjs          # SDK smoke test (session → streamed turn)
└── src/
    ├── app/
    │   ├── page.tsx           # Orchestrator chat home
    │   ├── board/page.tsx     # Kanban + card drawer (approve/deny/answer/dispatch)
    │   └── api/
    │       ├── chat/route.ts        # POST {message} → SSE of orchestrator turn
    │       ├── stream/route.ts      # SSE full-board JSON on change
    │       └── tasks/[id]/route.ts  # GET task+events; POST {action: dispatch|approve|answer}
    ├── lib/
    │   ├── db.ts              # Prisma singleton
    │   ├── tf.ts              # TrueForge SDK client singleton
    │   ├── fleet.ts           # Roles (researcher/writer/filer) + ORCHESTRATOR_SPEC
    │   ├── engine.ts          # dispatchTask, event pump, sweep() auto-chain, resolvePause
    │   └── orchestrator.ts    # ensureOrchestratorSession, runOrchestratorTurn
    └── ...
```

## Data model

- **Mission**: title, goal, status.
- **Task**: role, column, sessionId, turnId, lastSeq, `dependsOn` (JSON array of task ids), `handoff` (explicit context from `mark_done`), `output` (fallback), `pendingActions` (**structured JSON of paused calls — source of truth for approve/answer UI**), error.
- **TaskEvent**: per-task event log (type + truncated payload) for the drawer.
- **Schedule**: name, cronExpr, prompt (croner jobs booted by MCP server).
- **Setting**: key/value (orchestrator session id).

## Kanban columns = harness state

`backlog → working → blocked → approval → settled`

- `tool.approval_required` → approval ⚠ · `tool.response_required` / `mcp.auth_required` → blocked · clean `turn.done` → settled (+sweep auto-chain) · cancelled → back to backlog.
- Approvals/questions resume via a NEW turn whose input is `user.tool_approval` / `user.tool_response` items (never mixed with user.message).

## CRITICAL gotchas (learned the hard way)

1. **TrueForge SDK returns camelCase** (`requiredActions`, `sourceEventId`, `threadId`) while docs/OpenAPI show snake_case. Always read camelCase from SDK events.
2. **Deltas must be merged.** `model.message` base events arrive EMPTY; tool-call args and text arrive via `.delta` fragments sharing the same `id`. Use `isEventDelta` / `mergeEventDelta` from the SDK before reading toolCalls — otherwise approval pauses show no name/args.
3. **Never parse TaskEvent payloads for logic** — they're truncated to 4000 chars and cut mid-JSON. Logic uses `Task.pendingActions`; events are display-only.
4. **Node ≥ 22.14 required.** Homebrew node was shadowed by `/usr/local/bin/node`; fixed with PATH prepend in ~/.zshrc.
5. **Prisma pinned to v6** (v7 removed schema datasource url). After schema change: `npx prisma migrate dev --name X` **then `npx prisma generate`**, then RESTART next dev or you get "Unknown argument" 500s (stale client).
6. **croner v10 API**: `new Cron(expr).schedule(fn)` — no callback in constructor, no `.start()`.
7. **Next 16**: route handler `params` are Promises (await them). Standard Web Request/Response handlers.
8. **tsx watch restarts the MCP process** when engine files change; TrueForge may then run an orchestrator turn with zero tool defs (`usage.tool_definitions: 0`). Symptom: agent answers but doesn't call tools / says board is empty. Fix: just retry the turn after MCP is healthy again.
9. **Linear `save_issue` requires `team`** when creating. Filer role therefore enables discovery tools (`list_teams`, `get_team`, `get_workspace`, …). Gate config: `require_approval_for_tools: ["save_issue"]`.
10. **Specialist completion signal**: agents call MCP `mark_done(task_id, summary, handoff?)`. Kickoff message embeds `TASK_ID:` so they can. If they skip it, fallback = final turn output.
11. Dispatch guard: only backlog tasks with `sessionId == null`; claim via `updateMany` race check. Cancelled turns return cards to backlog (redispatch-safe).
12. Secrets live ONLY in `mission-control/.env.local` (gitignored): `DATABASE_URL`, `TRUEFORGE_BASE_URL=http://localhost:8790`, `OPENROUTER_API_KEY`. Never commit keys; never paste real keys into repo files.

## Hackathon strategy notes

- Tracks: Best Use of TrueForge (DGX Spark), Code Quality w/ Qodo (install Qodo day one, work through PRs — judges read the trail), Best UI (kanban + approval-on-card is the demo moment).
- Judging penalizes "platform with half-finished features" → demo ONE flagship flow (research → Linear issue with approval gate), show generality briefly.
- Demo script: type mission in chat → researcher runs exa → handoff injects into filer → filer asks team question (Blocked) → answer → save_issue gate (⚠) → approve from card drawer → issue HAC-x appears in Linear.

## Verified end-to-end (Aug 22)

Mission → orchestrator MCP tool calls → researcher (exa) settles with handoff → auto-chain dispatches filer → ask_user_question answered via board → save_issue approval gate → approved → Linear issue created (HAC-5) → settled.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
