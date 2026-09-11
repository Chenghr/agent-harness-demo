import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiModel, ModelRegistry } from "../server/models.mjs";
import { Harness } from "../server/harness.mjs";
import { settingsRoute } from "../server/settings/routes.mjs";
import { summarizeWithModel } from "../server/context/summarizer.mjs";
import { managementReviewer } from "../server/capability-reviewer.mjs";
import { modelExchange } from "../server/model-history.mjs";
import { compareImport } from "../server/conflict-review.mjs";
import { capabilityRoute } from "../server/capability-routes.mjs";

// Protocol fixtures, never requests to DeepSeek or claims about model quality.
const stream = (events) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
function configured(t, protocol = "chat-completions", effort = "high") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-protocol-"));
  const h = new Harness({ root, env: {}, speed: 0 });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const provider = h.models.settings.saveProvider({
    name: "Protocol fixture",
    baseUrl: "https://api.deepseek.com",
    protocol,
    apiKey: "fixture-secret",
  });
  const profile = h.models.settings.saveModel({
    providerId: provider.id,
    modelName: "fixture-model",
    contextWindow: 32000,
    maxOutput: 4000,
    tools: true,
    maxTokensField: "max_tokens",
    reasoningEfforts: ["none", "high"],
    effort,
  });
  return { h, profile: h.models.get(profile.id), provider };
}
function strictProvider(protocol, seen) {
  let sequence = 0;
  return async (url, options) => {
    assert.ok(url.startsWith("https://api.deepseek.com/"));
    assert.equal(options.headers.Authorization, "Bearer fixture-secret");
    const body = JSON.parse(options.body);
    seen.push(body);
    const messages = protocol === "responses" ? body.input : body.messages;
    const thinking =
      protocol === "responses"
        ? body.reasoning?.effort !== "none"
        : body.thinking?.type !== "disabled";
    if (thinking && protocol === "chat-completions") {
      for (const message of messages.filter((m) => m.role === "assistant"))
        assert.match(
          message.reasoning_content ?? "",
          /^fixture-state-/,
          "continuation must retain every assistant reasoning field",
        );
    }
    if (thinking && protocol === "responses") {
      for (const item of messages.filter((m) => ["function_call", "message"].includes(m.type))) {
        const index = messages.indexOf(item);
        assert.equal(
          messages[index - 1]?.type,
          "reasoning",
          "provider output must be replayed with reasoning",
        );
      }
      assert.ok(
        !messages.some((m) => m.role === "assistant" && !m.type),
        "reasoning-bearing messages must not become neutral history",
      );
    }
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const hasResult = messages
      .slice(lastUser + 1)
      .some((m) => m.role === "tool" || m.type === "function_call_output");
    const tool =
      body.tools?.length === 1 ? (body.tools[0].function?.name ?? body.tools[0].name) : "file_list";
    const useTool = !hasResult && !!body.tools?.length;
    const args =
      tool === "connection_probe"
        ? { ok: true }
        : tool === "history_search"
          ? { query: "测试" }
          : {};
    const callId = `call-${++sequence}`;
    const state = `fixture-state-${sequence}`;
    if (protocol === "chat-completions")
      return stream([
        ...(thinking ? [{ choices: [{ delta: { reasoning_content: state } }] }] : []),
        {
          choices: [
            {
              delta: useTool
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: callId,
                        type: "function",
                        function: { name: tool, arguments: JSON.stringify(args) },
                      },
                    ],
                  }
                : { content: "测试完成，请用户核实" },
              finish_reason: useTool ? "tool_calls" : "stop",
            },
          ],
        },
      ]);
    const output = [
      ...(thinking
        ? [
            {
              type: "reasoning",
              id: `r-${sequence}`,
              content: [{ type: "reasoning_text", text: state }],
            },
          ]
        : []),
      useTool
        ? { type: "function_call", call_id: callId, name: tool, arguments: JSON.stringify(args) }
        : {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "测试完成，请用户核实" }],
          },
    ];
    return stream([
      ...(!useTool ? [{ type: "response.output_text.delta", delta: "测试完成，请用户核实" }] : []),
      { type: "response.completed", response: { output } },
    ]);
  };
}

