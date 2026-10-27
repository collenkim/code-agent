import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import childProcess, { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";

import { classifyCodexReadiness, codexReadiness, type CodexProbeRaw } from "../agent/codexReadiness";
import { init, initialize } from "../agent/init";
import { managedHostView, requireRunHosts } from "../agent/master/hostProfile";
import { ControlError, hostProfileOf } from "../agent/master/protocol";
import { probeResponse, stubCodexProbe, type ProbeState } from "./codexProbeFixture";

let root: string;
let stub: ReturnType<typeof stubCodexProbe> | undefined;
let children: ChildProcess[] = [];
const cli = join(__dirname, "../agent/cli.js");
const saved = { home: process.env.CODEX_HOME, sandbox: process.env.CODEX_SANDBOX };
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-ready-root-")));
  process.env.CODEX_HOME = join(root, "codex-home");
  delete process.env.CODEX_SANDBOX;
});
afterEach(async () => {
  // 판정 파일 기록과 분리 프로세스 종료는 다르다. 이 시험이 띄운 자식의 종료 후 폴더를 정리한다.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex 준비 조회 자식 종료 대기 초과")), 30_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  children = []; mock.restoreAll();
  stub?.restore(); stub = undefined;
  for (const [key, value] of [["CODEX_HOME", saved.home], ["CODEX_SANDBOX", saved.sandbox]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(dirname(root), realpathSync.native(tmpdir())); assert.ok(root.includes("ca-ready-root-"));
  rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});
const codes = (raw: CodexProbeRaw): string[] => classifyCodexReadiness(root, raw).problems.map((problem) => problem.code);
const userConfig = (text: string): void => { mkdirSync(join(root, "codex-home"), { recursive: true }); writeFileSync(join(root, "codex-home", "config.toml"), text); };
const records = (): string[] => {
  const dir = join(process.env.CODE_AGENT_HOME!, "cache", "codex-readiness");
  return existsSync(dir) ? readdirSync(dir) : [];
};

test("분류 — 앞 단계가 막히면 뒤 단계는 알리지 않고, 신뢰 밖의 사유·hook 기능·옛 Codex·조회 실패를 가른다", () => {
  const untrusted = classifyCodexReadiness(root, probeResponse(root, "project-untrusted"));
  assert.equal(untrusted.state, "project-untrusted");
  assert.equal(untrusted.hooks, undefined);
  assert.match(untrusted.problems[0].message, /Codex: To load project-local config.*hook 검토가 필요한지는 신뢰한 뒤 다시 조회해 알립니다/);
  // 프로젝트가 꺼져 있으면 hook 기능 설정도 알리지 않는다 — 신뢰한 뒤의 실효 설정으로 다시 본다
  const both = probeResponse(root, "project-untrusted");
  both.config!.config = { features: { hooks: false } };
  assert.deepEqual(codes(both), ["codex-project-untrusted"]);
  const other = probeResponse(root, "ready");
  other.config!.layers![0].disabledReason = "project config failed to parse";
  assert.deepEqual(codes(other), ["codex-project-disabled"]);
  assert.deepEqual(codes(probeResponse(root, "hooks-disabled")), ["codex-hooks-disabled"]);
  // config/read 가 없는 옛 Codex — 모두 신뢰돼 로드되면 준비, 하나도 없으면 갱신 안내
  assert.equal(classifyCodexReadiness(root, probeResponse(root, "legacy")).state, "ready");
  assert.deepEqual(codes(probeResponse(root, "legacy-untrusted")), ["codex-unsupported"]);
  assert.deepEqual(codes({ error: "hooks/list 를 지원하지 않습니다", code: "unsupported" }), ["codex-unsupported"]);
  assert.deepEqual(codes(probeResponse(root, "spawn-missing")), ["codex-not-found"]);
  // 근거가 없으면 조회 실패 — 준비로 보지 않는다
  for (const raw of [{ error: "Codex app-server 가 8초 안에 답하지 않았습니다", code: "timeout" }, { config: {}, hooks: { data: [] } },
    { config: { layers: [] }, hooks: { data: [] } }, { ...probeResponse(root, "ready"), hooks: { data: [] } }] as CodexProbeRaw[]) {
    assert.equal(classifyCodexReadiness(root, raw).state, "query-failed", JSON.stringify(raw));
  }
  // 이 저장소 hooks.json 의 오류만 설치 문제다 — 다른 층의 오류는 판정과 무관하다
  const invalid = probeResponse(root, "ready");
  invalid.hooks!.data![0].errors = [{ path: join(root, ".codex", "hooks.json"), message: "expected value" }];
  assert.deepEqual(codes(invalid), ["codex-hooks-invalid"]);
  invalid.hooks!.data![0].errors = [{ path: join(root, "codex-home", "hooks.json"), message: "expected value" }];
  assert.equal(classifyCodexReadiness(root, invalid).state, "ready");
  // 비동기 등록은 설치 문제, 꺼진 신뢰 hook 은 검토 대상, 관리 설정(managed)은 신뢰로 본다
  const rows = probeResponse(root, "ready");
  const hooks = rows.hooks!.data![0].hooks!;
  hooks[0].async = true; hooks[1].enabled = false; hooks[2].trustStatus = "managed";
  assert.match(classifyCodexReadiness(root, rows).problems[0].message, /PreToolUse\(비동기 등록\)/);
  hooks[0].async = false;
  const review = classifyCodexReadiness(root, rows);
  assert.equal(review.state, "hooks-review");
  assert.deepEqual(review.hooks, [{ event: "UserPromptSubmit", status: "disabled" }]);
  assert.match(review.problems[0].message, /UserPromptSubmit\(꺼짐\)/);
});

test("기록 — hello(stored)는 묻지 않고, 접수(reuse)는 기한 안의 판정을 다시 쓰며, 신뢰 기록이 바뀌면 다시 묻는다", () => {
  init(root, { host: "codex", cli });
  let state: ProbeState = "hooks-review", during: (() => void) | undefined;
  stub = stubCodexProbe(() => { during?.(); return probeResponse(root, state); });
  const check = (mode: "fresh" | "reuse" | "stored") => codexReadiness(root, mode, { command: ["codex"] });
  // 기록이 없고 연동 전(kick 없음) — 묻지 않고 '확인 전'
  let result = check("stored");
  assert.deepEqual([result.state, result.problems[0].code, stub.calls()], ["checking", "codex-unchecked", 0]);
  assert.equal(check("reuse").state, "hooks-review");
  assert.equal(stub.calls(), 1);
  // 기록은 사용자 키 자리(CODE_AGENT_HOME)에 남는다 — 프로젝트·OS 임시 폴더가 아니다
  assert.equal(records().filter((name) => name.endsWith(".json")).length, 1);
  result = check("stored");
  assert.deepEqual([result.state, result.target?.version, stub.calls()], ["hooks-review", "0.163.0", 1]);
  assert.equal(check("reuse").state, "hooks-review");
  assert.equal(stub.calls(), 1);
  assert.equal(check("fresh").state, "hooks-review");
  assert.equal(stub.calls(), 2);
  // 사람이 Codex 에서 신뢰·검토하면 사용자 설정(지문)이 바뀐다 — hello 는 '확인 전', 접수는 다시 묻는다
  userConfig("[hooks.state]\n"); state = "ready";
  assert.equal(check("stored").state, "checking");
  assert.equal(check("reuse").state, "ready");
  assert.equal(stub.calls(), 3);
  assert.equal(check("stored").state, "ready");
  // 묻는 사이 설정이 바뀌면 그 판정은 기록하지 않는다
  let n = 0;
  during = () => userConfig(`# ${n++}\n`);
  assert.equal(check("fresh").state, "ready");
  during = undefined;
  assert.equal(check("stored").state, "checking");
  // 조회 실패도 짧은 기한 동안은 접수가 다시 쓴다 — 멈춘 Codex 를 제어 잠금 안에서 거듭 기다리지 않는다
  state = "query-failed";
  assert.equal(check("fresh").state, "query-failed");
  const calls = stub.calls();
  assert.equal(check("reuse").state, "query-failed");
  assert.equal(stub.calls(), calls);
});

test("Codex 샌드박스 안에서는 묻지 않는다 — 지문이 같은 기록만 쓰고, 없으면 터미널 확인을 안내하며 분리 갱신도 띄우지 않는다", () => {
  init(root, { host: "codex", cli });
  stub = stubCodexProbe("ready");
  process.env.CODEX_SANDBOX = "seatbelt";
  const sandboxed = codexReadiness(root, "fresh");
  assert.deepEqual([sandboxed.state, sandboxed.problems[0].code, stub.calls()], ["query-failed", "codex-sandboxed", 0]);
  const stored = codexReadiness(root, "stored", { kick: true });
  assert.equal(stored.problems[0].code, "codex-unchecked");
  assert.deepEqual(records(), []);
  delete process.env.CODEX_SANDBOX;
  assert.equal(codexReadiness(root, "fresh").state, "ready");
  process.env.CODEX_SANDBOX = "seatbelt";
  assert.equal(codexReadiness(root, "fresh").state, "ready");
  assert.equal(stub.calls(), 1);
});

test("hello 의 분리 갱신 — 연동한 프로젝트에서 띄운 master codex-check 가 같은 자리에 판정을 남기고, 도는 동안 겹쳐 띄우지 않는다", () => {
  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args); children.push(child); return child;
  });
  spawnSync("git", ["init", "-q", root], { windowsHide: true });
  init(root, { host: "codex", cli });
  // 분리 프로세스는 이 대역 밖이다 — CODE_AGENT_CODEX_BIN(이 node)이 app-server 를 띄우지 못해 '답하기 전에 끝남'이 기록된다
  stub = stubCodexProbe("ready");
  // 상대 경로 실행 파일은 인증 없는 hello 가 띄우지 않는다 — 작업 경로의 파일이 실행될 수 있다. 사람이 doctor 로 묻는다
  assert.equal(codexReadiness(root, "stored", { kick: true, command: [join("tools", "codex.exe")] }).problems[0].code, "codex-unchecked");
  assert.deepEqual(records().filter((name) => name.endsWith(".kick")), []);
  const first = codexReadiness(root, "stored", { kick: true });
  assert.equal(first.problems[0].code, "codex-checking");
  const kick = records().find((name) => name.endsWith(".kick"));
  assert.ok(kick, records().join(" "));
  assert.equal(codexReadiness(root, "stored", { kick: true }).problems[0].code, "codex-checking");
  let result = first;
  for (let i = 0; i < 150 && result.state === "checking"; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    result = codexReadiness(root, "stored", { kick: true });
  }
  assert.equal(result.state, "query-failed");
  assert.match(result.problems[0].message, /Codex app-server 가 답하기 전에 끝났습니다/);
  assert.equal(stub.calls(), 0);
});

