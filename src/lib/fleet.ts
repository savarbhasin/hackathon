import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

export const MCP_SERVER_NAME = "mission-control";

export const ORCHESTRATOR_MODEL = "google-gemini/gemini-3-6-flash";
export const SPECIALIST_MODEL = "openai/gpt-5-6-luna";
export const TITLE_MODEL = "google-gemini/gemini-3-6-flash";

export const SPECIALIST_RUNTIME_PREAMBLE = `## Mission Control runtime instructions

You are a specialist agent in a fleet managed by Mission Control.

### Scope and evidence
- Treat the mission as context and YOUR ASSIGNMENT as your exact scope. Do not broaden the mission, create board tasks, or take ownership of another specialist's work.
- Use only the predefined specialist roster. Create or launch subagents only when dynamic subagents are enabled for you and the assignment explicitly requires parallel specialist work.
- Use every supplied input and predecessor document before asking the user for information. Never invent facts, identifiers, tool results, completed actions, or access you do not have.
- If instructions conflict, follow the narrower assignment and state the conflict in your completion summary. If a required input is still missing after safe checks, ask one precise question that names the missing item and why work cannot continue without it.
- A failed or unavailable tool is not a successful result. Try a safe alternative when one exists. Otherwise report the failure plainly and do not claim completion.

### Documents and handoffs
- Call get_doc for every DOC_ID listed in the kickoff before doing dependent work. If a document cannot be read, do not reconstruct or guess its contents.
- When the kickoff lists downstream successors, create a document with create_doc and kind="handoff" whenever those successors need substantial context, evidence, decisions, or finished material from you. Make it self-contained enough for the next agent to continue without asking the user to repeat information.
- Use kind="artifact" only for material that should remain available to people but is not needed by a successor. Do not put substantial downstream context only in mark_done.
- After create_doc, verify the tool response reports the intended kind. Include the returned document ID in your completion summary.

### Completion
- Do not call mark_done until the requested deliverable exists, required checks are complete, and any approval-gated action has actually succeeded or been explicitly denied.
- Call mark_done exactly once. Keep its summary to two to four factual sentences describing the completed outcome, important limitations, checks performed, and any document IDs. Do not paste the full deliverable into the summary.

<!-- End Mission Control runtime instructions -->`;

const SPECIALIST_RUNTIME_PREFIX = `${SPECIALIST_RUNTIME_PREAMBLE}\n\n`;

// The runtime section is intentionally marked as a reserved Markdown block.
// TrueForge stores the full system prompt, while Mission Control's editor must
// expose only the agent-authored portion. Keep the end marker explicit so a
// prompt containing a similarly named heading cannot hide arbitrary content.
const INTERNAL_RUNTIME_BLOCK = /(?:^|\n)## Mission Control runtime instructions[ \t]*\n[\s\S]*?<!--[ \t]*End Mission Control runtime instructions[ \t]*-->[ \t]*(?:\n|$)/gi;

// Older manifests used an unheaded shared preamble. These prompts predate the
// delimiter above, so retain a narrowly-scoped compatibility parser for them.
const LEGACY_RUNTIME_BLOCK = /(?:^|\n)You are a specialist agent in a fleet managed by Mission Control\.[ \t]*\n+[ \t]*Scope and evidence:[ \t]*\n[\s\S]*?\n[ \t]*Completion:[ \t]*\n(?:[ \t]*-[^\n]*(?:\n|$))+/gi;
const LEGACY_FLEET_CONTRACT_BLOCK = /(?:^|\n)(?:You are a specialist agent in a fleet managed by Mission Control\.[ \t]*\n+)?FLEET CONTRACT[ \t]*\n[\s\S]*?(?=\nROLE:[ \t]*[^\n]+(?:\n|$))/gi;

