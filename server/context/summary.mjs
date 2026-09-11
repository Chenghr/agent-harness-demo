import { estimateTokens, fitText } from "./budget.mjs";
// Extractive, traceable, and deliberately non-authoritative. Keep both ends of
// long records; preserve full original records in the checkpoint archive.
function excerpt(value, budget) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (estimateTokens(text) <= budget) return text;
  const head = fitText(text, Math.floor(budget * 0.65));
  const tail = [...fitText([...text].reverse().join(""), Math.floor(budget * 0.3))]
    .reverse()
    .join("");
  return head + " …[节选，须查原文]… " + tail;
}
export function summarizeExtractively(previous, units, budget, archiveId) {
  const header = `历史原文：artifact_read(${archiveId})；也可 history_search 分页查询。以下为有损节选，未出现不代表未发生；不确定、继续写入或确认完成前查原文。\n`;
  const sources = [
    ...(previous ? [{ ref: "上次摘要（原文链见归档）", text: previous }] : []),
    ...units.map((u) => ({
      ref: u.id,
      text: u.messages
        .map((m) => `[${m.role}] ${m.content || JSON.stringify(m.tool_calls ?? [])}`)
        .join("\n"),
    })),
  ];
  const left = Math.max(0, budget - estimateTokens(header));
  const per = Math.max(0, Math.floor(left / Math.max(1, sources.length)) - 18);
  let out = header;
  for (const item of sources) {
    const line = `[${item.ref}] ${excerpt(item.text, per)}\n`;
    if (estimateTokens(out + line) > budget) break;
    out += line;
  }
  return estimateTokens(out) <= budget ? out : "";
}
