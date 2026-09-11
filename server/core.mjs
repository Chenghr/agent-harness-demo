import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
export { ProcessManager } from "./runtime/process-manager.ts";

export const id = (prefix = "id") => `${prefix}_${randomUUID().slice(0, 12)}`;
export const now = () => new Date().toISOString();
export class HarnessError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}
export const abortError = () => new HarnessError("CANCELLED", "操作已取消");
export function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}
export function delay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Abortable queue. Waiting agents do not reserve a model/execution slot. */
export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  acquire(signal) {
    checkAbort(signal);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release.bind(this));
    }
    return new Promise((resolve, reject) => {
      const item = { resolve, signal, cancel: null };
      item.cancel = () => {
        this.queue = this.queue.filter((q) => q !== item);
        reject(abortError());
      };
      signal?.addEventListener("abort", item.cancel, { once: true });
      this.queue.push(item);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      next.signal?.removeEventListener("abort", next.cancel);
      next.resolve(this.release.bind(this));
    } else this.active--;
  }
  async run(fn, signal) {
    const release = await this.acquire(signal);
    try {
      checkAbort(signal);
      return await fn();
    } finally {
      release();
    }
  }
}

/** Paths are confined to our generated workspaces, never the user's project. */
export function safePath(root, relative) {
  root = fs.realpathSync(root);
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\0") ||
    path.isAbsolute(relative)
  )
    throw new HarnessError("PATH_DENIED", "只接受工作区内的相对路径");
  const absolute = path.resolve(root, relative);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  if (!inside(absolute) || absolute === root)
    throw new HarnessError("PATH_DENIED", "路径超出当前任务工作区");
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!inside(fs.realpathSync(probe)))
    throw new HarnessError("PATH_DENIED", "路径经符号链接指向工作区之外");
  return absolute;
}

export class Store extends EventEmitter {
  constructor(root) {
    super();
    this.root = path.resolve(root);
    this.seq = new Map();
    this.tail = new Map();
    for (const dir of ["sessions", "events", "artifacts", "workspaces", "catalog"])
      fs.mkdirSync(path.join(this.root, dir), { recursive: true });
    this.setMaxListeners(100);
  }
  save(session) {
    const target = path.join(this.root, "sessions", `${session.id}.json`);
    fs.writeFileSync(target + ".tmp", JSON.stringify(session));
    fs.renameSync(target + ".tmp", target);
  }
  loadAll() {
    return fs
      .readdirSync(path.join(this.root, "sessions"))
      .filter((f) => f.endsWith(".json"))
      .map((file) => {
        const s = JSON.parse(fs.readFileSync(path.join(this.root, "sessions", file), "utf8"));
        const events = this.events(s.id, 0, Infinity);
        this.seq.set(s.id, events.at(-1)?.seq ?? 0);
        this.tail.set(s.id, events.slice(-300));
        return s;
      });
  }
  event(sessionId, type, data = {}, agentId = null) {
    const event = {
      id: id("ev"),
      seq: (this.seq.get(sessionId) ?? 0) + 1,
      time: now(),
      sessionId,
      agentId,
      type,
      data,
    };
    this.seq.set(sessionId, event.seq);
    fs.appendFileSync(
      path.join(this.root, "events", `${sessionId}.jsonl`),
      JSON.stringify(event) + "\n",
    );
    const tail = this.tail.get(sessionId) ?? [];
    tail.push(event);
    if (tail.length > 300) tail.shift();
    this.tail.set(sessionId, tail);
    this.emit("event", event);
    return event;
  }
  events(sessionId, after = 0, limit = 2000) {
    const file = path.join(this.root, "events", `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.seq > after)
      .slice(0, limit === Infinity ? undefined : limit);
  }
  artifact(sessionId, name, content, agentId = "main") {
    const artifact = {
      id: id("art"),
      sessionId,
      agentId,
      name: path.basename(name),
      bytes: Buffer.byteLength(content),
      createdAt: now(),
    };
    fs.writeFileSync(path.join(this.root, "artifacts", artifact.id + ".txt"), content);
    fs.writeFileSync(
      path.join(this.root, "artifacts", artifact.id + ".json"),
      JSON.stringify(artifact),
    );
    return artifact;
  }
  readArtifact(sessionId, artifactId) {
    if (!/^art_[a-z0-9-]+$/.test(artifactId)) throw new HarnessError("NOT_FOUND", "产物不存在");
    const metadata = path.join(this.root, "artifacts", artifactId + ".json");
    if (!fs.existsSync(metadata)) throw new HarnessError("NOT_FOUND", "产物不存在");
    const info = JSON.parse(fs.readFileSync(metadata, "utf8"));
    if (info.sessionId !== sessionId) throw new HarnessError("NOT_FOUND", "产物不属于当前任务");
    return {
      ...info,
      content: fs.readFileSync(path.join(this.root, "artifacts", artifactId + ".txt"), "utf8"),
    };
  }
}

export function validate(schema, value, at = "参数") {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new HarnessError("INVALID_ARGUMENT", `${at}必须是对象`);
    for (const key of schema.required ?? [])
      if (!(key in value)) throw new HarnessError("INVALID_ARGUMENT", `缺少参数 ${key}`);
    for (const [key, val] of Object.entries(value)) {
      if (!schema.properties?.[key]) {
        if (schema.additionalProperties === false)
          throw new HarnessError("INVALID_ARGUMENT", `未知参数 ${key}`);
      } else validate(schema.properties[key], val, key);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new HarnessError("INVALID_ARGUMENT", `${at}必须是数组`);
    for (const val of value) validate(schema.items, val, at);
  } else if (schema.type && typeof value !== schema.type)
    throw new HarnessError("INVALID_ARGUMENT", `${at}类型应为 ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value))
    throw new HarnessError("INVALID_ARGUMENT", `${at}不在允许值中`);
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw new HarnessError("INVALID_ARGUMENT", `${at}超出允许范围`);
  if (typeof value === "string" && schema.maxLength && value.length > schema.maxLength)
    throw new HarnessError("INVALID_ARGUMENT", `${at}过长`);
}

export function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined)
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
