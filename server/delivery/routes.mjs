import { HarnessError } from "../core.mjs";
export async function deliveryRoute(h, s, parts, method, read) {
  const service = h.delivery;
  if (method === "GET" && parts.length === 3) return service.snapshot(s);
  if (method === "POST") {
    const body = await read();
    if (parts[3] === "select") return service.select(s, body.assetId);
    if (parts[3] === "select-media") return service.selectMedia(s, body.mediaId);
    if (parts[3] === "requirements") return service.requirements(s, body);
    if (parts[3] === "request-publish")
      return service.requestPublish(s, s.agents.main, body.previewId);
    if (parts[3] === "publish") return service.approvePublish(s, body.requestId, body.decision);
  }
  throw new HarnessError("NOT_FOUND", "图片与网站接口不存在");
}
