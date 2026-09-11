import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarnessError } from "../core.mjs";
import { modelExchange } from "../model-history.mjs";
export async function settingsRoute(h, parts, method, read) {
  const [area, resource, identifier, action] = parts;
  if (area === "workspaces") {
    if (method === "GET") return h.workspaces.list();
    if (method === "POST" && resource === "pick") {
      if (process.platform !== "darwin")
        throw new HarnessError("UNAVAILABLE", "当前系统请填写本地目录绝对路径");
      try {
        const { stdout } = await promisify(execFile)(
          "/usr/bin/osascript",
          ["-e", 'POSIX path of (choose folder with prompt "选择 Harness 工作区")'],
          { timeout: 120000 },
        );
        return h.workspaces.add(stdout.trim());
      } catch {
        throw new HarnessError("PICK_CANCELLED", "未选择目录；也可以手动填写绝对路径");
      }
    }
    if (method === "POST") return h.workspaces.add((await read()).path);
  }
  if (area === "settings") {
    if (resource === "delivery") {
      if (method === "GET") return h.delivery.config.list();
      if (method === "POST") return h.delivery.config.save(identifier, await read());
    }
    const settings = h.models.settings;
    if (method === "GET" && resource === "models") return settings.list();
    if (method === "POST" && resource === "providers") return settings.saveProvider(await read());
    if (method === "POST" && resource === "models" && !identifier)
      return settings.saveModel(await read());
    if (method === "POST" && resource === "models" && action === "remove") {
      if (
        [...h.sessions.values()].some((s) =>
          Object.values(s.agents).some((a) => a.model === identifier),
        )
      )
        throw new HarnessError("MODEL_IN_USE", "历史对话仍引用此模型，请保留配置或先切换模型");
      settings.removeModel(identifier);
      return { ok: true };
    }
    if (method === "POST" && resource === "discover")
      return { models: await settings.discover((await read()).providerId) };
    if (method === "POST" && resource === "test") {
      const profile = h.models.get((await read()).modelId);
      if (profile.simulated) throw new HarnessError("MODEL_CONFIG", "请选择真实模型");
      const tool = {
        type: "function",
        function: {
          name: "connection_probe",
          description: "连接测试：调用此工具并传入 ok=true",
          parameters: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      };
      const messages = [
        {
          role: "system",
          content: "这是连接测试。请调用 connection_probe 工具且 ok=true，收到结果后回答连接成功。",
        },
        { role: "user", content: "开始连接测试" },
      ];
      const agent = { model: profile.id, history: [{ messages: [messages[1]] }] };
      const signal = AbortSignal.timeout(120000),
        start = Date.now();
      const result = await h.apiModel.complete({
        agent,
        profile,
        input: { messages, tools: [tool] },
        signal,
        onDelta: () => {},
      });
      const call = result.calls?.[0];
      if (
        result.calls?.length !== 1 ||
        call.function.name !== "connection_probe" ||
        JSON.parse(call.function.arguments).ok !== true
      )
        throw new HarnessError(
          "MODEL_PROTOCOL",
          "模型能响应，但工具调用测试未通过；请检查工具能力和协议",
        );
      const exchange = modelExchange(result, agent.model);
      exchange.messages.push({ role: "tool", tool_call_id: call.id, content: '{"ok":true}' });
      exchange.complete = true;
      agent.history.push(exchange);
      const answer = await h.apiModel.complete({
        agent,
        profile,
        input: { messages: [...messages, ...exchange.messages], tools: [tool] },
        signal,
        onDelta: () => {},
      });
      if (!answer.text?.trim() || answer.calls?.length)
        throw new HarnessError("MODEL_PROTOCOL", "工具返回后的最终回答测试未通过");
      return {
        ok: true,
        model: profile.label,
        protocol: profile.protocol,
        toolRoundTrip: true,
        durationMs: Date.now() - start,
        configVersion: profile.configVersion ?? "environment",
        contextWindow: profile.contextWindow,
        maxOutput: profile.maxOutput,
        note: "连通与工具协议测试通过；上下文上限仍来自配置，未通过此测试验证",
      };
    }
  }
  throw new HarnessError("NOT_FOUND", "设置接口不存在");
}
