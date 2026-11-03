import assert from "node:assert/strict";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formatAnswerSources, openQuestions, readAnswerRows } from "../agent/answers";
import { next, start } from "../agent/commands";
import { loadConsent, observeConsent } from "../agent/consent";
import { loadActive, saveActive } from "../agent/layout";
import { parseQuestions } from "../agent/questions";
import { questionApplies, type PlanningState, type PlanningTask } from "../agent/planningState";
import { workDocsHash } from "../agent/workDocs";
import { requestBegin, requestSubmit } from "../agent/request";
import { CONSENT_SPEC, CONSENT_WORK_ID, approveAndApplyFixture, consentEvent, prepareConsentFixture, writeFixture } from "./consentFixture";
import { gitFixture } from "./repoFixture";
import { root, QUESTIONS, startWork, hook, question, ask, writeQuestions, sources } from "./answerObservationFixture";

import "./answerObservationFixture";
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

test("새 실행 회차는 이전 회차 반영 커밋과 질문 원문·답이 같은 답을 이어받는다 — 질문 본문 결속 전 형식의 관찰 기록이어도 다시 묻지 않고, 반영 뒤 고친 질문·답은 출처 미확인이다", () => {
  startWork();
  writeQuestions("## Q1 · 분석\n범위?\n[Answer]: 모듈 하나\n\n## Q2 · 분석\n이름?\n[Answer]: value\n\n## Q3 · 분석\n값?\n[Answer]: 1\n");
  // 결속 전 형식(f8c67b8 까지) — 질문 행에 documentHash 가 없다
  const file = join(root, `.code-agent/work/${CONSENT_WORK_ID}/answers.jsonl`);
  for (const [q, answer] of [["Q1", "모듈 하나"], ["Q2", "value"], ["Q3", "1"]]) {
    appendFileSync(file, `${JSON.stringify({ type: "ask", at: new Date().toISOString(), host: "claude", session: "old", toolId: `old-${q}`, prefilled: false, items: [{ q, header: "범위", questionHash: `h-${q}`, options: [answer] }] })}\n`);
    appendFileSync(file, `${JSON.stringify({ type: "answer", at: new Date().toISOString(), host: "claude", session: "old", toolId: `old-${q}`, items: [{ q, questionHash: `h-${q}`, answer, free: false }] })}\n`);
  }
  assert.deepEqual([...sources().values()], ["unverified", "unverified", "unverified"], "회차 밖에서는 결속 전 형식의 관찰을 인정하지 않는다");
  gitFixture(root, "add", "-A");
  gitFixture(root, "commit", "-qm", `[${CONSENT_WORK_ID}] 반영`);
  saveActive(root, { ...loadActive(root)!, cycle: { number: 2, delivered: gitFixture(root, "rev-parse", "HEAD") } });
  assert.deepEqual([...sources().values()], ["delivered", "delivered", "delivered"]);
  writeQuestions("## Q1 · 분석\n범위?\n[Answer]: 모듈 하나\n\n## Q2 · 분석\n이름?\n[Answer]: other\n\n## Q3 · 분석\n바뀐 값?\n[Answer]: 1\n");
  assert.deepEqual([...sources().entries()], [["Q1", "delivered"], ["Q2", "unverified"], ["Q3", "unverified"]], "반영 뒤 답·질문을 고치면 이어받지 않는다");
  assert.match(formatAnswerSources(root, CONSENT_WORK_ID) ?? "", /^질문 답 출처: 이전 회차 반영본 1 · 출처 미확인 2$/);
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

test("검토 #11 Q 번호 없는 질문 호출의 응답은 어느 질문에도 맞추지 않는다 — 같은 답(예·A)을 가진 다른 질문이 관찰됨이 되지 않는다", () => {
  startWork();
  writeQuestions("## Q4 · 범위\n이 범위로 진행할까요?\n[Answer]: 예\n\n## Q5 · 결제\n어느 결제?\nA. 토스\nB. 카드\n[Answer]: A\n");
  ask("다음으로 넘어갈까요?", ["예", "아니오"], "예");
  ask("어느 쪽?", ["A", "B"], "A");
  const rows = readAnswerRows(root, CONSENT_WORK_ID).filter((row) => row.type === "answer");
  assert.equal(rows.length, 2, "응답은 기록한다");
  assert.equal(sources().get("Q4"), "unverified");
  assert.equal(sources().get("Q5"), "unverified");
  assert.deepEqual(openQuestions(root, QUESTIONS).unverified.map((question) => question.id), ["Q4", "Q5"]);
  ask("Q4. 이 범위로 진행할까요?", ["예", "아니오"], "예");
  assert.equal(sources().get("Q4"), "observed", "같은 Q 번호의 응답은 관찰됨");
  assert.equal(sources().get("Q5"), "unverified");
});

test("변경 분류 — 분류가 있는 질문은 도구 질문 본문에 '분류: <이름>'이 보인 응답만 관찰된 답이고, 출처 표시가 붙은 답은 분류를 쓰지 않는다", () => {
  startWork();
  const body = "## Q1 · 빈 폴더\nmigration 폴더를 지울까요?\n[Kind]: operation\n[Answer]: 지운다\n";
  writeQuestions(body);
  assert.equal(parseQuestions(readFileSync(join(root, QUESTIONS), "utf8"))[0].kind, "operation");
  ask("Q1. migration 폴더를 지울까요?", ["지운다", "둔다"], "지운다");
  assert.equal(sources().get("Q1"), "unverified", "분류를 보이지 않고 받은 답은 그 분류의 답이 아니다");
  ask("Q1. migration 폴더를 지울까요?\n분류: 운영·파일 정리", ["지운다", "둔다"], "지운다");
  assert.equal(sources().get("Q1"), "observed");
  // 답한 뒤 분류를 바꾸면 질문 원문이 달라져 출처 미확인이다
  writeQuestions(body.replace("[Kind]: operation", "[Kind]: test"));
  assert.equal(sources().get("Q1"), "unverified");
  writeQuestions(`${body}[Source]: 대화\n`);
  assert.equal(parseQuestions(readFileSync(join(root, QUESTIONS), "utf8"))[0].kind, undefined, "관찰되지 않은 답에는 분류를 쓰지 않는다");
  writeQuestions(body.replace("[Kind]: operation", "[Kind]: requirement"));
  assert.equal(parseQuestions(readFileSync(join(root, QUESTIONS), "utf8"))[0].kind, undefined, "요구·설계는 기본값이다");
});

test("변경 분류 — 운영·문서 표현·테스트 구현 오류의 답은 승인 묶음에 들지 않고, 계획 작업 중 plan·critic 만(운영은 어느 작업도) 받는다", () => {
  startWork();
  const hash = () => workDocsHash(root, CONSENT_WORK_ID, loadActive(root)!.spec);
  writeQuestions("");
  const empty = hash();
  writeQuestions("## Q1 · 단언\nTC-127 의 null 단언을 고칠까요?\n[Kind]: test\n[Answer]: 고친다\n");
  assert.equal(hash(), empty, "테스트 구현 오류의 답은 계획 승인을 낡게 하지 않는다");
  writeQuestions("## Q1 · 범위\n취소도 포함할까요?\n[Answer]: 포함\n");
  assert.notEqual(hash(), empty, "요구·설계 답은 승인 묶음이다");
  const task = (role: string) => ({ id: role, role, questionIds: [], requirements: ["R1"] }) as unknown as PlanningTask;
  const state = { tasks: [] } as unknown as PlanningState;
  const [operation, wording] = parseQuestions("## Q1 · 폴더\n지울까요?\n[Kind]: operation\n[Answer]: 예\n## Q2 · 문구\n표현?\n[Kind]: wording\n[Answer]: 예\n");
  assert.deepEqual(["analysis", "design", "plan", "critic"].map((role) => questionApplies(operation, task(role), state)), [false, false, false, false]);
  assert.deepEqual(["analysis", "design", "plan", "critic"].map((role) => questionApplies(wording, task(role), state)), [false, false, true, true]);
  assert.equal(questionApplies(operation, { ...task("analysis"), questionIds: ["Q1"] } as PlanningTask, state), true, "작업이 질문 ID 를 직접 받으면 입력이다");
});
