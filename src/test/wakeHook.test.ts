/**
 * 쉬는 메인 깨우기(wake-event) — 대화형 CLI·확인한 호스트 버전·asyncRewake 설치를 갖췄을 때만 기다리고, 처리하지 않은 완료가 남으면 그 완료로
 * 한 번만 깨운다. 메인의 처리·다른 담당 실행·메인의 턴 끝·사람 판단 자리에서는 깨우지 않는다. 임시 git 저장소에 판정 함수와 CLI 진입점을 부른다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { AGENT_RUNS_FILE, consumeCompletion, noteAgentFinished, noteAgentStarted, pendingCompletion } from "../agent/agentRuns";
import { CONSENT_INDEX } from "../agent/consentState";
import { CROSS_CHILD_ENV } from "../agent/crossEnv";
import { doctor } from "../agent/doctor";
import { readHookOutputs } from "../agent/hookLog";
import { IMPLEMENT_MATCHER, init, WAKE_MATCHER, wakeHookAsync } from "../agent/init";
import { hookFailureExit, hookFailureInput } from "../agent/retryPolicy";
import { readTimeline, recordEvent } from "../agent/timeline";
import { versionAtLeast, WAKE, wakeMain, type WakeHookInput, type WakeOptions } from "../agent/wakeHook";
import { start } from "./confirmedStart";
import { createStageRepo, removeStageRepo, repo, write } from "./stageFixture";

const SESSION = "s1", AGENT = "a-1";
let transcript: string;

beforeEach(() => {
  createStageRepo("ca-wake-");
  start(repo, join(repo, "doc/work/ORD-1.md"));
  init(repo);
  transcript = join(repo, ".git", "main-transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", version: "2.1.312", entrypoint: "cli" })}\n`);
});
afterEach(() => removeStageRepo());

const input = (extra: Partial<WakeHookInput> = {}): WakeHookInput =>
  ({ cwd: repo, hook_event_name: "SubagentStop", session_id: SESSION, agent_id: AGENT, agent_type: "ca-analyst", transcript_path: transcript, ...extra });
const FAST: WakeOptions = { recordMs: 200, graceMs: 0, pollMs: 20, env: { CLAUDE_CODE_ENTRYPOINT: "cli" } };
const wake = (extra: Partial<WakeHookInput> = {}, options: WakeOptions = {}) => wakeMain(input(extra), repo, { ...FAST, ...options });

/** 분석 담당 완료 — agoMs 만큼 지난 완료로 고친다(진입점 시험이 깨우기 hook 의 기다림을 건너뛴다) */
function finished(agent = AGENT, agoMs = 0): void {
  noteAgentFinished(repo, "ORD-1", agent, { source: "planning", type: "ca-analyst", status: "completed", phase: "analysis", advance: true });
  if (!agoMs) return;
  const ledger = JSON.parse(readFileSync(join(repo, AGENT_RUNS_FILE), "utf8"));
  ledger.works["ORD-1"].completed.at = new Date(Date.now() - agoMs).toISOString();
  writeFileSync(join(repo, AGENT_RUNS_FILE), JSON.stringify(ledger));
}