test("DeepSeek streamed reasoning is preserved separately from visible text", async () => {
  const registry = new ModelRegistry({
    LLM_BASE_URL: "https://api.deepseek.com",
    LLM_API_KEY: "fixture",
    LLM_MODEL: "fixture",
    LLM_PROTOCOL: "chat-completions",
  });
  let request;
  const adapter = new ApiModel(registry, async (_, options) => {
    request = JSON.parse(options.body);
    return stream([
      { choices: [{ delta: { reasoning_content: "fixture-" } }] },
      {
        choices: [
          { delta: { reasoning_content: "state", content: "可见回答" }, finish_reason: "stop" },
        ],
      },
    ]);
  });
  const text = [];
  const result = await adapter.complete({
    agent: { model: "api-primary", history: [] },
    input: { messages: [{ role: "user", content: "测试" }], tools: [] },
    profile: registry.get("api-primary"),
    signal: new AbortController().signal,
    onDelta: (chunk) => text.push(chunk),
  });
  assert.equal(result.rawResponse[0].reasoning_content, "fixture-state");
  assert.equal(result.text, "可见回答");
  assert.deepEqual(text, ["可见回答"]);
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.max_completion_tokens, undefined);
});

for (const protocol of ["chat-completions", "responses"]) {
  for (const effort of ["none", "high"])
    test(`${protocol}: saved DeepSeek model completes the connection tool round trip (${effort})`, async (t) => {
      const { h, profile } = configured(t, protocol, effort);
      const seen = [];
      h.apiModel.fetcher = strictProvider(protocol, seen);
      const result = await settingsRoute(h, ["settings", "test"], "POST", async () => ({
        modelId: profile.id,
      }));
      assert.equal(result.toolRoundTrip, true);
      assert.equal(seen.length, 2);
      if (protocol === "responses") assert.equal(seen[0].reasoning.effort, effort);
      else {
        assert.deepEqual(seen[0].thinking, { type: effort === "none" ? "disabled" : "enabled" });
        assert.equal(seen[0].reasoning_effort, effort === "none" ? undefined : effort);
      }
    });
  test(`${protocol}: main task, later user turn, child and pet all retain protocol state`, async (t) => {
    const { h, profile } = configured(t, protocol);
    const seen = [];
    h.apiModel.fetcher = strictProvider(protocol, seen);
    const s = h.get(
      h.create({ model: profile.id, autoStart: false, prompt: "测试：只读列出文件，不要修改文件" })
        .id,
    );
    const a = s.agents.main;
    await h.launch(s, a);
    assert.notEqual(s.status, "failed", a.error);
    assert.ok(a.history.some((u) => u.rawResponse));
    h.message(s.id, "再检查一次文件列表", "append");
    await h.controller(s, a).completion;
    assert.notEqual(s.status, "failed", a.error);
    assert.ok(
      s.actions.filter((v) => v.tool === "file_list" && v.status === "succeeded").length >= 2,
    );
    const childSession = h.get(
      h.create({ model: profile.id, autoStart: false, prompt: "测试后台助手" }).id,
    );
    const child =
      childSession.agents[
        h.spawnAgent(childSession, childSession.agents.main, {
          goal: "只读检查分配材料",
          mode: "background",
        }).agentId
      ];
    await h.controller(childSession, child).completion;
    assert.notEqual(child.status, "failed", child.error);
    await h.controller(childSession, childSession.agents.main).completion;
    const before = JSON.stringify(a.history);
    const answer = await h.companion.ask(s.id, { text: "解释测试记录", query: "测试" });
    assert.equal(answer.simulated, false);
    assert.equal(JSON.stringify(a.history), before);
    assert.ok(seen.length >= 8);
  });
}

