import { randomUUID } from "node:crypto";
import type {
  BrowseOptions,
  Capability,
  Decision,
  Files,
  ImportInput,
  Pending,
  Report,
} from "./types.ts";
import { fault } from "./types.ts";
import { CapabilityRepository } from "./repository.ts";
import { CapabilityDirectory } from "./directory.ts";
import { parseImport } from "./parser.ts";
import { conflicts, inspect } from "./inspection.ts";

export class CapabilityLibrary {
  repo: CapabilityRepository;
  directory: CapabilityDirectory;
  onChange?: () => void;
  constructor(root: string) {
    this.repo = new CapabilityRepository(root);
    this.directory = new CapabilityDirectory(this.repo, () => this.items());
  }
  items(): Capability[] {
    return this.repo.list<Capability>("items");
  }
  get(id: string): Capability {
    return (
      this.repo.get<Capability>("items", id) ??
      this.items().find((i) => i.name === id) ??
      fault("能力不存在")
    );
  }
  package(id: string, version?: string): Files {
    const item = this.get(id);
    const v = version ?? item.version;
    if (v !== item.version && !this.repo.get("versions", `${item.id}@${v}`))
      fault("此版本不属于该能力");
    return this.repo.package(v);
  }
  seed(record: Capability, files: Files) {
    if (this.repo.get("items", record.id)) return;
    record.version = this.repo.savePackage(files);
    record.scan = inspect(record, files);
    this.repo.put("items", record.id, record);
    this.repo.put("versions", `${record.id}@${record.version}`, record);
  }
  import(input: ImportInput): Pending {
    const { record, files } = parseImport(input);
    const sameSource = this.items().find(
      (item) =>
        item.kind === record.kind &&
        item.source === record.source &&
        item.originalName === record.originalName,
    );
    if (sameSource) {
      record.id = sameSource.id;
      record.name = sameSource.name;
    }
    record.version = this.repo.savePackage(files);
    record.scan = inspect(record, files);
    const pending: Pending = {
      id: randomUUID(),
      record,
      conflicts: conflicts(record, this.items()),
      status: "pending",
    };
    this.repo.put("imports", pending.id, pending);
    return pending;
  }
  pending() {
    return this.repo.list<Pending>("imports");
  }
  resolve(id: string, decision: Decision): Capability {
    const pending = this.repo.get<Pending>("imports", id) ?? fault("导入记录不存在");
    if (pending.status !== "pending") fault("该导入已处理，请刷新");
    if (
      !["keep", "skip", "attach-source", "replace", "save-disabled", "dismiss"].includes(
        decision.action,
      )
    )
      fault("未知冲突处理方式");
    const item = structuredClone(pending.record);
    const result = this.repo.transaction(() => {
      if (decision.action === "skip") {
        this.repo.put("imports", id, { ...pending, status: "skipped", decision });
        return item;
      }
      const duplicate = pending.conflicts.find((c) => c.type === "duplicate");
      if (decision.action === "attach-source") {
        if (!duplicate) fault("没有相同文件包，不能补记来源");
        const existing = this.get(duplicate.otherId);
        if (existing.version !== duplicate.otherVersion) fault("冲突对象已更新，请重新导入检查");
        existing.sources = [...new Set([...existing.sources, item.source])];
        this.repo.put("items", existing.id, existing);
        this.repo.put("imports", id, {
          ...pending,
          status: "resolved",
          decision,
          resultId: existing.id,
        });
        return existing;
      }
      const dirs = decision.directories ?? [];
      if (!dirs.length) fault("请先确认分类");
      dirs.forEach((d) => this.directory.get(d));
      const contradictions = pending.conflicts.filter((c) => c.type === "contradiction");
      if (contradictions.length && decision.action === "keep")
        fault("存在疑似矛盾，请暂不启用、改用新项，或明确标记误报");
      const old = this.repo.get<Capability>("items", item.id);
      if (old?.tool?.always) fault("基础控制工具只能随可信应用配置更新，不能通过导入替换");
      if (old && decision.action !== "replace" && decision.action !== "save-disabled")
        fault("相同能力已存在；请选择启用新版或保留待处理");
      if (decision.action === "save-disabled" && old) {
        this.repo.put("versions", `${item.id}@${item.version}`, item);
        this.repo.put("imports", id, { ...pending, decision });
        return item;
      }
      for (const c of pending.conflicts)
        if (this.get(c.otherId).version !== c.otherVersion) fault("冲突对象已更新，请重新扫描导入");
      if (
        item.scan.findings.some((f) => f.severity === "block") &&
        decision.action !== "save-disabled"
      )
        fault("发现系统禁止的执行内容，只能停用保存");
      if (duplicate) fault("重复内容请选择跳过或补记来源");
      if (old) this.repo.put("versions", `${old.id}@${old.version}`, old);
      if (decision.action === "replace")
        for (const conflict of contradictions) {
          const previous = this.get(conflict.otherId);
          previous.enabled = false;
          this.repo.put("items", previous.id, previous);
        }
      const sourceTrust = this.repo.get<Capability["trust"]>("source-trust", item.source);
      if (sourceTrust) item.trust = { ...sourceTrust, verified: false, verification: undefined };
      if (old?.trust.trusted && old.trust.scope === "item")
        item.trust = { ...old.trust, verified: false, verification: undefined };
      item.directories = [...new Set(dirs)];
      item.enabled = decision.action !== "save-disabled" && item.compatibility.length === 0;
      item.title = decision.displayName?.trim() || item.title;
      if (this.items().some((i) => i.name === item.name && i.id !== item.id))
        item.name = `${item.name}-${item.id.slice(-8)}`;
      if (old) item.name = old.name;
      this.repo.put("items", item.id, item);
      this.repo.put("versions", `${item.id}@${item.version}`, item);
      this.repo.put("imports", id, { ...pending, status: "resolved", decision, resultId: item.id });
      for (const conflict of pending.conflicts.filter(
        (c) => c.type === "similar" || c.type === "contradiction",
      ))
        this.repo.put("relations", [item.id, conflict.otherId].sort().join(":"), {
          ids: [item.id, conflict.otherId],
          versions: [item.version, conflict.otherVersion],
          type: decision.action === "dismiss" ? "dismissed" : "alternative",
          confirmed: true,
          reason: decision.reason || "用户选择保留并存",
          evidence: conflict.evidence,
        });
      return item;
    });
    this.directory.refresh();
    this.onChange?.();
    return result;
  }
  update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      directories?: string[];
      enabled?: boolean;
      trust?: Capability["trust"];
      structure?: Capability["structure"];
      dependencies?: Capability["dependencies"];
    },
  ) {
    const item = this.get(id);
    if (
      patch.title !== undefined &&
      (typeof patch.title !== "string" || !patch.title.trim() || patch.title.length > 500)
    )
      fault("显示名称不合法");
    if (
      patch.description !== undefined &&
      (typeof patch.description !== "string" || patch.description.length > 4000)
    )
      fault("用途简介不合法");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean")
      fault("启用状态必须是布尔值");
    if (patch.enabled === false && item.tool?.always) fault("基础运行控制工具不能停用");
    if (
      patch.directories &&
      (!Array.isArray(patch.directories) || patch.directories.some((d) => typeof d !== "string"))
    )
      fault("分类必须是目录列表");
    if (
      patch.trust &&
      (!["item", "source"].includes(patch.trust.scope ?? "item") ||
        typeof patch.trust.trusted !== "boolean" ||
        typeof patch.trust.verified !== "boolean")
    )
      fault("来源标注不合法");
    if (
      patch.dependencies &&
      (!Array.isArray(patch.dependencies) ||
        patch.dependencies.some(
          (d) =>
            !d.name ||
            typeof d.required !== "boolean" ||
            !["author", "analysis"].includes(d.origin),
        ))
    )
      fault("依赖声明格式不合法");
    if (patch.directories) patch.directories.forEach((d) => this.directory.get(d));
    if (patch.trust?.trusted && !patch.trust.reason?.trim()) fault("可信标记需要范围和依据");
    if (patch.trust?.verified && !patch.trust.verification?.trim()) fault("来源核实需要证据记录");
    if (patch.structure) {
      if (
        patch.structure.confirmed !== true ||
        !patch.structure.global.length ||
        !Object.keys(patch.structure.stages).length
      )
        fault("分段结构需要人工确认共同规则和阶段");
      const files = this.package(item.id);
      for (const f of [...patch.structure.global, ...Object.values(patch.structure.stages).flat()])
        if (files[f] === undefined) fault(`分段引用不存在：${f}`);
    }
    if (
      patch.enabled &&
      (item.scan.findings.some((f) => f.severity === "block") || item.compatibility.length)
    )
      fault("存在禁止项或兼容缺口，不能启用");
    if (patch.trust?.scope === "source") {
      this.repo.put("source-trust", item.source, patch.trust);
      for (const sibling of this.items().filter(
        (i) => i.source === item.source && i.id !== item.id,
      )) {
        sibling.trust = {
          ...patch.trust,
          verified: sibling.trust.verified,
          verification: sibling.trust.verification,
        };
        this.repo.put("items", sibling.id, sibling);
      }
    }
    const next = { ...item, ...patch };
    this.repo.put("items", item.id, next);
    this.directory.refresh();
    this.onChange?.();
    return next;
  }
  addReport(id: string, report: Report) {
    const item = this.get(id);
    if (item.version !== report.version) {
      this.repo.put("reports", report.id, { ...report, itemId: item.id });
      return;
    }
    item.reports.push(report);
    this.repo.put("items", item.id, item);
    this.repo.put("reports", report.id, { ...report, itemId: item.id });
  }
  scan(id: string) {
    const item = this.get(id);
    item.scan = inspect(item, this.package(id));
    this.repo.put("items", item.id, item);
    return item.scan;
  }
  browse(id = "root", options: BrowseOptions = {}) {
    return this.directory.browse(id, options);
  }
  search(query: string, options: BrowseOptions & { directory?: string } = {}) {
    const all = this.items(),
      nodes = this.directory.nodes();
    const root = options.directory ?? "root",
      ids = this.directory.descendants(root, nodes),
      words = query
        .toLowerCase()
        .split(/[\s,，]+/)
        .filter(Boolean);
    const entries = [];
    for (const id of ids) {
      const view = this.directory.browse(id, options, all, nodes);
      if (id !== root && (view.total || options.management))
        entries.push({
          id,
          name: view.name,
          title: view.name,
          kind: "directory",
          description: view.abstract,
          overview: view.overview,
          path: view.path,
        });
    }
    for (const i of all)
      if (
        (options.management || i.enabled) &&
        (!options.visible || options.visible(i)) &&
        (!options.kind || options.kind === "all" || i.kind === options.kind) &&
        i.directories.some((d) => ids.has(d))
      )
        entries.push({
          id: i.id,
          name: i.name,
          title: i.title,
          kind: i.kind,
          description: i.description,
          overview: "",
          path: this.directory.path(i.directories.find((d) => ids.has(d))!),
        });
    const scored = entries
      .map((i) => ({
        ...i,
        score: words.reduce(
          (n, w) =>
            n +
            (i.name === w
              ? 100
              : `${i.name} ${i.title} ${i.description} ${i.overview}`.toLowerCase().includes(w)
                ? 1
                : 0),
          words.length ? 0 : 1,
        ),
      }))
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score);
    const offset = Math.max(0, options.offset ?? 0),
      limit = Math.max(1, Math.min(50, options.limit ?? 20));
    return {
      items: scored.slice(offset, offset + limit),
      total: scored.length,
      nextOffset: offset + limit < scored.length ? offset + limit : null,
      directory: root,
    };
  }
  close() {
    this.repo.close();
  }
}
