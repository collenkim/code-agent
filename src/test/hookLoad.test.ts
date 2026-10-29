/**
 * hook 기동 — hook 은 도구 호출마다 새 프로세스로 돈다. 진입점(cli.ts HOOKS)이 그 hook 의 모듈만 지연 로드하고, hook 경로가
 * 명령 모듈(consent·cliMain·validate…)을 정적으로 읽지 않는지, 모듈 로드에 실패하면 retryPolicy.hookFailureExit 표대로 끝나는지 본다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { hookFailureExit, hookFailureInput, type HookFailureInput } from "../agent/retryPolicy";
import { start } from "./confirmedStart";
import { createStageRepo, removeStageRepo, repo } from "./stageFixture";

const AGENT = join(__dirname, "..", "agent");
const CLI = join(AGENT, "cli.js");
/** 한 자식 프로세스에서 모듈을 읽고 그 과정에서 읽힌 파일 목록을 돌려준다 */
const PROBE = "const M=require('module');const s=new Set();const o=M._load;M._load=function(r,p,i){const x=o.apply(this,arguments);try{s.add(M._resolveFilename(r,p,i))}catch{}return x};require(process.argv[1]);process.stdout.write(JSON.stringify([...s]))";
/** hook 경로가 읽으면 안 되는 명령 모듈 */
const HEAVY = ["consent.js", "cliMain.js", "commands.js", "deliver.js", "sourceUpdate.js", "validate.js", "verificationFlow.js", "crossCheck.js",
  "plugins/commands.js", "usage.js", "doctor.js", "init.js", "update.js", "graph/runtime.js", "graph/lifecycle.js", "graph/planning.js"];
/**
 * SessionStart 는 빠진 hook 설정을 알리려고 init 의 hookInstallProblems 를 읽는다(대화를 열 때 한 번이라 허용한다).
 * 도구 호출마다 도는 PreToolUse·Codex 이벤트 경로는 init 도 읽지 않는다
 */
const ALLOWED: Record<string, string[]> = { "sessionHook.js": ["init.js"] };

const slash = (path: string): string => path.split("\\").join("/");
function loaded(entry: string): string[] {
  const result = spawnSync(process.execPath, ["-e", PROBE, join(AGENT, entry)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as string[]).map(slash);
}
const dist = (files: string[]): string[] => files.filter((file) => file.includes("/dist/agent/") || file.includes("/dist/core/"));
const heavyIn = (files: string[], entry: string): string[] =>
  HEAVY.filter((heavy) => !(ALLOWED[entry] ?? []).includes(heavy) && files.some((file) => file.endsWith(`/dist/agent/${heavy}`)));

let scratch: string;
/** 프로세스가 끝날 때 읽힌 모듈 목록을 파일로 쓰는 미리 읽기 스크립트(-r) */
function recorder(): string {
  const path = join(scratch, "record-loads.cjs");
  writeFileSync(path, "const M=require('module');const fs=require('fs');const s=new Set();const o=M._load;M._load=function(r,p,i){const x=o.apply(this,arguments);try{s.add(M._resolveFilename(r,p,i))}catch{}return x};process.on('exit',()=>fs.writeFileSync(process.env.CA_LOAD_RECORD,JSON.stringify([...s])))");
  return path;
}
function runRecorded(args: string[], input: string, cwd: string, env: Record<string, string> = {}): { status: number | null; stdout: string; files: string[] } {
  const record = join(scratch, `loads-${Math.random().toString(36).slice(2)}.json`);
  const result = spawnSync(process.execPath, ["-r", recorder(), CLI, ...args], { cwd, input, encoding: "utf8", env: { ...process.env, ...env, CA_LOAD_RECORD: record } });
  return { status: result.status, stdout: result.stdout, files: (JSON.parse(readFileSync(record, "utf8")) as string[]).map(slash) };
}

beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "ca-hookload-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("hook 기동 — 모듈 그래프", () => {
  for (const entry of ["hook.js", "codexHook.js", "stopHook.js", "sessionHook.js", "agentHook.js"]) {
    test(`${entry} 는 명령 모듈을 읽지 않는다`, () => {
      const heavy = heavyIn(loaded(entry), entry);
      assert.deepEqual(heavy, [], `${entry} 가 ${heavy.join(", ")} 를 읽습니다 — hook 경로에서 명령 모듈을 import하지 마세요(지연 로드는 cli.ts HOOKS·분기 안 require)`);
    });
  }

  test("retryPolicy 는 순수 모듈이다 — fs·child_process·zod 없이 stop 만 읽는다", () => {
    const files = loaded("retryPolicy.js");
    for (const builtin of ["fs", "node:fs", "child_process", "node:child_process"]) assert.ok(!files.includes(builtin), builtin);
    assert.ok(!files.some((file) => file.includes("/node_modules/zod/")), "zod");
    assert.deepEqual(dist(files).map((file) => file.slice(file.lastIndexOf("/dist/") + 6)).sort(), ["agent/retryPolicy.js", "agent/stop.js"]);
  });

  test("cli.js 의 hook 하위 명령은 cliMain 을 읽지 않고, 명령은 cliMain 으로 그대로 돈다", () => {
    const stop = runRecorded(["stop"], "{}", scratch);
    assert.equal(stop.status, 0);
    assert.ok(!stop.files.some((file) => file.endsWith("/dist/agent/cliMain.js")), "stop 이 cliMain 을 읽었습니다");
    const help = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout.split("\n")[0], /^code-agent —/);
  });
});

