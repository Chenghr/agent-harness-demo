import { capabilityRoute } from "./capability-routes.mjs";
import { RuntimeFault } from "./runtime/contracts.ts";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Harness } from "./harness.mjs";
import { HarnessError, loadEnv } from "./core.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
function send(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 5000000)
      throw new HarnessError("INVALID_ARGUMENT", "请求正文过大");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HarnessError("INVALID_ARGUMENT", "请求正文必须是 JSON");
  }
}

export function createServer({
  harness = new Harness(),
  staticDir = path.join(projectRoot, "dist"),
  port = 4317,
} = {}) {
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      const hostname = (req.headers.host ?? "").split(":")[0];
      if (!["127.0.0.1", "localhost", "["].includes(hostname))
        throw new HarnessError("FORBIDDEN", "仅接受本机访问");
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (
          !["127.0.0.1", "localhost"].includes(origin.hostname) ||
          !["4317", "4318", String(port)].includes(origin.port)
        )
          throw new HarnessError("FORBIDDEN", "请求来源不在本地应用范围");
      }
      if (url.pathname.startsWith("/api/")) {
        const parts = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
        const method = req.method;
        if (method === "GET" && parts[0] === "health")
          return send(res, 200, { ok: true, version: "1.0.0" });
        if (parts[0] === "companion" && parts[1] === "focus") {
          if (method === "GET")
            return send(res, 200, {
              sessionId: harness.companion.focusedSessionId,
              selected: harness.companion.hasFocus,
            });
          if (method === "POST")
            return send(res, 200, harness.companion.focus((await readBody(req)).sessionId));
        }
        if (method === "GET" && parts[0] === "config") return send(res, 200, harness.config());
        if (parts[0] === "management")
          return send(
            res,
            200,
            await capabilityRoute({ harness, parts, method, url, read: () => readBody(req) }),
          );
        if (parts[0] === "catalog") {
          if (method !== "GET") throw new HarnessError("NOT_FOUND", "接口不存在");
          if (parts.length === 1) {
            const kind = url.searchParams.get("kind") ?? "all";
            if (!["all", "tool", "skill"].includes(kind))
              throw new HarnessError("INVALID_ARGUMENT", "未知目录类型");
            return send(
              res,
              200,
              harness.catalog.search(
                url.searchParams.get("q") ?? "",
                kind,
                20,
                Math.max(0, Number(url.searchParams.get("offset")) || 0),
                url.searchParams.get("category") ?? "",
              ),
            );
          }
          if (parts[1] === "tool") return send(res, 200, harness.catalog.getTool(parts[2]));
          if (parts[1] === "skill") {
            const { file: _file, body: _body, ...skill } = harness.catalog.getSkill(parts[2]);
            return send(res, 200, skill);
          }
        }
        if (parts[0] === "sessions") {
          if (parts.length === 1) {
            if (method === "GET") return send(res, 200, harness.list());
            if (method === "POST") return send(res, 201, harness.create(await readBody(req)));
          }
          const sid = parts[1];
          const session = harness.get(sid);
          if (parts[2] === "companion") {
            if (method === "GET") {
              if (parts[3] === "history")
                return send(
                  res,
                  200,
                  harness.companion.history(sid, {
                    seq: Number(url.searchParams.get("seq")),
                    offset: Number(url.searchParams.get("offset") || 0),
                  }),
                );
              return send(
                res,
                200,
                parts[3] === "export"
                  ? harness.companion.export(sid)
                  : harness.companion.snapshot(sid),
              );
            }
            if (method === "POST") {
              const body = await readBody(req);
              if (parts[3] === "feedback")
                return send(res, 201, harness.companion.feedback(sid, body));
              if (parts[3] === "cancel") return send(res, 200, harness.companion.cancel(sid));
              if (parts[3] === "clear") return send(res, 200, harness.companion.clear(sid));
              if (parts[3] === "messages") {
                // Capture ownership after admission; an unrelated busy request must
                // never cancel the first window's call when it disconnects.
                if (harness.companion.active.has(sid))
                  throw new HarnessError("COMPANION_BUSY", "小伴正在回答，可以先停止再提问");
                const pending = harness.companion.ask(sid, body);
                const owned = harness.companion.active.get(sid);
                const close = () => {
                  if (!res.writableEnded && owned && harness.companion.active.get(sid) === owned)
                    owned.controller.abort(new HarnessError("CANCELLED", "宠物窗口连接已关闭"));
                };
                res.once("close", close);
                try {
                  return send(res, 200, await pending);
                } finally {
                  res.off("close", close);
                }
              }
            }
            throw new HarnessError("NOT_FOUND", "宠物接口不存在");
          }
          if (parts.length === 2 && method === "GET") return send(res, 200, harness.snapshot(sid));
          if (parts[2] === "stream" && method === "GET") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            res.flushHeaders();
            streams.add(res);
            const write = (type, data) => {
              if (res.writableEnded || res.destroyed) return;
              if (res.writableLength > 1000000) {
                res.end();
                return;
              }
              res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
            };
            write("state", harness.snapshot(sid));
            const last = Number(req.headers["last-event-id"] || url.searchParams.get("after") || 0);
            const tail = (harness.store.tail.get(sid) ?? []).filter(
              (e) =>
                e.seq > last &&
                !["context.unit", "context.completed", "model.delta", "process.output"].includes(
                  e.type,
                ),
            );
            for (const event of tail) write("event", event);
            const listener = (event) => {
              if (event.sessionId !== sid) return;
              if (["context.unit", "context.completed", "process.output"].includes(event.type))
                return;
              res.write(`id: ${event.seq}\n`);
              write("event", event);
            };
            const state = (id) => {
              if (id === sid) write("state", harness.snapshot(sid));
            };
            harness.on("event", listener);
            harness.on("state", state);
            const heartbeat = setInterval(() => {
              if (!res.writableEnded) res.write(": heartbeat\n\n");
            }, 15000);
            const cleanup = () => {
              clearInterval(heartbeat);
              harness.off("event", listener);
              harness.off("state", state);
              streams.delete(res);
            };
            req.on("close", cleanup);
            return;
          }
          if (parts[2] === "events" && method === "GET")
            return send(res, 200, {
              events: harness.store.events(
                sid,
                Math.max(0, Number(url.searchParams.get("after")) || 0),
                500,
              ),
            });
          if (parts[2] === "artifacts" && method === "GET")
            return send(res, 200, harness.store.readArtifact(sid, parts[3]));
          if (parts[2] === "files" && method === "GET")
            return send(res, 200, {
              files: fs
                .readdirSync(session.workspace, { withFileTypes: true })
                .filter((e) => e.isFile())
                .map((e) => ({
                  path: e.name,
                  content: fs
                    .readFileSync(path.join(session.workspace, e.name), "utf8")
                    .slice(0, 20000),
                })),
            });
          if (method === "POST") {
            const body = await readBody(req);
            if (parts[2] === "messages")
              return send(res, 200, harness.message(sid, body.text, body.mode));
            if (parts[2] === "stop") return send(res, 200, await harness.stop(sid));
            if (parts[2] === "review") return send(res, 200, harness.reviewCompletion(sid, body));
            if (parts[2] === "model")
              return send(res, 200, await harness.requestSwitch(sid, body.model));
            if (parts[2] === "approvals")
              return send(res, 200, harness.approve(sid, parts[3], body.decision));
            if (parts[2] === "revoke") return send(res, 200, harness.revoke(sid));
            if (parts[2] === "compact")
              return send(
                res,
                200,
                await harness.context.compact(session, session.agents.main, { force: true }),
              );
            if (parts[2] === "load") {
              if (!["tool", "skill"].includes(body.kind))
                throw new HarnessError("INVALID_ARGUMENT", "未知能力类型");
              harness.capabilityLoader.load(
                session,
                session.agents.main,
                body.kind,
                body.name,
                body.stage,
              );
              return send(res, 200, harness.snapshot(sid));
            }
            if (parts[2] === "unload")
              return send(
                res,
                200,
                harness.unload(session, session.agents.main, body.kind, body.name),
              );
            if (parts[2] === "agents") {
              if (parts.length === 3)
                return send(
                  res,
                  201,
                  await harness.invoke(session, session.agents.main, "agent_spawn", body),
                );
              if (parts[4] === "cancel")
                return send(res, 200, await harness.cancelAgent(sid, parts[3]));
              if (parts[4] === "message")
                return send(
                  res,
                  200,
                  harness.messageAgent(sid, parts[3], body.message, "main", body.mode),
                );
            }
          }
        }
        throw new HarnessError("NOT_FOUND", "接口不存在");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new HarnessError("NOT_FOUND", "页面不存在");
      let relative = decodeURIComponent(url.pathname);
      if (relative.endsWith("/")) relative += "index.html";
      let file = path.resolve(staticDir, "." + relative);
      if (!fs.existsSync(file) && !path.extname(url.pathname.replace(/\/$/, ""))) {
        file = path.resolve(staticDir, "." + url.pathname.replace(/\/$/, "") + ".html");
      }
      if (!file.startsWith(path.resolve(staticDir) + path.sep))
        throw new HarnessError("FORBIDDEN", "路径不允许");
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        if (url.pathname === "/" && !fs.existsSync(path.join(staticDir, "index.html"))) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(
            "前端尚未构建。请先运行 npm run build，再使用 npm start；开发模式使用 npm run dev。",
          );
          return;
        }
        throw new HarnessError("NOT_FOUND", "文件不存在");
      }
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] || "application/octet-stream",
        "Cache-Control": path.extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "FORBIDDEN"
            ? 403
            : ["STALE_APPROVAL", "STALE_REVIEW", "CHECKS_FAILED", "CLOSING"].includes(error.code)
              ? 409
              : error instanceof HarnessError ||
                  error instanceof RuntimeFault ||
                  error.code === "INVALID_ARGUMENT"
                ? 400
                : 500;
      send(res, status, {
        error: {
          code: error.code ?? "INTERNAL_ERROR",
          message: status === 500 ? "服务处理失败，请检查本地服务日志" : error.message,
        },
      });
      if (status === 500) console.error(error);
    }
  });
  server.on("close", () => {
    for (const stream of streams) stream.end();
  });
  return {
    server,
    harness,
    async close() {
      for (const stream of streams) stream.end();
      await harness.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv(path.join(projectRoot, ".env"));
  const port = Number(process.env.PORT || 4317);
  const host = process.env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost"].includes(host))
    throw new Error("本地教学应用未提供远程认证，HOST 仅支持 127.0.0.1 或 localhost");
  const app = createServer({
    harness: new Harness({
      root: path.resolve(projectRoot, process.env.HARNESS_DATA_DIR || ".harness"),
    }),
    port,
  });
  app.server.listen(port, host, () =>
    console.log(
      `Harness Lab: http://${host}:${port}\n模拟模式已就绪。数据目录为本地 .harness；真实模型配置只从服务端环境读取。`,
    ),
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
