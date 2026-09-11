import test from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry, ApiModel, parseSSE } from "../server/models.mjs";

const stream = (frames) =>
  new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
function fixture(protocol, fetcher) {
  const registry = new ModelRegistry({
    LLM_API_KEY: "test-only-secret",
    LLM_MODEL: "test-model",
    LLM_PROTOCOL: protocol,
  });
  return {
    adapter: new ApiModel(registry, fetcher),
    profile: registry.get("api-primary"),
    agent: {
      model: "api-primary",
      history: [{ messages: [{ role: "user", content: "run a tool" }], complete: true }],
    },
    input: {
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "run a tool" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "file_list",
            description: "List",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        },
      ],
    },
    signal: new AbortController().signal,
    onDelta: () => {},
  };
}
test("chat-compatible adapter assembles streamed tool argument fragments before returning", async () => {
  let body;
  const setup = fixture("chat-completions", async (url, options) => {
    assert.ok(url.endsWith("/chat/completions"));
    body = JSON.parse(options.body);
    return stream([
      { choices: [{ delta: { content: "Checking" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "file_read", arguments: '{"pa' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"cart.mjs"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
  });
  const result = await setup.adapter.complete(setup);
  assert.equal(result.text, "Checking");
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { path: "cart.mjs" });
  assert.equal(body.model, "test-model");
  assert.equal(body.messages[0].role, "system");
});
test("incomplete stream does not produce executable calls", async () => {
  const setup = fixture("chat-completions", async () =>
    stream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c", function: { name: "file_write", arguments: '{"path":' } },
              ],
            },
          },
        ],
      },
    ]),
  );
  await assert.rejects(setup.adapter.complete(setup), { code: "MODEL_INCOMPLETE" });
});
test("malformed full tool arguments fail validation before runtime execution", async () => {
  const setup = fixture("chat-completions", async () =>
    stream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c", function: { name: "file_write", arguments: "not json" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]),
  );
  await assert.rejects(setup.adapter.complete(setup), { code: "INVALID_ARGUMENT" });
});
test("Responses adapter preserves provider output only for same-model continuation", async () => {
  let body;
  const raw = [
    { type: "reasoning", id: "r", encrypted_content: "opaque-test", summary: [] },
    { type: "function_call", call_id: "c", name: "file_list", arguments: "{}" },
  ];
  const setup = fixture("responses", async (url, options) => {
    assert.ok(url.endsWith("/responses"));
    body = JSON.parse(options.body);
    return stream([
      { type: "response.output_text.delta", delta: "Done" },
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done" }],
            },
          ],
        },
      },
    ]);
  });
  setup.agent.history = [
    {
      rawModel: "api-primary",
      rawResponse: raw,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c", type: "function", function: { name: "file_list", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c", content: '{"files":[]}' },
      ],
      complete: true,
    },
  ];
  await setup.adapter.complete(setup);
  assert.deepEqual(body.input.slice(0, 2), raw);
  assert.equal(body.input[2].type, "function_call_output");
  assert.equal(body.store, false);
  assert.equal(body.instructions, "rules");
});
test("provider HTTP errors never include echoed provider body or secret", async () => {
  const setup = fixture(
    "responses",
    async () => new Response("test-only-secret: echoed sensitive input", { status: 401 }),
  );
  await assert.rejects(
    setup.adapter.complete(setup),
    (error) => error.code === "MODEL_HTTP" && !error.message.includes("secret"),
  );
});
test("SSE decoder handles arbitrary UTF-8 chunk boundaries and CRLF", async () => {
  const bytes = new TextEncoder().encode('data: {"text":"中文"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseSSE(body)) events.push(event);
  assert.deepEqual(events, [{ text: "中文" }]);
});
