import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { answerSources, formatAnswerSources, openQuestions, readAnswerRows } from "../agent/answers";
import { codexHook } from "../agent/codexHook";
import { next, start } from "../agent/commands";
import { loadConsent, observeConsent, runConsentHook } from "../agent/consent";
import { loadActive, saveActive } from "../agent/layout";
import { parseQuestions } from "../agent/questions";
import { requestBegin, requestSubmit } from "../agent/request";
import { decideStop } from "../agent/stopHook";
import {
  CONSENT_SPEC, CONSENT_WORK_ID, approveAndApplyFixture, consentEvent, prepareConsentFixture, preparePlanFixture,
  setupConsentProject, submitConsentRequest, writeFixture,
} from "./consentFixture";

let root: string;
const QUESTIONS = `doc/work/${CONSENT_WORK_ID}/questions.md`;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-answers-")));
  setupConsentProject(root);
});
afterEach(() => {
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-answers-"));
  rmSync(target, { recursive: true, force: true });
});

function startWork(): void {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  start(root, join(root, CONSENT_SPEC));
}
/** 업무 질문 Claude 이벤트를 production hook 진입점으로 넣는다 — CLAUDE_PROJECT_DIR 을 이 저장소로 두고 stderr 를 모은다 */
function hook(event: object): { code: number; stderr: string } {
  const saved = process.env.CLAUDE_PROJECT_DIR, write = process.stderr.write;
  let stderr = "";
  process.env.CLAUDE_PROJECT_DIR = root;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try { return { code: runConsentHook(JSON.stringify(event)), stderr }; }
  finally {
    process.stderr.write = write;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
}
const question = (text: string, labels: string[], header = "범위") =>
  ({ question: text, header, options: labels.map((label) => ({ label, description: label })), multiSelect: false });
function ask(text: string, labels: string[], answer: string, extra: { agent?: string; prefilled?: boolean; skipPre?: boolean; tool?: string } = {}) {
  const questions = [question(text, labels)];
  const base = { cwd: root, session_id: "main", tool_use_id: extra.tool ?? `tool-${Math.random()}`, tool_name: "AskUserQuestion",
    ...(extra.agent ? { agent_id: extra.agent } : {}) };
  if (!extra.skipPre) assert.equal(hook({ ...base, hook_event_name: "PreToolUse", tool_input: { questions, ...(extra.prefilled ? { answers: { [text]: answer } } : {}) } }).code, 0);
  assert.equal(hook({ ...base, hook_event_name: "PostToolUse", tool_input: { questions }, tool_response: { questions, answers: { [text]: answer } } }).code, 0);
}
const writeQuestions = (body: string) => writeFixture(root, QUESTIONS, `# ${CONSENT_WORK_ID} 질문\n\n${body}`);
const sources = () => answerSources(root, CONSENT_WORK_ID, parseQuestions(readFileSync(join(root, QUESTIONS), "utf8")));

test("T-6-1·T-6-2 Claude 질문 도구의 답은 관찰되고, 관찰 없이 적은 답은 출처 미확인으로 막힌다", () => {
  startWork();
  writeQuestions("## Q1 · 분석\n범위?\n[Answer]: 모듈 하나\n");
  assert.throws(() => next(root), /답의 출처를 확인할 수 없는 질문이 1개/);
  const active = loadActive(root)!;
  saveActive(root, { ...active, phase: "implement" });
  assert.match(decideStop({ cwd: root }, root) ?? "", /Q1 · 분석 \(답 출처 미확인\)/);
  saveActive(root, active);
  ask("Q1. 범위?", ["모듈 하나", "서비스 전체"], "모듈 하나");
  const rows = readAnswerRows(root, CONSENT_WORK_ID);
  assert.deepEqual(rows.map((row) => row.type), ["start", "ask", "answer"]);
  assert.equal(sources().get("Q1"), "observed");
  assert.throws(() => next(root), (error: Error) => !/답의 출처/.test(error.message), "답 게이트는 지난다(다음 게이트에서 멈춘다)");
  assert.deepEqual(openQuestions(root, QUESTIONS).unverified, []);
});

test("T-6-3·T-6-8 대화로 받은 답은 [Source]: 대화 로 지나고, 확인 화면에 관찰 안 된 답으로 이름과 함께 실린다", () => {
  preparePlanFixture(root);
  const before = existsSync(join(root, ".code-agent/log/prompts.jsonl"));
  codexHook({ cwd: root, hook_event_name: "UserPromptSubmit", session_id: "codex", turn_id: "t1", prompt: "모듈 하나로 해 주세요" });
  assert.equal(existsSync(join(root, ".code-agent/log/prompts.jsonl")), before, "Codex 사용자 메시지 원문은 기록하지 않는다");
  writeQuestions("## Q1 · 범위\n어디까지?\n[Requirements]: R9\n[Answer]: 모듈 하나로 해 주세요\n[Source]: 대화\n");
  assert.equal(sources().get("Q1"), "conversation");
  assert.match(formatAnswerSources(root, CONSENT_WORK_ID) ?? "", /대화 직접 입력\(관찰 안 됨\) 1[\s\S]*Q1 · 범위: "모듈 하나로 해 주세요"/);
  const consent = prepareConsentFixture(root, { action: "plan" });
  assert.match(consent.questions[0].question, /대화 직접 입력\(관찰 안 됨\) 1/);
  assert.match(consent.questions[0].question, /경계·검증 선언/);
});

test("T-6-4 선택지 글자 답은 그 선택지 문장으로 관찰과 대조한다", () => {
  startWork();
  writeQuestions("## Q2 · 범위\n어디까지?\nA. 서비스 전체\nB. 모듈 하나\n[Answer]: B\n");
  assert.equal(sources().get("Q2"), "unverified");
  ask("Q2. 어디까지?", ["서비스 전체", "모듈 하나"], "모듈 하나");
  assert.equal(sources().get("Q2"), "observed");
});

test("T-6-5·T-6-6 Pre 없는 Post·미리 채운 답·서브에이전트 질문은 기록하지 않는다", () => {
  startWork();
  ask("Q1. 범위?", ["모듈 하나", "서비스 전체"], "모듈 하나", { skipPre: true });
  ask("Q1. 범위?", ["모듈 하나", "서비스 전체"], "모듈 하나", { prefilled: true });
  ask("Q1. 범위?", ["모듈 하나", "서비스 전체"], "모듈 하나", { agent: "child" });
  assert.equal(readAnswerRows(root, CONSENT_WORK_ID).filter((row) => row.type === "answer").length, 0);
  writeQuestions("## Q1 · 분석\n범위?\n[Answer]: 모듈 하나\n");
  assert.equal(sources().get("Q1"), "unverified");
});

test("T-6-7 이전 형식 작업의 답은 막지 않고, 접수 답은 확정 지시서의 '접수 때 정한 것'과 같을 때만 인정한다", () => {
  approveAndApplyFixture(root, { action: "setup" });
  requestBegin(root, CONSENT_WORK_ID, "feature");
  const draft = `doc/work/${CONSENT_WORK_ID}/request.json`;
  writeFixture(root, draft, JSON.stringify({
    id: CONSENT_WORK_ID, kind: "feature", title: "값과 오류", target: ["value"],
    original: "값 1을 반환한다. 음수는 거부한다.", requirements: ["값 1을 반환한다.", "음수는 거부한다."],
    clarifications: [{ question: "범위?", answer: "모듈 하나" }],
  }));
  requestSubmit(root, join(root, draft));
  writeQuestions("## Q1 · 접수\n범위?\n[Answer]: 모듈 하나\n\n## Q2 · 접수\n이름?\n[Answer]: value\n");
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  start(root, join(root, CONSENT_SPEC));
  assert.equal(sources().get("Q1"), "intake");
  assert.equal(sources().get("Q2"), "unverified");
  assert.throws(() => next(root), /답의 출처를 확인할 수 없는 질문이 1개[\s\S]*Q2/);
  writeQuestions("## Q1 · 접수\n범위?\n[Answer]: 모듈 하나\n\n## Q2 · 접수\n이름?\n[Answer]: value\n[Source]: 대화\n");
  assert.equal(sources().get("Q2"), "conversation");
  unlinkSync(join(root, `.code-agent/work/${CONSENT_WORK_ID}/answers.jsonl`));
  writeQuestions("## Q3 · 분석\n값?\n[Answer]: 1\n");
  assert.equal(sources().get("Q3"), "legacy", "시작 행이 없는 이전 형식 작업은 막지 않는다");
  assert.match(formatAnswerSources(root, CONSENT_WORK_ID) ?? "", /^질문 답 출처: 이전 형식\(관찰 기록 없음\) 1$/);
});

test("T-6-9 업무 질문 관찰 실패는 질문을 막지 않는다", () => {
  startWork();
  writeFixture(root, ".code-agent/active.json", "{broken");
  const questions = [question("Q1. 범위?", ["가", "나"])];
  const result = hook({ cwd: root, session_id: "main", tool_use_id: "t", tool_name: "AskUserQuestion", hook_event_name: "PostToolUse",
    tool_input: { questions }, tool_response: { questions, answers: { "Q1. 범위?": "가" } } });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /업무 답을 기록하지 못했습니다/);
});

