import Ajv from "ajv";
import { HarnessError } from "./core.mjs";
const ajv = new Ajv({ strict: true, allErrors: true, validateFormats: true });
const cache = new Map();
export function validateTool(schema, value) {
  const key = JSON.stringify(schema);
  let check = cache.get(key);
  if (!check) {
    try {
      check = ajv.compile(schema);
    } catch {
      throw new HarnessError(
        "SCHEMA_UNSUPPORTED",
        "工具参数定义包含不支持或不合法的 JSON Schema 规则",
      );
    }
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(key, check);
  }
  if (!check(value))
    throw new HarnessError("INVALID_ARGUMENT", `参数校验失败：${ajv.errorsText(check.errors)}`);
}
