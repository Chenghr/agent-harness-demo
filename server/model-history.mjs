/** Provider continuation data stays separate from visible task messages. All
 * callers (loop, connection probe and pet) use this same exchange format. */
export function modelExchange(response, model) {
  const calls = response.calls ?? [];
  return {
    complete: calls.length === 0,
    messages: [
      {
        role: "assistant",
        content: response.text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
    ],
    ...(response.rawResponse
      ? {
          rawResponse: structuredClone(response.rawResponse),
          rawModel: model,
          rawConfigVersion: response.configVersion ?? "environment",
          rawProtocol: response.protocol,
        }
      : {}),
  };
}

export function withoutProviderState(unit) {
  const {
    rawResponse: _raw,
    rawModel: _model,
    rawConfigVersion: _version,
    rawProtocol: _protocol,
    ...visible
  } = unit;
  return visible;
}

function canReplay(unit, agent, profile) {
  return (
    Array.isArray(unit.rawResponse) &&
    unit.rawModel === agent.model &&
    (unit.rawConfigVersion ?? "environment") === (profile.configVersion ?? "environment") &&
    (!unit.rawProtocol || unit.rawProtocol === profile.protocol)
  );
}

function units(agent, input) {
  if (agent.history?.length) return agent.history;
  return [{ messages: input.messages.filter((m, i) => i !== 0 || m.role !== "system") }];
}

export function chatMessages(agent, input, profile, deepseek = false) {
  const messages = input.messages[0]?.role === "system" ? [input.messages[0]] : [];
  for (const unit of units(agent, input)) {
    const original =
      canReplay(unit, agent, profile) && unit.rawResponse.find((m) => m.role === "assistant");
    for (const message of unit.messages) {
      if (message.role !== "assistant") {
        messages.push(message);
        continue;
      }
      const { reasoning_content: _reasoning, ...visible } = message;
      // Empty compatibility field for old/foreign history; never borrow another
      // model's reasoning or invent a replacement for it.
      messages.push({ ...(deepseek ? { reasoning_content: "" } : {}), ...(original || visible) });
    }
  }
  return messages;
}

export function responseItems(agent, input, profile) {
  const items = [];
  for (const unit of units(agent, input)) {
    const replay = canReplay(unit, agent, profile);
    if (replay) items.push(...unit.rawResponse);
    for (const message of unit.messages) {
      if (message.role === "tool")
        items.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: message.content,
        });
      else if (!replay) {
        if (message.content) items.push({ role: message.role, content: message.content });
        for (const call of message.tool_calls ?? [])
          items.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
      }
    }
  }
  return items;
}

/** A profile's connection is deliberately non-enumerable so credentials never
 * enter JSON responses. Preserve that pinned descriptor when changing budgets. */
export function withModelOptions(profile, options) {
  const copy = { ...profile, ...options };
  const connection = Object.getOwnPropertyDescriptor(profile, "connection");
  if (connection) Object.defineProperty(copy, "connection", connection);
  return copy;
}
