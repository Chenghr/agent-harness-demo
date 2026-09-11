import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-"));
  const h = new Harness({ root, speed: 0 });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const s = h.get(h.create({ autoStart: false, prompt: "检查隐私标注" }).id);
  return { h, s, root };
}
test("companion reads archived evidence without changing the main task", async (t) => {
  const { h, s } = setup(t);
  h.context.add(s, s.agents.main, [{ role: "assistant", content: "样本 A17 的 end 不包含末尾" }]);
  const before = JSON.stringify({
    history: s.agents.main.history,
    grants: s.grants,
    chat: s.chat,
    revision: s.revision,
  });
  const result = await h.companion.ask(s.id, { text: "A17", query: "A17" });
  assert.equal(result.simulated, true);
  assert.ok(result.sources.some((e) => e.excerpt.includes("A17")));
  assert.equal(
    JSON.stringify({
      history: s.agents.main.history,
      grants: s.grants,
      chat: s.chat,
      revision: s.revision,
    }),
    before,
  );
  assert.equal(h.companion.snapshot(s.id).messages.length, 2);
});
test("feedback has explicit target, model and revision; never changes acceptance", async (t) => {
  const { h, s } = setup(t);
  const reply = await h.companion.ask(s.id, { text: "进展" });
  const before = s.status;
  const feedback = h.companion.feedback(s.id, {
    kind: "egg",
    target: { type: "companion", id: reply.id },
    reason: "解释不清楚",
  });
  assert.equal(feedback.kind, "egg");
  assert.equal(feedback.model, s.model);
  assert.equal(feedback.revision, s.revision);
  assert.equal(s.status, before);
  assert.throws(
    () => h.companion.feedback(s.id, { kind: "up", target: { type: "companion", id: "missing" } }),
    { code: "NOT_FOUND" },
  );
  assert.equal(h.companion.export(s.id).feedback.length, 1);
  h.companion.clear(s.id);
  assert.equal(h.companion.export(s.id).feedback.length, 0);
});
test("companion rejects concurrent chats and cancels owned calls", async (t) => {
  const { h, s } = setup(t);
  h.models.profiles[0].simulated = false;
  h.apiModel.complete = ({ signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  const p = h.companion.ask(s.id, { text: "hello" });
  await assert.rejects(h.companion.ask(s.id, { text: "second" }), { code: "COMPANION_BUSY" });
  h.companion.cancel(s.id);
  await assert.rejects(p);
  assert.equal(h.companion.active.size, 0);
});
test("feedback cannot point into another task", (t) => {
  const { h, s } = setup(t);
  const other = h.get(h.create({ autoStart: false }).id);
  h.chat(other, "assistant", "other task");
  assert.throws(
    () =>
      h.companion.feedback(s.id, {
        kind: "down",
        target: { type: "message", id: other.chat.at(-1).id },
      }),
    { code: "NOT_FOUND" },
  );
});
test("real-model companion admits only history reads and marks invented citations", async (t) => {
  const { h, s } = setup(t);
  h.models.profiles[0].simulated = false;
  h.context.add(s, s.agents.main, [{ role: "assistant", content: "A17 的边界检查已记录" }]);
  const event = h.store
    .events(s.id)
    .find((e) => e.type === "context.unit" && JSON.stringify(e).includes("A17"));
  const before = JSON.stringify(s.agents.main.history);
  let count = 0;
  h.apiModel.complete = async ({ input }) => {
    assert.deepEqual(
      input.tools.map((t) => t.function.name),
      ["history_search"],
    );
    if (++count === 1)
      return {
        text: "",
        calls: [
          {
            id: "forbidden",
            type: "function",
            function: { name: "file_write", arguments: '{"path":"bad.txt","content":"bad"}' },
          },
        ],
      };
    if (count === 2) {
      assert.match(JSON.stringify(input), /宠物只有历史读取能力/);
      return {
        text: "",
        calls: [
          {
            id: "read",
            type: "function",
            function: { name: "history_search", arguments: '{"query":"A17"}' },
          },
        ],
      };
    }
    return { text: `已有检查记录 [#${event.seq}]，另一个来源 [#999999]`, calls: [] };
  };
  const result = await h.companion.ask(s.id, { text: "解释一下 A17" });
  assert.match(result.text, /未核实引用 #999999/);
  assert.ok(result.sources.some((e) => e.seq === event.seq));
  assert.equal(JSON.stringify(s.agents.main.history), before);
  assert.equal(s.approvals.length, 0);
  assert.equal(fs.existsSync(path.join(s.workspace, "bad.txt")), false);
});
