import assert from "node:assert/strict";
import test from "node:test";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { ROLES, stripSpecialistRuntimeInstructions } from "./fleet";
import { reconcileManagedManifest } from "./agents";

test("reconciles role requirements while preserving the selected model and extra connectors", () => {
  const customInstructions = "Keep this user-edited instruction text exactly as the editable content.";
  const current: TrueForgeApi.AgentSpec = {
    model: { name: "stale-model" },
    instructions: customInstructions,
    config: {
      sandbox: { enabled: false, fileDownloads: false },
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: true },
    },
    mcpServers: [
      {
        name: "mission-control",
        enableTools: ["custom_tool", "mark_done"],
        disableTools: ["@all", "mark_done", "custom_disabled"],
        requireApprovalForTools: ["custom_tool"],
      },
      { name: "custom-connector", enableTools: ["custom_tool"], preload: true },
    ],
  };

  const reconciled = reconcileManagedManifest(current, ROLES.researcher);
  const missionControl = reconciled.mcpServers?.find((server) => server.name === "mission-control");

  assert.equal(reconciled.model.name, "stale-model");
  assert.equal(stripSpecialistRuntimeInstructions(reconciled.instructions ?? ""), customInstructions);
  assert.equal(reconciled.config?.sandbox?.enabled, true);
  assert.equal(reconciled.config?.sandbox?.fileDownloads, false);
  assert.equal(reconciled.config?.dynamicSubAgents?.enabled, true);
  assert.equal(reconciled.config?.generativeUi?.enabled, false);
  assert.ok(reconciled.mcpServers?.some((server) => server.name === "exa"));
  assert.ok(missionControl?.enableTools?.includes("custom_tool"));
  assert.ok(missionControl?.enableTools?.includes("create_doc"));
  assert.ok(!missionControl?.disableTools?.includes("@all"));
  assert.ok(!missionControl?.disableTools?.includes("mark_done"));
  assert.ok(missionControl?.disableTools?.includes("custom_disabled"));
  assert.deepEqual(
    reconciled.mcpServers?.find((server) => server.name === "custom-connector"),
    current.mcpServers?.find((server) => server.name === "custom-connector")
  );
});

test("keeps filer save_issue enabled and approval-gated, then becomes idempotent", () => {
  const current: TrueForgeApi.AgentSpec = {
    model: { name: ROLES.filer.spec.model.name },
    instructions: ROLES.filer.instructions,
    mcpServers: [
      {
        name: "linear",
        enableTools: ["custom_linear_tool"],
        disableTools: ["save_issue"],
        requireApprovalForTools: ["custom_linear_tool"],
      },
      { name: "extra-connector", enableTools: ["extra_tool"] },
    ],
  };

  const reconciled = reconcileManagedManifest(current, ROLES.filer);
  const linear = reconciled.mcpServers?.find((server) => server.name === "linear");

  assert.ok(linear?.enableTools?.includes("save_issue"));
  assert.ok(linear?.requireApprovalForTools?.includes("save_issue"));
  assert.ok(!linear?.disableTools?.includes("save_issue"));
  assert.ok(reconciled.mcpServers?.some((server) => server.name === "mission-control"));
  assert.ok(reconciled.mcpServers?.some((server) => server.name === "extra-connector"));
  assert.deepEqual(reconcileManagedManifest(reconciled, ROLES.filer), reconciled);
});