const ROUTING_DESCRIPTION_BLOCK = /(?:^|\n)(?:#{1,6}[ \t]+)?AGENT DESCRIPTION FOR ROUTING[ \t]*\n([\s\S]*?)(?=\n(?:#{1,6}[ \t]+|You are a specialist agent in a fleet managed by Mission Control\.|## Mission Control runtime instructions|ROLE:[ \t]*)|$)/i;
const LEGACY_SECTION_HEADINGS = /^(ROLE:[^\n]+|CAPABILITY AND BOUNDARY|OPERATING PROCEDURE|ANALYSIS METHOD|QUALITY RULES|SAFETY AND OUTPUT|ENGINEERING SAFETY|DELIVERY STANDARD|FINANCIAL SAFETY)$/gim;

export function withSpecialistRuntimeInstructions(instructions: string): string {
  return `${SPECIALIST_RUNTIME_PREFIX}${stripSpecialistRuntimeInstructions(instructions).trim()}`;
}

/**
 * Remove shared Mission Control policy before exposing editable instructions.
 *
 * This parser is deliberately tolerant of old persisted manifests: prompts
 * created before the reserved heading may contain a legacy preamble and a
 * duplicated fleet contract around the role-specific instructions.
 */
export function stripSpecialistRuntimeInstructions(instructions: string): string {
  return instructions
    .replace(INTERNAL_RUNTIME_BLOCK, "\n")
    .replace(LEGACY_RUNTIME_BLOCK, "\n")
    .replace(LEGACY_FLEET_CONTRACT_BLOCK, "\n")
    // Routing text is stored in the profile description, not in the editable
    // execution prompt. This also prevents it being persisted again on save.
    .replace(ROUTING_DESCRIPTION_BLOCK, "\n")
    // Normalize headings from prompts created before system instructions were
    // explicitly authored as Markdown. The replacement is intentionally
    // limited to known section labels so ordinary agent text is untouched.
    .replace(LEGACY_SECTION_HEADINGS, "## $1")
    .trim();
}

/** Extract the optional agent-specific routing description from a manifest. */
export function routingDescription(instructions: string): string | undefined {
  const match = instructions.match(ROUTING_DESCRIPTION_BLOCK);
  const description = match?.[1]?.trim();
  return description || undefined;
}

export interface RoleDef {
  id: string;
  label: string;
  description: string;
  instructions: string;
  spec: TrueForgeApi.AgentSpec;
}

type AgentMcpServers = NonNullable<TrueForgeApi.AgentSpec["mcpServers"]>;

export interface RoleCapabilities {
  sandbox?: boolean;
  dynamicSubAgents?: boolean;
}

function specialistSpec(
  instructions: string,
  servers: AgentMcpServers = [],
  capabilities: RoleCapabilities = {}
): RoleDef["spec"] {
  return {
    model: { name: SPECIALIST_MODEL },
    instructions: withSpecialistRuntimeInstructions(instructions),
    config: {
      sandbox: { enabled: capabilities.sandbox ?? false },
      dynamicSubAgents: { enabled: capabilities.dynamicSubAgents ?? false },
      generativeUi: { enabled: false },
    },
    mcpServers: [
      ...servers,
      {
        name: MCP_SERVER_NAME,
        enableTools: ["mark_done", "create_doc", "update_doc", "get_doc"],
      },
    ],
  };
}

interface DefineRoleInput {
  id: string;
  label: string;
  description: string;
  instructions: string;
  servers?: AgentMcpServers;
  capabilities?: RoleCapabilities;
}

function defineRole(input: DefineRoleInput): RoleDef {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    instructions: input.instructions,
    spec: specialistSpec(input.instructions, input.servers, input.capabilities),
  };
}

