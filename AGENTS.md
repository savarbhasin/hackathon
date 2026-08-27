# Mission Control — Agent Fleet Control Center

A Next.js control center where an **Orchestrator** agent decomposes missions into tasks on a kanban board, specialist agents (running on TrueForge) execute them, and every irreversible action pauses as a "⚠ Licence Required" card until a human approves.

## Architecture

```
Browser
  ├─ /            Orchestrator chat
  ├─ /board       Kanban
  └─ /schedules   Recurring work
        │ Convex subscriptions
        ▼
Convex ◀──────── Next.js (port 3000)
  ▲                  │ admit runs
  │                  ▼
  │              Redis/BullMQ
  │                  │
  │                  ▼
  └──────────── Worker ───────────▶ TrueForge server (port 8790)
  ▲                                    │
  └──────── MCP server (port 3100) ◀───┘
  tools: mark_done, list_board, get_task, create_mission, create_task,
         dispatch_task, dispatch_ready, create/list/cancel_schedule
```

- **Convex is the application source of truth**: the board and run state are read and written through Convex, while Redis/BullMQ delivers work to the worker.
- TrueForge has its own separate SQLite (`~/Library/Application Support/trueforge/db/`) — never touch it; go through the SDK/API.
- The worker owns TrueForge turns and persists session IDs, turn IDs, events, pause actions, and provider cursors in Convex.

## Running

```bash
npm run dev        # Next.js on :3000
npm run dev:mcp    # MCP server on :3100 (tsx watch)
npm run dev:worker # BullMQ worker and schedule reconciler
npx convex dev     # Convex functions and generated bindings
docker compose up redis
```

Prereqs: TrueForge running (`npx @truefoundry/trueforge` → :8790), model provider configured in its Settings, connectors `exa` + `linear` + `mission-control` registered.

## File structure

```
trueforge-mc/
├── convex/                    # Schema, queries, mutations, run state
├── server/mcp.ts              # Express + @modelcontextprotocol/sdk, stateless StreamableHTTP at /mcp
├── worker/agent-runs.ts       # BullMQ worker and schedule reconciliation
└── src/
    ├── app/
    │   ├── page.tsx           # Orchestrator chat home
    │   ├── board/page.tsx     # Kanban + card drawer (approve/deny/answer/dispatch)
    │   └── api/
    │       ├── chat/route.ts        # Admit an orchestrator run and enqueue it
    │       └── tasks/[id]/route.ts  # POST {action: dispatch|retry|approve|deny|answer}
    ├── lib/
    │   ├── tf.ts              # TrueForge SDK client singleton
    │   ├── fleet.ts           # Roles (researcher/writer/filer) + ORCHESTRATOR_SPEC
    │   ├── durable-task-engine.ts  # Convex task admission, pause resolution, successor dispatch
    │   └── queue/             # BullMQ producer, worker processor, schedule projection
    └── ...
```

## Data model

- **Mission**: title, goal, status.
- **Task**: missionId, role, column, sessionId, turnId, lastSeq, position, claimCount, `dependsOn`, `handoff`, `output`, `pendingActions`, and error.
- **TaskEvent**: ordered per-task activity and chat records.
- **AgentRun**: one orchestrator, specialist, follow-up, or scheduled execution with provider checkpoints and pause state.
- **Schedule**: validated schedule config in Convex plus BullMQ scheduler identity, revision, hash, and sync state.

## Kanban columns = harness state

`backlog → working → blocked → approval → settled`

- `tool.approval_required` → approval ⚠ · `tool.response_required` / `mcp.auth_required` → blocked · clean `turn.done` → settled (+sweep auto-chain) · cancelled → back to backlog.
- Approvals/questions resume via a NEW turn whose input is `user.tool_approval` / `user.tool_response` items (never mixed with user.message).

## CRITICAL gotchas (learned the hard way)

1. **TrueForge SDK returns camelCase** (`requiredActions`, `sourceEventId`, `threadId`) while docs/OpenAPI show snake_case. Always read camelCase from SDK events.
2. **Deltas must be merged.** `model.message` base events arrive EMPTY; tool-call args and text arrive via `.delta` fragments sharing the same `id`. Use `isEventDelta` / `mergeEventDelta` from the SDK before reading toolCalls — otherwise approval pauses show no name/args.
3. **Never parse TaskEvent payloads for state transitions**. Logic uses `Task.pendingActions` and `AgentRun`; events are activity and chat records.
4. **Node ≥ 22.14 required.** Homebrew node was shadowed by `/usr/local/bin/node`; fixed with PATH prepend in ~/.zshrc.
5. **MCP does not own schedules**. It validates cron expressions and writes Convex. The worker reconciles BullMQ Job Schedulers.
6. **Next 16**: route handler `params` are Promises (await them). Standard Web Request/Response handlers.
7. **tsx watch restarts the MCP process** when MCP files change; TrueForge may then run a turn with zero tool definitions. Retry after `/health` succeeds.
8. **Linear `save_issue` requires `team`** when creating. Filer role therefore enables discovery tools (`list_teams`, `get_team`, `get_workspace`, …). Gate config: `require_approval_for_tools: ["save_issue"]`.
9. **Specialist completion signal**: agents call MCP `mark_done(task_id, summary, handoff?)`. Kickoff messages embed `TASK_ID:`.
10. Dispatch guard: Convex admits only backlog tasks without active run ownership. The Convex mutation is the race boundary.
11. Secrets live only in `.env.local`. Never commit keys or print connection credentials.

## Verified end-to-end (Aug 22)

Mission → orchestrator MCP tool calls → researcher (exa) settles with handoff → auto-chain dispatches filer → ask_user_question answered via board → save_issue approval gate → approved → Linear issue created (HAC-5) → settled.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
