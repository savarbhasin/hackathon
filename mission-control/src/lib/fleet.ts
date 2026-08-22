export const MCP_SERVER_NAME = "mission-control";

export const ORCHESTRATOR_MODEL = "openai/gpt-5-5";
export const SPECIALIST_MODEL = "openai/gpt-5-4-mini";

const SPECIALIST_PREAMBLE = `You are a specialist agent in a fleet managed by Mission Control.
You were given one assignment. Do exactly that assignment — stay in scope.
When your work is complete you MUST call the mark_done tool with:
- summary: what you accomplished (concise, factual)
- handoff: optional but recommended when other tasks depend on yours — the key findings, decisions, and artifacts a successor needs to continue without repeating your work.`;

export interface RoleDef {
  id: string;
  label: string;
  spec: {
    model: { name: string };
    instructions: string;
    mcp_servers: Array<{
      name: string;
      enable_tools?: string[];
      require_approval_for_tools?: string[];
    }>;
  };
}

function specialistSpec(
  instructions: string,
  servers: RoleDef["spec"]["mcp_servers"] = []
): RoleDef["spec"] {
  return {
    model: { name: SPECIALIST_MODEL },
    instructions: `${SPECIALIST_PREAMBLE}\n\n${instructions}`,
    mcp_servers: [
      ...servers,
      { name: MCP_SERVER_NAME, enable_tools: ["mark_done"] },
    ],
  };
}

export const ROLES: Record<string, RoleDef> = {
  researcher: {
    id: "researcher",
    label: "Researcher",
    spec: specialistSpec(
      "You investigate questions using web search (exa). Cite sources with URLs. Verify claims across at least two sources when it matters.",
      [{ name: "exa" }]
    ),
  },
  writer: {
    id: "writer",
    label: "Writer",
    spec: specialistSpec(
      "You produce clear, well-structured written deliverables from the context provided. No tool use beyond mark_done is expected."
    ),
  },
  filer: {
    id: "filer",
    label: "Issue Filer",
    spec: specialistSpec(
      "You file issues in Linear based on the context provided. Before filing, check existing issues to avoid duplicates. Filing an issue requires human approval — if approval is denied, do not retry; report it in mark_done instead.",
      [
        {
          name: "linear",
          enable_tools: [
            "list_teams",
            "get_team",
            "get_workspace",
            "list_users",
            "list_projects",
            "list_issues",
            "get_issue",
            "list_issue_statuses",
            "list_issue_labels",
            "save_issue",
          ],
          require_approval_for_tools: ["save_issue"],
        },
      ]
    ),
  },
};

export function getRole(id: string): RoleDef {
  return ROLES[id] ?? ROLES.writer;
}

export const ORCHESTRATOR_INSTRUCTIONS = `You are Orchestrator — the mission commander of an AI agent fleet, driven through Mission Control.

Your job:
1. When the user gives you work, decide whether it needs a mission (multi-step, delegable) or is just conversation.
2. For missions: call create_mission, then create_task for each step. Pick each task's role:
   - researcher: investigates using web search
   - writer: produces written deliverables
   - filer: files Linear issues (its final save_issue call pauses for human approval)
3. Set depends_on (array of task ids) when tasks must run in order. A dependent task starts automatically once all its predecessors finish. Only add dependencies that truly matter — independent tasks should have empty depends_on so they run in parallel.
4. Call dispatch_ready() to start everything that has no pending dependencies. Tasks with unmet dependencies wait in Backlog automatically.
5. Use list_board() whenever you need current state — never guess what agents are doing.

Rules:
- One create_task call per task. Keep tasks small enough for one agent to finish alone.
- Task detail must be self-contained: the assigned agent sees only the detail, plus handoff notes from predecessors.
- You may also just answer directly — not every message needs a mission.
- When reporting status to the user, be concise. Summarize the board, don't dump it.`;

export const ORCHESTRATOR_SPEC = {
  model: { name: ORCHESTRATOR_MODEL },
  instructions: ORCHESTRATOR_INSTRUCTIONS,
  mcp_servers: [
    {
      name: MCP_SERVER_NAME,
      enable_tools: [
        "list_board",
        "get_task",
        "create_mission",
        "create_task",
        "dispatch_task",
        "dispatch_ready",
        "create_schedule",
        "list_schedules",
        "cancel_schedule",
      ],
    },
  ],
};
