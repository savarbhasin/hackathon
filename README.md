# Mission Control

A control center for running agent fleets on TrueForge. Instead of chatting with one agent at a time, you hand a mission to an orchestrator that decomposes it into a board of tasks, delegates each task to a specialist agent, and keeps every irreversible action behind a human approval gate.

## What it does

- **Mission intake through chat.** You describe an outcome; the orchestrator decides whether to answer directly or split the work into a dependency graph of specialist tasks.
- **Specialists that own one job each.** Every task is assigned to an agent configured with its own model, tools, and connector access. No agent wanders outside its assignment.
- **Approvals before irreversible actions.** Filing issues, sending messages, anything external pauses the task and waits for a yes from a human.
- **Questions instead of guesses.** When an agent is missing information it stops and asks from the board rather than inventing facts.
- **Documents as handoffs.** Research, briefs, and finished artifacts get saved as versioned Markdown so downstream agents inherit real material, not lossy chat summaries.
- **Recurring missions.** Cron-driven schedules kick off prompts on an interval — morning digests, periodic research sweeps.

## Architecture

```
Browser
  ├─ /            Orchestrator chat (streamed turns)
  ├─ /board       Kanban of tasks with per-task drawer
  ├─ /agents      Specialist registry (model + tool access per role)
  └─ /schedules   Recurring prompts
        │ Convex subscriptions
        ▼
Next.js  ── Convex ── TrueForge server (sessions, turns, events)
   │                   │
   └─ BullMQ/Redis ── worker
                       │
                MCP server exposing board tools to agents
```

Convex is the source of truth for the board and run state. BullMQ and Redis deliver work to the worker, which owns the long-lived TrueForge stream. Live assistant text is batched into the official Convex Agent streaming component and consumed through Convex subscriptions; the application’s `chatMessages` table remains the final durable record.

## The board

Tasks move through `backlog → working → blocked → approval → settled`. The columns are harness state, not manual labels:

- **approval** — an action needs sign-off; approve or deny straight from the card
- **blocked** — the agent asked a question; answer resumes the same thread
- **settled** — done, and any successor whose dependencies just cleared gets dispatched automatically

## Local development

Copy `.env.example` to `.env.local`, start Redis with `docker compose up redis`, and run these processes:

```bash
npx convex dev
npm run dev
npm run dev:worker
npm run dev:mcp
```

The web app uses `NEXT_PUBLIC_CONVEX_URL`. Next.js, the MCP server, and the worker use `CONVEX_URL`. Redis carries BullMQ delivery only. TrueForge owns agent sessions and turns.

## Stack

Next.js (App Router) · TypeScript · Convex · Redis/BullMQ · TrueForge SDK · Model Context Protocol
