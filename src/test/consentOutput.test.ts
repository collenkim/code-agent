/**
 * 동의 왕복 줄이기(C7 OPT-1·2) — `consent prepare --action` 인라인 준비, `--for claude|codex` 호스트별 출력, `consent finish` 의
 * 적용 뒤 `phase`·`next`. 준비 티켓(hook 이 관찰한 세션)과 적용 결속(C5)은 그대로 거친다 — hook 판정 → CLI 자식 프로세스로 왕복한다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { nextStep, status } from "../agent/commands";
import { applyConsent, consentStatus, finishConsent, loadConsent, observeConsent, prepareConsent, renderConsentOutput } from "../agent/consent";
import { consentCommandOf, parsePrepareArgs, splitCommandArgs } from "../agent/consentTicket";
import { codexHook } from "../agent/codexHook";
import { decide } from "../agent/hook";
import { ACCEPT_CONSENT, observeConsentFixture, prepareConsentFixture, setupConsentProject, submitConsentRequest, writeFixture } from "./consentFixture";

let root: string;
const cli = join(__dirname, "../agent/cli.js");
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-consent-output-")));
  setupConsentProject(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 셸 표지 없이(비TTY 자식) CLI 를 돌린다 */
function runCli(args: string[]) {
  const env = { ...process.env };
  delete env.CLAUDECODE; delete env.CODE_AGENT_CROSS;
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env, input: "" });
}
/** hook 이 셸 명령을 판정(허용이면 티켓)한 뒤 같은 명령을 CLI 로 실행한다 */
function observed(command: string, session: string, host: "claude" | "codex") {
  assert.equal(decide({ cwd: root, session_id: session, host, tool_name: "Bash", tool_input: { command } }), undefined, command);
  return runCli(splitCommandArgs(command.replace(/^code-agent\s+/, ""))!);
}
const keys = (json: string): string[] => Object.keys(JSON.parse(json)).sort();
const ticketFiles = (): string[] => { const dir = join(root, ".code-agent/consents/tickets"); return existsSync(dir) ? readdirSync(dir) : []; };
/** Claude 질문 도구 응답 — 기록의 전체 질문으로 Pre/Post 를 넣는다 */
function answerAs(id: string, session: string): void {
  const full = JSON.parse(consentStatus(root, id));
  const base = { cwd: root, session_id: session, tool_use_id: `tool-${session}`, tool_name: "AskUserQuestion", tool_input: structuredClone(full.toolInput) };
  observeConsent({ ...base, hook_event_name: "PreToolUse" });
  observeConsent({ ...base, hook_event_name: "PostToolUse", tool_response: { questions: full.questions,
    answers: Object.fromEntries(full.questions.map((q: { question: string }) => [q.question, ACCEPT_CONSENT])) } });
}

test("--for 없이 준비한 동의는 지금과 같은 전체 출력이다(옛 템플릿 호환)", () => {
  const json = prepareConsent(root, { action: "docs" });
  assert.deepEqual(keys(json), ["codexReply", "id", "questions", "status", "summary", "toolInput"]);
  assert.equal(renderConsentOutput(root, json), json);
});