test("summary and approval keep the pinned provider when overriding output limits", async (t) => {
  const { h, profile, provider } = configured(t);
  let calls = 0;
  h.apiModel.fetcher = async (url, options) => {
    assert.ok(url.startsWith("https://api.deepseek.com/"));
    assert.equal(options.headers.Authorization, "Bearer fixture-secret");
    calls++;
    return stream([
      {
        choices: [
          {
            delta: {
              content:
                calls === 1 ? "测试摘要 [unit_source]" : '{"decision":"allow","reason":"本机测试"}',
            },
            finish_reason: "stop",
          },
        ],
      },
    ]);
  };
  h.models.settings.saveProvider({ ...provider, apiKey: "new-fixture-secret" });
  const summary = await summarizeWithModel(h, {
    previous: "",
    units: [{ id: "unit_source", messages: [{ role: "user", content: "测试资料" }] }],
    profile,
    budget: 500,
    signal: new AbortController().signal,
  });
  assert.equal(summary, "测试摘要 [unit_source]");
  // Resolve the pinned snapshot here to model a request already prepared before settings changed.
  const get = h.models.get.bind(h.models);
  h.models.get = (id) => (id === profile.id ? profile : get(id));
  const review = await h.permissions.review(
    { model: profile.id, userRequirements: ["测试"], workspace: "test" },
    { tool: "shell_run", args: { command: "pwd" } },
    new AbortController().signal,
  );
  assert.equal(review.decision, "allow");
  assert.equal(calls, 2);
});

