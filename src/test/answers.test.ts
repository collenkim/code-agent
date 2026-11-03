import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formatAnswerSources, openQuestions, readAnswerRows } from "../agent/answers";
import { codexHook } from "../agent/codexHook";
import { next } from "../agent/commands";
import { loadActive, saveActive } from "../agent/layout";
import { mutateInteractions } from "../agent/interactions";
import { decideStop } from "../agent/stopHook";
import { CONSENT_WORK_ID, confirmationText, prepareConsentFixture, preparePlanFixture } from "./consentFixture";
import { root, QUESTIONS, startWork, hook, question, ask, writeQuestions, sources } from "./answerObservationFixture";

import "./answerObservationFixture";
test("2-5 Post의 만료·긴 답 저장 실패에도 실제 답 관찰은 남는다", () => {
  startWork();
  for (const [kind, answer] of [["expired", "모듈 하나"], ["long", "긴 답".repeat(800)]] as const) {
    writeQuestions(`## Q9 · 범위\n어디까지?\n[Answer]: ${answer}\n`);
    const text = "Q9 · 범위\n어디까지?", questions = [question(text, ["모듈 하나", "전체"])];
    const base = { cwd: root, session_id: "main", tool_use_id: `post-${kind}`, tool_name: "AskUserQuestion", tool_input: { questions } };
    assert.equal(hook({ ...base, hook_event_name: "PreToolUse" }).code, 0);
    if (kind === "expired") mutateInteractions(root, state => {
      for (const r of Object.values(state.requests)) if (r.nativeCallIds?.includes(base.tool_use_id)) r.expiresAt = "2000-01-01T00:00:00.000Z";
    });
    const result = hook({ ...base, hook_event_name: "PostToolUse", tool_response: { questions, answers: { [text]: answer } } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /영속 질문/);
    assert.equal(sources().get("Q9"), "observed");
    assert.ok(readAnswerRows(root, CONSENT_WORK_ID).some(row => row.type === "answer" && row.toolId === base.tool_use_id && row.items.some(item => item.answer === answer)));
  }
});

test("1-7 같은 Q와 답이어도 제목·본문을 바꾸거나 다른 제목으로 물으면 관찰된 답이 아니다", () => {
  startWork();
  const original = "## Q1 · 범위\n어디까지?\n[Answer]: 모듈 하나\n";
  writeQuestions(original);
  ask("Q1. 다른 질문?", ["모듈 하나", "전체"], "모듈 하나", { rawTitle: true });
  assert.equal(sources().get("Q1"), "unverified");
  ask("Q1. 어디까지?", ["모듈 하나", "전체"], "모듈 하나");
  assert.equal(sources().get("Q1"), "observed");
  for (const edited of [original.replace("범위", "승인"), original.replace("어디까지?", "삭제할까요?")]) {
    writeQuestions(edited);
    assert.equal(sources().get("Q1"), "unverified");
  }
  writeQuestions(original);
  assert.equal(sources().get("Q1"), "observed");
});

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
  assert.match(confirmationText(consent), /대화 직접 입력\(관찰 안 됨\) 1[\s\S]*Q1 · 범위: "모듈 하나로 해 주세요"/);
  assert.match(confirmationText(consent), /경계·검증 선언/);
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
