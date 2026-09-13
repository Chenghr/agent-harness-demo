const str = { type: "string", minLength: 1, maxLength: 200 };
const sectionItems = {
  type: "array",
  minItems: 1,
  maxItems: 6,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { ...str, maxLength: 60 },
      text: { ...str, maxLength: 500 },
    },
    required: ["title", "text"],
  },
};
const tool = (name, description, properties = {}, required = Object.keys(properties)) => ({
  name,
  title: description,
  description,
  kind: "tool",
  category: "图片与网站",
  source: "local",
  version: "1",
  simulated: false,
  parameters: { type: "object", properties, required, additionalProperties: false },
});
export const DELIVERY_TOOLS = [
  tool("image_models", "列出用户配置的出图模型；模型 ID 与主对话模型分开"),
  tool("music_models", "列出用户配置的音乐生成模型；只返回非敏感配置"),
  tool("video_models", "列出用户配置的视频生成模型；只返回非敏感配置"),
  tool(
    "image_generate",
    "生成虚构头像或插画，保存独立版本。不能使用照片、真人脸参考或链接；同一成员使用相同 key",
    {
      key: str,
      prompt: { ...str, maxLength: 6000 },
      modelId: str,
    },
    ["key", "prompt"],
  ),
  tool(
    "music_generate",
    "生成网站背景音乐并立即保存本地版本；不把临时下载链接作为交付物",
    { key: str, prompt: { ...str, maxLength: 2000 } },
  ),
  tool(
    "video_generate",
    "异步生成约 10 秒、720P 的感谢短片，记录远程任务 ID 并在完成后保存本地版本",
    { key: str, prompt: { ...str, maxLength: 6000 } },
  ),
  tool(
    "site_preview",
    "从明确列出的静态文件创建固定版本的本地预览。仅预览，不发布；用 assets 将生成图片加入网站",
    {
      title: str,
      entry: str,
      files: { type: "array", items: str, maxItems: 200 },
      assets: {
        type: "array",
        maxItems: 40,
        items: {
          type: "object",
          properties: { id: str, path: str },
          required: ["id", "path"],
          additionalProperties: false,
        },
      },
    },
    ["title", "entry", "files"],
  ),
  tool(
    "site_request_publish",
    "为指定预览请求用户批准发布。不会执行发布，完全访问权限也不能跳过用户确认",
    { previewId: str },
  ),
  tool(
    "greeting_site",
    "将全部成员的祝福与生成图片组装为主题化网站预览，校验用户设置的成员名单和字数要求；不会发布",
    {
      title: str,
      subtitle: { ...str, maxLength: 240 },
      intro: { ...str, maxLength: 600 },
      sectionTitle: { ...str, maxLength: 100 },
      highlights: sectionItems,
      journey: sectionItems,
      closingTitle: { ...str, maxLength: 100 },
      closing: { ...str, maxLength: 600 },
      theme: { type: "string", enum: ["paper-garden", "warm-gallery", "night-sky"] },
      layout: { type: "string", enum: ["gallery", "timeline"] },
      motion: { type: "string", enum: ["gentle", "reduced"] },
      musicId: str,
      videoId: str,
      members: {
        type: "array",
        minItems: 1,
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: str,
            gender: { type: "string", enum: ["female", "male"] },
            blessing: { ...str, maxLength: 3000 },
            imageId: str,
            keyword: { ...str, maxLength: 24 },
          },
          required: ["name", "blessing", "imageId"],
        },
      },
    },
    ["title", "members"],
  ),
  tool(
    "greeting_review",
    "独立检查固定祝福网站预览的成员、字数、图片与音视频版本、主题、可访问性和发布状态；只读，不修改成果",
    { previewId: str },
  ),
];