test("web-created real models are accepted by independent Skill evaluation", async (t) => {
  const { h, profile } = configured(t);
  h.apiModel.fetcher = async () =>
    stream([{ choices: [{ delta: { content: '{"grades":[]}' }, finish_reason: "stop" }] }]);
  const result = await managementReviewer(h)({
    kind: "quality",
    model: profile.id,
    item: { name: "fixture", kind: "skill", claims: {}, dependencies: [], scan: {} },
    files: { "SKILL.md": "测试规则" },
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { grades: [] });
  await assert.rejects(
    managementReviewer(h)({ kind: "quality", model: "demo-balanced" }),
    /真实模型/,
  );
});

test("management routes and import comparison accept configured model identities rather than ID prefixes", async (t) => {
  const { h, profile } = configured(t);
  const item = h.catalog.library.items().find((i) => i.kind === "skill");
  let submitted;
  h.evaluations.start = (...args) => {
    submitted = args;
    return { id: "test-job" };
  };
  const job = await capabilityRoute({
    harness: h,
    parts: ["management", "evaluate"],
    method: "POST",
    url: new URL("http://localhost/"),
    read: async () => ({ ids: [item.id], kind: "quality", model: profile.id }),
  });
  assert.equal(job.id, "test-job");
  assert.equal(submitted[2], profile.id);
  const files = { "SKILL.md": "---\nname: web-model-review\ndescription: 本机测试\n---\n测试说明" };
  const first = h.catalog.library.import({ kind: "skill", source: "fixture-a", files });
  h.catalog.library.resolve(first.id, { action: "keep", directories: ["root"] });
  const pending = h.catalog.library.import({
    kind: "skill",
    source: "fixture-b",
    files: { "SKILL.md": files["SKILL.md"] + "\n新版" },
  });
  let called = false;
  h.apiModel.fetcher = async () => {
    called = true;
    return stream([
      { choices: [{ delta: { content: '{"relations":[]}' }, finish_reason: "stop" }] },
    ]);
  };
  await compareImport(h, pending.id, profile.id);
  assert.ok(called);
});

for (const protocol of ["chat-completions", "responses"])
  test(`${protocol}: compression archives whole provider state and switching removes it`, async (t) => {
    const { h, profile } = configured(t, protocol);
    const source = h.get(
      h.create({ model: profile.id, autoStart: false, prompt: "只读测试，保留已完成文件检查" }).id,
    );
    const seen = [];
    h.apiModel.fetcher = strictProvider(protocol, seen);
    await h.launch(source, source.agents.main);
    // Compact an open conversation; completed tasks have already closed their execution scope.
    const s = h.get(h.create({ model: profile.id, autoStart: false, prompt: "继续文件检查" }).id);
    const a = s.agents.main;
    // Retain several complete exchanges, including provider data larger than visible answers.
    const exemplar = source.agents.main.history.find((u) => u.rawResponse);
    for (let i = 0; i < 8; i++) {
      const copy = JSON.parse(JSON.stringify(exemplar).replaceAll('call-1', `archived-call-${i}`));
      const unit = h.context.add(s, a, copy.messages, true);
      Object.assign(unit, {
        rawResponse: copy.rawResponse,
        rawModel: copy.rawModel,
        rawProtocol: copy.rawProtocol,
        rawConfigVersion: copy.rawConfigVersion,
      });
      const padding = "fixture-preserved-".repeat(200);
      if (protocol === "chat-completions") unit.rawResponse[0].reasoning_content += padding;
      else unit.rawResponse[0].content[0].text += padding;
    }
    const before = h.context.build(s, a, profile);
    assert.ok(before.breakdown.rawResponse > 1000);
    const result = await h.context.compact(s, a, { delayMs: 0 });
    assert.ok(result.archiveId);
    assert.match(h.store.readArtifact(s.id, result.archiveId).content, /fixture-preserved-/);
    assert.ok(a.history.some((u) => u.rawResponse));
    assert.ok(h.context.build(s, a, profile).tokens < before.tokens);
    const visible = a.history.flatMap((u) => u.messages);
    await h.requestSwitch(s.id, "demo-balanced");
    assert.ok(a.history.every((u) => !u.rawResponse && !u.rawConfigVersion && !u.rawProtocol));
    assert.deepEqual(a.history.slice(1).flatMap((u) => u.messages), visible);
  });

test("changed model/configuration never receives another profile's provider continuation", async () => {
  const registry = new ModelRegistry({
    LLM_BASE_URL: "https://api.deepseek.com",
    LLM_API_KEY: "fixture",
    LLM_MODEL: "fixture",
    LLM_PROTOCOL: "chat-completions",
  });
  const agent = {
    model: "api-primary",
    history: [
      modelExchange(
        {
          text: "已完成文件读取",
          calls: [],
          rawResponse: [
            {
              role: "assistant",
              content: "已完成文件读取",
              reasoning_content: "private-other-profile",
            },
          ],
          protocol: "chat-completions",
          configVersion: "old",
        },
        "api-primary",
      ),
    ],
  };
  let body;
  const adapter = new ApiModel(registry, async (_, options) => {
    body = JSON.parse(options.body);
    return stream([{ choices: [{ delta: { content: "继续" }, finish_reason: "stop" }] }]);
  });
  await adapter.complete({
    agent,
    input: { messages: [{ role: "system", content: "测试" }], tools: [] },
    profile: registry.get("api-primary"),
    signal: new AbortController().signal,
    onDelta: () => {},
  });
  assert.equal(body.messages[1].content, "已完成文件读取");
  assert.equal(body.messages[1].reasoning_content, "");
  assert.ok(!JSON.stringify(body).includes("private-other-profile"));
});

test("cancelling a reasoning stream never returns partial executable calls", async () => {
  const registry = new ModelRegistry({
    LLM_BASE_URL: "https://api.deepseek.com",
    LLM_API_KEY: "fixture",
    LLM_MODEL: "fixture",
    LLM_PROTOCOL: "chat-completions",
  });
  const controller = new AbortController();
  const adapter = new ApiModel(registry, async () => {
    controller.abort();
    return stream([
      {
        choices: [
          {
            delta: {
              reasoning_content: "partial",
              tool_calls: [
                { index: 0, id: "partial", function: { name: "file_write", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
  });
  await assert.rejects(
    adapter.complete({
      agent: { model: "api-primary", history: [] },
      input: { messages: [{ role: "user", content: "测试" }], tools: [] },
      profile: registry.get("api-primary"),
      signal: controller.signal,
      onDelta: () => {},
    }),
    { name: "AbortError" },
  );
});
