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
import { codexReadiness } from "../agent/codexReadiness";
export function codexProject() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-managed-codex-"))), root = join(dir, "project"), home = join(dir, "codex-home");
  mkdirSync(root); mkdirSync(home);
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
  initialize(root);
  writeFileSync(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n[hooks.state.${JSON.stringify(root + "/.codex/hooks.json")} ]\ntrusted_hash = "synthetic-test-only"\n`);
  // 모의 app-server 가 CODEX_HOME 의 신뢰 기록으로 config/read·hooks/list 에 답한다. 판정 기록은 시험 폴더에, 교차 검증 호스트는 이 node 로
  const saved = { CODEX_HOME: process.env.CODEX_HOME, CODE_AGENT_HOME: process.env.CODE_AGENT_HOME, CODE_AGENT_CLAUDE_BIN: process.env.CODE_AGENT_CLAUDE_BIN, CODE_AGENT_CODEX_BIN: process.env.CODE_AGENT_CODEX_BIN };
  Object.assign(process.env, { CODEX_HOME: home, CODE_AGENT_HOME: join(dir, "code-agent-home"), CODE_AGENT_CLAUDE_BIN: process.execPath, CODE_AGENT_CODEX_BIN: process.execPath });
  const hostFile = join(dir, "host.json"), tokenFile = join(dir, "token");
  writeFileSync(hostFile, JSON.stringify({ kind: "codex", command: [process.execPath, join(__dirname, "masterCodexFakeHost.js")] }));
  withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "synthetic fixture" }), ask: () => "" }, () => masterEnable(root, { controller: "test", host: hostFile, tokenOut: tokenFile }));
  const token = readFileSync(tokenFile, "utf8").trim();
  // 사람이 doctor 로 확인한 것처럼 지금 묻고 기록한다 — hello 는 묻지 않고 이 기록을 읽는다
  const recheck = () => codexReadiness(root, "fresh", { command: [process.execPath, join(__dirname, "masterCodexFakeHost.js")] });
  recheck();
  const send = (type: string, payload: object = {}, commandId = randomUUID()) => call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type, controller: "test", generation: 1, token, commandId, payload })) as ReturnType<typeof call> & { result?: any };
  const wait = async (runId: string, predicate = (r: NonNullable<ReturnType<typeof readRun>>) => ["completed", "failed", "blocked", "paused", "cancelled"].includes(r.state)) => {
    const until = Date.now() + 30000;
    while (Date.now() < until) { const run = readRun(root, runId); if (run && predicate(run)) return run; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`실행 대기 초과 ${JSON.stringify(readRun(root, runId))}`);
  };
  const close = () => {
    for (const run of listRuns(root)) for (const p of [run.host, run.supervisor]) if (p && liveness(p.pid, p.marker) === "alive") killVerified(p.pid, p.marker);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(resolve(dir).startsWith(realpathSync.native(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { root, home, dir, send, wait, close, recheck };
}
