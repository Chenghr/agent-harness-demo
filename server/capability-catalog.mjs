import { inspect } from "./runtime/capabilities/inspection.ts";
import fs from "node:fs";
import path from "node:path";
import { CapabilityLibrary } from "./runtime/capabilities/library.ts";
import { fingerprint } from "./runtime/capabilities/repository.ts";

export function initializeLibrary(catalog) {
  const library = new CapabilityLibrary(path.join(catalog.root, "managed"));
  const existing = new Set(library.items().map((i) => i.id));
  const dirs = new Set(library.directory.nodes().map((n) => n.id));
  function directory(parent, name) {
    const id = `dir-${fingerprint([parent, name]).slice(0, 16)}`;
    if (!dirs.has(id)) {
      library.repo.put("directories", id, {
        id,
        parent,
        name,
        abstract: "",
        overview: "",
        origin: "generated",
        stale: false,
        version: 1,
        basedOn: "",
      });
      dirs.add(id);
    }
    return id;
  }
  library.repo.transaction(() => {
    for (const [kind, entries] of [
      ["tool", catalog.tools],
      ["skill", catalog.skills],
    ])
      for (const item of entries.values()) {
        const id = `seed-${kind}-${item.name}`;
        if (existing.has(id)) {
          const current = library.get(id);
          // Built-in executable contracts are owned by the shipped code. Upgrade
          // their immutable package on startup; preserve user metadata and old
          // versions so existing task snapshots remain readable.
          if (kind === "tool" && JSON.stringify(current.tool) !== JSON.stringify(item)) {
            const files = {
              "tool.json": JSON.stringify(item, null, 2),
              ...(item.adapter === "node-command-v1"
                ? { "command.mjs": fs.readFileSync(item.binding.entry, "utf8") }
                : {}),
            };
            const next = {
              ...current,
              tool: structuredClone(item),
              version: library.repo.savePackage(files),
            };
            next.scan = inspect(next, files);
            library.repo.put("items", id, next);
            library.repo.put("versions", `${id}@${next.version}`, next);
          }
          continue;
        }
        const top = directory(
          "root",
          item.category === "隐私实体数据集构建"
            ? item.category
            : item.simulated
              ? "教学规模样本"
              : "工作方法与运行控制",
        );
        const category = directory(
          top,
          item.category === "隐私实体数据集构建" ? "标注检查" : item.category || "通用",
        );
        const leaf = category;
        const files =
          kind === "skill"
            ? Object.fromEntries([
                ["SKILL.md", fs.readFileSync(item.file, "utf8")],
                ...item.resources.map((relative) => [
                  relative,
                  fs.readFileSync(path.join(path.dirname(item.file), relative), "utf8"),
                ]),
              ])
            : {
                "tool.json": JSON.stringify(item, null, 2),
                ...(item.adapter === "node-command-v1"
                  ? { "command.mjs": fs.readFileSync(item.binding.entry, "utf8") }
                  : {}),
              };
        library.seed(
          {
            id,
            name: item.name,
            originalName: item.name,
            title: item.title,
            description: item.description,
            kind,
            source: item.source,
            sources: [item.source],
            version: "",
            authorVersion: item.version,
            entry: kind === "skill" ? "SKILL.md" : "tool.json",
            format: "bundled",
            claims: {},
            enabled: true,
            directories: [leaf],
            simulated: !!item.simulated,
            untrusted: item.untrusted,
            seeded: true,
            scan: {},
            permissions: [],
            dependencies: [],
            compatibility: [],
            trust: { trusted: false, verified: false },
            reports: [],
            ...(kind === "tool" ? { tool: structuredClone(item) } : {}),
          },
          files,
        );
      }
    library.directory.refresh();
  });
  catalog.library = library;
  catalog.refreshManaged = () => {
    for (const item of library.items()) {
      const map = item.kind === "skill" ? catalog.skills : catalog.tools;
      const prior = map.get(item.name) ?? {};
      map.set(item.name, {
        ...prior,
        ...(item.seeded
          ? item.tool
          : { parameters: item.tool?.parameters, always: false, adapter: "unbound" }),
        name: item.name,
        kind: item.kind,
        title: item.title,
        description: item.description,
        category: library.directory.get(item.directories[0] ?? "root").name,
        source: item.source,
        version: item.version,
        managedId: item.id,
        enabled: item.enabled,
        simulated: item.simulated,
        untrusted: item.untrusted,
      });
    }
  };
  library.onChange = catalog.refreshManaged;
  catalog.refreshManaged();
}
