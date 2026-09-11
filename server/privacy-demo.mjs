// A small, explicitly synthetic teaching fixture. These labels and offset rules
// belong to this example, not to the harness or all privacy datasets.
export const PRIVACY_SOURCE = [
  { id: "sample-01", text: "📌 示例甲的邮箱为 demo.a@example.invalid。" },
  { id: "sample-02", text: "请把说明交给示例乙，联系 demo.b@example.invalid。" },
  { id: "sample-03", text: "此条没有需要标注的实体。" },
];
export const PRIVACY_RULES = `# 隐私实体标注练习\n所有内容均为合成示例，不含真实联系人。\n只标注示例甲、示例乙为 PERSON，两个 example.invalid 邮箱为 EMAIL。\n位置按 Unicode 码点计数（emoji 算一个），start 包含起点，end 不包含末尾；实体不包含末尾标点。\n保留每条原文、顺序和 id。输出 dataset.json，内容为数组，每项含 id、text、entities；实体含 type、text、start、end。空样本 entities 为 []。\n示例字段约定只用于本任务，不代表通用数据集格式。\n`;
const markers = [
  ["PERSON", "示例甲"],
  ["PERSON", "示例乙"],
  ["EMAIL", "demo.a@example.invalid"],
  ["EMAIL", "demo.b@example.invalid"],
];
export const PRIVACY_DATA = PRIVACY_SOURCE.map((row) => ({
  ...row,
  entities: markers
    .filter(([, text]) => row.text.includes(text))
    .map(([type, text]) => ({
      type,
      text,
      start: Array.from(row.text.slice(0, row.text.indexOf(text))).length,
      end: Array.from(row.text.slice(0, row.text.indexOf(text)) + text).length,
    }))
    .sort((a, b) => a.start - b.start),
}));
export function checkPrivacyDataset(source, rules, raw) {
  const issues = [];
  if (source !== JSON.stringify(PRIVACY_SOURCE, null, 2) || rules !== PRIVACY_RULES)
    issues.push("原始材料或规则已被修改");
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return [...issues, "dataset.json 不是有效 JSON"];
  }
  if (!Array.isArray(rows) || rows.length !== PRIVACY_SOURCE.length)
    return [...issues, "样本数量不符合示例要求"];
  rows.forEach((row, i) => {
    const expected = PRIVACY_DATA[i];
    if (!row || row.id !== expected.id || row.text !== expected.text)
      issues.push(`第 ${i + 1} 条样本 id 或原文发生变化`);
    if (!Array.isArray(row?.entities)) {
      issues.push(`第 ${i + 1} 条缺少实体数组`);
      return;
    }
    for (const entity of row.entities) {
      if (
        !entity ||
        !Number.isInteger(entity.start) ||
        !Number.isInteger(entity.end) ||
        entity.start < 0 ||
        entity.end <= entity.start ||
        entity.end > Array.from(expected.text).length ||
        Array.from(expected.text).slice(entity.start, entity.end).join("") !== entity.text
      )
        issues.push(`第 ${i + 1} 条实体边界错误`);
    }
    const normalized = row.entities
      .map((e) => ({ type: e?.type, text: e?.text, start: e?.start, end: e?.end }))
      .sort((a, b) => a.start - b.start);
    if (JSON.stringify(normalized) !== JSON.stringify(expected.entities))
      issues.push(`第 ${i + 1} 条实体缺失、多余或类型错误`);
  });
  return issues;
}
