const str = { type: "string", minLength: 1, maxLength: 200 };
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
    "将全部成员的祝福与生成图片组装为统一风格的网站预览，校验用户设置的成员名单和字数要求；不会发布",
    {
      title: str,
      members: {
        type: "array",
        minItems: 1,
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { name: str, blessing: { ...str, maxLength: 3000 }, imageId: str },
          required: ["name", "blessing", "imageId"],
        },
      },
    },
  ),
];
