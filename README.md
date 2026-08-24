# Mission Control

A control center for running agent fleets on TrueForge. Instead of chatting with one agent at a time, you hand a mission to an orchestrator that decomposes it into a board of tasks, delegates each task to a specialist agent, and keeps every irreversible action behind a human approval gate.

This repo is the plan for the week — the build happens on branches as each piece lands.

## What it will do

- **Mission intake through chat.** You describe an outcome; the orchestrator decides whether to answer directly or split the work into a dependency graph of specialist tasks.
- **Specialists that own one job each.** Every task is assigned to an agent configured with its own model, tools, and connector access. No agent wanders outside its assignment.
- **Approvals before irreversible actions.** Filing issues, sending messages, anything external pauses the task and waits for a yes from a human.
- **Questions instead of guesses.** When an agent is missing information it stops and asks from the board rather than inventing facts.
- **Documents as handoffs.** Research, briefs, and finished artifacts get saved as versioned Markdown so downstream agents inherit real material, not lossy chat summaries.
- **Recurring missions.** Cron-driven schedules kick off prompts on an interval — morning digests, periodic research sweeps.

## Planned architecture

```
Browser
  ├─ /            Orchestrator chat (streamed turns)
  ├─ /board       Kanban of tasks with per-task drawer
  ├─ /agents      Specialist registry (model + tool access per role)
  └─ /schedules   Recurring prompts
        │ SSE
        ▼
Next.js  ── Prisma/SQLite ── TrueForge server (sessions, turns, events)
                    │
             MCP server exposing board tools to agents
```

One shared SQLite file between the app and the MCP server keeps the board honest: what you see is exactly what the agents did.

## The board

Tasks move through `backlog → working → blocked → approval → settled`. The columns are harness state, not manual labels:

- **approval** — an action needs sign-off; approve or deny straight from the card
- **blocked** — the agent asked a question; answer resumes the same thread
- **settled** — done, and any successor whose dependencies just cleared gets dispatched automatically

## Milestones

- [ ] Orchestrator chat streaming into a persisted conversation
- [ ] Kanban board fed by the same database the agents write to
- [ ] MCP tool surface: mark_done, create_doc, board queries, dispatch
- [ ] Specialist registry synced with TrueForge agents
- [ ] Approval gates on irreversible tool calls
- [ ] Document handoffs between dependent tasks
- [ ] Cron schedules for recurring missions

## Stack

Next.js (App Router) · TypeScript · Prisma + SQLite · TrueForge SDK · Model Context Protocol · croner
