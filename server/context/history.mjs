import { HarnessError } from "../core.mjs";

// Both the assistant and companion use this reader; child visibility is enforced
// before matching and before returning a referenced event.
export function searchHistory(runtime, session, agent, args = {}) {
  const { query = "", after = 0, limit = 6, seq, offset = 0 } = args;
  if (
    typeof query !== "string" ||
    ![after, limit, offset, ...(seq === undefined ? [] : [seq])].every(Number.isInteger) ||
    after < 0 ||
    offset < 0 ||
    limit < 1 ||
    limit > 20
  )
    throw new HarnessError("INVALID_ARGUMENT", "历史查询参数无效");
  const events = runtime.store.events(session.id, 0, Infinity).filter(
    (e) =>
      (!agent.parentId || e.agentId === agent.id) &&
      !["model.delta", "process.output"].includes(e.type) &&
      !e.type.startsWith("companion.") &&
      // Search results must not recursively become evidence for later searches.
      !(["tool.started", "tool.succeeded"].includes(e.type) && e.data.tool === "history_search"),
  );
  if (seq !== undefined) {
    const e = events.find((e) => e.seq === seq);
    if (!e) throw new HarnessError("NOT_FOUND", "当前助手不可读取该历史记录");
    const content = JSON.stringify(e);
    return {
      seq,
      content: content.slice(offset, offset + 2400),
      offset,
      nextOffset: offset + 2400 < content.length ? offset + 2400 : null,
      total: content.length,
    };
  }
  const matches = events.filter(
    (e) => e.seq > after && JSON.stringify(e).toLowerCase().includes(query.toLowerCase()),
  );
  const page = matches.slice(0, limit);
  return {
    total: matches.length,
    events: page.map((e) => {
      const raw = JSON.stringify(e.data);
      const at = Math.max(0, raw.toLowerCase().indexOf(query.toLowerCase()) - 160);
      return {
        seq: e.seq,
        type: e.type,
        time: e.time,
        agentId: e.agentId,
        excerpt: raw.slice(at, at + 1000),
        truncated: raw.length > 1000,
      };
    }),
    nextAfter: matches.length > page.length ? page.at(-1).seq : null,
  };
}
