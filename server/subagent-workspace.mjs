import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { safePath, HarnessError } from "./core.mjs";
import { assertRead, relativePath, canReadArtifact } from "./runtime/agent-access.ts";
import { workspacePath } from "./workspace-access.mjs";

/** Prepares only explicitly delegated materials; contains no scenario-specific filenames. */
export class SubagentWorkspace {
  constructor(harness) {
    this.harness = harness;
  }
  prepare(s, parent, child, request) {
    const h = this.harness,
      source = h.workspace(s, parent),
      destination = h.workspace(s, child);
    if ((request.files?.length ?? 0) + (request.artifacts?.length ?? 0) > 40)
      throw new HarnessError("INPUT_LIMIT", "单次最多分配 40 份材料");
    const inputs = [];
    let bytes = 0;
    for (const value of request.files ?? []) {
      const relative = relativePath(value);
      assertRead(parent, relative);
      const file = workspacePath(source, parent, relative);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        throw new HarnessError("NOT_FOUND", `输入文件不存在：${relative}`);
      if (fs.statSync(file).size > 2_000_000)
        throw new HarnessError("INPUT_LIMIT", "输入文件过大，请先提供所需片段");
      inputs.push({
        path: relative,
        content: fs.readFileSync(file),
        sourceAgentId: parent.id,
        sourcePath: relative,
      });
    }
    for (const id of request.artifacts ?? []) {
      if (!canReadArtifact(parent, id))
        throw new HarnessError("PATH_DENIED", "不能分配无权读取的产物");
      const artifact = h.store.readArtifact(s.id, id);
      inputs.push({
        path: `inputs/${id}.txt`,
        content: Buffer.from(artifact.content),
        sourceAgentId: parent.id,
        artifactId: id,
      });
    }
    if (inputs.length > 40) throw new HarnessError("INPUT_LIMIT", "单次最多分配 40 份材料");
    for (const input of inputs) bytes += input.content.length;
    if (bytes > 4_000_000) throw new HarnessError("INPUT_LIMIT", "本次材料总量过大，请拆分任务");
    fs.mkdirSync(destination, { recursive: true });
    try {
      const used = new Set();
      for (const input of inputs) {
        if (used.has(input.path))
          throw new HarnessError("INVALID_ARGUMENT", "分配材料的文件名重复");
        used.add(input.path);
        const file = safePath(destination, input.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, input.content);
        const { content, ...reference } = input;
        child.delegation.materials.push({
          ...reference,
          digest: createHash("sha256").update(content).digest("hex"),
        });
      }
      child.delegation.artifactIds = [...(request.artifacts ?? [])];
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }
  stale(s, a) {
    if (!a.delegation) return a.baseRevision !== s.workspaceRevision;
    if (a.delegation.requirementRevision !== s.revision) return true;
    return a.delegation.materials.some((m) => {
      try {
        const source = s.agents[m.sourceAgentId];
        const content = m.artifactId
          ? this.harness.store.readArtifact(s.id, m.artifactId).content
          : fs.readFileSync(safePath(this.harness.workspace(s, source), m.sourcePath));
        return createHash("sha256").update(content).digest("hex") !== m.digest;
      } catch {
        return true;
      }
    });
  }
}
