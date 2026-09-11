import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxCommand } from "../server/workspace-tools.mjs";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("macOS full-access shell cannot read photo folders or call the harness approval API", { skip: process.platform !== "darwin" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "full-access-boundary-"));
  const work = path.join(root, "work"), store = path.join(root, "state");
  fs.mkdirSync(work); fs.mkdirSync(store); fs.mkdirSync(path.join(work, "Photos"));
  fs.writeFileSync(path.join(work, "Photos", "fixture.txt"), "PRIVATE_SENTINEL");
  let contacted = false;
  const server = http.createServer((_req, res) => { contacted = true; res.end("should not reach approval API"); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const port = server.address().port;
  const run = command => { const p = sandboxCommand(work, store, command, "full", [], [port]); return promisify(execFile)(p.executable, p.args, { cwd: work, timeout: 5000 }); };
  await assert.rejects(run("cat Photos/fixture.txt"));
  await assert.rejects(run(`/usr/bin/curl --max-time 2 http://127.0.0.1:${port}/api/fake-approval`));
  assert.equal(contacted, false);
  await run("printf okay > normal.txt");
  assert.equal(fs.readFileSync(path.join(work, "normal.txt"), "utf8"), "okay");
});
test(
  "macOS shell profile permits workspace output and denies outside reads/writes and credentials",
  { skip: process.platform !== "darwin" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-sandbox-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const work = path.join(root, "work"),
      store = path.join(root, "state");
    fs.mkdirSync(work);
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, "credentials.json"), "secret");
    fs.writeFileSync(path.join(work, ".env"), "secret");
    const run = (command) => {
      const spec = sandboxCommand(work, store, command, "ask");
      return spawnSync(spec.executable, spec.args, {
        cwd: work,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 5000,
      });
    };
    const ok = run("printf hello > result.txt");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.readFileSync(path.join(work, "result.txt"), "utf8"), "hello");
    assert.notEqual(run("cat .env").status, 0);
    assert.notEqual(run("cat ../state/credentials.json").status, 0);
    assert.notEqual(run("printf x > ../outside.txt").status, 0);
    assert(!fs.existsSync(path.join(root, "outside.txt")));
  },
);

test(
  "stopping an approved shell task reaps the process and preserves rollback for partial output",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { Harness } = await import("../server/harness.mjs");
    const { delay } = await import("../server/core.mjs");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-cancel-")),
      work = path.join(root, "work");
    fs.mkdirSync(work);
    let sent = false;
    const h = new Harness({
      root: path.join(root, "state"),
      speed: 0,
      modelAdapter: {
        async complete() {
          if (sent) return { text: "done", calls: [] };
          sent = true;
          return {
            text: "准备执行测试命令",
            calls: [
              ["tool_load", { name: "shell_run" }],
              ["shell_run", { command: "printf partial > output.txt; sleep 10" }],
            ].map(([name, args], i) => ({
              id: "shell-" + i,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            })),
          };
        },
      },
    });
    t.after(async () => {
      await h.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const w = h.workspaces.add(work),
      s = h.get(h.create({ workspaceId: w.id, prompt: "运行临时测试命令" }).id);
    const until = async (predicate) => {
      const end = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > end) throw Error("Timed out");
        await delay(10);
      }
    };
    await until(() => s.approvals.length);
    h.approve(s.id, s.approvals[0].id, "once");
    await until(() => fs.existsSync(path.join(work, "output.txt")));
    await h.stop(s.id);
    assert.equal(h.processes.list(s.id).length, 0);
    const round = h.workspaces.history(w.id, s.id)[0];
    assert(round.changes.some((c) => c.path === "output.txt"));
    h.rollbackWorkspace(s.id, round.id);
    assert(!fs.existsSync(path.join(work, "output.txt")));
  },
);
