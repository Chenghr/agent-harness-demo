import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { delay, ProcessManager, Semaphore } from "../server/core.mjs";

const answer = {
  async complete() {
    return { text: "已检查分配的材料，结论待主助手核实。", calls: [] };
  },
};
async function until(fn) {
  const end = Date.now() + 3000;
  while (!fn()) {
    assert.ok(Date.now() < end, "timed out");
    await delay(5);
  }
}
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-subagents-"));
  const h = new Harness({ root, env: {}, speed: 0, modelAdapter: answer, ...options });
  t.after(async () => {
    for (const s of h.sessions.values()) await h.stop(s.id);
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const s = h.get(h.create({ autoStart: false, scenario: "custom", prompt: "检查已分配材料" }).id);
  return { h, s, a: s.agents.main };
}

test("general assistant accepts a new kind of task without a custom definition", async (t) => {
  const { h, s, a } = setup(t);
  fs.writeFileSync(path.join(s.workspace, "notes.txt"), "指定材料");
  const ref = await h.spawnAgent(s, a, {
    goal: "比较材料中的两个观点",
    files: ["notes.txt"],
    expectedOutput: "差异和依据",
  });
  const child = s.agents[ref.agentId];
  assert.equal(child.delegation.type, "general");
  assert.equal(child.model, a.model);
  await until(() => child.output);
  assert.equal(child.output.status, "needs_review");
  assert.ok(child.output.resultId);
  assert.ok(!fs.existsSync(path.join(h.workspace(s, child), "cart.mjs")));
});

test("child context and history cannot expose unrelated parent evidence", async (t) => {
  const { h, s, a } = setup(t, {
    modelAdapter: {
      async complete({ signal }) {
        await delay(10000, signal);
        return answer.complete();
      },
    },
  });
  h.context.add(s, a, [{ role: "user", content: "PRIVATE_PARENT_EVIDENCE" }]);
  const art = h.artifact(s, "private.txt", "PRIVATE_PARENT_EVIDENCE");
  const ref = await h.spawnAgent(s, a, { goal: "只分析自己的说明" }),
    child = s.agents[ref.agentId];
  const input = h.context.build(s, child, h.models.get(child.model));
  assert.ok(!JSON.stringify(input).includes("PRIVATE_PARENT_EVIDENCE"));
  assert.ok(!input.tools.some((t) => t.function.name === "agent_spawn"));
  assert.equal(
    (await h.invoke(s, child, "history_search", { query: "PRIVATE_PARENT_EVIDENCE" })).total,
    0,
  );
  await assert.rejects(h.invoke(s, child, "artifact_read", { id: art.id }), {
    code: "PATH_DENIED",
  });
  await assert.rejects(h.invoke(s, child, "file_read", { path: "cart.mjs" }), {
    code: "PATH_DENIED",
  });
  await assert.rejects(h.invoke(s, child, "agent_spawn", { goal: "再开一个" }), {
    code: "POLICY_DENIED",
  });
});

const waitingModel = {
  async complete({ signal }) {
    await delay(10000, signal);
    return answer.complete();
  },
};
function definitions(t, changes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-custom-assistants-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["general", "analysis", "review"]) {
    const source = fs.readFileSync(new URL(`../config/agents/${name}.md`, import.meta.url), "utf8");
    const [, head, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
    fs.writeFileSync(
      path.join(directory, `${name}.md`),
      `---\n${JSON.stringify({ ...JSON.parse(head), ...changes[name] })}\n---\n${body}`,
    );
  }
  return directory;
}

test("model selection follows explicit choice, configured default, then parent inheritance", async (t) => {
  const agentDefinitionsDir = definitions(t, {
    analysis: { model: "demo-focused", allowedModels: ["demo-focused", "demo-balanced"] },
    review: { allowedModels: ["demo-focused"] },
  });
  const { h, s, a } = setup(t, { modelAdapter: waitingModel, agentDefinitionsDir });
  assert.equal(
    h.spawnAgent(s, a, { goal: "检查默认模型", type: "analysis" }).model,
    "demo-focused",
  );
  assert.equal(
    h.spawnAgent(s, a, { goal: "检查显式模型", type: "analysis", model: "demo-balanced" }).model,
    "demo-balanced",
  );
  assert.equal(h.spawnAgent(s, a, { goal: "继承父模型" }).model, "demo-balanced");
  assert.throws(
    () =>
      h.spawnAgent(s, a, { goal: "不能用被禁止的模型", type: "review", model: "demo-balanced" }),
    { code: "POLICY_DENIED" },
  );
  a.model = "demo-focused";
  assert.ok(Object.values(s.agents).some((c) => c.parentId && c.model === "demo-balanced"));
});

test("nested assistants cannot regain ancestor tools, models, or write access", async (t) => {
  const agentDefinitionsDir = definitions(t, {
    analysis: { canDelegateTo: ["general"], allowedModels: ["demo-balanced"], allowedSkills: [] },
    general: { canDelegateTo: ["general"] },
  });
  const { h, s, a } = setup(t, { modelAdapter: waitingModel, agentDefinitionsDir });
  const parent = s.agents[h.spawnAgent(s, a, { goal: "只读分工", type: "analysis" }).agentId];
  const child = s.agents[h.spawnAgent(s, parent, { goal: "继承只读范围" }).agentId];
  await assert.rejects(h.invoke(s, child, "tool_load", { name: "file_write" }), {
    code: "POLICY_DENIED",
  });
  assert.equal(child.delegation.definition.workspaceMode, "read");
  assert.deepEqual(child.delegation.definition.allowedSkills, []);
  assert.throws(
    () => h.spawnAgent(s, parent, { goal: "尝试扩大模型范围", model: "demo-focused" }),
    { code: "POLICY_DENIED" },
  );
  assert.throws(() => h.spawnAgent(s, child, { goal: "超过深度" }), { code: "AGENT_DEPTH" });
});

test("dontAsk rejects unapproved writes without creating an approval request", async (t) => {
  const agentDefinitionsDir = definitions(t, { general: { permissionMode: "dontAsk" } });
  const { h, s, a } = setup(t, { modelAdapter: waitingModel, agentDefinitionsDir });
  const child = s.agents[h.spawnAgent(s, a, { goal: "不能自行申请授权" }).agentId];
  await h.invoke(s, child, "tool_load", { name: "file_write" });
  await assert.rejects(h.invoke(s, child, "file_write", { path: "outputs/a.txt", content: "no" }), {
    code: "APPROVAL_DENIED",
  });
  assert.equal(s.approvals.length, 0);
});

test("unconfirmed child resources prevent successful completion and remain visible", async (t) => {
  const { h, s, a } = setup(t);
  const child = s.agents[h.spawnAgent(s, a, { goal: "资源未确认", mode: "foreground" }).agentId];
  const list = h.processes.list.bind(h.processes);
  const resource = {
    id: "unconfirmed-test-resource",
    sessionId: s.id,
    agentId: child.id,
    status: "cleanup_unconfirmed",
  };
  h.processes.list = () => [resource];
  try {
    await assert.rejects(h.invoke(s, a, "agent_spawn", { goal: "清理未确认时不能继续委派" }), {
      code: "CLEANUP_FAILED",
    });
    h.launch(s, a);
    await until(() => !h.controller(s, a).running && s.status === "failed");
    assert.notEqual(s.status, "completed");
    assert.equal(child.output.cleanup, "unconfirmed");
    assert.equal(h.snapshot(s.id).agents[child.id].status, "interrupted");
    await assert.rejects(h.cancelAgent(s.id, child.id), { code: "CLEANUP_FAILED" });
  } finally {
    h.processes.list = list;
  }
});
test("child writes only its own outputs and approvals cannot leak between helpers", async (t) => {
  const { h, s, a } = setup(t, { modelAdapter: waitingModel });
  const one = await h.spawnAgent(s, a, { goal: "生成自己的成果" }),
    child = s.agents[one.agentId];
  await h.invoke(s, child, "tool_load", { name: "file_write" });
  s.grants.push({ id: "parent-only", tool: "file_write", path: "outputs/report.txt" });
  const write = h.invoke(s, child, "file_write", {
    path: "outputs/report.txt",
    content: "child evidence",
  });
  await until(() => s.approvals.length === 1);
  assert.equal(s.approvals[0].agentId, child.id);
  h.approve(s.id, s.approvals[0].id, "task");
  const written = await write;
  assert.equal(
    (await h.invoke(s, child, "artifact_read", { id: written.artifactId })).content,
    "child evidence",
  );
  assert.equal(s.grants.at(-1).agentId, child.id);
  await assert.rejects(h.invoke(s, child, "file_write", { path: "report.txt", content: "bad" }), {
    code: "POLICY_DENIED",
  });
  const two = await h.spawnAgent(s, a, { goal: "另一个成果" }),
    sibling = s.agents[two.agentId];
  await h.invoke(s, sibling, "tool_load", { name: "file_write" });
  const rejected = h.invoke(s, sibling, "file_write", {
    path: "outputs/report.txt",
    content: "sibling",
  });
  await until(() => s.approvals.length === 2);
  h.approve(s.id, s.approvals[1].id, "deny");
  await assert.rejects(rejected, { code: "APPROVAL_DENIED" });
  await assert.rejects(h.invoke(s, sibling, "artifact_read", { id: written.artifactId }), {
    code: "PATH_DENIED",
  });
});

test("revocation while a child waits for its write lock prevents the write", async (t) => {
  const { h, s, a } = setup(t, { modelAdapter: waitingModel });
  const ref = h.spawnAgent(s, a, { goal: "生成自己的成果" }),
    child = s.agents[ref.agentId];
  await h.invoke(s, child, "tool_load", { name: "file_write" });
  const lock = new Semaphore(1),
    release = await lock.acquire();
  h.writeLocks.set(h.key(s, child), lock);
  s.grants.push({
    id: "child-only",
    agentId: child.id,
    tool: "file_write",
    path: "outputs/report.txt",
  });
  const write = h.invoke(s, child, "file_write", {
    path: "outputs/report.txt",
    content: "must not write",
  });
  await until(() => lock.queue.length === 1);
  h.revoke(s.id);
  release();
  await assert.rejects(write, { code: "APPROVAL_DENIED" });
  assert.ok(!fs.existsSync(path.join(h.workspace(s, child), "outputs/report.txt")));
});

test("stopping a branch prevents another descendant before cancellation drains", async (t) => {
  const { h, s, a } = setup(t, { modelAdapter: waitingModel });
  const ref = h.spawnAgent(s, a, { goal: "检查" }),
    child = s.agents[ref.agentId];
  const stopping = h.cancelAgent(s.id, child.id);
  assert.throws(() => h.spawnAgent(s, child, { goal: "不得再创建" }), { code: "CLOSING" });
  assert.equal(
    h.supervisor(s).cancelTree(child.id, a.id),
    h.supervisor(s).cancelTree(child.id, a.id),
  );
  await stopping;
  assert.equal(child.output.status, "cancelled");
  assert.equal(
    h.store
      .events(s.id)
      .filter((e) => e.type === "inbox.received" && e.data.message.source === "child").length,
    1,
  );
});

test("steering the main task cancels old helpers and preserves their recorded result", async (t) => {
  const { h, s, a } = setup(t, { modelAdapter: waitingModel });
  h.launch(s, a);
  await until(() => a.status === "thinking");
  const ref = h.spawnAgent(s, a, { goal: "旧目标的检查" }),
    child = s.agents[ref.agentId];
  h.message(s.id, "新的工作目标", "steer");
  await until(() => child.output);
  assert.equal(child.output.status, "cancelled");
  assert.ok(h.subagentWorkspace.stale(s, child));
});

test("explicit model selection and source-file freshness are recorded", async (t) => {
  const { h, s, a } = setup(t, { modelAdapter: waitingModel });
  fs.writeFileSync(path.join(s.workspace, "source.txt"), "first");
  const ref = h.spawnAgent(s, a, {
      goal: "对照资料",
      files: ["source.txt"],
      model: "demo-focused",
    }),
    child = s.agents[ref.agentId];
  assert.equal(child.model, "demo-focused");
  assert.equal(h.subagentWorkspace.stale(s, child), false);
  fs.writeFileSync(path.join(s.workspace, "source.txt"), "changed");
  assert.equal(h.subagentWorkspace.stale(s, child), true);
  assert.equal(fs.readFileSync(path.join(h.workspace(s, child), "source.txt"), "utf8"), "first");
  assert.throws(() => h.spawnAgent(s, a, { goal: "无效模型", model: "unknown" }), {
    code: "MODEL_NOT_FOUND",
  });
});

test("readonly helper rejects direct writes and tool loading despite a parent grant", async (t) => {
  const { h, s, a } = setup(t, {
    modelAdapter: {
      async complete({ signal }) {
        await delay(10000, signal);
        return answer.complete();
      },
    },
  });
  const ref = await h.spawnAgent(s, a, { type: "analysis", goal: "只读分析" }),
    child = s.agents[ref.agentId];
  s.grants.push({ id: "parent", tool: "file_write", path: "outputs/x.txt" });
  await assert.rejects(h.invoke(s, child, "tool_load", { name: "file_write" }), {
    code: "POLICY_DENIED",
  });
  await assert.rejects(
    h.invoke(s, child, "file_write", { path: "outputs/x.txt", content: "bad" }),
    { code: "POLICY_DENIED" },
  );
});

test("failed input setup produces a failed child and never leaves an idle waiter", async (t) => {
  const { h, s, a } = setup(t);
  const prepare = h.subagentWorkspace.prepare.bind(h.subagentWorkspace);
  h.subagentWorkspace.prepare = () => {
    throw new Error("DISK_SETUP_FAILED");
  };
  const ref = await h.spawnAgent(s, a, { goal: "启动失败" });
  h.subagentWorkspace.prepare = prepare;
  await until(() => s.agents[ref.agentId].output);
  assert.equal(s.agents[ref.agentId].output.status, "failed");
  const result = await h.waitChildren(s, a, new AbortController().signal);
  assert.equal(result.agents[0].status, "failed");
});

test("cancellation between input preparation and launch never starts the child model", async (t) => {
  const called = [];
  const { h, s, a } = setup(t, {
    modelAdapter: {
      async complete({ agent }) {
        called.push(agent.id);
        return answer.complete();
      },
    },
  });
  let cancelled;
  const stopOnSpawn = (e) => {
    if (e.type === "agent.spawned") cancelled = h.cancelAgent(s.id, e.agentId);
  };
  h.on("event", stopOnSpawn);
  const ref = h.spawnAgent(s, a, { goal: "创建时取消", mode: "foreground" });
  h.off("event", stopOnSpawn);
  await cancelled;
  const child = s.agents[ref.agentId];
  assert.equal(child.output.status, "cancelled");
  assert.ok(!called.includes(child.id));
  assert.equal(h.supervisor(s).live(child), false);
});

test("long foreground results retain a stable receipt and readable full conclusion", async (t) => {
  const content = "这是有依据的完整结论。".repeat(400);
  const { h, s, a } = setup(t, {
    modelAdapter: {
      async complete() {
        return { text: content, calls: [] };
      },
    },
  });
  const receipt = await h.invoke(s, a, "agent_spawn", { goal: "返回较长结论", mode: "foreground" });
  assert.ok(receipt.resultId);
  assert.ok(receipt.textArtifactId);
  assert.equal(receipt.textTruncated, true);
  assert.equal(s.agents[receipt.agentId].output.text, content);
  const full = h.store.readArtifact(s.id, receipt.textArtifactId);
  assert.equal(full.content, content);
  assert.equal(
    (await h.invoke(s, a, "artifact_read", { id: receipt.textArtifactId })).total,
    content.length,
  );
});

test("foreground delegation works with one model slot and no duplicate mailbox result", async (t) => {
  const { h, s, a } = setup(t, { modelConcurrency: 1 });
  const result = await h.invoke(s, a, "agent_spawn", { goal: "检查", mode: "foreground" });
  assert.equal(result.status, "needs_review");
  assert.ok(result.resultId);
  assert.equal(a.pendingMessages.filter((m) => m.source === "child").length, 0);
  assert.equal(h.modelSlots.active, 0);
});

test("the main model can delegate and receive a foreground result with one model slot", async (t) => {
  const calls = [];
  const { h, s, a } = setup(t, {
    modelConcurrency: 1,
    modelAdapter: {
      async complete({ agent, input }) {
        calls.push(agent.id);
        if (agent.parentId) return answer.complete();
        if (calls.length === 1)
          return {
            text: "分配检查",
            calls: [
              {
                id: "foreground-from-model",
                type: "function",
                function: {
                  name: "agent_spawn",
                  arguments: JSON.stringify({ goal: "核对材料", mode: "foreground" }),
                },
              },
            ],
          };
        assert.ok(JSON.stringify(input.messages).includes("resultId"));
        return answer.complete();
      },
    },
  });
  h.launch(s, a);
  await until(() => s.closing && !h.controller(s, a).running);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "main");
  assert.notEqual(calls[1], "main");
  assert.equal(calls[2], "main");
  assert.equal(
    h.store
      .events(s.id)
      .filter((e) => e.type === "inbox.received" && e.data.message.source === "child").length,
    0,
  );
  assert.equal(s.status, "needs_review");
});

