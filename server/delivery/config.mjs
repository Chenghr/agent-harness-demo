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
    this.data = read(path.join(root, "delivery.json"), { images: [], publisher: null });
    this.secrets = read(path.join(root, "delivery-credentials.json"), {});
  }
  list() {
    return {
      images: this.data.images.map((p) => ({ ...p, hasKey: !!this.secrets[p.id] })),
      publisher: this.data.publisher && {
        ...this.data.publisher,
        hasKey: !!this.secrets.publisher,
      },
    };
  }
  save(kind, v) {
    if (!["image", "publisher"].includes(kind)) fail("未知服务类型");
    if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 100) fail("请填写服务名称");
    const baseUrl = serviceUrl(v.baseUrl);
    const old =
      kind === "image" ? this.data.images.find((p) => p.id === v.id) : this.data.publisher;
    if (kind === "image" && v.id && !old) fail("图片服务不存在");
    const key = kind === "image" ? (old?.id ?? id("image-model")) : "publisher";
    const record = { id: key, name: v.name.trim(), baseUrl, version: (old?.version ?? 0) + 1 };
    if (kind === "image") {
      if (typeof v.model !== "string" || !v.model.trim() || v.model.length > 200)
        fail("请填写图片模型 ID");
      if (!["gpt-image", "b64-compatible", "dashscope-multimodal"].includes(v.protocol))
        fail("未知图片协议");
      Object.assign(record, { model: v.model.trim(), protocol: v.protocol, size: "1024x1024" });
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
    else this.data.publisher = record;
    privateJson(path.join(this.root, "delivery-credentials.json"), this.secrets);
    privateJson(path.join(this.root, "delivery.json"), this.data);
    return this.list();
  }
  image(key) {
    const p = key ? this.data.images.find((p) => p.id === key) : this.data.images[0];
    if (!p) fail("请先在模型与运行设置中配置出图服务");
    return { ...p, apiKey: this.secrets[p.id] || "" };
  }
  publisher() {
    const p = this.data.publisher;
    if (!p) fail("请先配置 Netlify 发布服务和 Site ID");
    return { ...p, apiKey: this.secrets.publisher || "" };
  }
}