test("실행 방식별 준비 — 고를 수 있는 방식과 준비를 따로 알리고, both 는 주 호스트마다 판정하며 교차 검증 호스트는 실행 파일만 본다", () => {
  init(root, { host: "both", cli });
  stub = stubCodexProbe("project-untrusted");
  // 판정 기록이 없으면 hello 는 묻지 않고 '확인 전'(연동 전이라 분리 갱신도 없다)
  let view = managedHostView(root, undefined);
  assert.deepEqual(view.runSelection, { supported: true, modes: ["claude", "codex", "both"] });
  assert.deepEqual([view.runReadiness.codex.ready, view.runReadiness.codex.state, view.runReadiness.codex.blocking[0].code], [false, "checking", "codex-unchecked"]);
  codexReadiness(root, "fresh");
  const calls = stub.calls();
  view = managedHostView(root, undefined);
  assert.equal(stub.calls(), calls);
  assert.equal(view.runReadiness.claude.ready, true);
  assert.deepEqual([view.runReadiness.codex.ready, view.runReadiness.codex.state], [false, "project-untrusted"]);
  assert.deepEqual(view.runReadiness.codex.blocking.map((item) => [item.host, item.code]), [["codex", "codex-project-untrusted"]]);
  // 교차 검증의 Codex 는 읽기 전용 exec 라 프로젝트·hook 신뢰가 필요 없다 — Claude 주 실행의 both 는 준비, Codex 주 실행의 both 는 막힌다
  assert.equal(view.runReadiness.both.claude.ready, true);
  assert.deepEqual([view.runReadiness.both.codex.ready, view.runReadiness.both.codex.state], [false, "project-untrusted"]);
  assert.equal(view.hosts.codex?.state, "project-untrusted");
  assert.equal(view.hosts.codex?.target?.version, "0.163.0");

  const claude = hostProfileOf({ kind: "claude" }), codex = hostProfileOf({ kind: "codex" });
  const rejects = (run: () => void, detail: Record<string, unknown>) => assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ControlError);
    for (const [key, value] of Object.entries(detail)) assert.deepEqual((error.detail as Record<string, unknown>)[key], value, `${key}: ${error.message}`);
    return true;
  });
  requireRunHosts(root, claude, { mode: "both", main: "claude" });
  rejects(() => requireRunHosts(root, codex, { mode: "codex" }), { host: "codex", state: "project-untrusted", problems: ["codex-project-untrusted"] });
  // 교차 검증 호스트의 실행 파일 설정 오류는 both 만 막는다
  process.env.CODE_AGENT_CODEX_BIN = join(root, "missing", "codex.exe");
  rejects(() => requireRunHosts(root, claude, { mode: "both", main: "claude" }), { host: "codex", role: "cross", problems: ["cross-host-config"] });
  requireRunHosts(root, claude, { mode: "claude" });
});

test("init 은 설치 완료와 Codex 실행 준비를 나눠 알리고 재검사 경로를 준다", () => {
  stub = stubCodexProbe("project-untrusted");
  const text = initialize(root, { cli, readiness: true });
  assert.match(text, /두 호스트 설치 완료\./);
  assert.match(text, /Codex 실행 준비: 설치 완료 · 신뢰 확인 필요 — Codex 가 이 저장소를 신뢰하지 않아 .*code-agent doctor --host codex 로 다시 확인합니다/);
  assert.doesNotMatch(text, /검토·신뢰가 필요한 code-agent hook/);
  assert.match(initialize(root, { cli }), /Codex 실행 준비: 확인 전 — .*code-agent doctor --host codex 로 다시 확인합니다/);
});