test("symlink aliases cannot read other assistants or overwrite assigned inputs", async (t) => {
  const { h, s, a } = setup(t, { modelAdapter: waitingModel });
  fs.writeFileSync(path.join(s.workspace, "input.txt"), "original");
  const ref = h.spawnAgent(s, a, { goal: "生成成果", files: ["input.txt"] }),
    child = s.agents[ref.agentId];
  const workspace = h.workspace(s, child);
  fs.symlinkSync("agents", path.join(s.workspace, "alias"));
  await assert.rejects(h.invoke(s, a, "file_read", { path: `alias/${child.id}/input.txt` }), {
    code: "PATH_DENIED",
  });
  fs.mkdirSync(path.join(workspace, "outputs"));
  fs.symlinkSync("../input.txt", path.join(workspace, "outputs", "alias.txt"));
  await h.invoke(s, child, "tool_load", { name: "file_write" });
  s.grants.push({ agentId: child.id, tool: "file_write", path: "outputs/alias.txt" });
  await assert.rejects(
    h.invoke(s, child, "file_write", { path: "outputs/alias.txt", content: "bad" }),
    { code: "POLICY_DENIED" },
  );
  fs.symlinkSync("../input.txt", path.join(workspace, "outputs", "safe.txt.harness-tmp"));
  s.grants.push({ agentId: child.id, tool: "file_write", path: "outputs/safe.txt" });
  await h.invoke(s, child, "file_write", { path: "outputs/safe.txt", content: "safe output" });
  assert.equal(fs.readFileSync(path.join(workspace, "input.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(workspace, "outputs", "safe.txt"), "utf8"), "safe output");
});

test("same spawn call is idempotent and finished children release live capacity", async (t) => {
  const { h, s, a } = setup(t, { maxAgents: 1 });
  const request = { goal: "一次检查", mode: "foreground" };
  const first = await h.invoke(s, a, "agent_spawn", request, { callId: "same-call" });
  const repeated = await h.invoke(s, a, "agent_spawn", request, { callId: "same-call" });
  assert.equal(first.agentId, repeated.agentId);
  const next = await h.invoke(s, a, "agent_spawn", request, { callId: "next-call" });
  assert.notEqual(next.agentId, first.agentId);
});

test("historical finished nodes without new result metadata do not hold live capacity", async (t) => {
  const { h, s, a } = setup(t, { maxAgents: 1 });
  const old = h.agent(s, { agentId: "old-format", parentId: a.id, goal: "旧记录", model: a.model });
  old.status = "completed";
  old.result = "旧记录中的结果";
  const next = await h.invoke(s, a, "agent_spawn", { goal: "新的工作", mode: "foreground" });
  assert.equal(next.status, "needs_review");
  assert.equal(h.supervisor(s).live(old), false);
});

test(
  "group leader exit does not leave an untracked ordinary descendant",
  { timeout: 10000 },
  async (t) => {
    if (process.platform === "win32") return t.skip("POSIX");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-process-audit-"));
    const manager = new ProcessManager(() => {});
    let result;
    try {
      result = await manager.run({
        sessionId: "test",
        agentId: "main",
        cwd: root,
        timeout: 3000,
        args: [
          "-e",
          "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});console.log(c.pid);process.exit(0);",
        ],
      });
      const pid = Number(result.output.trim());
      assert.throws(() => process.kill(pid, 0));
      assert.equal(manager.list().length, 0);
    } finally {
      if (result?.pid)
        try {
          process.kill(-result.pid, "SIGKILL");
        } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
