# UI audit

- [x] Show a task's predecessors in its drawer.
- [x] Keep internal task IDs out of the main UI.
- [x] Keep navigation in the same place between chat and the board.
- [x] Keep every kanban column heading the same height.
- [x] Hide the event log behind a disclosure arrow.
- [x] Render Markdown in chat.

- [x] Show real model cost, or remove cost if the provider does not report enough data.
- [x] Explain the difference between Blocked and Needs approval in the board UI.
- [x] Remove the red outline from task cards.

# Completed improvements

- [x] Use a sidebar with Command as the home screen.
- [x] Add Fleet, Schedules, Docs, and Agents sections.
- [x] Let agents create saved research and writing documents.
- [x] Store orchestrator conversations and let users reopen them.
- [x] Support reusable custom agents instead of limiting roles to three presets.
- [x] Provide six editable defaults: Planner, Researcher, Coder, Reviewer, Writer, and Issue Filer.
- [x] Rewrite the default agent and orchestrator prompts with concrete scope, workflow, and completion rules.
- [x] Store handoffs only when another task actually depends on the completed task.
- [x] Remove the divider below The Squad heading.
- [x] Remove the green handoff excerpt from kanban cards.
- [x] Keep Docs out of the chat history sidebar.
- [x] Show documents in their own sidebar on the Docs screen.
- [x] Make documents editable in one Notion-like surface with Markdown block shortcuts.
- [x] Autosave document changes after a short pause in typing.
- [x] Stream model text into chat as it arrives.

# Next improvements

- [x] Use a cheap model to generate chat titles.
- [x] Keep Mission as an internal task grouping and use task-focused language in the UI.
- [x] Replace raw tool-call chips with a human-readable live activity row and expandable technical detail.
- [x] Add a Fleet date dropdown. Default to today, with Yesterday, Past week, and Past month options closed but clicking on arrow shows them.
- [x] Improve agent task cards with clearer live state and useful metadata.
- [x] Add the human-readable, shimmering tool activity row to chat.
- [x] Add an expandable explanation for Blocked versus Needs approval.


# Next next improvements
lets commit what we have already done, start a new branch from here where we do this

- [x] agents are supported by truefoundry, so instead of generating agent ourselves, i think we should shift to that , there we will be able to customize tools for agents as well so that ll be good.
so we can have an agent called issue tracker agent which only has tools linear, jira, and github issues
a coder agent which will have access to sandbox and also allowed to spwan subagents
researcher agent only exa web search and (sandbox?) along with subagents thing
like this, think of clubbing tools and building efficient agents
- [x] prompts need to be heavily improved for orchestrator, it should know how to prompt a mission it is starting what kind of work to be delegated, and how output of work. like instead of getting handoff from one agent, it should i think create document if its extensive, so that document id will be preloaded in the successor agent started if it needs. or if the goal of the subagent was to create a script lets say content script it should just generate a doc and when we click on the agent card along with result we should be able to see hyperlink to doc
given above we should also customize the docs page, on what are user created what are agent created, think how we can effectively show user, maybe not even a sidebar, something like finder?

- remember we still keep the result field of the agent to certainly tell what it did, not extensive, if extensive it uses the doc

- [x] think of better ways of displaying the agent log, human readable
- [x] the ui on clicking agent card displays the information on the side, can we open a new page or sum, im not sure, this side ui doesnt feel good


# some ui changes
- [ ] in the tools connector thing in agents, make it like accordion, if clicked on exa, expand tools again click close with arrow, if tick on exa, all tools ticked. (for all tools exa is just example)
- You are a specialist agent in a fleet managed by Mission Control.
Complete only the assignment in your kickoff message. Do not broaden the mission or create more tasks.
Use create_doc when the useful output is a research note, brief, comparison, or other document that people should be able to read later. Pass your TASK_ID so Mission Control links the document to your task and mission.
When your work is complete, call mark_done exactly once. Keep the summary to two to four factual sentences. Put extensive output in a document instead of the summary.
If you create subagents, give each one a self-contained assignment and tell it not to call mark_done. Only you, the parent specialist, may finish the Mission Control task.
Add a handoff only when another task depends on unpublished context that is not already in a linked document.

can we hide this thing, because we re giving the same thing to each agent, and this is just our default behaviour
