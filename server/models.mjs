import { ModelSettings } from "./settings/models.mjs";
import { PRIVACY_DATA } from "./privacy-demo.mjs";
import { id, delay, checkAbort, HarnessError } from "./core.mjs";
import { FIXED_CART } from "./fixtures.mjs";
import { chatMessages, responseItems } from "./model-history.mjs";

const call = (name, args = {}) => ({
  id: id("call"),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const step = (text, ...calls) => ({ text, calls });
const load = (name) => call("tool_load", { name });

export class ModelRegistry {
  constructor(env = process.env, settingsRoot) {
    const window = Number(env.LLM_CONTEXT_WINDOW || 32768),
      output = Number(env.LLM_MAX_OUTPUT || 2048);
    this.profiles = [
      {
        id: "demo-balanced",
        label: "Demo · 标准",
        simulated: true,
        configured: true,
        contextWindow: 18000,
        maxOutput: 1800,
        protocol: "scripted",
        tools: true,
      },
      {
        id: "demo-focused",
        label: "Demo · 紧凑",
        simulated: true,
        configured: true,
        contextWindow: 12000,
        maxOutput: 1500,
        protocol: "scripted",
        tools: true,
      },
      ...[
        ["api-primary", env.LLM_MODEL],
        ["api-secondary", env.LLM_MODEL_ALT],
      ].map(([key, name]) => ({
        id: key,
        label: name || (key === "api-primary" ? "真实模型 A" : "真实模型 B"),
        modelName: name || "",
        simulated: false,
        configured: !!(name && env.LLM_API_KEY),
        contextWindow:
          key === "api-secondary" ? Number(env.LLM_CONTEXT_WINDOW_ALT || window) : window,
        maxOutput: key === "api-secondary" ? Number(env.LLM_MAX_OUTPUT_ALT || output) : output,
        protocol: env.LLM_PROTOCOL || "responses",
        maxTokensField: env.LLM_MAX_TOKENS_FIELD || undefined,
        tools: true,
      })),
    ];
    this.baseUrl = (env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    this.key = env.LLM_API_KEY || "";
    this.effort = env.LLM_REASONING_EFFORT || "";
    if (settingsRoot) {
      const builtins = [...this.profiles];
      this.settings = new ModelSettings(settingsRoot, () => {
        this.profiles = [...builtins, ...this.settings.profiles()];
        this.onChange?.();
      });
      this.profiles = [...builtins, ...this.settings.profiles()];
    }
  }
  list() {
    return this.profiles.map(({ modelName: _modelName, ...p }) => p);
  }
  get(name) {
    const profile = this.profiles.find((p) => p.id === name);
    if (!profile) throw new HarnessError("MODEL_NOT_FOUND", "模型配置不存在");
    if (!profile.configured)
      throw new HarnessError(
        "MODEL_UNCONFIGURED",
        "真实模型尚未配置，请在网页模型设置中保存服务密钥和模型信息；不会自动回退到模拟模型",
      );
    if (
      !Number.isFinite(profile.contextWindow) ||
      profile.contextWindow < 2000 ||
      !Number.isFinite(profile.maxOutput) ||
      profile.maxOutput < 1 ||
      profile.maxOutput >= profile.contextWindow
    )
      throw new HarnessError("MODEL_CONFIG", "模型上下文或输出预算配置无效");
    const pinned = { ...profile };
    Object.defineProperty(pinned, "connection", {
      value: profile.providerId
        ? this.settings.connection(profile.providerId)
        : { baseUrl: this.baseUrl, key: this.key, effort: this.effort },
    });
    return pinned;
  }
}

/** A deterministic model simulator, not an LLM. All actions use the real runtime. */
export class DemoModel {
  constructor(speed = 1) {
    this.speed = speed;
  }
  plan(session, agent) {
    if (session.workspaceId && !agent.parentId)
      return [
        step(
          "当前选择的是模拟模型。模拟模型不会修改你的真实工作区；请在模型设置中配置 API，并切换到真实模型后继续任务。",
        ),
      ];
    if (agent.parentId && !agent.delegation?.materials.some((m) => m.path === "cart.test.mjs"))
      return [
        step("模拟子助手正在查看分配的材料。", call("file_list")),
        step(
          "这是模拟助手返回的示例结果。真实工作需要接入模型后，依据所分配材料完成；本结果供主助手核实。",
        ),
      ];
    if (agent.parentId)
      return [
        step(
          "后台任务会独立读取代码和测试，返回证据，不修改共享实现。",
          call("skill_load", { name: "test-analysis" }),
          load("run_diagnostic"),
          load("run_tests"),
        ),
        step(
          "",
          call("file_read", { path: "cart.mjs" }),
          call("file_read", { path: "cart.test.mjs" }),
        ),
        step(
          "",
          call("run_diagnostic", {
            duration: session.scenario === "interrupt" ? 18000 : Math.max(250, 4000 * this.speed),
          }),
        ),
        step("", call("run_tests")),
        step(
          "后台诊断完成。已检查数量、折扣、空输入和舍入测试；实现中的 subtotal 需要将 price 与 quantity 相乘。具体测试退出码见工具结果。此结论依据启动时及执行时读取的示例文件。",
        ),
      ];
    if (session.scenario === "privacy")
      return [
        step(
          "读取本次合成示例的原文与规则。当前是可复现的模拟流程；文件、授权与最终检查真实执行。",
          call("file_read", { path: "rules.md" }),
          call("file_read", { path: "source.json" }),
        ),
        step(
          "本任务以 Unicode 码点计数，end 不包含末尾，emoji 算一个位置。只使用示例给定的 PERSON 和 EMAIL 标签。",
          call("skill_load", { name: "privacy-boundary" }),
          load("file_write"),
        ),
        step(
          "准备写入三条样本的标注结果，原文不变。请确认本次写入。",
          call("file_write", {
            path: "dataset.json",
            content: JSON.stringify(PRIVACY_DATA, null, 2),
          }),
        ),
        step("读取实际输出，交由独立成果检查核对。", call("file_read", { path: "dataset.json" })),
        step(
          "合成示例的标注结果已写入 dataset.json。接下来运行时会重新读取文件，检查原文、实体范围、标签和空样本；请在成果中查看标注与检查报告。模拟脚本不代表真实模型的标注质量。",
        ),
      ];
    if (session.scenario === "custom")
      return [
        step(
          "已收到你的任务。当前选用的是模拟模型，它只支持预设演示，不会理解并执行自由任务。请切换到已配置的真实模型继续，或新建一个演示任务。",
        ),
      ];
    if (session.scenario === "capability")
      return [
        step(
          "按需加载演示任务已就绪。当前活跃 Skill 为 0；请打开“运行详情 → 工具”，从能力目录检索并只加载本次需要的一项 Skill，演示结束后再卸载。",
        ),
      ];
    if (session.scenario === "scale") {
      const names = [
        "analytics__latency__mean",
        "testing__errors__max",
        "observability__throughput__sum",
        "commerce__volume__trend",
        "inventory__backlog__min",
      ];
      const plan = [
        step(
          "开始千次调用演示。模型决策由脚本模拟，接下来的每次计算都会经过真实的参数检查、工具分发和结果记录。",
          ...names.map(load),
        ),
      ];
      for (let offset = 0; offset < 1005; offset += 15) {
        const calls = Array.from({ length: Math.min(15, 1005 - offset) }, (_, i) =>
          call(names[(offset + i) % names.length], {
            values: [offset + i + 1, offset + i + 2, offset + i + 3],
          }),
        );
        plan.push(
          step(
            offset % 150 === 0
              ? `正在执行第 ${offset + 1} 至 ${offset + calls.length} 次模拟数据计算。`
              : "",
            ...calls,
          ),
        );
        if (offset % 150 === 135) plan.push(step("", call("context_compact")));
      }
      plan.push(
        step(
          "千次调用演示结束。已通过实际工具分发执行 1005 次模拟数据计算，外加加载与压缩操作。请查看调用记录与上下文面板；这不代表千种真实服务集成或千级并发。",
        ),
      );
      return plan;
    }
    if (session.scenario === "security")
      return [
        step(
          "这是明确标注的安全反例。将加载一份不可信 Skill，并让运行时检查它提出的越界操作。",
          call("skill_load", { name: "untrusted-example" }),
          load("file_write"),
        ),
        step("Skill 已加载；它的内容不会获得更高权限。", call("file_read", { path: "../../.env" })),
        step(
          "继续检查对测试文件的改写请求。",
          call("file_write", { path: "cart.test.mjs", content: "// try to bypass tests" }),
        ),
        step(
          "安全反例结束：请在工具面板查看 PATH_DENIED 和 POLICY_DENIED。拒绝来自运行时的路径与操作规则，不依赖模拟模型自觉遵守。",
        ),
      ];
    const hasChild = Object.values(session.agents).some(
      (a) => a.parentId === agent.id && !["cancelled", "failed"].includes(a.status),
    );
    const plans = [
      step(
        "我会先复现购物车问题，并把测试边界分析交给后台任务。当前使用可复现的模拟模型，文件读取和测试进程真实执行。",
        call("catalog_search", { query: "测试 debug", kind: "skill" }),
      ),
      step(
        "加载代码诊断方法与本次需要的工具定义。",
        call("skill_load", { name: "code-debug" }),
        call("skill_read_resource", { name: "code-debug", path: "references/checklist.md" }),
        load("run_tests"),
        load("file_write"),
        load("generate_logs"),
        load("run_diagnostic"),
      ),
      ...(!hasChild
        ? [
            step(
              "后台分析开始后，我继续读取实现和测试。",
              call("agent_spawn", {
                goal: "检查购物车数量、折扣和空输入边界，返回测试证据，不修改文件。",
                type: "analysis",
                files: ["cart.mjs", "cart.test.mjs", "README.md"],
                expectedOutput: "测试依据与问题说明",
                mode: "background",
              }),
            ),
          ]
        : []),
      step(
        "",
        call("file_read", { path: "cart.mjs" }),
        call("file_read", { path: "cart.test.mjs" }),
      ),
      step("运行现有测试，区分代码推测与实测结果。", call("run_tests")),
    ];
    if (session.scenario === "interrupt")
      plans.push(
        step(
          "长诊断正在运行。现在可以点击停止，或发送“先停止诊断，只给分析”来观察打断。",
          call("run_diagnostic", { duration: 20000 }),
        ),
      );
    if (session.scenario === "context")
      plans.push(
        step(
          "生成足量、明确标注的诊断演示日志。原始输出保存在产物中，当前上下文保留一段较长预览。",
          call("generate_logs", { lines: 520 }),
        ),
        step(
          "压缩前材料已准备好。本演示不会自动压缩；请打开“运行详情 → 上下文”，记录当前占用后点击“手动压缩上下文”。",
        ),
      );
    if (session.scenario === "full")
      plans.push(
        step(
          "生成明确标注的诊断演示日志。原始输出保存在产物中，不会随上下文压缩删除。",
          call("generate_logs", { lines: 380 }),
        ),
        step(
          "将较早的完整交互压缩，保留用户约束、近期结果和原始历史入口。",
          call("context_compact"),
        ),
      );
    plans.push(step("收集后台结果，等待时释放模型执行槽位。", call("agent_wait")));
    if (!session.readOnly && session.scenario !== "context" && session.scenario !== "interrupt")
      plans.push(
        step(
          "定位到 subtotal 累加时遗漏 quantity。准备只修改 cart.mjs，保持测试不变；实际写入由授权检查决定。",
          call("file_write", { path: "cart.mjs", content: FIXED_CART }),
        ),
        step("重新执行原有测试，验证修改是否生效。", call("run_tests")),
      );
    plans.push(step("__FINAL__"));
    return plans;
  }
  async complete({ session, agent, signal, onDelta }) {
    agent.plan ??= this.plan(session, agent);
    let output = agent.plan[agent.cursor] ?? step("__FINAL__");
    let text = output.text;
    if (text === "__FINAL__") {
      const written = session.actions.some(
        (a) => a.tool === "file_write" && a.status === "succeeded",
      );
      const tested = [...session.actions]
        .reverse()
        .find((a) => a.tool === "run_tests" && a.agentId === agent.id && a.status === "succeeded");
      text = written
        ? `任务已完成。cart.mjs 已将 price × quantity 纳入总额计算，测试文件未修改。\n\n最后一次测试退出码：${tested?.result?.exitCode ?? "请查阅原始结果"}。可在产物面板查看完整输出，并在任务树核对后台资源。`
        : "分析已完成。问题位于 cart.mjs 的 subtotal 累加：只累加 price，遗漏了 quantity；因此数量大于 1 时金额偏低。\n\n本轮未执行实现修改。原始测试输出、后台证据和已加载的能力可在右侧面板查看。";
    }
    await delay((session.scenario === "scale" ? 5 : 450) * this.speed, signal);
    for (const piece of text.match(/.{1,12}/gs) ?? []) {
      checkAbort(signal);
      onDelta(piece);
      await delay(22 * this.speed, signal);
    }
    return { text, calls: output.calls, simulated: true };
  }
}

/** Parse complete SSE frames; tool argument fragments are never executed here. */
export async function* parseSSE(body) {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
      if (buffer.length > 4_000_000)
        throw new HarnessError("MODEL_PROTOCOL", "模型流式帧超过处理上限");
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export class ApiModel {
  constructor(registry, fetcher = fetch) {
    this.registry = registry;
    this.fetcher = fetcher;
  }
  async complete({ agent, input, profile, signal, onDelta }) {
    const protocol = profile.protocol;
    const connection = profile.connection ?? this.registry;
    const effort = profile.effort ?? connection.effort ?? this.registry.effort;
    const deepseek = new URL(connection.baseUrl).hostname === "api.deepseek.com";
    if (!["responses", "chat-completions"].includes(protocol))
      throw new HarnessError("MODEL_PROTOCOL", "LLM_PROTOCOL 只支持 responses 或 chat-completions");
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    let payload;
    if (protocol === "chat-completions") {
      payload = {
        model: profile.modelName,
        messages: chatMessages(agent, input, profile, deepseek),
        tools: input.tools,
        stream: true,
        [profile.maxTokensField ?? (deepseek ? "max_tokens" : "max_completion_tokens")]:
          profile.maxOutput,
      };
      if (deepseek && effort) {
        payload.thinking = { type: effort === "none" ? "disabled" : "enabled" };
        if (effort !== "none") payload.reasoning_effort = effort;
      } else if (effort) payload.reasoning_effort = effort;
    } else {
      payload = {
        model: profile.modelName,
        instructions: input.messages[0].content,
        input: responseItems(agent, input, profile),
        tools: input.tools.map((t) => ({ type: "function", ...t.function, strict: false })),
        stream: true,
        max_output_tokens: profile.maxOutput,
        store: false,
        ...(!deepseek ? { include: ["reasoning.encrypted_content"] } : {}),
      };
      if (effort) payload.reasoning = { effort };
    }
    const response = await this.fetcher(
      `${connection.baseUrl}/${protocol === "responses" ? "responses" : "chat/completions"}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.key}`,
        },
        body: JSON.stringify(payload),
        signal: requestSignal,
        redirect: "error",
      },
    );
    if (!response.ok) {
      // Do not log provider response bodies: they may echo sensitive input.
      throw new HarnessError(
        "MODEL_HTTP",
        `模型服务返回 HTTP ${response.status}；请检查模型名、协议和服务端配置`,
      );
    }
    let text = "",
      reasoningContent,
      finished = false,
      rawResponse;
    const parts = new Map();
    for await (const event of parseSSE(response.body)) {
      checkAbort(signal);
      if (protocol === "responses") {
        if (event.type === "response.output_text.delta") {
          text += event.delta;
          onDelta(event.delta);
        }
        if (event.type === "response.completed") {
          rawResponse = event.response.output;
          finished = true;
        }
        if (
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event.type === "error"
        )
          throw new HarnessError(
            "MODEL_INCOMPLETE",
            "模型请求未完整结束，没有派发不完整的工具调用",
          );
      } else {
        const choice = event.choices?.[0];
        if (typeof choice?.delta?.reasoning_content === "string")
          reasoningContent = (reasoningContent ?? "") + choice.delta.reasoning_content;
        if (choice?.delta?.content) {
          text += choice.delta.content;
          onDelta(choice.delta.content);
        }
        for (const c of choice?.delta?.tool_calls ?? []) {
          const item = parts.get(c.index) ?? {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          };
          if (c.id) item.id = c.id;
          if (c.function?.name) item.function.name += c.function.name;
          if (c.function?.arguments) item.function.arguments += c.function.arguments;
          parts.set(c.index, item);
        }
        if (choice?.finish_reason) {
          if (!["stop", "tool_calls"].includes(choice.finish_reason))
            throw new HarnessError(
              "MODEL_INCOMPLETE",
              `模型返回 ${choice.finish_reason}，未派发不完整调用`,
            );
          finished = true;
        }
      }
    }
    if (!finished)
      throw new HarnessError("MODEL_INCOMPLETE", "模型连接在完成前中断，未执行流式调用片段");
    const calls =
      protocol === "responses"
        ? (rawResponse ?? [])
            .filter((i) => i.type === "function_call")
            .map((i) => ({
              id: i.call_id,
              type: "function",
              function: { name: i.name, arguments: i.arguments },
            }))
        : [...parts.values()];
    for (const c of calls) {
      if (!c.id || !c.function.name)
        throw new HarnessError("MODEL_PROTOCOL", "工具调用缺少标识或名称");
      try {
        JSON.parse(c.function.arguments);
      } catch {
        throw new HarnessError("INVALID_ARGUMENT", "模型工具参数不是完整 JSON");
      }
    }
    if (protocol === "chat-completions")
      rawResponse = [
        {
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
        },
      ];
    return {
      text,
      calls,
      rawResponse,
      protocol,
      configVersion: profile.configVersion ?? "environment",
      simulated: false,
    };
  }
}