/** 격리 호스트 — 이 빌드의 CLI 진입점을 자식 프로세스로 부른다. 진입점 표지는 env 로만 준다 */
function cli(args: string[], stdin?: object | string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const { NODE_TEST_CONTEXT: _test, CLAUDE_CODE_ENTRYPOINT: _entry, [CROSS_CHILD_ENV]: _cross, ...base } = process.env;
  const result = spawnSync(process.execPath, [join(__dirname, "..", "agent", "cli.js"), ...args], {
    cwd: repo, encoding: "utf8", windowsHide: true, input: stdin === undefined ? "" : typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    env: { ...base, CLAUDE_PROJECT_DIR: repo, CODE_AGENT_HOST: "claude", ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const stop = (session: string): string => {
  const out = cli(["stop"], { cwd: repo, session_id: session, hook_event_name: "Stop", last_assistant_message: "담당을 불렀습니다." }).stdout.trim();
  return out ? (JSON.parse(out) as { reason: string }).reason : "";
};

describe("깨운다", () => {
  test("처리하지 않은 완료가 남은 채 쉬면 그 완료로 한 번만 깨우고, 깨운 세션의 턴 끝은 같은 완료로 다시 막지 않는다", () => {
    finished(AGENT, 2 * WAKE.graceMs);
    const woke = cli(["wake-event"], input(), { CLAUDE_CODE_ENTRYPOINT: "cli" });
    assert.equal(woke.status, 2, woke.stderr);
    assert.match(woke.stderr, /담당 완료가 기록됐습니다\(ca-analyst · completed · /);
    assert.match(woke.stderr, /`code-agent planning advance`/);
    assert.ok(pendingCompletion(repo, "ORD-1")!.completion.wokenAt, "깨운 완료는 장부에 표시된다 — 처리(소비)한 것은 아니다");
    assert.deepEqual(readHookOutputs(repo).filter((row) => row.kind === "wake").map((row) => [row.event, row.session, row.agent, row.tool]),
      [["SubagentStop", SESSION, AGENT, "ca-analyst"]]);
    const woken = readTimeline(repo).filter((event) => event.type === "host.woken");
    assert.deepEqual(woken.map((event) => [event.session, event.agent]), [[SESSION, AGENT]]);
    assert.match(woken[0].reason ?? "", /^깨움: /);
    assert.equal(cli(["wake-event"], input(), { CLAUDE_CODE_ENTRYPOINT: "cli" }).status, 0, "같은 완료의 재알림으로 다시 깨우지 않는다");
    assert.equal(stop(SESSION), "", "깨운 세션의 턴 끝은 같은 완료로 다시 막지 않는다");
    assert.match(stop("s2"), /담당 완료가 기록됐습니다/, "재시작한 세션은 처리하지 않은 완료를 한 번 잇는다");
  });

  test("동시에 끝난 깨우기 hook 둘 중 하나만 깨운다 — 같은 완료(eventId)는 장부 잠금 안에서 한 번만 잡힌다", () => {
    finished();
    assert.match(wake() ?? "", /담당 완료가 기록됐습니다/);
    assert.equal(wake(), undefined);
    finished("a-2");
    assert.match(wake({ agent_id: "a-2" }) ?? "", /담당 완료가 기록됐습니다/, "새 완료는 새로 잡는다");
  });

  test("완료 → 깨움 상한은 graceMs + pollMs 다 — 메인이 그 안에 처리하면 깨우지 않는다", () => {
    finished();
    const started = Date.now();
    assert.match(wake({}, { graceMs: 300, pollMs: 20 }) ?? "", /담당 완료가 기록됐습니다/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250 && elapsed < 300 + 20 + 1_000, `${elapsed}ms`);
    assert.ok(WAKE.timeoutSec * 1_000 > WAKE.recordMs + WAKE.graceMs + WAKE.pollMs, "기다림이 설치 항목의 timeout 안에 끝난다");
  });
});

describe("깨우지 않는다", () => {
  test("대화형 CLI·확인한 호스트 버전·asyncRewake 설치가 모두 있어야 기다린다 — 아니면 동기 SubagentStop 의 exit 2 가 담당 되돌림이 되므로 바로 0", () => {
    finished(AGENT, 2 * WAKE.graceMs);
    assert.equal(wake({}, { env: {} }), undefined, "진입점 표지가 없다");
    assert.equal(wake({}, { env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } }), undefined, "-p·SDK·관리 실행");
    assert.equal(wake({ transcript_path: undefined }), undefined, "호스트 버전을 모른다");
    writeFileSync(transcript, `${JSON.stringify({ version: "2.1.311" })}\n`);
    assert.equal(wake(), undefined, "확인하지 않은 옛 버전");
    writeFileSync(transcript, `${JSON.stringify({ version: "2.1.312" })}\n`);
    assert.equal(wake({ agent_id: undefined }), undefined);
    const path = join(repo, ".claude", "settings.json"), settings = JSON.parse(readFileSync(path, "utf8"));
    for (const entry of settings.hooks.SubagentStop) for (const hook of entry.hooks) delete hook.asyncRewake;
    writeFileSync(path, JSON.stringify(settings, null, 2));
    assert.equal(wakeHookAsync(repo), false);
    assert.equal(wake(), undefined, "손으로 asyncRewake 를 지운 설치");
    assert.match(doctor(repo).text, /asyncRewake 가 없어 깨우기가 꺼져 있습니다/);
    assert.equal(cli(["wake-event"], input(), { CLAUDE_CODE_ENTRYPOINT: "cli" }).status, 0);
    init(repo);
    assert.equal(cli(["wake-event"], input(), { CLAUDE_CODE_ENTRYPOINT: "cli", [CROSS_CHILD_ENV]: "1" }).status, 0, "교차 실행이 띄운 호스트");
    assert.equal(cli(["wake-event"], input(), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).status, 0);
    assert.equal(cli(["wake-event"], "not json", { CLAUDE_CODE_ENTRYPOINT: "cli" }).status, 0);
    assert.equal(pendingCompletion(repo, "ORD-1")!.completion.wokenAt, undefined);
    assert.match(wake() ?? "", /담당 완료가 기록됐습니다/, "조건을 갖추면 같은 완료로 깨운다");
    for (const [version, expected] of [["2.1.312", true], ["2.2.0", true], ["10.0.0", true], ["2.1.99", false], ["1.9.999", false]] as const) {
      assert.equal(versionAtLeast(version, WAKE.minVersion), expected, version);
    }
  });

  test("메인이 처리했거나, 다른 담당이 돌거나, 완료로 남지 않은 담당이거나, 완료 뒤 메인의 턴 끝이 기록됐으면 깨우지 않는다", () => {
    finished();
    consumeCompletion(repo);
    assert.equal(wake(), undefined, "진행 명령이 완료를 처리했다");
    noteAgentStarted(repo, "ORD-1", "a-2", { source: "planning", type: "ca-explorer", phase: "analysis" });
    finished();
    assert.equal(pendingCompletion(repo, "ORD-1")?.running, 1);
    assert.equal(wake(), undefined, "병렬 담당이 아직 돈다");
    noteAgentFinished(repo, "ORD-1", "a-2", { source: "planning", type: "ca-explorer", status: "cancelled", phase: "analysis", advance: false });
    assert.equal(wake({ agent_id: "a-2" }), undefined, "되돌림·늦은 결과·중복처럼 완료로 남지 않은 담당");
    recordEvent(repo, { type: "host.stopped", host: "claude", session: SESSION });
    assert.equal(wake(), undefined, "완료 뒤 메인의 턴 끝은 Stop 이 이미 판정했다");
    assert.match(wake({ session_id: "s2" }) ?? "", /담당 완료가 기록됐습니다/, "다른 세션의 턴 끝은 이 세션을 대신하지 않는다");
  });

  test("사람 판단 자리(앞서 있던 답 없는 질문·열린 동의)와 Stop 이 이미 막은 세션에서는 깨우지 않는다", () => {
    finished();
    assert.match(stop(SESSION), /담당 완료가 기록됐습니다/);
    assert.equal(wake(), undefined, "Stop 이 같은 완료로 이미 막았다");
    finished("a-2");
    write("doc/work/ORD-1/questions.md", "## Q1 · 범위\n어디까지 볼까?\n[Answer]:\n");
    assert.equal(wake({ agent_id: "a-2", session_id: "s2" }), undefined, "사람의 답을 기다린다");
    write("doc/work/ORD-1/questions.md", "## Q1 · 범위\n어디까지 볼까?\n[Answer]: 주문 조회까지\n");
    finished("a-3");
    mkdirSync(join(repo, CONSENT_INDEX, ".."), { recursive: true });
    writeFileSync(join(repo, CONSENT_INDEX), JSON.stringify({ version: 1, open: { "c-1": { action: "plan", status: "pending", createdAt: new Date().toISOString() } }, recent: {} }));
    assert.equal(wake({ agent_id: "a-3", session_id: "s3" }), undefined, "응답·적용을 기다리는 동의");
    assert.equal(pendingCompletion(repo, "ORD-1")!.completion.wokenAt, undefined);
  });
});

describe("설치", () => {
  test("init 이 장부에 완료를 남기는 모든 담당 matcher 와 asyncRewake·timeout 으로 한 번만 설치하고, 실패 표는 언제나 0 이다", () => {
    init(repo);
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, { matcher?: string; hooks: { command: string; asyncRewake?: boolean; timeout?: number }[] }[]> };
    const ours = settings.hooks.SubagentStop.filter((entry) => entry.hooks.some((hook) => hook.command.endsWith(" wake-event")));
    assert.equal(ours.length, 1);
    assert.equal(ours[0].matcher, WAKE_MATCHER);
    assert.deepEqual([ours[0].hooks[0].asyncRewake, ours[0].hooks[0].timeout], [true, WAKE.timeoutSec]);
    for (const agent of ["ca-analyst", "ca-explorer", "ca-writer", "ca-critic", "ca-reviewer", ...IMPLEMENT_MATCHER.split("|")]) assert.ok(WAKE_MATCHER.split("|").includes(agent), agent);
    assert.equal(wakeHookAsync(repo), true);
    assert.doesNotMatch(doctor(repo).text, /asyncRewake/);
    for (const stdin of ["not json", "{\"hook_event_name\":\"SubagentStop\"}"]) assert.equal(hookFailureExit(hookFailureInput("wake-event", stdin)).code, 0, stdin);
  });
});
