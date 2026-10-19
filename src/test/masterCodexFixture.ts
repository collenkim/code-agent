import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { initialize } from "../agent/init";
import { masterEnable } from "../agent/master/admin";
import { call } from "../agent/master/control";
import { withInteraction } from "../agent/tty";
import { listRuns, readRun } from "../agent/master/store";
import { liveness, killVerified } from "../agent/master/processes";
export function codexProject() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-managed-codex-"))), root = join(dir, "project"), home = join(dir, "codex-home");
  mkdirSync(root); mkdirSync(home);
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
  initialize(root);
  writeFileSync(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n[hooks.state.${JSON.stringify(root + "/.codex/hooks.json")} ]\ntrusted_hash = "synthetic-test-only"\n`);
  const savedHome = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  const hostFile = join(dir, "host.json"), tokenFile = join(dir, "token");
  writeFileSync(hostFile, JSON.stringify({ kind: "codex", command: [process.execPath, join(__dirname, "masterCodexFakeHost.js")] }));
  withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "synthetic fixture" }), ask: () => "" }, () => masterEnable(root, { controller: "test", host: hostFile, tokenOut: tokenFile }));
  const token = readFileSync(tokenFile, "utf8").trim();
  const send = (type: string, payload: object = {}, commandId = randomUUID()) => call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type, controller: "test", generation: 1, token, commandId, payload })) as ReturnType<typeof call> & { result?: any };
  const wait = async (runId: string, predicate = (r: NonNullable<ReturnType<typeof readRun>>) => ["completed", "failed", "blocked", "paused", "cancelled"].includes(r.state)) => {
    const until = Date.now() + 30000;
    while (Date.now() < until) { const run = readRun(root, runId); if (run && predicate(run)) return run; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`실행 대기 초과 ${JSON.stringify(readRun(root, runId))}`);
  };
  const close = () => {
    for (const run of listRuns(root)) for (const p of [run.host, run.supervisor]) if (p && liveness(p.pid, p.marker) === "alive") killVerified(p.pid, p.marker);
    if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
    assert.ok(resolve(dir).startsWith(realpathSync.native(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true });
  };
  return { root, home, dir, send, wait, close };
}