describe("hook 기동 — 실행 경로", () => {
  beforeEach(() => {
    createStageRepo("ca-hookload-repo-");
    start(repo, join(repo, "doc/work/ORD-1.md"));
  });
  afterEach(() => removeStageRepo());

  const bash = (command: string): string => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command } });
  const consentLoaded = (files: string[]): boolean => files.some((file) => file.endsWith("/dist/agent/consent.js"));

  test("작업 중 Bash code-agent status 와 Codex 일반 메시지는 consent 를 읽지 않는다", () => {
    const status = runRecorded(["hook"], bash("code-agent status"), repo, { CLAUDE_PROJECT_DIR: repo });
    assert.equal(status.status, 0);
    assert.equal(consentLoaded(status.files), false, "hook 이 consent.js 를 읽었습니다");
    const prompt = runRecorded(["codex-event"], JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "안녕하세요", cwd: repo, session_id: "s", turn_id: "t" }), repo);
    assert.equal(prompt.status, 0);
    assert.equal(consentLoaded(prompt.files), false, "Codex UserPromptSubmit 이 consent.js 를 읽었습니다");
    const stop = runRecorded(["codex-event"], JSON.stringify({ hook_event_name: "Stop", cwd: repo, session_id: "s", turn_id: "t" }), repo);
    assert.equal(stop.status, 0);
    assert.ok(!stop.files.some((file) => file.endsWith("/dist/agent/planningHook.js")), "Codex Stop 이 planningHook 을 읽었습니다");
  });

  test("동의 적용 명령에서는 consent 를 실제로 읽어 세션 가드를 돈다", () => {
    const finish = runRecorded(["hook"], bash("code-agent consent finish 12345678-1234-1234-1234-123456789abc"), repo, { CLAUDE_PROJECT_DIR: repo });
    assert.equal(consentLoaded(finish.files), true);
    assert.equal(finish.status, 0);
    assert.match(JSON.parse(finish.stdout).hookSpecificOutput.permissionDecisionReason, /확인 요청을 읽을 수 없습니다/, "기록 없는 동의 적용은 가드가 막는다");
  });
});

