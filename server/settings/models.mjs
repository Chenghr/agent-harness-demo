import fs from "node:fs";
import path from "node:path";
import { HarnessError, id } from "../core.mjs";

const fail = (message) => {
  throw new HarnessError("MODEL_CONFIG", message);
};
export function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${id("save")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
const read = (file, fallback) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
export class ModelSettings {
  constructor(root, changed = () => {}) {
    this.root = root;
    this.changed = changed;
    this.data = read(path.join(root, "models.json"), { providers: [], models: [] });
    this.keys = read(path.join(root, "credentials.json"), {});
  }
  list() {
    return {
      ...structuredClone(this.data),
      providers: this.data.providers.map((p) => ({ ...p, hasKey: !!this.keys[p.id] })),
    };
  }
  persist() {
    privateJson(path.join(this.root, "credentials.json"), this.keys);
    privateJson(path.join(this.root, "models.json"), this.data);
    this.changed();
  }
  saveProvider(value) {
    let url;
    try {
      url = new URL(value.baseUrl);
    } catch {
      fail("API 地址无效");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail("API 地址只能包含协议、主机和路径");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      fail("远程 API 地址必须使用 HTTPS");
    if (!["responses", "chat-completions"].includes(value.protocol)) fail("不支持此 API 协议");
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 100)
      fail("请填写服务名称");
    const old = value.id && this.data.providers.find((p) => p.id === value.id);
    if (value.id && !old) fail("服务不存在");
    const p = {
      id: old?.id ?? id("provider"),
      name: value.name.trim(),
      baseUrl: url.href.replace(/\/$/, ""),
      protocol: value.protocol,
      version: (old?.version ?? 0) + 1,
    };
    if (value.apiKey !== undefined) {
      if (typeof value.apiKey !== "string" || value.apiKey.length > 8192) fail("密钥格式无效");
      this.keys[p.id] = value.apiKey;
    }
    this.data.providers = this.data.providers.filter((x) => x.id !== p.id).concat(p);
    this.persist();
    return this.list().providers.find((x) => x.id === p.id);
  }
  saveModel(v) {
    if (!this.data.providers.some((p) => p.id === v.providerId)) fail("请先添加模型服务");
    if (typeof v.modelName !== "string" || !v.modelName.trim() || v.modelName.length > 200)
      fail("模型 ID 无效");
    const contextWindow = Number(v.contextWindow),
      maxOutput = Number(v.maxOutput);
    if (!Number.isInteger(contextWindow) || contextWindow < 2000 || contextWindow > 10_000_000)
      fail("上下文上限需要填写有效的整数");
    if (!Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput >= contextWindow)
      fail("输出上限必须小于上下文上限");
    const efforts = v.reasoningEfforts ?? [];
    if (
      !Array.isArray(efforts) ||
      efforts.length > 10 ||
      efforts.some((e) => typeof e !== "string" || !/^[a-z_]{1,30}$/.test(e))
    )
      fail("思考等级无效");
    if (v.effort && !efforts.includes(v.effort)) fail("所选思考等级不在模型允许范围内");
    if (v.tools !== true) fail("当前 Agent 需要支持工具调用的模型");
    const old = v.id && this.data.models.find((m) => m.id === v.id);
    if (v.id && !old) fail("模型不存在");
    const m = {
      id: old?.id ?? id("model"),
      providerId: v.providerId,
      modelName: v.modelName.trim(),
      label: String(v.label || v.modelName).slice(0, 200),
      contextWindow,
      maxOutput,
      tools: true,
      reasoningEfforts: efforts,
      effort: v.effort || "",
      maxTokensField: v.maxTokensField === "max_tokens" ? "max_tokens" : "max_completion_tokens",
      metadataSource: "user",
      version: (old?.version ?? 0) + 1,
    };
    this.data.models = this.data.models.filter((x) => x.id !== m.id).concat(m);
    this.persist();
    return structuredClone(m);
  }
  removeModel(modelId) {
    if (!this.data.models.some((m) => m.id === modelId)) fail("模型不存在");
    this.data.models = this.data.models.filter((m) => m.id !== modelId);
    this.persist();
  }
  connection(providerId) {
    const p = this.data.providers.find((p) => p.id === providerId);
    if (!p) fail("模型服务不存在");
    return {
      baseUrl: p.baseUrl,
      key: this.keys[p.id] ?? "",
      protocol: p.protocol,
      version: p.version,
    };
  }
  profiles() {
    return this.data.models.map((m) => {
      const p = this.data.providers.find((p) => p.id === m.providerId);
      return {
        ...m,
        protocol: p.protocol,
        providerName: p.name,
        baseUrl: p.baseUrl,
        configured:
          !!this.keys[p.id] ||
          ["localhost", "127.0.0.1", "[::1]"].includes(new URL(p.baseUrl).hostname),
        simulated: false,
        configVersion: `${p.version}:${m.version}`,
      };
    });
  }
  async discover(providerId, fetcher = fetch) {
    const c = this.connection(providerId);
    const r = await fetcher(c.baseUrl + "/models", {
      headers: c.key ? { Authorization: `Bearer ${c.key}` } : {},
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!r.ok) fail(`获取模型列表失败：HTTP ${r.status}`);
    const body = await r.json();
    if (!Array.isArray(body.data)) fail("服务没有返回支持的模型列表，请手动填写模型 ID");
    return body.data
      .slice(0, 2000)
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id.slice(0, 200) }));
  }
}
