import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { Harness } from "../server/harness.mjs";
import { createServer } from "../server/index.mjs";
import { delay } from "../server/core.mjs";
import { zipFiles } from "../server/delivery/zip.mjs";
import { DeliveryConfig } from "../server/delivery/config.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2l8AAAAASUVORK5CYII=",
  "base64",
);
const model = {
  async complete({ signal }) {
    await delay(30000, signal);
    return { text: "done", calls: [] };
  },
};
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    assert.ok(Date.now() < deadline, "timed out");
    await delay(5);
  }
}
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-delivery-"));
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url, ...init });
    if (url.endsWith("/images/generations"))
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    if (init.method === "POST") return Response.json({ id: "deployment-1", state: "processing" });
    return Response.json({
      id: "deployment-1",
      state: "ready",
      ssl_url: "https://fixture.example.test/",
    });
  };
  const h = new Harness({
    root: path.join(root, "state"),
    env: {},
    speed: 0,
    modelAdapter: model,
    deliveryOptions: { fetcher, pollMs: 1, ...options },
  });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const s = h.get(
    h.create({ autoStart: false, scenario: "custom", prompt: "准备虚构形象和祝福网站" }).id,
  );
  const a = s.agents.main;
  const config = h.delivery.config;
  const image = config.save("image", {
    name: "Test Images",
    baseUrl: "https://images.example.test/v1",
    model: "image-fixture",
    protocol: "gpt-image",
    apiKey: "image-test-fixture",
  }).images[0];
  config.save("publisher", {
    name: "Test Publish",
    baseUrl: "https://publish.example.test/api/v1",
    siteId: "test-site",
    apiKey: "publish-test-fixture",
  });
  return { h, s, a, root, requests, image };
}
async function generate(h, s, a, key) {
  await h.invoke(s, a, "tool_load", { name: "image_generate" });
  return h.invoke(s, a, "image_generate", { key, prompt: "统一暖色纸艺风格的虚构卡通人物" });
}
async function preview(h, s, a) {
  fs.writeFileSync(
    path.join(h.workspace(s, a), "index.html"),
    "<!doctype html><h1>Preview v1</h1>",
  );
  await h.invoke(s, a, "tool_load", { name: "site_preview" });
  return h.invoke(s, a, "site_preview", {
    title: "测试预览",
    entry: "index.html",
    files: ["index.html"],
  });
}