describe("hook 기동 — 모듈 로드 실패는 hookFailureExit 표를 따른다", () => {
  /** 이름이 같은 모듈 해석을 실패시킨다 — 설치·소스 빌드 도중 dist 가 반쯤 바뀐 상태를 흉내 낸다 */
  function failing(command: string, module: string, stdin: string): { status: number | null; stdout: string; stderr: string } {
    const preload = join(scratch, "fail-require.cjs");
    writeFileSync(preload, "const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){if(r===process.env.CA_FAIL_MODULE)throw new Error('Cannot find module '+r);return o.call(this,r,...a)}");
    const env: NodeJS.ProcessEnv = { ...process.env, CA_FAIL_MODULE: module };
    delete env.CLAUDE_PROJECT_DIR; delete env.CODE_AGENT_CROSS;
    const result = spawnSync(process.execPath, ["-r", preload, CLI, command], { cwd: scratch, input: stdin, encoding: "utf8", env });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  const ROWS: [HookFailureInput["command"], string, string][] = [
    ["stop", "./stopHook", "{}"],
    ["session-event", "./sessionHook", JSON.stringify({ source: "startup" })],
    ["hook", "./hook", JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })],
    ["consent-event", "./consent", JSON.stringify({ hook_event_name: "PreToolUse" })],
    ["planning-event", "./planningHook", JSON.stringify({ hook_event_name: "SubagentStart" })],
    ["planning-event", "./planningHook", JSON.stringify({ hook_event_name: "SubagentStop" })],
    ["review-event", "./reviewHook", JSON.stringify({ hook_event_name: "SubagentStart" })],
    ["agent-event", "./agentHook", JSON.stringify({ hook_event_name: "SubagentStart" })],
    ["agent-event", "./agentHook", JSON.stringify({ hook_event_name: "SubagentStop" })],
    ["agent-event", "./agentHook", "not json"],
    ["codex-event", "./codexHook", JSON.stringify({ hook_event_name: "PreToolUse" })],
    ["codex-event", "./codexHook", "not json"],
    ["codex-event", "./codexHook", JSON.stringify({ hook_event_name: "Stop" })],
    ["codex-event", "./codexHook", JSON.stringify({ hook_event_name: "UserPromptSubmit" })],
    ["codex-event", "./codexHook", JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "안녕하세요" })],
    ["planning-event", "./planningHook", "not json"],
    ["review-event", "./reviewHook", "not json"],
  ];
  for (const [command, module, stdin] of ROWS) {
    test(`${command} · ${stdin.slice(0, 50)}`, () => {
      const result = failing(command, module, stdin);
      const expected = hookFailureExit(hookFailureInput(command, stdin), "x");
      assert.equal(result.status, expected.code, result.stderr);
      assert.match(result.stderr, /hook 을 실행하지 못했습니다/);
      if (!expected.stdout) assert.equal(result.stdout, "");
      else if (expected.stdout === "{}") assert.equal(result.stdout, "{}");
      else assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
    });
  }
  /**
   * 분기 안의 지연 require 가 실패해도 같은 표다 — 진입 모듈은 읽혔고 그 분기에서 읽는 모듈이 없다. 가드를 try/catch 로 감싸
   * undefined 로 넘기는 변경(동의 적용 가드가 열린 채 통과 — fail-open)은 여기서 잡힌다
   */
  const UUID = "12345678-1234-1234-1234-123456789abc";
  const lazyRows = (): [HookFailureInput["command"], string, string][] => [
    ["hook", "./consent", JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: scratch, tool_name: "Bash", tool_input: { command: `code-agent consent finish ${UUID}` } })],
    ["codex-event", "./consent", JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", turn_id: "t", cwd: scratch, tool_name: "Bash", tool_input: { command: `code-agent consent finish ${UUID}` } })],
    ["codex-event", "./consent", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", turn_id: "t", cwd: scratch, prompt: `code-agent consent respond ${UUID} 1 abcdef` })],
    ["codex-event", "./stopHook", JSON.stringify({ hook_event_name: "Stop", session_id: "s1", turn_id: "t", cwd: scratch })],
    ["codex-event", "./planningHook", JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s1", cwd: scratch, agent_id: "a1", agent_type: "ca_analyst" })],
    ["codex-event", "./agentHook", JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s1", cwd: scratch, agent_id: "a1", agent_type: "ca_implementer" })],
    ["codex-event", "./sessionHook", JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: scratch, source: "compact" })],
  ];
  test("분기 안의 지연 로드 실패 — 동의 적용 가드·Codex 동의 응답은 막고, Codex Stop·담당 이벤트·세션 시작은 막지 않는다", () => {
    for (const [command, module, stdin] of lazyRows()) {
      const result = failing(command, module, stdin);
      const label = `${command} · ${module} · ${stdin.slice(0, 60)}`;
      const expected = hookFailureExit(hookFailureInput(command, stdin), "x");
      assert.match(result.stderr, new RegExp(`Cannot find module \\${module}`), `${label}: 그 분기의 모듈이 실제로 실패해야 한다`);
      assert.equal(result.status, expected.code, `${label}\n${result.stderr}`);
      if (!expected.stdout) assert.equal(result.stdout, "", label);
      else if (expected.stdout === "{}") assert.equal(result.stdout, "{}", label);
      else assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny", label);
    }
    // 표의 값 그대로 — Claude 적용 가드 2, Codex 적용 가드 deny, 동의 응답 2, Stop·담당·세션 시작 0
    assert.deepEqual(lazyRows().map(([command, , stdin]) => hookFailureExit(hookFailureInput(command, stdin)).code), [2, 0, 2, 0, 0, 0, 0]);
  });

  test("깨진 stdin — 계획·리뷰 담당 hook 의 진입 함수(subagentExit)와 모듈 로드 실패(hookFailureExit)가 같은 종료 코드다", () => {
    for (const command of ["planning-event", "review-event"] as const) {
      for (const stdin of ["not json", ""]) {
        const env = { ...process.env };
        delete env.CODE_AGENT_CROSS; delete env.CLAUDE_PROJECT_DIR;
        const result = spawnSync(process.execPath, [CLI, command], { cwd: scratch, input: stdin, encoding: "utf8", env });
        assert.equal(result.status, hookFailureExit(hookFailureInput(command, stdin)).code, `${command} ${stdin}: ${result.stderr}`);
        assert.equal(result.status, 2, `${command} ${stdin}`);
      }
    }
  });

  test("표의 값 — Stop·SessionStart·SubagentStop 은 막지 않고 PreToolUse·SubagentStart 와 Codex 도구 호출은 막는다", () => {
    const code = (command: HookFailureInput["command"], stdin: string) => hookFailureExit(hookFailureInput(command, stdin)).code;
    assert.deepEqual([code("stop", "{}"), code("session-event", "{}"), code("hook", "{}"), code("consent-event", "{\"hook_event_name\":\"PreToolUse\"}"),
      code("planning-event", "{\"hook_event_name\":\"SubagentStart\"}"), code("planning-event", "{\"hook_event_name\":\"SubagentStop\"}"),
      code("agent-event", "{\"hook_event_name\":\"SubagentStart\"}"), code("agent-event", "not json")], [0, 0, 2, 2, 2, 0, 0, 0]);
    assert.match(hookFailureExit(hookFailureInput("codex-event", "not json")).stdout ?? "", /"permissionDecision":"deny"/);
  });
});

