import { Catalog } from "../server/catalog.mjs";
import path from "node:path";
const catalog = new Catalog(path.resolve(".harness/catalog"));
console.log(JSON.stringify(catalog.counts(), null, 2));
console.log("Skill 包已生成到 .harness/catalog/skills，每个目录包含 SKILL.md。");
