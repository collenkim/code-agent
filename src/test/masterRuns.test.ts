/**
 * master 실행 — 감독 프로세스·호스트 프로세스·정지(협력·강제)·재조정·중복 실행 방지·프로젝트 격리(모의 시험).
 * 호스트는 가짜(masterFakeHost.js)다 — 실제 모델 실행이 아니다. 실제 Claude 실행 결과는 doc/reviews 의 실측 기록에 따로 남긴다.
 * 사람의 TTY 확인(enable)은 withInteraction 으로 흉내낸다.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { masterEnable } from "../agent/master/admin";
import { call } from "../agent/master/control";
import { killVerified, liveness } from "../agent/master/processes";
import { listRuns, readRun, writeRunRecord, type RunRecord } from "../agent/master/store";
import { withInteraction } from "../agent/tty";
import { deadPid } from "./deadPid";

const tty = <T>(run: () => T): T => withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "모의 TTY(시험)" }), ask: () => "n" }, run);
const FAKE = join(__dirname, "masterFakeHost.js");
const POLICY = { heartbeatMs: 200, progressMs: 300, startTimeoutMs: 1000, stopGraceMs: 60_000, masterTimeoutMs: 600_000 };

interface Project { root: string; token: string }
const projects: Project[] = [];
let outside: string;
let seq = 0;
const cid = (): string => `c-${++seq}-${Date.now()}`;

function project(policy: Record<string, unknown> = POLICY): Project {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-master-run-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "master"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
  writeFileSync(join(root, "README.md"), "x\n");
  git("add", "-A"); git("commit", "-qm", "init");
  const hostFile = join(outside, `host-${seq}.json`), policyFile = join(outside, `policy-${seq}.json`), tokenFile = join(outside, `token-${++seq}`);
  writeFileSync(hostFile, JSON.stringify({ command: [process.execPath, FAKE] }));
  writeFileSync(policyFile, JSON.stringify(policy));
  tty(() => masterEnable(root, { controller: "m1", tokenOut: tokenFile, host: hostFile, policy: policyFile }));
  const created = { root, token: readFileSync(tokenFile, "utf8").trim() };
  projects.push(created);
  return created;
}
type Res = ReturnType<typeof call> & { result?: any };
function send(p: Project, type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Res {
  return call(p.root, JSON.stringify({ protocol: "code-agent.master", version: 1, type, controller: "m1", generation: 1, token: p.token, payload, ...extra })) as Res;
}
async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`기다림 초과: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const runOf = (p: Project, runId: string): RunRecord => readRun(p.root, runId)!;
const terminal = (state: string) => ["completed", "blocked", "failed", "cancelled", "paused", "abandoned", "unknown"].includes(state);

beforeEach(() => { outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-master-run-out-"))); });
afterEach(() => {
  for (const p of projects.splice(0)) {
    for (const run of listRuns(p.root)) {
      if (run.host && liveness(run.host.pid, run.host.marker) === "alive") killVerified(run.host.pid, run.host.marker);
      if (run.supervisor && liveness(run.supervisor.pid, run.supervisor.marker) === "alive") killVerified(run.supervisor.pid, run.supervisor.marker);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { rmSync(p.root, { recursive: true, force: true }); break; } catch { execFileSync(process.execPath, ["-e", "setTimeout(()=>{},300)"]); }
    }
  }
  rmSync(outside, { recursive: true, force: true });
});

describe("접수·실행·결과", () => {
  test("접수 → 감독 → 호스트 → 결과 근거. 같은 commandId 재전송은 같은 실행을 돌려주고 새로 띄우지 않는다", async () => {
    const p = project();
    const id = cid();
    const payload = { mode: "start", prompt: "MODE=complete WRITE=src/out.txt", links: { missionId: "M-1", taskId: "T-1", attemptId: "A-1" } };
    const accepted = send(p, "submit", payload, { commandId: id, expect: { work: null } });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    const runId = accepted.result.runId as string;
    const replay = send(p, "submit", payload, { commandId: id, expect: { work: null } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.runId, runId);
    assert.equal(send(p, "submit", { ...payload, prompt: "MODE=fail" }, { commandId: id, expect: { work: null } }).error?.code, "conflict");
    const done = await waitFor("실행 종료", () => terminal(runOf(p, runId).state) && runOf(p, runId));
    assert.equal(done.state, "completed", JSON.stringify(done.outcome));
    assert.equal(listRuns(p.root).length, 1, "재전송이 실행을 더 만들지 않았다");
    const result = send(p, "result", { runId }).result;
    assert.equal(result.final, true);
    assert.equal(result.result.host.exitCode, 0);
    assert.match(result.result.note, /완료 발언/);
    assert.ok(result.result.changes.files.some((file: { path: string; category: string }) => file.path === "src/out.txt" && file.category === "product"));
    assert.deepEqual(result.result.links, payload.links);
    const lookup = send(p, "command", { commandId: id }).result;
    assert.equal(lookup.phase, "completed");
    const types = send(p, "events", { after: 0 }).result.events.map((event: { type: string }) => event.type);
    for (const type of ["run.accepted", "run.starting", "run.started", "run.finished"]) assert.ok(types.includes(type), `${type} 이벤트`);
    assert.ok(types.indexOf("run.accepted") < types.indexOf("run.finished"));
  });

  test("호스트 실패는 failed — 모델 출력과 관계없이 종료 코드·결과 줄로 판정한다", async () => {
    const p = project();
    const runId = send(p, "submit", { prompt: "MODE=fail" }, { commandId: cid() }).result.runId as string;
    const done = await waitFor("실패 종료", () => terminal(runOf(p, runId).state) && runOf(p, runId));
    assert.equal(done.state, "failed");
  });
});

describe("정지·재개", () => {
  test("실행 중에는 새 실행을 받지 않고(busy), 재조정은 살아 있는 실행을 바꾸지 않으며, pause 는 hook 을 통한 협력 정지로 끝난다 → resume 은 같은 세션을 잇는다", async () => {
    const p = project();
    const first = send(p, "submit", { prompt: "MODE=loop" }, { commandId: cid() });
    const runId = first.result.runId as string;
    await waitFor("실행 시작", () => runOf(p, runId).state === "running");
    assert.equal(send(p, "submit", { prompt: "MODE=complete" }, { commandId: cid() }).error?.code, "busy");
    const reconciled = send(p, "reconcile", {}, { commandId: cid() });
    assert.equal(reconciled.ok, true);
    assert.equal(runOf(p, runId).state, "running", "감독이 살아 있으면 재조정이 바꾸지 않는다");
    const paused = send(p, "pause", { runId, reason: "시험 정지" }, { commandId: cid() });
    assert.equal(paused.result.requested, true);
    const done = await waitFor("정지", () => terminal(runOf(p, runId).state) && runOf(p, runId));
    assert.equal(done.state, "paused");
    assert.equal(done.outcome?.cooperative, true);
    assert.equal(done.outcome?.forced, false);
    assert.equal(liveness(done.host!.pid, done.host!.marker), "dead");
    const resumed = send(p, "resume", { runId, prompt: "MODE=complete" }, { commandId: cid() });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
    assert.equal(resumed.result.mode, "continue");
    assert.equal(resumed.result.sessionId, done.sessionId);
    const next = await waitFor("이어 실행 종료", () => terminal(runOf(p, resumed.result.runId).state) && runOf(p, resumed.result.runId));
    assert.equal(next.state, "completed");
  });

  test("협력하지 않는 호스트는 유예 뒤 확인된 프로세스만 강제 종료하고 cancelled(forced)로 남긴다", async () => {
    const p = project();
    const runId = send(p, "submit", { prompt: "MODE=hang" }, { commandId: cid() }).result.runId as string;
    await waitFor("실행 시작", () => runOf(p, runId).state === "running");
    const host = runOf(p, runId).host!;
    send(p, "cancel", { runId, graceMs: 300 }, { commandId: cid() });
    const done = await waitFor("취소", () => terminal(runOf(p, runId).state) && runOf(p, runId), 60_000);
    assert.equal(done.state, "cancelled");
    assert.equal(done.outcome?.forced, true);
    assert.equal(liveness(host.pid, host.marker), "dead");
  });
});

describe("재조정·격리", () => {
  test("감독이 죽으면 재조정이 실제 프로세스를 대조한다 — 성공으로 처리하거나 다시 실행하지 않는다(Windows 는 호스트가 감독과 함께 끝나 unknown)", async () => {
    const p = project();
    const runId = send(p, "submit", { prompt: "MODE=hang" }, { commandId: cid() }).result.runId as string;
    await waitFor("실행 시작", () => runOf(p, runId).state === "running");
    const supervisor = runOf(p, runId).supervisor!;
    // 감독 프로세스 하나만 끝낸다(트리 종료가 아니다)
    process.kill(supervisor.pid);
    await waitFor("감독 종료", () => liveness(supervisor.pid, supervisor.marker) === "dead");
    send(p, "reconcile", {}, { commandId: cid() });
    const run = runOf(p, runId);
    assert.equal(run.state, process.platform === "win32" ? "unknown" : "orphaned", JSON.stringify(run.history));
    assert.equal(listRuns(p.root).length, 1, "다시 실행하지 않았다");
    if (run.state === "unknown") assert.equal((run.result as { recovered?: boolean }).recovered, true);
    else send(p, "cancel", { runId, force: true, waitMs: 15_000 }, { commandId: cid() });
  });

  test("감독 없이 살아 있는 호스트(orphaned)는 끝나지 않은 것으로 본다 — 새 실행은 받지 않고, 강제 취소는 확인된 그 호스트만 끝낸다. 다른 프로젝트의 실행은 그대로다", async () => {
    const p = project(), q = project();
    const other = send(q, "submit", { prompt: "MODE=loop" }, { commandId: cid() }).result.runId as string;
    // 감독과 떨어진 호스트 — 실제 감독이 띄운 것처럼 세션 표지를 명령줄에 둔다
    const session = "dddddddd-2222-4333-8444-555555555555";
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const orphan = spawn(process.execPath, [FAKE, "-p", "--session-id", session], { cwd: p.root, detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    orphan.stdin!.end("MODE=hang");
    orphan.unref();
    const at = new Date(Date.now() - 10_000).toISOString();
    writeRunRecord(p.root, { version: 1, runId: "run-orphan-host", commandId: "c-o", controller: "m1", generation: 1, mode: "start", links: {}, state: "running", acceptedAt: at, updatedAt: at,
      sessionId: session, promptHash: "x", timeoutMs: 600_000, workId: null, baseHead: null, baseStateVersion: "x", history: [],
      supervisor: { pid: deadPid(), startedAt: at, marker: "master supervise run-orphan-host", heartbeatAt: at }, host: { pid: orphan.pid!, startedAt: at, marker: session } });
    await waitFor("q 시작", () => runOf(q, other).state === "running");
    assert.equal(liveness(orphan.pid!, session), "alive");
    send(p, "reconcile", {}, { commandId: cid() });
    assert.equal(runOf(p, "run-orphan-host").state, "orphaned");
    assert.equal(send(p, "submit", { prompt: "MODE=complete" }, { commandId: cid() }).error?.code, "busy", "끝나지 않은 실행이 있으면 다시 배정하지 않는다");
    const cancelled = send(p, "cancel", { runId: "run-orphan-host", force: true, waitMs: 15_000 }, { commandId: cid() });
    assert.equal(cancelled.result.stopped, true, JSON.stringify(cancelled.result));
    assert.equal(runOf(p, "run-orphan-host").state, "cancelled");
    assert.equal(runOf(p, "run-orphan-host").outcome?.forced, true);
    assert.equal(liveness(orphan.pid!, session), "dead");
    assert.equal(runOf(q, other).state, "running", "다른 프로젝트의 실행은 영향이 없다");
    send(q, "pause", { runId: other }, { commandId: cid() });
    assert.equal((await waitFor("q 정지", () => terminal(runOf(q, other).state) && runOf(q, other))).state, "paused");
  });

  test("접수 뒤 감독이 시작하지 않은 실행은 시작 기한 뒤 abandoned — 다시 실행하지 않는다", async () => {
    const p = project();
    const at = new Date(Date.now() - 5_000).toISOString();
    writeRunRecord(p.root, { version: 1, runId: "run-orphan-accept", commandId: "c-x", controller: "m1", generation: 1, mode: "start", links: {}, state: "accepted", acceptedAt: at, updatedAt: at,
      sessionId: "cccccccc-2222-4333-8444-555555555555", promptHash: "x", timeoutMs: 10_000, workId: null, baseHead: null, baseStateVersion: "x", history: [] });
    // 다음 요청의 재조정이 시작 기한이 지난 접수를 abandoned 로 닫는다 — 그 뒤에야 새 실행을 받는다
    const next = send(p, "submit", { prompt: "MODE=complete" }, { commandId: cid() });
    assert.equal(next.ok, true, JSON.stringify(next.error));
    const run = readRun(p.root, "run-orphan-accept")!;
    assert.equal(run.state, "abandoned");
    assert.equal(run.host, undefined, "호스트를 띄우지 않았다");
    await waitFor("새 실행 종료", () => terminal(runOf(p, next.result.runId).state));
  });

  test("master 연결이 끊기면(정책 pause) 실행을 협력 정지한다 — 연결 끊김만으로 실패·재배정하지 않는다", async () => {
    const p = project({ ...POLICY, masterTimeoutMs: 1000, onMasterDisconnect: "pause" });
    const runId = send(p, "submit", { prompt: "MODE=loop" }, { commandId: cid() }).result.runId as string;
    const done = await waitFor("연결 끊김 정지", () => terminal(runOf(p, runId).state) && runOf(p, runId), 30_000);
    assert.equal(done.state, "paused");
    assert.match(done.stop?.reason ?? "", /연결/);
    const types = JSON.parse(JSON.stringify(send(p, "events", { after: 0 }).result.events)).map((event: { type: string }) => event.type);
    assert.ok(types.includes("master.disconnected"));
  });
});
