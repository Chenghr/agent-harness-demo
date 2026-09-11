import { HarnessError } from "./core.mjs";

// All first-party tools share this boundary. Skills and full-access mode cannot change it.
export const photoPath = (value) => /(?:^|[\\/])(?:Photos|Pictures|相册)(?:[\\/]|$)/i.test(value);
export function assertNoPhotoPath(value) {
  if (photoPath(value))
    throw new HarnessError(
      "POLICY_DENIED",
      "本应用禁止读取私人相册；完全访问和 Skill 加载不会改变此限制",
    );
}
export function assertFictionalImage(prompt) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 6000)
    throw new HarnessError("INVALID_ARGUMENT", "请提供 1 到 6000 字符的虚拟形象说明");
  const positive = prompt.replace(
    /(?:不要|不能|禁止|不得|不)(?:读取|使用|参考|复刻|还原|模仿)(?:任何)?(?:真人脸|真人照片|人脸照片|相册)|do not use (?:real person|face photo)/gi,
    "",
  );
  if (
    /(?:使用|读取|参考|复刻|还原|模仿|基于).{0,24}(?:真人|人脸照片|相册)|(?:impersonate|recreate|use|copy).{0,30}(?:real person|celebrity|face photo)|https?:\/\/|~\//i.test(
      positive,
    )
  )
    throw new HarnessError(
      "POLICY_DENIED",
      "仅支持文字描述的虚构形象；不能使用真人脸、照片、外部链接或相册作为参考",
    );
}
export const photoSandboxRule =
  '(deny file-read* file-write* (regex #"/(Photos|Pictures|photos|pictures|相册)(/|$)"))';
