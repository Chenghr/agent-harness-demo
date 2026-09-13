import { HarnessError, delay } from "../core.mjs";

async function json(response, maxBytes = 32 * 1024 * 1024) {
  if (!response.ok)
    throw new HarnessError(
      "PROVIDER_HTTP",
      `外部服务返回 HTTP ${response.status}，未记录响应中的敏感信息`,
    );
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new HarnessError("PROVIDER_LIMIT", "外部服务响应过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HarnessError("PROVIDER_PROTOCOL", "外部服务未返回有效 JSON");
  }
}
const headers = (p) => (p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {});
async function imageBytes(response, maxBytes = 32 * 1024 * 1024) {
  if (!response.ok)
    throw new HarnessError(
      "PROVIDER_HTTP",
      `图片下载返回 HTTP ${response.status}，未记录响应中的敏感信息`,
    );
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new HarnessError("PROVIDER_LIMIT", "外部服务返回的图片过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mime: "image/png", extension: "png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { mime: "image/jpeg", extension: "jpg" };
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return { mime: "image/webp", extension: "webp" };
  throw new HarnessError("PROVIDER_PROTOCOL", "出图结果不是 PNG、JPEG 或 WebP");
}
export async function generateImage(profile, prompt, signal, fetcher = fetch) {
  if (profile.protocol === "dashscope-multimodal") {
    const data = await json(
      await fetcher(profile.baseUrl, {
        method: "POST",
        headers: { ...headers(profile), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: profile.model,
          input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
          parameters: { prompt_extend: true },
        }),
        signal,
        redirect: "error",
      }),
    );
    const imageUrl = data.output?.choices?.[0]?.message?.content?.find(
      (item) => typeof item?.image === "string",
    )?.image;
    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch {
      throw new HarnessError("PROVIDER_PROTOCOL", "百炼出图服务未返回有效图片地址");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !(parsed.hostname === "aliyuncs.com" || parsed.hostname.endsWith(".aliyuncs.com"))
    )
      throw new HarnessError("PROVIDER_PROTOCOL", "百炼出图服务返回了不受信任的图片地址");
    const bytes = await imageBytes(
      await fetcher(parsed.href, { signal, redirect: "error" }),
    );
    return { bytes, ...imageType(bytes) };
  }
  const body = { model: profile.model, prompt, n: 1, size: profile.size };
  if (profile.protocol === "b64-compatible") body.response_format = "b64_json";
  const data = await json(
    await fetcher(profile.baseUrl + "/images/generations", {
      method: "POST",
      headers: { ...headers(profile), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    }),
  );
  const b64 = data.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/=\s]+$/.test(b64))
    throw new HarnessError(
      "PROVIDER_PROTOCOL",
      "图片服务须返回 b64_json；不自动下载第三方图片链接",
    );
  const bytes = Buffer.from(b64, "base64");
  return { bytes, ...imageType(bytes) };
}
export async function deploySite(
  profile,
  zip,
  signal,
  { fetcher = fetch, onSubmitted = () => {}, pollMs = 1000 } = {},
) {
  let data = await json(
    await fetcher(`${profile.baseUrl}/sites/${encodeURIComponent(profile.siteId)}/deploys`, {
      method: "POST",
      headers: { ...headers(profile), "Content-Type": "application/zip" },
      body: zip,
      signal,
      redirect: "error",
    }),
    1000000,
  );
  if (typeof data.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(data.id))
    throw new HarnessError("PROVIDER_PROTOCOL", "发布服务未返回有效部署 ID，请在服务端核对");
  const deployId = data.id;
  onSubmitted(deployId);
  while (data.state !== "ready") {
    if (data.state === "error") throw new HarnessError("DEPLOY_FAILED", "发布服务报告部署失败");
    await delay(pollMs, signal);
    data = await json(
      await fetcher(`${profile.baseUrl}/deploys/${deployId}`, {
        headers: headers(profile),
        signal,
        redirect: "error",
      }),
      1000000,
    );
  }
  const url = data.ssl_url || data.deploy_ssl_url || data.url;
  if (typeof url !== "string" || !url.startsWith("https://"))
    throw new HarnessError(
      "PROVIDER_PROTOCOL",
      "部署已就绪，但没有返回 HTTPS 地址，请到服务端核对",
    );
  return { deployId, url };
}