test("T-6-10 [Source] 는 [Answer]: 뒤에서만 읽고 답에 섞이지 않는다", () => {
  const [parsed] = parseQuestions("## Q1\nA. 가\n[Answer]: A\n[Source]: 대화");
  assert.deepEqual([parsed.answer, parsed.source, parsed.options?.A], ["A", "대화", "가"]);
  const [head] = parseQuestions("## Q1\n질문\n[Source]: 대화\n[Answer]: 예");
  assert.equal(head.source, undefined, "질문 본문의 [Source] 는 출처가 아니다");
  assert.equal(head.answer, "예");
  assert.equal(parseQuestions("## Q1\n[Answer]:\n[Source]: 대화")[0].source, undefined, "답이 없으면 출처도 없다");
});

test("T-6-11 동의를 준비한 뒤의 업무 질문은 기록에 남아 그 동의를 대상 변경으로 폐기한다", () => {
  startWork();
  const consent = prepareConsentFixture(root, { action: "abort" });
  const questions = [question("Q1. 범위?", ["가", "나"])];
  assert.equal(hook({ cwd: root, session_id: consent.sessionId, tool_use_id: "biz", tool_name: "AskUserQuestion", hook_event_name: "PreToolUse", tool_input: { questions } }).code, 0);
  assert.throws(() => observeConsent(consentEvent(consent, "PreToolUse")), /확인 대상이 바뀌었습니다/);
  assert.equal(loadConsent(root, consent.id).failure?.kind, "target");
  assert.match(loadConsent(root, consent.id).failure!.detail, /answers\.jsonl/);
});
