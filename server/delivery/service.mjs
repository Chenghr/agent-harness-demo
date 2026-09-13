import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { HarnessError, id, now, safePath, Semaphore } from "../core.mjs";
import { privateJson } from "../settings/models.mjs";
import { workspacePath } from "../workspace-access.mjs";
import { excludedPath } from "../workspaces.mjs";
import { assertFictionalImage } from "../privacy-policy.mjs";
import { DeliveryConfig } from "./config.mjs";
import { generateImage, generateMusic, generateVideo, deploySite } from "./providers.mjs";
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
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
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
    fail("INVALID_ARGUMENT", "网站只接受明确列出的 HTML、CSS、JS、图片、音视频和字体相对路径");
  return value;
}

/** Owns media versions and immutable previews. Publication is a separate user operation. */
export class DeliveryService {
  constructor(h, { fetcher = fetch, pollMs = 1000, imageRetryBaseMs = 600 } = {}) {
    this.h = h;
    this.root = path.join(h.store.root, "delivery");
    this.config = new DeliveryConfig(path.join(h.store.root, "settings"));
    this.records = new Map();
    this.imageLocks = new Set();
    this.mediaLocks = new Set();
    this.imageSlots = new Map();
    this.active = new Map();
    this.fetcher = fetcher;
    this.pollMs = pollMs;
    this.imageRetryBaseMs = imageRetryBaseMs;
  }
  state(s) {
    if (!this.records.has(s.id)) {
      const file = path.join(this.root, s.id, "state.json");
      const state = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : {
            assets: [],
            selections: {},
            media: [],
            mediaSelections: {},
            previews: [],
            publications: [],
            version: 0,
          };
      state.assets ??= [];
      state.selections ??= {};
      state.media ??= [];
      state.mediaSelections ??= {};
      state.previews ??= [];
      state.publications ??= [];
      for (const record of state.publications)
        if (record.status === "publishing") {
          record.status = "unknown";
          record.error = "服务重启，外部发布结果需核对，不自动重放";
        }
      for (const record of state.assets)
        if (record.status === "generating") record.status = "interrupted";
      for (const record of state.media)
        if (record.status === "generating") {
          record.status = record.externalTaskId ? "unknown" : "interrupted";
          record.error = record.externalTaskId
            ? "服务重启，远程媒体任务结果需核对，不自动重新提交"
            : "服务重启，媒体请求已中断，不自动重新提交";
        }
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
  assignPreviews(s, parent, child, ids) {
    const previews = [...new Set(ids)].map((id) => this.getPreview(s, id, parent));
    child.assignedPreviewIds = previews.map((preview) => preview.id);
    return previews.map(({ id, title, createdAt, digest, theme, checks }) => ({
      id,
      title,
      createdAt,
      digest,
      theme,
      checks,
    }));
  }
  assignMedia(s, parent, child, ids) {
    const media = [...new Set(ids)].map((id) => this.mediaAsset(s, id, parent));
    child.assignedMediaIds = media.map((item) => item.id);
    return media.map(({ id, kind, key, version, model, duration, resolution }) => ({
      id,
      kind,
      key,
      version,
      model,
      duration,
      resolution,
    }));
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
  mediaAsset(s, mediaId, a = s.agents.main) {
    const item = this.state(s).media.find((x) => x.id === mediaId && x.status === "ready");
    if (!item || (!this.owns(s, a, item.ownerId) && !a.assignedMediaIds?.includes(item.id)))
      fail("PATH_DENIED", "媒体不存在或没有分配给当前助手");
    return item;
  }
  mediaBytes(s, item) {
    return fs.readFileSync(path.join(this.root, s.id, "media", item.id + "." + item.extension));
  }
  async generate(s, a, args, signal, epoch) {
    assertFictionalImage(args.prompt);
    if (s.readOnly || (a.parentId && a.delegation.definition.workspaceMode !== "outputs"))
      fail("POLICY_DENIED", "只读助手不能生成图片");
    const state = this.state(s),
      expectedGender = state.requirements?.genders?.[args.key],
      genderText = expectedGender === "female" ? "年轻成年女性" : "年轻成年男性";
    if (expectedGender && !args.prompt.includes(genderText))
      fail("CHECKS_FAILED", `${args.key}的出图描述必须明确包含“${genderText}”`);
    if (state.assets.length >= 100)
      fail("DELIVERY_LIMIT", "本任务已达 100 个图片版本，请新建任务");
    const profile = this.config.image(a.imageModelId || args.modelId);
    let lineage = a;
    while (lineage.replacesAgentId) lineage = s.agents[lineage.replacesAgentId];
    const slot = lineage.id + ":" + args.key,
      lock = s.id + ":" + slot;
    if (this.imageLocks.has(lock))
      fail("DELIVERY_BUSY", "同一形象已有出图请求，请等待或停止该请求");
    this.imageLocks.add(lock);
    const previous = state.selections[slot];
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
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      if (!this.imageSlots.has(profile.id))
        this.imageSlots.set(profile.id, new Semaphore(profile.maxConcurrency ?? 2));
      const output = await this.imageSlots.get(profile.id).run(
        () =>
          generateImage(
            profile,
            `仅生成虚构人物或插画，不复刻任何真实人物，不使用照片参考。\n${args.prompt}`,
            requestSignal,
            this.fetcher,
            { retryBaseMs: this.imageRetryBaseMs },
          ),
        requestSignal,
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
        retryCount: output.retryCount,
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
  async generateMedia(s, a, kind, args, signal, epoch) {
    if (s.readOnly || (a.parentId && a.delegation.definition.workspaceMode !== "outputs"))
      fail("POLICY_DENIED", "只读助手不能生成媒体");
    const state = this.state(s);
    if (state.media.length >= 20) fail("DELIVERY_LIMIT", "本任务已达 20 个音视频版本，请新建任务");
    const profile = this.config[kind]();
    let lineage = a;
    while (lineage.replacesAgentId) lineage = s.agents[lineage.replacesAgentId];
    const slot = `${lineage.id}:${kind}:${args.key}`,
      lock = `${s.id}:${slot}`;
    if (this.mediaLocks.has(lock)) fail("DELIVERY_BUSY", "同一媒体已有生成请求，请等待或停止该请求");
    this.mediaLocks.add(lock);
    const previous = state.mediaSelections[slot];
    const record = {
      id: id(kind === "music" ? "audio" : "video"),
      kind,
      key: args.key,
      slot,
      ownerId: a.id,
      version: state.media.filter((x) => x.slot === slot).length + 1,
      modelId: profile.id,
      model: profile.model,
      configVersion: profile.version,
      prompt: args.prompt,
      status: "generating",
      createdAt: now(),
      ...(kind === "video"
        ? { resolution: profile.resolution, ratio: profile.ratio, duration: profile.duration }
        : {}),
    };
    state.media.push(record);
    this.save(s, `${kind}.started`);
    try {
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(kind === "video" ? 20 * 60 * 1000 : 8 * 60 * 1000),
      ]);
      const output =
        kind === "music"
          ? await generateMusic(profile, args.prompt, requestSignal, this.fetcher)
          : await generateVideo(profile, args.prompt, requestSignal, this.fetcher, {
              pollMs: this.pollMs,
              onSubmitted: (taskId) => {
                record.externalTaskId = taskId;
                this.save(s, "video.submitted");
              },
            });
      this.h.valid(s, a, epoch, signal);
      if (
        state.media.filter((x) => x.status === "ready").reduce((n, x) => n + x.bytes, 0) +
          output.bytes.length >
        200 * 1024 * 1024
      )
        fail("DELIVERY_LIMIT", "本任务音视频总量超过 200 MB");
      const directory = path.join(this.root, s.id, "media");
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
        providerAssetId: output.providerAssetId,
        externalTaskId: output.taskId ?? record.externalTaskId,
        actualDuration: output.duration,
        url: `/api/sessions/${s.id}/delivery/media/${record.id}`,
      });
      if (state.mediaSelections[slot] === previous) state.mediaSelections[slot] = record.id;
      state.version++;
      a.outputRevision = (a.outputRevision ?? 0) + 1;
      this.save(s, `${kind}.ready`);
      return structuredClone(record);
    } catch (error) {
      const remoteUnknown = kind === "video" && record.externalTaskId && error?.code !== "VIDEO_FAILED";
      record.status = remoteUnknown ? "unknown" : signal.aborted ? "cancelled" : "failed";
      record.error = remoteUnknown
        ? "远程视频任务已提交，但本地未确认最终结果；为避免重复计费不会自动重提"
        : error instanceof HarnessError
          ? error.message
          : `${kind === "music" ? "音乐" : "视频"}请求失败或超时，已有版本保留`;
      this.save(s, `${kind}.failed`);
      if (signal.aborted) signal.throwIfAborted();
      throw error instanceof HarnessError
        ? error
        : new HarnessError(kind === "music" ? "MUSIC_FAILED" : "VIDEO_FAILED", record.error);
    } finally {
      this.mediaLocks.delete(lock);
    }
  }
  generateMusic(s, a, args, signal, epoch) {
    return this.generateMedia(s, a, "music", args, signal, epoch);
  }
  generateVideo(s, a, args, signal, epoch) {
    return this.generateMedia(s, a, "video", args, signal, epoch);
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
  selectMedia(s, mediaId) {
    const item = this.mediaAsset(s, mediaId),
      state = this.state(s);
    if (state.mediaSelections[item.slot] === item.id) return this.snapshot(s);
    state.mediaSelections[item.slot] = item.id;
    state.version++;
    for (const p of state.publications) if (p.status === "awaiting_approval") p.status = "stale";
    this.save(s, "media.selected");
    this.userInput(
      s,
      `用户已将${item.kind === "music" ? "背景音乐" : "感谢视频"}恢复到版本 ${item.version}（${item.id}），需要重新创建预览。`,
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
  commitPreview(s, a, title, files, sources, assets, members, metadata = {}) {
    const state = this.state(s);
    if (state.previews.length >= 40) fail("DELIVERY_LIMIT", "本任务已达 40 个预览版本");
    if (Object.values(files).reduce((n, b) => n + b.length, 0) > 260 * 1024 * 1024)
      fail("DELIVERY_LIMIT", "网站预览总量超过 260 MB");
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
      ...metadata,
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
  requirements(
    s,
    {
      members,
      limits = {},
      genders = {},
      presentation = {},
      media = { music: false, video: false },
    },
  ) {
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
    if (
      !genders ||
      typeof genders !== "object" ||
      Array.isArray(genders) ||
      Object.entries(genders).some(
        ([name, gender]) => !members.includes(name) || !["female", "male"].includes(gender),
      )
    )
      fail("INVALID_ARGUMENT", "成员性别要求须对应名单，并使用 female 或 male");
    const section = (value) =>
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 6 &&
      value.every(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof item.title === "string" &&
          item.title.length >= 1 &&
          item.title.length <= 100 &&
          typeof item.text === "string" &&
          item.text.length >= 1 &&
          item.text.length <= 600,
      );
    if (
      !presentation ||
      typeof presentation !== "object" ||
      Array.isArray(presentation) ||
      Object.entries(presentation).some(([key, value]) => {
        if (["highlights", "journey"].includes(key)) return !section(value);
        return (
          !["title", "subtitle", "intro", "sectionTitle", "closingTitle", "closing"].includes(
            key,
          ) ||
          typeof value !== "string" ||
          !value.trim() ||
          value.length > 1000
        );
      })
    )
      fail("INVALID_ARGUMENT", "网站展示要求格式无效");
    if (
      !media ||
      typeof media !== "object" ||
      Array.isArray(media) ||
      Object.keys(media).some((key) => !["music", "video"].includes(key)) ||
      Object.values(media).some((value) => typeof value !== "boolean")
    )
      fail("INVALID_ARGUMENT", "网站媒体要求格式无效");
    const state = this.state(s);
    state.requirements = {
      members,
      limits,
      genders,
      presentation,
      media: { music: !!media.music, video: !!media.video },
      version: (state.requirements?.version ?? 0) + 1,
    };
    s.acceptance = {
      ...s.acceptance,
      description:
        "核对网站成员名单、祝福字数与媒体版本；画面和内容由用户预览确认，发布另行批准。",
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
      media = [],
      members = [];
    for (const [index, member] of args.members.entries()) {
      const limit = requirements.limits[member.name];
      if (!member.blessing.trim() || (limit && [...member.blessing].length > limit))
        fail("CHECKS_FAILED", `${member.name}的祝福为空或超过 ${limit} 字`);
      const asset = this.asset(s, member.imageId, a);
      if (asset.key !== member.name)
        fail("CHECKS_FAILED", `${member.name}引用了其他成员的图片版本`);
      if (state.selections[asset.slot] !== asset.id)
        fail("CHECKS_FAILED", `${member.name}引用的图片不是当前选中版本`);
      const target = `images/member-${index + 1}.${asset.extension}`;
      files[target] = this.imageBytes(s, asset);
      assets.push({ id: asset.id, slot: asset.slot, selected: asset.id, target });
      members.push({ ...member, imagePath: target });
    }
    const includeMedia = (kind, mediaId, targetBase) => {
      if (!mediaId) {
        if (requirements.media?.[kind])
          fail("CHECKS_FAILED", `网站缺少${kind === "music" ? "背景音乐" : "感谢视频"}`);
        return undefined;
      }
      const item = this.mediaAsset(s, mediaId, a);
      if (item.kind !== kind) fail("CHECKS_FAILED", "网站媒体类型与版本 ID 不匹配");
      if (state.mediaSelections[item.slot] !== item.id)
        fail("CHECKS_FAILED", "网站引用的音视频不是当前选中版本");
      const target = `media/${targetBase}.${item.extension}`;
      files[target] = this.mediaBytes(s, item);
      media.push({ id: item.id, slot: item.slot, selected: item.id, kind, target });
      return target;
    };
    const musicPath = includeMedia("music", args.musicId, "background");
    const videoPath = includeMedia("video", args.videoId, "thanks");
    const requiredPresentation = requirements.presentation ?? {};
    for (const key of ["title", "subtitle"])
      if (
        requiredPresentation[key] &&
        args[key] !== undefined &&
        args[key] !== requiredPresentation[key]
      )
        fail("CHECKS_FAILED", `网站${key === "title" ? "标题" : "副标题"}与任务要求不一致`);
    const finalTitle = requiredPresentation.title ?? args.title;
    const presentation = {
      subtitle:
        requiredPresentation.subtitle ?? args.subtitle ?? "八个人，一份共同的感谢",
      intro:
        requiredPresentation.intro ??
        args.intro ??
        "谢谢您把耐心、方法与勇气留在我们的成长里。",
      sectionTitle:
        requiredPresentation.sectionTitle ?? args.sectionTitle ?? "八封写给导师的信",
      highlights: requiredPresentation.highlights ?? args.highlights,
      journey: requiredPresentation.journey ?? args.journey,
      closingTitle:
        requiredPresentation.closingTitle ?? args.closingTitle ?? "新程有您，步履更坚定",
      closing:
        requiredPresentation.closing ??
        args.closing ??
        "感谢您以经验为灯，也以关怀为伴。未来我们会带着这份耐心与认真继续成长。",
      theme: args.theme ?? "paper-garden",
      layout: args.layout ?? "gallery",
      motion: args.motion ?? "gentle",
      musicPath,
      videoPath,
    };
    const checks = [
      { id: "members", label: "成员完整且唯一", status: "pass", detail: `${members.length}/${requirements.members.length}` },
      { id: "copy", label: "文案非空且符合字数", status: "pass", detail: `${members.length} 项通过` },
      { id: "images", label: "当前图片一一对应", status: "pass", detail: `${assets.length} 张 ready 图片` },
      {
        id: "media",
        label: "背景音乐与感谢视频",
        status: "pass",
        detail: `${musicPath ? "音乐 ready" : "未要求音乐"} · ${videoPath ? "视频 ready" : "未要求视频"}`,
      },
      { id: "accessibility", label: "替代文本与减少动效", status: "pass", detail: "模板内置" },
      { id: "publication", label: "发布仍需用户批准", status: "pass", detail: "本地固定预览" },
    ];
    files["index.html"] = Buffer.from(greetingHtml(finalTitle, members, presentation));
    return this.commitPreview(s, a, finalTitle, files, [], assets, members, {
      ...presentation,
      media,
      checks,
    });
  }
  getPreview(s, previewId, a = s.agents.main) {
    const record = this.state(s).previews.find((x) => x.id === previewId);
    if (
      !record ||
      (!this.owns(s, a, record.ownerId) && !a.assignedPreviewIds?.includes(record.id))
    )
      fail("NOT_FOUND", "预览不存在或没有分配给当前助手");
    return record;
  }
  reviewGreeting(s, a, previewId) {
    const preview = this.getPreview(s, previewId, a),
      state = this.state(s),
      requirements = state.requirements,
      members = preview.members ?? [],
      names = members.map((member) => member.name),
      publications = state.publications.filter((item) => item.previewId === preview.id);
    const mediaReady = (kind) => {
      if (!requirements?.media?.[kind]) return true;
      const ref = preview.media?.find((item) => item.kind === kind),
        item = ref && state.media.find((candidate) => candidate.id === ref.id),
        file = ref && preview.files.find((candidate) => candidate.name === ref.target);
      return !!(
        ref &&
        item?.status === "ready" &&
        state.mediaSelections[item.slot] === item.id &&
        file?.sha256 === item.sha256 &&
        file.bytes === item.bytes
      );
    };
    const checks = [
      {
        id: "members",
        label: "成员完整且唯一",
        status:
          requirements &&
          names.length === requirements.members.length &&
          new Set(names).size === names.length &&
          requirements.members.every((name) => names.includes(name))
            ? "pass"
            : "fail",
        detail: `${names.length}/${requirements?.members.length ?? 0}`,
      },
      {
        id: "copy",
        label: "文案非空且符合字数",
        status:
          requirements &&
          members.every((member) => {
            const limit = requirements.limits[member.name];
            return member.blessing?.trim() && (!limit || [...member.blessing].length <= limit);
          })
            ? "pass"
            : "fail",
        detail: "按 Unicode 字符检查",
      },
      {
        id: "images",
        label: "图片版本与成员对应",
        status: members.every((member) => {
          const asset = state.assets.find((item) => item.id === member.imageId);
          return asset?.status === "ready" && asset.key === member.name;
        })
          ? "pass"
          : "fail",
        detail: `${members.length} 个图片引用`,
      },
      {
        id: "media",
        label: "音视频版本与本地副本",
        status:
          mediaReady("music") && mediaReady("video")
            ? "pass"
            : "fail",
        detail: `${preview.media?.length ?? 0} 个媒体引用`,
      },
      {
        id: "latest",
        label: "检查最新固定预览",
        status:
          state.previews.at(-1)?.id === preview.id &&
          preview.requirementsVersion === (requirements?.version ?? 0)
            ? "pass"
            : "fail",
        detail: preview.id,
      },
      {
        id: "accessibility",
        label: "可访问性模板规则",
        status: preview.checks?.some(
          (check) => check.id === "accessibility" && check.status === "pass",
        )
          ? "pass"
          : "fail",
        detail: "图片替代文本与 prefers-reduced-motion",
      },
      {
        id: "visual",
        label: "头像视觉一致性",
        status: "pending",
        detail: "需要用户查看实际预览",
      },
      {
        id: "publication",
        label: "发布状态",
        status: "pass",
        detail: publications.length ? publications.at(-1).status : "尚未申请发布",
      },
    ];
    return {
      previewId: preview.id,
      verdict: checks.some((check) => check.status === "fail")
        ? "needs_revision"
        : "needs_user_review",
      deterministicChecksPassed: checks.filter((check) => check.status !== "pending").every(
        (check) => check.status === "pass",
      ),
      checks,
    };
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
    for (const item of preview.media ?? [])
      if (state.mediaSelections[item.slot] !== item.selected)
        fail("STALE_APPROVAL", "音视频版本已改变，请重新预览和批准");
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
