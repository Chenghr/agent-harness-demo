import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { HarnessError, id, now, safePath } from "../core.mjs";
import { privateJson } from "../settings/models.mjs";
import { workspacePath } from "../workspace-access.mjs";
import { excludedPath } from "../workspaces.mjs";
import { assertFictionalImage } from "../privacy-policy.mjs";
import { DeliveryConfig } from "./config.mjs";
import { generateImage, deploySite } from "./providers.mjs";
import { zipFiles } from "./zip.mjs";
import { greetingHtml } from "./greeting-site.mjs";

const fail = (code, message) => {
  throw new HarnessError(code, message);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
function filename(value) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !value ||
    value.includes("\\") ||
    value.split("/").some((x) => !x || x === "." || x === ".." || x.startsWith(".")) ||
    !types[path.extname(value).toLowerCase()] ||
    excludedPath(value)
  )
    fail("INVALID_ARGUMENT", "网站只接受明确列出的 HTML、CSS、JS、图片和字体相对路径");
  return value;
}

/** Owns media versions and immutable previews. Publication is a separate user operation. */
export class DeliveryService {
  constructor(h, { fetcher = fetch, pollMs = 1000 } = {}) {
    this.h = h;
    this.root = path.join(h.store.root, "delivery");
    this.config = new DeliveryConfig(path.join(h.store.root, "settings"));
    this.records = new Map();
    this.imageLocks = new Set();
    this.active = new Map();
    this.fetcher = fetcher;
    this.pollMs = pollMs;
  }
  state(s) {
    if (!this.records.has(s.id)) {
      const file = path.join(this.root, s.id, "state.json");
      const state = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : { assets: [], selections: {}, previews: [], publications: [], version: 0 };
      for (const record of state.publications)
        if (record.status === "publishing") {
          record.status = "unknown";
          record.error = "服务重启，外部发布结果需核对，不自动重放";
        }
      for (const record of state.assets)
        if (record.status === "generating") record.status = "interrupted";
      this.records.set(s.id, state);
    }
    return this.records.get(s.id);
  }
  save(s, reason) {
    const state = this.state(s);
    privateJson(path.join(this.root, s.id, "state.json"), state);
    this.h.event(s, "delivery.updated", { reason, version: state.version });
  }
  snapshot(s) {
    return structuredClone(this.state(s));
  }
  owns(s, a, ownerId) {
    return a.id === "main" || a.id === ownerId || this.h.isDescendant(s, ownerId, a.id);
  }
  assign(s, parent, child, ids) {
    const images = [...new Set(ids)].map((id) => this.asset(s, id, parent));
    child.assignedImageIds = images.map((image) => image.id);
    return images.map(({ id, key, version, model }) => ({ id, key, version, model }));
  }
  asset(s, assetId, a = s.agents.main) {
    const asset = this.state(s).assets.find((x) => x.id === assetId && x.status === "ready");
    if (!asset || (!this.owns(s, a, asset.ownerId) && !a.assignedImageIds?.includes(asset.id)))
      fail("PATH_DENIED", "图片不存在或没有分配给当前助手");
    return asset;
  }
  imageBytes(s, asset) {
    return fs.readFileSync(path.join(this.root, s.id, "images", asset.id + "." + asset.extension));
  }
  async generate(s, a, args, signal, epoch) {
    assertFictionalImage(args.prompt);
    if (s.readOnly || (a.parentId && a.delegation.definition.workspaceMode !== "outputs"))
      fail("POLICY_DENIED", "只读助手不能生成图片");
    if (this.state(s).assets.length >= 100)
      fail("DELIVERY_LIMIT", "本任务已达 100 个图片版本，请新建任务");
    const profile = this.config.image(a.imageModelId || args.modelId);
    let lineage = a;
    while (lineage.replacesAgentId) lineage = s.agents[lineage.replacesAgentId];
    const slot = lineage.id + ":" + args.key,
      lock = s.id + ":" + slot;
    if (this.imageLocks.has(lock))
      fail("DELIVERY_BUSY", "同一形象已有出图请求，请等待或停止该请求");
    this.imageLocks.add(lock);
    const state = this.state(s),
      previous = state.selections[slot];
    const record = {
      id: id("image"),
      key: args.key,
      slot,
      ownerId: a.id,
      version: state.assets.filter((x) => x.slot === slot).length + 1,
      modelId: profile.id,
      model: profile.model,
      configVersion: profile.version,
      prompt: args.prompt,
      status: "generating",
      createdAt: now(),
    };
    state.assets.push(record);
    this.save(s, "image.started");
    try {
      const output = await generateImage(
        profile,
        `仅生成虚构人物或插画，不复刻任何真实人物，不使用照片参考。\n${args.prompt}`,
        AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        this.fetcher,
      );
      this.h.valid(s, a, epoch, signal);
      if (
        state.assets.filter((x) => x.status === "ready").reduce((n, x) => n + x.bytes, 0) +
          output.bytes.length >
        100 * 1024 * 1024
      )
        fail("DELIVERY_LIMIT", "本任务图片总量超过 100 MB");
      const directory = path.join(this.root, s.id, "images");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, record.id + "." + output.extension), output.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      Object.assign(record, {
        status: "ready",
        mime: output.mime,
        extension: output.extension,
        bytes: output.bytes.length,
        sha256: digest(output.bytes),
        url: `/api/sessions/${s.id}/delivery/assets/${record.id}`,
      });
      if (state.selections[slot] === previous) state.selections[slot] = record.id;
      state.version++;
      a.outputRevision = (a.outputRevision ?? 0) + 1;
      this.save(s, "image.ready");
      return structuredClone(record);
    } catch (error) {
      record.status = signal.aborted ? "cancelled" : "failed";
      record.error =
        error instanceof HarnessError ? error.message : "图片请求失败或超时，已有版本保留";
      this.save(s, "image.failed");
      if (signal.aborted) signal.throwIfAborted();
      throw error instanceof HarnessError ? error : new HarnessError("IMAGE_FAILED", record.error);
    } finally {
      this.imageLocks.delete(lock);
    }
  }
  select(s, assetId) {
    const asset = this.asset(s, assetId),
      state = this.state(s);
    if (state.selections[asset.slot] === asset.id) return this.snapshot(s);
    state.selections[asset.slot] = asset.id;
    state.version++;
    for (const p of state.publications) if (p.status === "awaiting_approval") p.status = "stale";
    this.save(s, "image.selected");
    this.userInput(
      s,
      `用户已将 ${asset.key} 恢复到图片版本 ${asset.version}（${asset.id}），其他图片保留。需要重新创建预览。`,
    );
    return this.snapshot(s);
  }
  sourceFile(s, a, value) {
    filename(value);
    const file =
      s.workspaceId && !a.parentId
        ? this.h.permissions.path(s, a, value).file
        : workspacePath(this.h.workspace(s, a), a, value);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      fail("NOT_FOUND", `网站文件不存在：${value}`);
    if (fs.statSync(file).size > 10 * 1024 * 1024) fail("DELIVERY_LIMIT", "单个网站文件超过 10 MB");
    return fs.readFileSync(file);
  }
  preview(s, a, args) {
    if (s.readOnly || (a.parentId && a.delegation.definition.workspaceMode !== "outputs"))
      fail("POLICY_DENIED", "只读助手不能创建网站成果");
    const state = this.state(s);
    if (state.previews.length >= 40) fail("DELIVERY_LIMIT", "本任务已达 40 个预览版本");
    const entry = filename(args.entry);
    if (path.extname(entry) !== ".html" || !args.files.includes(entry))
      fail("INVALID_ARGUMENT", "入口必须是已列出的 HTML 文件");
    const files = {},
      sources = [],
      assets = [];
    const base = path.posix.dirname(entry);
    for (const input of args.files) {
      const bytes = this.sourceFile(s, a, input);
      const target = path.posix.relative(base, input);
      filename(target);
      if (files[target]) fail("INVALID_ARGUMENT", "网站文件路径重复");
      files[target] = bytes;
      sources.push({ path: input, target, sha256: digest(bytes) });
    }
    if (path.posix.basename(entry) !== "index.html")
      fail("INVALID_ARGUMENT", "静态网站入口请命名为 index.html");
    for (const input of args.assets ?? []) {
      const asset = this.asset(s, input.id, a),
        target = filename(input.path);
      if (files[target]) fail("INVALID_ARGUMENT", "网站图片路径重复");
      if (types[path.extname(target)] !== asset.mime)
        fail("INVALID_ARGUMENT", "图片文件扩展名与真实格式不匹配");
      files[target] = this.imageBytes(s, asset);
      assets.push({
        id: asset.id,
        slot: asset.slot,
        selected: state.selections[asset.slot],
        target,
      });
    }
    return this.commitPreview(s, a, args.title, files, sources, assets);
  }
  commitPreview(s, a, title, files, sources, assets, members) {
    const state = this.state(s);
    if (state.previews.length >= 40) fail("DELIVERY_LIMIT", "本任务已达 40 个预览版本");
    if (Object.values(files).reduce((n, b) => n + b.length, 0) > 50 * 1024 * 1024)
      fail("DELIVERY_LIMIT", "网站预览总量超过 50 MB");
    const record = {
      id: id("preview"),
      title,
      ownerId: a.id,
      createdAt: now(),
      members,
      requirementsVersion: state.requirements?.version ?? 0,
      sources,
      assets,
      files: Object.entries(files).map(([name, b]) => ({
        name,
        sha256: digest(b),
        bytes: b.length,
      })),
      digest: digest(zipFiles(files)),
    };
    const directory = path.join(this.root, s.id, "previews", record.id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of Object.entries(files)) {
      const target = safePath(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    }
    record.url = `/preview/${s.id}/${record.id}/index.html`;
    state.previews.push(record);
    state.version++;
    for (const p of state.publications) if (p.status === "awaiting_approval") p.status = "stale";
    this.save(s, "preview.created");
    return structuredClone(record);
  }
  requirements(s, { members, limits = {} }) {
    if (
      !Array.isArray(members) ||
      !members.length ||
      members.length > 40 ||
      members.some((m) => typeof m !== "string" || !m.trim() || m.length > 100) ||
      new Set(members).size !== members.length
    )
      fail("INVALID_ARGUMENT", "成员名单需要 1 到 40 个不同的名字");
    if (
      !limits ||
      typeof limits !== "object" ||
      Array.isArray(limits) ||
      Object.entries(limits).some(
        ([name, n]) => !members.includes(name) || !Number.isInteger(n) || n < 1 || n > 3000,
      )
    )
      fail("INVALID_ARGUMENT", "字数限制须对应成员，范围为 1 到 3000");
    const state = this.state(s);
    state.requirements = { members, limits, version: (state.requirements?.version ?? 0) + 1 };
    s.acceptance = {
      ...s.acceptance,
      description: "核对网站成员名单与祝福字数；画面和内容由用户预览确认，发布另行批准。",
    };
    state.version++;
    for (const p of state.publications) if (p.status === "awaiting_approval") p.status = "stale";
    this.userInput(s, `用户设置了网站验收要求：${JSON.stringify(state.requirements)}`);
    this.save(s, "requirements.changed");
    return state.requirements;
  }
  userInput(s, text) {
    const a = s.agents.main,
      controller = this.h.controller(s, a);
    const terminal = controller.isTerminal;
    controller.enqueue(text, "user");
    if (terminal && !controller.running) {
      a.status = "idle";
      s.status = "idle";
      a.result = null;
    }
  }
  greeting(s, a, args) {
    if (s.readOnly || (a.parentId && a.delegation.definition.workspaceMode !== "outputs"))
      fail("POLICY_DENIED", "只读助手不能创建网站成果");
    const state = this.state(s),
      requirements = state.requirements;
    if (!requirements)
      fail("REQUIREMENTS_MISSING", "请用户先在图片与网站面板填写成员名单，避免遗漏");
    const names = args.members.map((m) => m.name);
    if (
      new Set(names).size !== names.length ||
      names.length !== requirements.members.length ||
      requirements.members.some((n) => !names.includes(n))
    )
      fail("CHECKS_FAILED", "成员名单不完整或重复，未生成预览");
    const files = {},
      assets = [],
      members = [];
    for (const [index, member] of args.members.entries()) {
      const limit = requirements.limits[member.name];
      if (!member.blessing.trim() || (limit && [...member.blessing].length > limit))
        fail("CHECKS_FAILED", `${member.name}的祝福为空或超过 ${limit} 字`);
      const asset = this.asset(s, member.imageId, a);
      if (state.selections[asset.slot] !== asset.id)
        fail("CHECKS_FAILED", `${member.name}引用的图片不是当前选中版本`);
      const target = `images/member-${index + 1}.${asset.extension}`;
      files[target] = this.imageBytes(s, asset);
      assets.push({ id: asset.id, slot: asset.slot, selected: asset.id, target });
      members.push({ ...member, imagePath: target });
    }
    files["index.html"] = Buffer.from(greetingHtml(args.title, members));
    return this.commitPreview(s, a, args.title, files, [], assets, members);
  }
  getPreview(s, previewId, a = s.agents.main) {
    const record = this.state(s).previews.find((x) => x.id === previewId);
    if (!record || !this.owns(s, a, record.ownerId))
      fail("NOT_FOUND", "预览不存在或没有分配给当前助手");
    return record;
  }
  previewFile(s, previewId, file) {
    const record = this.getPreview(s, previewId);
    const entry = record.files.find((x) => x.name === file);
    if (!entry) fail("NOT_FOUND", "文件不属于此预览版本");
    const bytes = fs.readFileSync(
      safePath(path.join(this.root, s.id, "previews", record.id), file),
    );
    if (digest(bytes) !== entry.sha256) fail("PREVIEW_CHANGED", "预览副本已被外部改动，请重新生成");
    return { bytes, mime: types[path.extname(file)] };
  }
  assertFresh(s, preview) {
    const state = this.state(s),
      owner = s.agents[preview.ownerId];
    if ((state.requirements?.version ?? 0) !== preview.requirementsVersion)
      fail("STALE_APPROVAL", "验收要求已改变，请重新生成预览");
    if (state.previews.at(-1)?.id !== preview.id)
      fail("STALE_APPROVAL", "已有新预览，请确认最新版本");
    for (const source of preview.sources) {
      if (digest(this.sourceFile(s, owner, source.path)) !== source.sha256)
        fail("STALE_APPROVAL", "源文件已改变，请重新预览和批准");
    }
    for (const asset of preview.assets)
      if (state.selections[asset.slot] !== asset.selected)
        fail("STALE_APPROVAL", "图片版本已改变，请重新预览和批准");
  }
  requestPublish(s, a, previewId) {
    const preview = this.getPreview(s, previewId, a);
    this.assertFresh(s, preview);
    const publisher = this.config.publisher(),
      state = this.state(s);
    for (const p of state.publications) {
      if (
        p.status === "awaiting_approval" &&
        (p.configVersion !== publisher.version || p.permissionVersion !== s.grantVersion)
      )
        p.status = "stale";
    }
    const existing = state.publications.find(
      (p) =>
        p.previewId === previewId &&
        p.configVersion === publisher.version &&
        ["awaiting_approval", "publishing", "published", "unknown"].includes(p.status),
    );
    if (existing) return structuredClone(existing);
    const request = {
      id: id("publish"),
      previewId,
      digest: preview.digest,
      ownerId: a.id,
      status: "awaiting_approval",
      createdAt: now(),
      target: publisher.siteId,
      configVersion: publisher.version,
      permissionVersion: s.grantVersion,
    };
    state.publications.push(request);
    this.save(s, "publish.requested");
    return structuredClone(request);
  }
  approvePublish(s, requestId, decision) {
    if (this.h.shuttingDown) fail("CLOSING", "服务正在关闭");
    const state = this.state(s),
      request = state.publications.find((p) => p.id === requestId);
    if (!request || request.status !== "awaiting_approval")
      fail("STALE_APPROVAL", "发布请求已处理或失效");
    if (decision === "deny") {
      request.status = "denied";
      this.save(s, "publish.denied");
      return structuredClone(request);
    }
    if (decision !== "approve") fail("INVALID_ARGUMENT", "未知发布决定");
    const preview = this.getPreview(s, request.previewId),
      publisher = this.config.publisher();
    this.assertFresh(s, preview);
    if (publisher.version !== request.configVersion || s.grantVersion !== request.permissionVersion)
      fail("STALE_APPROVAL", "发布配置或授权已改变，请重新申请");
    if ([...this.active.values()].some((r) => r.siteId === publisher.siteId))
      fail("DELIVERY_BUSY", "此网站正在发布，请稍后再试");
    const files = Object.fromEntries(
      preview.files.map((f) => [f.name, this.previewFile(s, preview.id, f.name).bytes]),
    );
    const zip = zipFiles(files);
    if (digest(zip) !== request.digest) fail("PREVIEW_CHANGED", "发布包与预览不一致");
    const controller = new AbortController();
    request.status = "publishing";
    request.approvedAt = now();
    const run = { sessionId: s.id, siteId: publisher.siteId, controller, promise: null };
    this.active.set(request.id, run);
    this.save(s, "publish.started");
    run.promise = Promise.resolve().then(async () => {
      try {
        const result = await deploySite(
          publisher,
          zip,
          AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
          {
            fetcher: this.fetcher,
            pollMs: this.pollMs,
            onSubmitted: (deployId) => {
              request.deployId = deployId;
              this.save(s, "publish.submitted");
            },
          },
        );
        Object.assign(request, result, { status: "published", finishedAt: now() });
      } catch (error) {
        request.status = error.code === "DEPLOY_FAILED" ? "failed" : "unknown";
        request.error =
          error instanceof HarnessError
            ? error.message
            : "发布连接中断或超时，请核对远程部署；未自动重发";
      } finally {
        this.active.delete(request.id);
        this.save(s, "publish.finished");
      }
    });
    return structuredClone(request);
  }
  async cancel(s) {
    const jobs = [...this.active.values()].filter((x) => x.sessionId === s.id);
    for (const job of jobs) job.controller.abort();
    for (const p of this.state(s).publications)
      if (p.status === "awaiting_approval") p.status = "cancelled";
    await Promise.allSettled(jobs.map((x) => x.promise));
    this.save(s, "publish.cancelled");
  }
  async close() {
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map((x) => x.promise));
  }
}