test("image versions and local selection preserve every other member; rejected face inputs never reach provider", async (t) => {
  const { h, s, a, requests } = setup(t);
  const one = await generate(h, s, a, "王磊"),
    other = await generate(h, s, a, "另一位同学"),
    two = await generate(h, s, a, "王磊");
  assert.equal(two.version, 2);
  assert.equal(h.delivery.state(s).selections[one.slot], two.id);
  h.delivery.select(s, one.id);
  assert.equal(h.delivery.state(s).selections[one.slot], one.id);
  assert.equal(h.delivery.state(s).selections[other.slot], other.id);
  assert.deepEqual(h.delivery.imageBytes(s, one), png);
  const n = requests.length;
  await assert.rejects(
    h.invoke(s, a, "image_generate", { key: "bad", prompt: "参考组员真人脸生成形象" }),
    { code: "POLICY_DENIED" },
  );
  await assert.rejects(
    h.invoke(s, a, "image_generate", {
      key: "bad",
      prompt: "虚构人物",
      referenceImage: "~/Photos/a.jpg",
    }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(requests.length, n);
});

test("image failure and cancellation preserve successful assets and discard late bytes", async (t) => {
  let fail = false,
    started = false;
  const { h, s, a } = setup(t, {
    fetcher: async () => {
      if (fail) return new Response("provider echoed secret", { status: 503 });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  const good = await generate(h, s, a, "成功成员");
  fail = true;
  await assert.rejects(generate(h, s, a, "失败成员"), { code: "PROVIDER_HTTP" });
  assert.equal(h.delivery.state(s).selections[good.slot], good.id);
  let release;
  h.delivery.fetcher = async () => {
    started = true;
    await new Promise((r) => {
      release = r;
    });
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  };
  const controller = new AbortController();
  const pending = h.invoke(
    s,
    a,
    "image_generate",
    { key: "取消成员", prompt: "虚构人物" },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(pending);
  await until(() => started);
  controller.abort();
  release();
  await rejected;
  assert.equal(h.delivery.state(s).assets.at(-1).status, "cancelled");
  assert.equal(h.delivery.state(s).assets.filter((x) => x.status === "ready").length, 1);
});

test("pending publish is deduplicated, survives reload and sends exactly the approved ZIP after user approval", async (t) => {
  const { h, s, a, root, requests } = setup(t);
  const p = await preview(h, s, a);
  const request = h.delivery.requestPublish(s, a, p.id);
  assert.equal(h.delivery.requestPublish(s, a, p.id).id, request.id);
  assert.equal(requests.length, 0);
  const stateFile = path.join(root, "state", "delivery", s.id, "state.json");
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).publications[0].id, request.id);
  h.delivery.records.delete(s.id);
  assert.equal(h.delivery.state(s).publications[0].status, "awaiting_approval");
  const result = h.delivery.approvePublish(s, request.id, "approve");
  assert.equal(result.status, "publishing");
  assert.throws(() => h.delivery.approvePublish(s, request.id, "approve"), {
    code: "STALE_APPROVAL",
  });
  await until(() => !h.delivery.active.size);
  assert.equal(h.delivery.state(s).publications[0].status, "published");
  const posts = requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 1);
  const zip = path.join(root, "published.zip");
  fs.writeFileSync(zip, posts[0].body);
  assert.equal(
    execFileSync("unzip", ["-p", zip, "index.html"]).toString(),
    "<!doctype html><h1>Preview v1</h1>",
  );
  assert.ok(!JSON.stringify(h.snapshot(s.id)).includes("publish-test-fixture"));
});

test("full access cannot publish without approval; changed files or configuration invalidate approval", async (t) => {
  const { h, s, a, requests } = setup(t);
  const p = await preview(h, s, a);
  s.permissionMode = "full";
  const request = h.delivery.requestPublish(s, a, p.id);
  assert.equal(requests.length, 0);
  fs.writeFileSync(path.join(s.workspace, "index.html"), "CHANGED");
  assert.throws(() => h.delivery.approvePublish(s, request.id, "approve"), {
    code: "STALE_APPROVAL",
  });
  assert.equal(requests.length, 0);
  fs.writeFileSync(path.join(s.workspace, "index.html"), "<!doctype html><h1>Preview v1</h1>");
  h.delivery.config.save("publisher", {
    name: "new target",
    baseUrl: "https://publish.example.test/api/v1",
    siteId: "another-site",
  });
  assert.throws(() => h.delivery.approvePublish(s, request.id, "approve"), {
    code: "STALE_APPROVAL",
  });
  assert.equal(requests.length, 0);
});

test("changed authorization requires a fresh publish request and allows that new request to complete", async (t) => {
  const { h, s, a, requests } = setup(t);
  const p = await preview(h, s, a);
  const old = h.delivery.requestPublish(s, a, p.id);
  h.permissions.set(s, "full");
  assert.throws(() => h.delivery.approvePublish(s, old.id, "approve"), { code: "STALE_APPROVAL" });
  const current = h.delivery.requestPublish(s, a, p.id);
  assert.notEqual(current.id, old.id);
  assert.equal(h.delivery.state(s).publications[0].status, "stale");
  h.delivery.approvePublish(s, current.id, "approve");
  await until(() => !h.delivery.active.size);
  assert.equal(h.delivery.state(s).publications.at(-1).status, "published");
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
});

test("eight-member greeting preview validates omissions, character limits and current image versions", async (t) => {
  const { h, s, a } = setup(t);
  const names = ["王磊", ...Array.from({ length: 7 }, (_, i) => `成员${i + 2}`)];
  h.delivery.requirements(s, { members: names, limits: { 王磊: 50 } });
  const members = [];
  for (const name of names)
    members.push({
      name,
      blessing: "老师节日快乐，感谢您的教导！",
      imageId: (await generate(h, s, a, name)).id,
    });
  await h.invoke(s, a, "tool_load", { name: "greeting_site" });
  await assert.rejects(
    h.invoke(s, a, "greeting_site", { title: "教师节快乐", members: members.slice(1) }),
    { code: "CHECKS_FAILED" },
  );
  await assert.rejects(
    h.invoke(s, a, "greeting_site", {
      title: "教师节快乐",
      members: members.map((m, i) => (i ? m : { ...m, blessing: "长".repeat(51) })),
    }),
    { code: "CHECKS_FAILED" },
  );
  const result = await h.invoke(s, a, "greeting_site", { title: "教师节快乐", members });
  const html = h.delivery.previewFile(s, result.id, "index.html").bytes.toString();
  assert.equal((html.match(/<article>/g) ?? []).length, 8);
  for (const name of names) assert.ok(html.includes(name));
  assert.equal(result.files.length, 9);
  const request = h.delivery.requestPublish(s, a, result.id);
  const newer = await generate(h, s, a, "王磊");
  h.delivery.select(s, newer.id);
  assert.throws(() => h.delivery.approvePublish(s, request.id, "approve"), {
    code: "STALE_APPROVAL",
  });
});

test("preview rejects secrets, path traversal, unrelated child files and modified immutable copies", async (t) => {
  const { h, s, a } = setup(t);
  await h.invoke(s, a, "tool_load", { name: "site_preview" });
  for (const file of [".env", "../outside.html", "Photos/person.png"]) {
    await assert.rejects(
      h.invoke(s, a, "site_preview", {
        title: "bad",
        entry: "index.html",
        files: [file, "index.html"],
      }),
    );
  }
  const child = s.agents[h.spawnAgent(s, a, { goal: "子任务" }).agentId];
  await h.invoke(s, child, "tool_load", { name: "site_preview" });
  await assert.rejects(
    h.invoke(s, child, "site_preview", {
      title: "bad",
      entry: "index.html",
      files: ["index.html"],
    }),
    { code: "PATH_DENIED" },
  );
  const p = await preview(h, s, a);
  fs.writeFileSync(
    path.join(h.delivery.root, s.id, "previews", p.id, "index.html"),
    "externally changed",
  );
  assert.throws(() => h.delivery.previewFile(s, p.id, "index.html"), { code: "PREVIEW_CHANGED" });
});

test("publication disconnect records uncertainty and never silently retries a POST", async (t) => {
  let calls = 0;
  const { h, s, a } = setup(t, {
    fetcher: async () => {
      calls++;
      throw new Error("network failure with private address");
    },
  });
  const p = await preview(h, s, a),
    request = h.delivery.requestPublish(s, a, p.id);
  h.delivery.approvePublish(s, request.id, "approve");
  await until(() => !h.delivery.active.size);
  assert.equal(h.delivery.state(s).publications[0].status, "unknown");
  assert.equal(h.delivery.requestPublish(s, a, p.id).id, request.id);
  assert.equal(calls, 1);
  assert.ok(!h.delivery.state(s).publications[0].error.includes("private address"));
});

test("delivery configuration hides secrets, rejects URL credentials, and ZIP preserves UTF-8 filenames", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = new DeliveryConfig(root);
  assert.throws(() =>
    config.save("image", {
      name: "bad",
      baseUrl: "https://user:password@example.test",
      model: "m",
      protocol: "gpt-image",
    }),
  );
  config.save("image", {
    name: "test",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "m",
    protocol: "b64-compatible",
    apiKey: "fixture-secret-value",
  });
  assert.ok(!JSON.stringify(config.list()).includes("fixture-secret-value"));
  assert.equal(fs.statSync(path.join(root, "delivery-credentials.json")).mode & 0o777, 0o600);
  const zip = path.join(root, "utf8.zip");
  fs.writeFileSync(zip, zipFiles({ "祝福.html": Buffer.from("祝福文本") }));
  assert.match(execFileSync("unzip", ["-p", zip]).toString(), /祝福文本/);
});

test("local HTTP image adapter and preview response use the real wire protocol and isolate executable HTML", async (t) => {
  let requestBody;
  const provider = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requestBody = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  t.after(() => {
    provider.closeAllConnections();
    provider.close();
  });
  const { h, s, a, image } = setup(t, { fetcher: fetch });
  h.delivery.config.save("image", {
    ...image,
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    protocol: "b64-compatible",
  });
  const asset = await generate(h, s, a, "合成人物");
  assert.equal(requestBody.model, "image-fixture");
  assert.equal(requestBody.response_format, "b64_json");
  assert.equal(requestBody.n, 1);
  assert.ok(!requestBody.image);
  const p = await preview(h, s, a);
  const app = createServer({ harness: h });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => {
    app.server.closeAllConnections();
    app.server.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(base + p.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /sandbox allow-scripts/);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /allow-same-origin/);
  assert.match(await page.text(), /Preview v1/);
  const bytes = await fetch(base + asset.url);
  assert.equal(bytes.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png);
});

test("DashScope multimodal image adapter sends native payload and stores the returned image", async (t) => {
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url, ...init });
    if (url === "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation")
      return Response.json({
        output: {
          choices: [{ message: { content: [{ image: "https://result.oss-cn-beijing.aliyuncs.com/generated.png" }] } }],
        },
      });
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  };
  const { h, s, a, image } = setup(t, { fetcher });
  h.delivery.config.save("image", {
    ...image,
    baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    model: "qwen-image-3.0",
    protocol: "dashscope-multimodal",
  });
  a.imageModelId = h.delivery.config.list().images.at(-1).id;
  const asset = await generate(h, s, a, "虚构机器人在工作台前");
  const payload = JSON.parse(requests[0].body);
  assert.equal(requests[0].url, h.delivery.config.list().images.at(-1).baseUrl);
  assert.equal(payload.model, "qwen-image-3.0");
  assert.match(payload.input.messages[0].content[0].text, /统一暖色纸艺风格/);
  assert.equal(payload.parameters.prompt_extend, true);
  assert.equal(requests[1].url, "https://result.oss-cn-beijing.aliyuncs.com/generated.png");
  assert.equal(asset.mime, "image/png");
});

