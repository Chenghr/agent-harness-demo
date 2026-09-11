import type { BrowseOptions, Capability, Directory } from "./types.ts";
import { fault } from "./types.ts";
import { CapabilityRepository, fingerprint } from "./repository.ts";

export class CapabilityDirectory {
  repo: CapabilityRepository;
  items: () => Capability[];
  constructor(repo: CapabilityRepository, items: () => Capability[]) {
    this.repo = repo;
    this.items = items;
    if (!repo.get("directories", "root"))
      repo.put("directories", "root", {
        id: "root",
        parent: null,
        name: "能力目录",
        abstract: "",
        overview: "",
        origin: "generated",
        stale: false,
        version: 1,
        basedOn: "",
      });
  }
  nodes() {
    return this.repo.list<Directory>("directories");
  }
  get(id: string): Directory {
    return this.repo.get<Directory>("directories", id) ?? fault("目录不存在");
  }
  create(parent: string, id: string, name: string, abstract = "") {
    this.get(parent);
    if (
      !/^[\p{L}\p{N}_.-]{1,120}$/u.test(id) ||
      this.nodes().some((n) => n.id === id) ||
      !name.trim()
    )
      fault("目录标识重复或名称不合法");
    const node: Directory = {
      id,
      parent,
      name,
      abstract,
      overview: "",
      origin: "generated",
      stale: false,
      version: 1,
      basedOn: "",
    };
    this.repo.put("directories", id, node);
    this.refresh();
    return this.get(id);
  }
  path(id: string): { id: string; name: string }[] {
    const node = this.get(id);
    return [...(node.parent ? this.path(node.parent) : []), { id, name: node.name }];
  }
  descendants(id: string, nodes = this.nodes()): Set<string> {
    const ids = new Set([id]);
    for (const n of nodes.filter((n) => n.parent === id))
      for (const child of this.descendants(n.id, nodes)) ids.add(child);
    return ids;
  }
  edit(id: string, abstract: string, overview: string) {
    if (
      typeof abstract !== "string" ||
      typeof overview !== "string" ||
      abstract.length > 1000 ||
      overview.length > 12000
    )
      fault("目录说明过长或类型错误");
    const node = this.get(id);
    this.repo.put("directories", id, {
      ...node,
      abstract,
      overview,
      origin: "manual",
      stale: false,
      version: node.version + 1,
    });
    this.refresh();
    return this.get(id);
  }
  refresh() {
    const nodes = this.nodes(),
      items = this.items();
    const visit = (id: string): Directory => {
      const node = nodes.find((n) => n.id === id)!;
      const children = nodes.filter((n) => n.parent === id).map((n) => visit(n.id));
      const leaves = items.filter((i) => i.directories.includes(id));
      const inputs = [
        ...children.map((n) => ({
          id: n.id,
          version: n.version,
          title: n.name,
          description: n.abstract,
        })),
        ...leaves.map((i) => ({
          id: i.id,
          version: `${i.version}:${i.enabled}:${i.description}`,
          title: i.title,
          description: i.description,
        })),
      ];
      const basedOn = fingerprint(["overview-v2", inputs]);
      if (basedOn !== node.basedOn) {
        const lines = inputs.map((i) => `${i.title}：${i.description}`);
        // Extractive summaries only: every sentence comes from an actual child, not invented taxonomy semantics.
        const overview = lines.length
          ? `下级能力与用途：\n${lines.slice(0, 12).join("\n")}\n${lines.length > 12 ? `另有 ${lines.length - 12} 项，请翻页查看完整入口。` : ""}`
          : "当前没有已归类的能力。";
        const abstract = inputs.length
          ? `包含${inputs
              .slice(0, 6)
              .map((i) => i.title)
              .join("、")}${inputs.length > 6 ? `等 ${inputs.length} 个方向` : ""}。`
          : node.abstract || "尚无下级能力";
        const updated = {
          ...node,
          basedOn,
          version: node.version + 1,
          ...(node.origin === "manual"
            ? { stale: true, suggestedAbstract: abstract, suggestedOverview: overview }
            : { abstract, overview, stale: false }),
        };
        Object.assign(node, updated);
        this.repo.put("directories", id, updated);
      }
      return node;
    };
    visit("root");
  }
  browse(id = "root", options: BrowseOptions = {}, all = this.items(), nodes = this.nodes()) {
    const node = this.get(id);
    const eligible = (i: Capability) =>
      (options.management || i.enabled) &&
      (!options.kind || options.kind === "all" || options.kind === i.kind) &&
      (!options.visible || options.visible(i));
    const visible = all.filter(eligible);
    const subtree = this.descendants(id, nodes);
    const restricted = all.some((i) => i.directories.some((d) => subtree.has(d)) && !eligible(i));
    const children = nodes
      .filter((n) => n.parent === id)
      .flatMap((n) => {
        const ids = this.descendants(n.id, nodes),
          subset = visible.filter((i) => i.directories.some((d) => ids.has(d)));
        if (!subset.length && !options.management) return [];
        const hidden = all.some((i) => i.directories.some((d) => ids.has(d)) && !eligible(i));
        return [
          {
            id: n.id,
            name: n.name,
            title: n.name,
            kind: "directory",
            description: hidden
              ? subset
                  .slice(0, 3)
                  .map((i) => i.description)
                  .join("；")
              : n.abstract,
            count: subset.length,
            path: this.path(n.id),
          },
        ];
      });
    const leaves = visible
      .filter((i) => i.directories.includes(id))
      .map((i) => ({
        id: i.id,
        name: i.name,
        title: i.title,
        kind: i.kind,
        description: i.description,
        enabled: i.enabled,
        version: i.version,
        simulated: i.simulated,
        path: this.path(id),
      }));
    const entries = [...children, ...leaves];
    const limit = Math.max(1, Math.min(50, options.limit ?? 20)),
      offset = Math.max(0, options.offset ?? 0);
    return {
      ...node,
      abstract: restricted
        ? entries
            .slice(0, 3)
            .map((e) => e.description)
            .join("；")
        : node.abstract,
      overview: restricted
        ? entries
            .slice(0, 12)
            .map((e) => `${e.title}：${e.description}`)
            .join("\n")
        : node.overview,
      suggestedAbstract: restricted ? undefined : node.suggestedAbstract,
      suggestedOverview: restricted ? undefined : node.suggestedOverview,
      basedOn: restricted ? undefined : node.basedOn,
      path: this.path(id),
      total: entries.length,
      items: entries.slice(offset, offset + limit),
      nextOffset: offset + limit < entries.length ? offset + limit : null,
      restricted,
    };
  }
}
