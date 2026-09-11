import fs from "node:fs";
import path from "node:path";
import { safePath, HarnessError } from "./core.mjs";
import { assertRead, assertWrite } from "./runtime/agent-access.ts";
import { assertNoPhotoPath } from "./privacy-policy.mjs";

/** Check both the requested name and its real target, including existing ancestors. */
export function workspacePath(root, agent, value, operation = "read") {
  const assert = operation === "write" ? assertWrite : assertRead;
  assert(agent, value);
  const file = safePath(root, value);
  let probe = file;
  const suffix = [];
  while (!fs.lstatSync(probe, { throwIfNoEntry: false })) {
    suffix.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  let target;
  try {
    target = path.join(fs.realpathSync(probe), ...suffix);
  } catch {
    throw new HarnessError("PATH_DENIED", "路径的真实目标不可访问");
  }
  assert(agent, path.relative(fs.realpathSync(root), target));
  assertNoPhotoPath(file);
  assertNoPhotoPath(target);
  return file;
}