test("인라인 준비(Claude) — 티켓의 세션에 묶이고 toolInput 만 낸다. status 도 같은 필드다", () => {
  const result = observed("code-agent consent prepare --action docs --for claude", "S1", "claude");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(keys(result.stdout), ["id", "status", "summary", "toolInput"]);
  const { id } = JSON.parse(result.stdout);
  const record = loadConsent(root, id);
  assert.equal(record.form, "claude");
  assert.deepEqual({ id: record.preparedSession?.id, host: record.preparedSession?.host }, { id: "S1", host: "claude" });
  assert.deepEqual(ticketFiles(), [], "준비 티켓은 소비됐다");
  const again = runCli(["consent", "status", id]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(keys(again.stdout), ["id", "status", "summary", "toolInput"]);
  // 함수 반환은 전체다 — Codex 응답 관찰·hook 이 쓴다
  assert.ok("questions" in JSON.parse(consentStatus(root, id)));
});

test("파일 준비(Codex) — codexReply 만 내고 Codex 응답 관찰 경로가 그대로 동작한다", () => {
  writeFixture(root, "doc/x.json", JSON.stringify({ action: "docs" }));
  const result = observed("code-agent consent prepare doc/x.json --for codex", "C1", "codex");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(keys(result.stdout), ["codexReply", "id", "status", "summary"]);
  const { id, codexReply } = JSON.parse(result.stdout);
  assert.equal(loadConsent(root, id).preparedSession?.host, "codex");
  const code = /확인 코드: ([a-f0-9]{6})/.exec(codexReply.questions.at(-1).question)![1];
  codexHook({ cwd: root, hook_event_name: "UserPromptSubmit", session_id: "C1", turn_id: "turn-1", prompt: `code-agent consent respond ${id} 1 ${code}` });
  assert.equal(JSON.parse(consentStatus(root, id)).status, "approved");
});

test("깃발 순서·따옴표는 상관없고, --for 가 티켓의 호스트와 다르거나 셸 연결자가 붙으면 준비하지 않는다", () => {
  for (const command of ["code-agent consent prepare --for claude --action docs", "code-agent consent prepare '--action' docs --for claude"]) {
    const result = observed(command, "S1", "claude");
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  const mismatch = observed("code-agent consent prepare --action docs --for codex", "S1", "claude");
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /세션\(claude\)과 다릅니다/);
  decide({ cwd: root, session_id: "S1", tool_name: "Bash", tool_input: { command: "code-agent consent prepare --action docs --for claude; echo x" } });
  assert.deepEqual(ticketFiles(), []);
  const unobserved = runCli(["consent", "prepare", "--action", "docs", "--for", "claude"]);
  assert.equal(unobserved.status, 1);
  assert.match(unobserved.stderr, /hook 이 관찰하지 못했습니다[\s\S]*--action <동작>/);
});

test("인라인 준비와 파일 준비의 동작이 같다", () => {
  writeFixture(root, "doc/x.json", JSON.stringify({ action: "docs", kind: "architecture" }));
  const file = JSON.parse(observed("code-agent consent prepare doc/x.json --for claude", "S1", "claude").stdout).id;
  const inline = JSON.parse(observed("code-agent consent prepare --action docs --kind architecture --for claude", "S1", "claude").stdout).id;
  assert.deepEqual(loadConsent(root, inline).action, loadConsent(root, file).action);
});

test("문법 오류는 티켓을 꺼내기 전에 사용법으로 멈추고, hook 도 그런 명령에는 티켓을 내지 않는다", () => {
  const cases: [string, RegExp][] = [
    ["code-agent consent prepare --action model --for claude", /JSON 파일로 준비/],
    ["code-agent consent prepare --action plan x.json", /하나로만/],
    ["code-agent consent prepare --action plan --comment x", /모르는 깃발/],
    ["code-agent consent prepare --action plan --for both", /claude 또는 codex/],
    ["code-agent consent prepare x.json --kind all", /사용법/],
  ];
  for (const [command, expected] of cases) {
    assert.equal(decide({ cwd: root, session_id: "S1", tool_name: "Bash", tool_input: { command } }), undefined, command);
    assert.deepEqual(ticketFiles(), [], `${command} 에 티켓이 났습니다`);
    assert.equal(consentCommandOf(command), undefined);
    const result = runCli(splitCommandArgs(command.replace(/^code-agent\s+/, ""))!);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, expected, command);
  }
  assert.match(runCli(["consent", "prepare"]).stderr, /사용법/);
  assert.deepEqual(parsePrepareArgs(["--action", "request", "--id", "W-1", "--for", "codex"]), { action: "request", id: "W-1", form: "codex" });
  assert.deepEqual(splitCommandArgs(`--spec "doc/work/W 1/requirement.md" --for claude`), ["--spec", "doc/work/W 1/requirement.md", "--for", "claude"]);
  assert.equal(splitCommandArgs("x.json > out"), undefined);
});

test("CLI finish 는 적용 티켓의 세션으로 적용하고 phase·next 를 돌려준다 — caller 없이는 적용하지 않는다", () => {
  const { id } = JSON.parse(observed("code-agent consent prepare --action docs --for claude", "S1", "claude").stdout);
  answerAs(id, "S1");
  assert.throws(() => applyConsent(root, id), /hook 이 확인한 적용 명령만/);
  assert.equal(JSON.parse(consentStatus(root, id)).status, "approved", "caller 없는 거부는 폐기하지 않는다");
  assert.equal(decide({ cwd: root, session_id: "S1", tool_name: "Bash", tool_input: { command: `code-agent consent finish ${id}` } }), undefined);
  const result = runCli(["consent", "finish", id]);
  assert.equal(result.status, 0, result.stderr);
  const applied = JSON.parse(result.stdout);
  assert.equal(applied.status, "applied");
  assert.equal(applied.phase, undefined, "작업이 없다");
  const nextLine = status(root).split("\n").find((line) => line.startsWith("다음: "))!.slice("다음: ".length);
  assert.equal(applied.next, nextLine);
  assert.deepEqual(nextStep(root), { next: nextLine });
});

test("흐름을 멈추는 동작은 적용 뒤 고정 문구를 돌려주고, 다시 finish 해도 같다", () => {
  submitConsentRequest(root);
  const fixture = prepareConsentFixture(root, { action: "abort" });
  observeConsentFixture(fixture);
  const first = JSON.parse(finishConsent(root, fixture.id));
  assert.match(first.next, /^진행을 종료했습니다/);
  assert.deepEqual(JSON.parse(finishConsent(root, fixture.id)), first);
});
