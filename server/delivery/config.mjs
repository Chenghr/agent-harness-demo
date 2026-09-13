import fs from "node:fs";
import path from "node:path";
import { privateJson } from "../settings/models.mjs";
import { HarnessError, id } from "../core.mjs";

const fail = (message) => {
  throw new HarnessError("DELIVERY_CONFIG", message);
};
export function serviceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("服务地址无效");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    fail("远程服务必须使用 HTTPS；地址不能包含凭据或查询参数");
  return url.href.replace(/\/$/, "");
}
const read = (p, fallback) =>
  fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
export class DeliveryConfig {
  constructor(root) {
    this.root = root;
    this.data = read(path.join(root, "delivery.json"), {
      images: [],
      music: null,
      video: null,
      publisher: null,
    });
    this.data.images ??= [];
    this.data.music ??= null;
    this.data.video ??= null;
    this.data.publisher ??= null;
    this.secrets = read(path.join(root, "delivery-credentials.json"), {});
  }
  list() {
    return {
      images: this.data.images.map((p) => ({ ...p, hasKey: !!this.secrets[p.id] })),
      music: this.data.music && {
        ...this.data.music,
        hasKey: !!this.secrets[this.data.music.id],
      },
      video: this.data.video && {
        ...this.data.video,
        hasKey: !!this.secrets[this.data.video.id],
      },
      publisher: this.data.publisher && {
        ...this.data.publisher,
        hasKey: !!this.secrets.publisher,
      },
    };
  }
  save(kind, v) {
    if (!["image", "music", "video", "publisher"].includes(kind)) fail("未知服务类型");
    if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 100) fail("请填写服务名称");
    const baseUrl = serviceUrl(v.baseUrl);
    const old =
      kind === "image"
        ? this.data.images.find((p) => p.id === v.id)
        : kind === "publisher"
          ? this.data.publisher
          : this.data[kind];
    if (kind === "image" && v.id && !old) fail("图片服务不存在");
    const key =
      kind === "image"
        ? (old?.id ?? id("image-model"))
        : kind === "publisher"
          ? "publisher"
          : (old?.id ?? id(`${kind}-model`));
    const record = { id: key, name: v.name.trim(), baseUrl, version: (old?.version ?? 0) + 1 };
    if (kind === "image") {
      if (typeof v.model !== "string" || !v.model.trim() || v.model.length > 200)
        fail("请填写图片模型 ID");
      if (!["gpt-image", "b64-compatible", "dashscope-multimodal"].includes(v.protocol))
        fail("未知图片协议");
      const maxConcurrency = Number(v.maxConcurrency ?? old?.maxConcurrency ?? 2);
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4)
        fail("图片并发数需要在 1 到 4 之间");
      Object.assign(record, {
        model: v.model.trim(),
        protocol: v.protocol,
        size: "1024x1024",
        maxConcurrency,
      });
    } else if (kind === "music") {
      if (typeof v.model !== "string" || !v.model.trim() || v.model.length > 200)
        fail("请填写音乐模型 ID");
      const protocol = v.protocol ?? old?.protocol ?? "dashscope-music";
      if (!["dashscope-music", "tokenhub-minimax-music"].includes(protocol))
        fail("未知音乐协议");
      Object.assign(record, {
        model: v.model.trim(),
        protocol,
        format: "mp3",
      });
    } else if (kind === "video") {
      if (typeof v.model !== "string" || !v.model.trim() || v.model.length > 200)
        fail("请填写视频模型 ID");
      Object.assign(record, {
        model: v.model.trim(),
        protocol: "dashscope-video-async",
        resolution: "720P",
        ratio: "16:9",
        duration: 10,
      });
    } else {
      if (typeof v.siteId !== "string" || !/^[a-zA-Z0-9.-]{1,150}$/.test(v.siteId))
        fail("请填写 Netlify Site ID");
      Object.assign(record, { siteId: v.siteId, protocol: "netlify-zip" });
    }
    if (v.apiKey !== undefined && (typeof v.apiKey !== "string" || v.apiKey.length > 8192))
      fail("密钥格式无效");
    if (v.apiKey !== undefined) this.secrets[key] = v.apiKey;
    if (kind === "image")
      this.data.images = this.data.images.filter((p) => p.id !== key).concat(record);
    else if (kind === "publisher") this.data.publisher = record;
    else this.data[kind] = record;
    privateJson(path.join(this.root, "delivery-credentials.json"), this.secrets);
    privateJson(path.join(this.root, "delivery.json"), this.data);
    return this.list();
  }
  image(key) {
    const p = key ? this.data.images.find((p) => p.id === key) : this.data.images[0];
    if (!p) fail("请先在模型与运行设置中配置出图服务");
    return { ...p, apiKey: this.secrets[p.id] || "" };
  }
  music() {
    const profile = this.data.music;
    if (!profile) fail("请先在模型与运行设置中配置音乐生成服务");
    return { ...profile, apiKey: this.secrets[profile.id] || "" };
  }
  video() {
    const profile = this.data.video;
    if (!profile) fail("请先在模型与运行设置中配置视频生成服务");
    return { ...profile, apiKey: this.secrets[profile.id] || "" };
  }
  publisher() {
    const p = this.data.publisher;
    if (!p) fail("请先配置 Netlify 发布服务和 Site ID");
    return { ...p, apiKey: this.secrets.publisher || "" };
  }
}
