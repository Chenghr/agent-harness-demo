// Design review probes: assertions below confirm gaps, not correct behavior.
// Uses temporary fixture data and a deterministic model; no real API requests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Harness } from "../server/harness.mjs";
import { deferred, delay } from "../server/core.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-design-check-"));
const gate = deferred();
let mainCalls = 0;
const h = new Harness({
  root,
  speed: 0,
  env: {},
  modelAdapter: {
    async complete({ agent }) {
      if (agent.parentId) throw new Error("CHILD_FAILURE_EVIDENCE");
      mainCalls++;
      await gate.promise;
      return { text: "Parent final response", calls: [] };
    },
  },
});

async function until(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, "timed out");
    await delay(5);
  }
}

try {
  const s = h.get(h.create({ prompt: "Review controlled inputs" }).id);
  await until(() => mainCalls === 1);
  const child = h.spawnAgent(s, s.agents.main, "Controlled failure");
  await until(() => s.agents[child.agentId].status === "failed" && h.controls.size === 1);
  const pendingFailures = s.agents.main.pendingMessages.length;
  gate.resolve();
  await until(() => h.controls.size === 0);
  assert.equal(pendingFailures, 0);
  assert.equal(mainCalls, 1);
  assert.equal(s.status, "completed");
  const result = {
    purpose: "design-gap reproduction, not acceptance tests",
    childFailureDelivery: {
      childFailed: true,
      pendingMessagesAfterFailure: pendingFailures,
      mainModelCalls: mainCalls,
      parentStatus: s.status,
    },
  };

  const t = h.get(h.create({ autoStart: false }).id);
  const a = t.agents.main;
  const definition = [...h.catalog.tools.values()].find((x) => x.simulated);
  await h.invoke(t, a, "tool_load", { name: definition.name });
  const replacement = structuredClone(definition);
  replacement.version = "2";
  replacement.parameters.properties.changed = { type: "string" };
  replacement.parameters.required = ["changed"];
  h.catalog.tools.set(definition.name, replacement);
  let validationError;
  try {
    await h.invoke(t, a, definition.name, { values: [1, 2] });
  } catch (error) {
    validationError = error.code;
  }
  assert.equal(validationError, "INVALID_ARGUMENT");
  result.toolVersionBinding = {
    loadedVersion: definition.version,
    subsequentDefinitionVersion: h.catalog.getTool(definition.name).version,
    oldArgumentsRejectedWith: validationError,
  };

  const skill = [...h.catalog.skills.values()].find((x) => x.resources.length);
  await h.invoke(t, a, "skill_load", { name: skill.name });
  const ref = skill.resources[0];
  fs.writeFileSync(path.join(path.dirname(skill.file), ref), "CHANGED_RESOURCE_AFTER_LOAD");
  const read = await h.invoke(t, a, "skill_read_resource", { name: skill.name, path: ref });
  assert.equal(read.content, "CHANGED_RESOURCE_AFTER_LOAD");
  result.skillResourceBinding = {
    skillBodySnapshotVersion: a.skillSnapshots[skill.name].version,
    changedResourceVisibleWithoutReload: true,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  gate.resolve();
  await h.close();
  fs.rmSync(root, { recursive: true, force: true });
}
