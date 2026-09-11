import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Files } from "./types.ts";
import { fault } from "./types.ts";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function checkedFiles(input: Files): Files {
  if (!input || typeof input !== "object" || Array.isArray(input)) fault("需要文件包");
  const files: Files = Object.create(null);
  let bytes = 0;
  for (const name of Object.keys(input).sort()) {
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((p) => !p || p === "." || p === "..") ||
      [...name].some((c) => c.charCodeAt(0) < 32)
    )
      fault("文件包路径不合法");
    const content = input[name];
    if (typeof content !== "string") fault("当前仅接收 UTF-8 文本文件，二进制资源需要另行适配");
    bytes += Buffer.byteLength(content);
    if (bytes > 4_000_000 || Object.keys(files).length >= 500)
      fault("文件包超过 4 MB 或 500 个文件");
    files[name] = content;
  }
  if (!Object.keys(files).length) fault("文件包为空");
  return files;
}
/** Storage owns transactions and immutable package snapshots; callers own domain rules. */
export class CapabilityRepository {
  root: string;
  db: DatabaseSync;
  closed = false;
  constructor(root: string) {
    this.root = root;
    fs.mkdirSync(path.join(root, "packages"), { recursive: true });
    this.db = new DatabaseSync(path.join(root, "library.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (bucket TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(bucket,id));",
    );
  }
  list<T>(bucket: string): T[] {
    return this.db
      .prepare("SELECT value FROM records WHERE bucket=?")
      .all(bucket)
      .map((r) => JSON.parse(String(r.value)) as T);
  }
  get<T>(bucket: string, id: string): T | undefined {
    const r = this.db.prepare("SELECT value FROM records WHERE bucket=? AND id=?").get(bucket, id);
    return r ? (JSON.parse(String(r.value)) as T) : undefined;
  }
  put(bucket: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET value=excluded.value",
      )
      .run(bucket, id, JSON.stringify(value));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  savePackage(files: Files): string {
    const clean = checkedFiles(files),
      version = fingerprint(clean),
      file = path.join(this.root, "packages", `${version}.json`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(clean), { flag: "wx" });
    return version;
  }
  package(version: string): Files {
    if (!/^[a-f0-9]{64}$/.test(version)) fault("版本不合法");
    const files = checkedFiles(
      JSON.parse(
        fs.readFileSync(path.join(this.root, "packages", `${version}.json`), "utf8"),
      ) as Files,
    );
    if (fingerprint(files) !== version) fault("文件包快照的内容指纹不匹配，停止读取该版本");
    return files;
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
