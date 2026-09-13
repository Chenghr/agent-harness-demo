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
async function mediaBytes(response, label, maxBytes = 160 * 1024 * 1024) {
  if (!response.ok)
    throw new HarnessError(
      "PROVIDER_HTTP",
      `${label}下载返回 HTTP ${response.status}，未记录响应中的敏感信息`,
    );
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new HarnessError("PROVIDER_LIMIT", `外部服务返回的${label}过大`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function trustedDashScopeResult(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HarnessError("PROVIDER_PROTOCOL", `百炼${label}服务未返回有效下载地址`);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !(url.hostname === "aliyuncs.com" || url.hostname.endsWith(".aliyuncs.com"))
  )
    throw new HarnessError("PROVIDER_PROTOCOL", `百炼${label}服务返回了不受信任的下载地址`);
  return url.href;
}
function trustedHttpsResult(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HarnessError("PROVIDER_PROTOCOL", `${label}服务未返回有效下载地址`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  )
    throw new HarnessError("PROVIDER_PROTOCOL", `${label}服务返回了不受信任的下载地址`);
  return url.href;
}
function audioType(bytes) {
  if (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0))
    return { mime: "audio/mpeg", extension: "mp3" };
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE")
    return { mime: "audio/wav", extension: "wav" };
  throw new HarnessError("PROVIDER_PROTOCOL", "音乐生成结果不是 MP3 或 WAV");
}
function videoType(bytes) {
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp")
    return { mime: "video/mp4", extension: "mp4" };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return { mime: "video/webm", extension: "webm" };
  throw new HarnessError("PROVIDER_PROTOCOL", "视频生成结果不是 MP4 或 WebM");
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
async function imageRequest(makeRequest, signal, retryBaseMs) {
  const retryable = new Set([429, 502, 503, 504]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await makeRequest();
    if (!retryable.has(response.status) || attempt === 2)
      return { response, retryCount: attempt };
    await response.body?.cancel().catch(() => {});
    await delay(retryBaseMs * 2 ** attempt, signal);
  }
}
export async function generateImage(
  profile,
  prompt,
  signal,
  fetcher = fetch,
  { retryBaseMs = 600 } = {},
) {
  if (profile.protocol === "dashscope-multimodal") {
    const { response, retryCount } = await imageRequest(
      () =>
        fetcher(profile.baseUrl, {
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
      signal,
      retryBaseMs,
    );
    const data = await json(
      response,
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
    return { bytes, ...imageType(bytes), retryCount };
  }
  const body = { model: profile.model, prompt, n: 1, size: profile.size };
  if (profile.protocol === "b64-compatible") body.response_format = "b64_json";
  const { response, retryCount } = await imageRequest(
    () =>
      fetcher(profile.baseUrl + "/images/generations", {
        method: "POST",
        headers: { ...headers(profile), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      }),
    signal,
    retryBaseMs,
  );
  const data = await json(
    response,
  );
  const b64 = data.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/=\s]+$/.test(b64))
    throw new HarnessError(
      "PROVIDER_PROTOCOL",
      "图片服务须返回 b64_json；不自动下载第三方图片链接",
    );
  const bytes = Buffer.from(b64, "base64");
  return { bytes, ...imageType(bytes), retryCount };
}
export async function generateMusic(profile, prompt, signal, fetcher = fetch) {
  if (profile.protocol === "tokenhub-minimax-music") {
    const data = await json(
      await fetcher(profile.baseUrl, {
        method: "POST",
        headers: { ...headers(profile), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: profile.model,
          prompt,
          lyrics_optimizer: false,
          is_instrumental: true,
          output_format: "url",
          audio_setting: {
            sample_rate: 44100,
            bitrate: 256000,
            format: profile.format ?? "mp3",
          },
        }),
        signal,
        redirect: "error",
      }),
      2 * 1024 * 1024,
    );
    if (data.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0)
      throw new HarnessError(
        "PROVIDER_PROTOCOL",
        `TokenHub 音乐服务生成失败（状态 ${data.base_resp.status_code}）`,
      );
    if (data.data?.status !== undefined && data.data.status !== 2)
      throw new HarnessError("PROVIDER_PROTOCOL", "TokenHub 音乐服务未返回已完成结果");
    const audio = data.data?.audio;
    let bytes;
    if (typeof audio === "string" && audio.startsWith("https://")) {
      const audioUrl = trustedHttpsResult(audio, "TokenHub 音乐");
      bytes = await mediaBytes(
        await fetcher(audioUrl, { signal, redirect: "error" }),
        "音乐",
        48 * 1024 * 1024,
      );
    } else if (
      typeof audio === "string" &&
      audio.length > 0 &&
      audio.length <= 96 * 1024 * 1024 &&
      audio.length % 2 === 0 &&
      /^[0-9a-fA-F]+$/.test(audio)
    ) {
      bytes = Buffer.from(audio, "hex");
    } else {
      throw new HarnessError("PROVIDER_PROTOCOL", "TokenHub 音乐服务未返回有效音频");
    }
    return {
      bytes,
      ...audioType(bytes),
      providerAssetId: data.trace_id,
      duration: Number(data.extra_info?.music_duration)
        ? Number(data.extra_info.music_duration) / 1000
        : Number(data.extra_info?.duration) || undefined,
    };
  }
  const data = await json(
    await fetcher(profile.baseUrl, {
      method: "POST",
      headers: { ...headers(profile), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: profile.model,
        input: {
          prompt,
          is_instrumental: true,
          format: profile.format ?? "mp3",
          enable_aigc_watermark: false,
        },
      }),
      signal,
      redirect: "error",
    }),
    2 * 1024 * 1024,
  );
  const audioUrl = trustedDashScopeResult(data.output?.audio?.url, "音乐");
  const bytes = await mediaBytes(
    await fetcher(audioUrl, { signal, redirect: "error" }),
    "音乐",
    48 * 1024 * 1024,
  );
  return {
    bytes,
    ...audioType(bytes),
    providerAssetId: data.output?.audio?.id,
    duration: Number(data.usage?.duration) || undefined,
  };
}

export async function generateVideo(
  profile,
  prompt,
  signal,
  fetcher = fetch,
  { pollMs = 15000, onSubmitted = () => {} } = {},
) {
  const submitted = await json(
    await fetcher(profile.baseUrl, {
      method: "POST",
      headers: {
        ...headers(profile),
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: profile.model,
        input: { prompt },
        parameters: {
          resolution: profile.resolution ?? "720P",
          ratio: profile.ratio ?? "16:9",
          duration: profile.duration ?? 10,
          audio: false,
          prompt_extend: true,
          watermark: false,
        },
      }),
      signal,
      redirect: "error",
    }),
    2 * 1024 * 1024,
  );
  const taskId = submitted.output?.task_id;
  if (typeof taskId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(taskId))
    throw new HarnessError("PROVIDER_PROTOCOL", "百炼视频服务未返回有效任务 ID");
  onSubmitted(taskId);
  const taskUrl = new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}`, profile.baseUrl).href;
  let result = submitted;
  while (!["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"].includes(result.output?.task_status)) {
    await delay(pollMs, signal);
    result = await json(
      await fetcher(taskUrl, { headers: headers(profile), signal, redirect: "error" }),
      2 * 1024 * 1024,
    );
  }
  if (result.output?.task_status !== "SUCCEEDED")
    throw new HarnessError("VIDEO_FAILED", `视频任务结束但未成功（${result.output?.task_status}）`);
  const resultUrl =
    result.output?.video_url ??
    result.output?.results?.video_url ??
    result.output?.results?.[0]?.video_url;
  const videoUrl = trustedDashScopeResult(resultUrl, "视频");
  const bytes = await mediaBytes(
    await fetcher(videoUrl, { signal, redirect: "error" }),
    "视频",
  );
  return {
    bytes,
    ...videoType(bytes),
    taskId,
    duration: Number(result.usage?.output_video_duration ?? result.usage?.duration) || undefined,
  };
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
