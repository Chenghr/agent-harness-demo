import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDefinitionRegistry } from "../server/runtime/agent-definitions.ts";

const catalog = {
  tools: ["file_read", "file_write"],
  skills: ["inspect"],
  models: ["small", "large"],
};
const definition = {
  name: "general",
  description: "通用助手",
  tools: ["@catalog"],
  allowedSkills: ["inspect"],
  skills: ["inspect"],
  model: "inherit",
  allowedModels: ["@catalog"],
  permissionMode: "default",
  workspaceMode: "outputs",
  canDelegateTo: [],
  maxTurns: 20,
  maxCalls: 50,
  timeoutMs: 1000,
};
function config(t: test.TestContext, patch: Record<string, unknown> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-definitions-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, "general.md"),
    `---\n${JSON.stringify({ ...definition, ...patch })}\n---\n根据分配材料工作。\n`,
  );
  return directory;
}
test("definition exclusions take priority and callers cannot mutate stored configuration", (t) => {
  const registry = new AgentDefinitionRegistry(
    config(t, { disallowedTools: ["file_write"] }),
    catalog,
  );
  const first = registry.get();
  assert.deepEqual(first.tools, ["file_read"]);
  first.tools.push("file_write");
  first.instructions = "changed";
  const next = registry.get();
  assert.deepEqual(next.tools, ["file_read"]);
  assert.equal(next.instructions, "根据分配材料工作。");
  assert.equal(first.version, next.version);
});
test("invalid capability names and unsupported config fail explicitly", (t) => {
  for (const patch of [
    { tools: ["@catalog", "missing"] },
    { skills: ["missing"] },
    { model: "missing" },
    { permissionMode: "bypass" },
    { workspaceMode: "host" },
    { canDelegateTo: ["missing"] },
    { maxCalls: 0 },
    { unknownField: true },
  ])
    assert.throws(() => new AgentDefinitionRegistry(config(t, patch), catalog), {
      code: "AGENT_CONFIG",
    });
});
test("duplicate assistant names are rejected at startup", (t) => {
  const directory = config(t);
  fs.copyFileSync(path.join(directory, "general.md"), path.join(directory, "duplicate.md"));
  assert.throws(() => new AgentDefinitionRegistry(directory, catalog), { code: "AGENT_CONFIG" });
});

test("preloaded skills obey the same active limit as later loading", (t) => {
  const skills = Array.from({ length: 9 }, (_, i) => `skill-${i}`);
  assert.throws(
    () =>
      new AgentDefinitionRegistry(config(t, { allowedSkills: skills, skills }), {
        ...catalog,
        skills,
      }),
    { code: "AGENT_CONFIG" },
  );
});
