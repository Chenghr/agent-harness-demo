import { compareImport } from "./conflict-review.mjs";
import { HarnessError } from "./core.mjs";
import {
  qualityRubric,
  qualityDimensions,
  toolDimensions,
} from "./runtime/capabilities/evaluation.ts";

/** Management requests never run inside an agent conversation. */
export async function capabilityRoute({ harness: h, parts, method, url, read }) {
  const lib = h.catalog.library,
    command = parts[1];
  const number = (key) => Math.max(0, Math.floor(Number(url.searchParams.get(key)) || 0));
  if (method === "GET") {
    if (command === "import") {
      const pending = lib.repo.get("imports", parts[2]);
      if (!pending) throw new HarnessError("NOT_FOUND", "导入记录不存在");
      return { ...pending, files: lib.repo.package(pending.record.version) };
    }
    if (command === "tree") return { nodes: lib.directory.nodes() };
    if (command === "directory")
      return lib.browse(url.searchParams.get("id") ?? "root", {
        management: true,
        offset: number("offset"),
        kind: url.searchParams.get("kind") ?? "all",
      });
    if (command === "search")
      return lib.search(url.searchParams.get("q") ?? "", {
        management: true,
        directory: url.searchParams.get("directory") ?? "root",
        kind: url.searchParams.get("kind") ?? "all",
        offset: number("offset"),
      });
    if (command === "item") {
      const item = lib.get(parts[2]);
      return {
        ...item,
        files: lib.package(item.id),
        history: lib.repo.list("reports").filter((r) => r.itemId === item.id),
        versions: lib.repo
          .list("versions")
          .filter((v) => v.id === item.id)
          .map((v) => ({ version: v.version, authorVersion: v.authorVersion })),
        relations: lib.repo.list("relations").filter((r) => r.ids.includes(item.id)),
      };
    }
    if (command === "imports") {
      const items = lib.pending().filter((p) => p.status === "pending");
      return { items: items.slice(number("offset"), number("offset") + 20), total: items.length };
    }
    if (command === "jobs")
      return {
        jobs: h.evaluations.list().slice(-40).reverse(),
        rubric: qualityRubric,
        qualityDimensions,
        toolDimensions,
      };
  }
  if (method === "POST") {
    const body = await read();
    if (command === "compare") return compareImport(h, body.id, body.model);
    if (command === "cancel-comparison") {
      h.managementReviews.get(body.id)?.controller.abort();
      return { cancelled: true };
    }
    if (command === "import") {
      if (!body.packages) return lib.import(body);
      if (!Array.isArray(body.packages) || !body.packages.length || body.packages.length > 1000)
        throw new HarnessError("INVALID_ARGUMENT", "一次导入最多 1000 个独立文件包");
      return {
        results: body.packages.map((input) => {
          try {
            return { pending: lib.import(input) };
          } catch (error) {
            return { error: error.message };
          }
        }),
      };
    }
    if (command === "resolve") {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200)
        throw new HarnessError("INVALID_ARGUMENT", "需要明确选中的导入项");
      return {
        results: body.ids.map((id) => {
          try {
            return { id, item: lib.resolve(id, body.decision) };
          } catch (error) {
            return { id, error: error.message };
          }
        }),
      };
    }
    if (command === "directory") {
      if (body.action === "create") return lib.directory.create(body.parent, body.id, body.name);
      return lib.directory.edit(body.id, body.abstract, body.overview);
    }
    if (command === "item") {
      const patch = Object.fromEntries(
        ["title", "description", "directories", "enabled", "trust", "structure", "dependencies"]
          .filter((k) => body[k] !== undefined)
          .map((k) => [k, body[k]]),
      );
      return lib.update(parts[2], patch);
    }
    if (command === "scan") {
      if (!Array.isArray(body.ids) || body.ids.length > 200)
        throw new HarnessError("INVALID_ARGUMENT", "请选择需要扫描的条目");
      return { results: body.ids.map((id) => ({ id, scan: lib.scan(id) })) };
    }
    if (command === "evaluate") {
      if (body.model) {
        const profile = h.models.get(body.model);
        if (!profile.id.startsWith("api-"))
          throw new HarnessError("INVALID_ARGUMENT", "请选择真实模型；模拟模型不生成评分");
      }
      return h.evaluations.start(body.ids, body.kind, body.model || undefined);
    }
    if (command === "cancel") return h.evaluations.cancel(body.id);
    if (command === "relation") {
      if (
        !Array.isArray(body.ids) ||
        body.ids.length !== 2 ||
        new Set(body.ids).size !== 2 ||
        !["alternative", "complementary", "contradiction", "dismissed"].includes(body.type) ||
        !body.reason?.trim()
      )
        throw new HarnessError("INVALID_ARGUMENT", "需要两个不同能力、关系类型和确认依据");
      const items = body.ids.map((id) => lib.get(id));
      const relation = {
        ids: items.map((i) => i.id),
        versions: items.map((i) => i.version),
        type: body.type,
        confirmed: true,
        reason: body.reason,
        date: new Date().toISOString(),
      };
      lib.repo.put("relations", [...relation.ids].sort().join(":"), relation);
      return relation;
    }
  }
  throw new HarnessError("NOT_FOUND", "管理接口不存在");
}