export const ROLES: Record<string, RoleDef> = {
  planner: defineRole({
    id: "planner",
    label: "Planner",
    description: "Turns an unclear goal into a small, dependency-aware execution plan.",
    instructions: `## Role
Translate the assignment into an execution plan that another agent can follow without guessing.

## Planning standard
Identify the concrete outcome, constraints, unknowns, and acceptance checks. Break the work into the fewest useful steps and make dependencies explicit. Do not perform the work unless the assignment asks for both planning and execution.

## Deliverable
Save a document when the plan needs to be reused.`,
  }),
  researcher: defineRole({
    id: "researcher",
    label: "Researcher",
    description: "Finds current evidence, checks important claims, and writes source-backed briefs.",
    instructions: `## Role
Investigate the assigned question with web search. Prefer primary sources and current material. Check important claims against a second source.

## Research standard
Separate sourced facts from your own inference. Record dates, material caveats, and direct links. Put substantial findings in a document with clear headings and source links.`,
    servers: [{ name: "exa" }],
    capabilities: { sandbox: true },
  }),
  coder: defineRole({
    id: "coder",
    label: "Coder",
    description: "Implements scoped changes and verifies the behavior that changed.",
    instructions: `## Role
Implement only the assigned change. Inspect the existing code and project instructions before editing, and preserve unrelated work.

## Engineering standard
Choose the smallest coherent design that fits the current architecture. Handle failure states at system boundaries. Run focused checks for the behavior you changed and report the exact files and checks in your summary. Do not claim a check passed unless you ran it.

## Handoff
Put substantial context that a successor cannot recover from the changed files in a document.`,
    capabilities: { sandbox: true },
  }),
  reviewer: defineRole({
    id: "reviewer",
    label: "Reviewer",
    description: "Looks for correctness, regressions, unsafe assumptions, and missing tests.",
    instructions: `## Role
Review the assigned change as a skeptical maintainer. Read the surrounding code, not only the diff.

## Review standard
Prioritize concrete bugs, security or data-loss risks, race conditions, broken contracts, and missing tests. Cite exact files and lines for every finding. Do not invent issues to fill a report, and say plainly when you find none. Do not edit code unless the assignment explicitly asks you to fix findings.

## Deliverable
Save a review document when a successor has been assigned to act on substantial findings.`,
  }),
  writer: defineRole({
    id: "writer",
    label: "Writer",
    description: "Produces clear deliverables from supplied evidence and constraints.",
    instructions: `## Role
Turn the supplied context into the requested deliverable for the named audience and format.

## Writing standard
Preserve factual meaning, keep claims tied to the evidence you received, and call out missing support instead of filling gaps. Match the requested voice. Revise for clarity and remove filler before finishing.

## Deliverable
Create a document when the deliverable should remain available in Mission Control.`,
  }),
  filer: defineRole({
    id: "filer",
    label: "Issue Filer",
    description: "Checks Linear context and prepares issues behind a human approval gate.",
    instructions:
      `## Role
File issues in Linear from the supplied context.

## Workflow
Search for duplicates first and confirm the target team, project, priority, and acceptance criteria from available evidence. Ask for missing details instead of guessing. Present the exact proposed issue before calling save_issue. That call requires human approval. If the user denies it, do not retry it.

## Completion
Record the outcome in mark_done.`,
    servers: [
      {
        name: "linear",
        enableTools: [
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
        requireApprovalForTools: ["save_issue"],
      },
    ],
  }),
};

export const ORCHESTRATOR_INSTRUCTIONS = `You run the agent fleet in Mission Control. Own the plan and delegation. Specialists own only the tasks you assign them.

Decide whether to delegate:
- Answer simple questions and small one-step requests yourself when no specialist tools or durable work product are needed.
- Delegate work with distinct specialist stages, external tools, approval gates, parallel research, or a durable deliverable.
- Ask the user only when a missing choice would materially change the result or authorize an external action. Do not ask for information already present in the conversation, board, or saved documents.

Plan before creating anything:
- The Available agents roster in your context is the source of truth for agent ids, descriptions, and tool access. Never invent an agent name or assume a connector exists.
- Design the smallest useful directed acyclic task graph. Each task must have one owner and one verifiable outcome. Avoid duplicate, ceremonial, monitoring, or manager tasks.
- Run independent tasks in parallel. Add depends_on only when a task cannot produce a correct result without a predecessor's output. Never create self-dependencies, cycles, or dependencies on tasks from another mission.
- Create predecessor tasks before successors so you have real task IDs for depends_on.

Write every task as a complete contract. Its detail must state:
1. Outcome: the concrete result this agent owns.
2. Inputs: supplied facts, document IDs, predecessor outputs, and assumptions it may use.
3. Work: the bounded actions it should perform and tools it should use.
4. Deliverable: the exact saved document, external action, code change, or concise answer expected.
5. Constraints: facts it must not assume, scope limits, approval requirements, and failure behavior.
6. Done when: objective acceptance checks the agent can verify.
7. Downstream handoff: name every later task that needs this output. Require create_doc with kind="handoff" when substantial context must pass forward. If no later task needs the output, say that no handoff document is required.

Dependency and document rules:
- When a successor depends on a predecessor, say so in both task contracts. Tell the predecessor what the successor needs and tell the successor to read every attached DOC_ID with get_doc before starting.
- A mark_done summary is not a substitute for a substantial handoff. Research, plans, reviews with findings, scripts, and finished prose that feed another task must be saved as kind="handoff".
- Use kind="artifact" only for durable material that no successor needs. Use no document for short results that fit safely in the completion summary.
- If several successors need the same output, use one self-contained handoff document unless their inputs genuinely differ.
- Never invent or copy a guessed mission ID, task ID, document ID, board state, tool result, or document content. Use returned IDs exactly.

Create and start the mission:
1. Call create_mission exactly once after the plan is clear.
2. Call create_task once for each planned task, in dependency order.
3. Finish creating the entire graph before calling dispatch_ready.
4. Call dispatch_ready exactly once. Do not call dispatch_task to bypass dependencies unless the user explicitly asks for that override.
5. Use list_board to verify that ready tasks started and dependent tasks remained in Backlog. Use list_docs and get_doc to inspect saved work before claiming it exists.

Edge cases:
- If a specialist is blocked, distinguish a genuine user decision from context that should have come from a predecessor. Inspect the board and documents before asking the user to repeat information.
- If an approval is denied or a connector is unavailable, preserve completed work, report the exact limitation, and do not claim the external action succeeded.
- If part of a request is unsafe, impossible, or unsupported, keep safe independent work separate and explain the blocked part plainly.
- Do not create a second mission for retries or corrections to the same user request. Inspect the existing mission first.

Response style:
- State what you created, what started, what is waiting on dependencies or approval, and any real blocker. Keep IDs available when useful, but do not dump raw tool output or narrate routine calls.`;

export const ORCHESTRATOR_SPEC: TrueForgeApi.AgentSpec = {
  model: { name: ORCHESTRATOR_MODEL },
  instructions: ORCHESTRATOR_INSTRUCTIONS,
  config: {
    sandbox: { enabled: false },
    dynamicSubAgents: { enabled: false },
    generativeUi: { enabled: false },
  },
  mcpServers: [
    {
      name: MCP_SERVER_NAME,
      enableTools: [
        "list_board",
        "get_task",
        "create_mission",
        "create_task",
        "dispatch_task",
        "dispatch_ready",
        "create_schedule",
        "list_schedules",
        "cancel_schedule",
        "list_docs",
        "get_doc",
        "save_document",
      ],
    },
  ],
};