test("a child's image model switch pins the current request and affects only its next generation", async (t) => {
  let release,
    entered = false;
  const models = [];
  const { h, s, a, image } = setup(t, {
    fetcher: async (_url, init) => {
      models.push(JSON.parse(init.body).model);
      if (models.length === 1) {
        entered = true;
        await new Promise((r) => {
          release = r;
        });
      }
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  const next = h.delivery.config
    .save("image", {
      name: "Alternative",
      baseUrl: "https://images.example.test/v1",
      model: "image-alternative",
      protocol: "gpt-image",
    })
    .images.at(-1);
  const child = s.agents[h.spawnAgent(s, a, { goal: "独立形象" }).agentId];
  const app = createServer({ harness: h });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => {
    app.server.closeAllConnections();
    app.server.close();
  });
  const first = generate(h, s, child, "本人形象");
  await until(() => entered);
  const r = await fetch(
    `http://127.0.0.1:${app.server.address().port}/api/sessions/${s.id}/agents/${child.id}/image-model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: next.id }),
    },
  );
  assert.equal(r.status, 200);
  release();
  const one = await first,
    two = await generate(h, s, child, "本人形象");
  assert.equal(one.modelId, image.id);
  assert.equal(two.modelId, next.id);
  assert.deepEqual(models, ["image-fixture", "image-alternative"]);
  assert.equal(a.imageModelId, undefined);
});

test("a background site builder sees only explicitly assigned image versions, not siblings' other images", async (t) => {
  const { h, s, a } = setup(t);
  const illustrator = s.agents[h.spawnAgent(s, a, { goal: "出图" }).agentId];
  const first = await generate(h, s, illustrator, "王磊");
  const other = await generate(h, s, illustrator, "李明");
  const builder = s.agents[h.spawnAgent(s, a, { goal: "搭站", images: [first.id] }).agentId];
  assert.equal(h.delivery.asset(s, first.id, builder).id, first.id);
  assert.throws(() => h.delivery.asset(s, other.id, builder), { code: "PATH_DENIED" });
  const later = await generate(h, s, illustrator, "王磊");
  assert.throws(() => h.delivery.asset(s, later.id, builder), { code: "PATH_DENIED" });
  assert.match(JSON.stringify(builder.history), new RegExp(first.id));
  assert.ok(h.context.facts(s, builder).assignedImageIds.includes(first.id));
  // A child cannot pass an unassigned image to a descendant to obtain access indirectly.
  assert.throws(() => h.delivery.assign(s, builder, {}, [other.id]), { code: "PATH_DENIED" });
});

test("end-to-end controlled model delegates eight image agents, creates a checked preview, and waits for user publication", async (t) => {
  const { h, s, a, requests } = setup(t);
  const names = Array.from({ length: 8 }, (_, i) => `成员${i + 1}`);
  h.delivery.requirements(s, { members: names, limits: { 成员1: 50 } });
  const calls = (prefix, entries) =>
    entries.map(([name, args], i) => ({
      id: prefix + i,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }));
  const counts = new Map();
  let created = false,
    assembled = false,
    requested = false;
  h.demo = {
    async complete({ agent }) {
      const n = (counts.get(agent.id) ?? 0) + 1;
      counts.set(agent.id, n);
      if (agent.goal === "后台搭站") {
        if (n === 1)
          return {
            calls: calls("site-", [
              ["tool_load", { name: "greeting_site" }],
              [
                "greeting_site",
                {
                  title: "教师节快乐",
                  members: names.map((name) => ({
                    name,
                    blessing: "老师，节日快乐！",
                    imageId: h.delivery.state(s).assets.find((x) => x.key === name).id,
                  })),
                },
              ],
            ]),
          };
        return { text: "网站预览已生成，请主助手交给用户检查。", calls: [] };
      }
      if (agent.parentId) {
        if (n === 1)
          return {
            calls: calls(agent.id, [
              ["tool_load", { name: "image_generate" }],
              [
                "image_generate",
                { key: agent.goal, prompt: "统一纸艺风格的虚构形象，不使用真人脸" },
              ],
            ]),
          };
        const asset = h.delivery
          .state(s)
          .assets.find((x) => x.ownerId === agent.id && x.status === "ready");
        return { text: JSON.stringify({ name: agent.goal, imageId: asset?.id }), calls: [] };
      }
      if (!created) {
        created = true;
        return {
          calls: calls(
            "spawn-",
            names.map((name) => ["agent_spawn", { goal: name, mode: "background" }]),
          ),
        };
      }
      const ready = h.delivery.state(s).assets.filter((x) => x.status === "ready");
      if (
        ready.length === 8 &&
        !assembled &&
        Object.values(s.agents)
          .filter((x) => x.parentId)
          .every((x) => x.output)
      ) {
        assembled = true;
        return {
          calls: calls("assemble-", [
            [
              "agent_spawn",
              { goal: "后台搭站", images: ready.map((x) => x.id), mode: "background" },
            ],
          ]),
        };
      }
      const p = h.delivery.state(s).previews.at(-1);
      if (p && !requested) {
        requested = true;
        return {
          calls: calls("publish-", [
            ["tool_load", { name: "site_request_publish" }],
            ["site_request_publish", { previewId: p.id }],
          ]),
        };
      }
      return { text: "已安排后台工作；完成后请查看预览并决定是否发布。", calls: [] };
    },
  };
  h.launch(s, a);
  await until(() => !h.controller(s, a).running);
  assert.equal(s.status, "needs_review");
  assert.equal(Object.values(s.agents).filter((x) => x.parentId).length, 9);
  assert.equal(h.delivery.state(s).assets.filter((x) => x.status === "ready").length, 8);
  assert.equal(h.delivery.state(s).previews[0].members.length, 8);
  assert.notEqual(h.delivery.state(s).previews[0].ownerId, "main");
  assert.equal(h.delivery.state(s).publications[0].status, "awaiting_approval");
  assert.equal(requests.filter((r) => r.url.includes("/deploys")).length, 0);
  h.delivery.approvePublish(s, h.delivery.state(s).publications[0].id, "approve");
  await until(() => !h.delivery.active.size);
  assert.equal(h.delivery.state(s).publications[0].status, "published");
  assert.equal(h.processes.list(s.id).length, 0);
});
