import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { consentStatus, loadConsent, runConsentHook } from "../agent/consent";
import { clipLine, displayWidth, excerpt, QUESTION_ROWS, questionScreenProblem, screenRows, SCREEN_WIDTH, shortCommand } from "../agent/screenText";
import { confirmationText, prepareConsentFixture, prepareDeliveryFixture, setupConsentProject } from "./consentFixture";
import type { PreparedConsentFixture } from "./consentFixture";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-screen-")));
  setupConsentProject(root);
});
afterEach(() => {
  assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep));
  assert.ok(root.includes("ca-screen-"));
  rmSync(root, { recursive: true, force: true });
});

test("화면 폭: 한글·전각은 두 칸, 넘치는 줄은 자동 줄넘김 수만큼 센다", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("확인 a"), 6);
  assert.equal(screenRows("가".repeat(SCREEN_WIDTH / 2)), 1);
  assert.equal(screenRows("가".repeat(SCREEN_WIDTH / 2 + 1)), 2);
  assert.equal(screenRows("a\n\nb"), 3);
  const clipped = clipLine("가".repeat(100));
  assert.ok(clipped.clipped && clipped.text.endsWith("…") && displayWidth(clipped.text) <= SCREEN_WIDTH);
  assert.deepEqual(clipLine("짧은 줄"), { text: "짧은 줄", clipped: false });
});

test("shortCommand — 모델에게 다시 보이는 긴 선언 명령은 앞부분과 글자 수만", () => {
  assert.equal(shortCommand("npm test"), "npm test");
  const long = `node -e "${"x".repeat(300)}"`;
  assert.equal(shortCommand(long), `${long.slice(0, 120)}… (${long.length}자)`);
});

test("앞부분 발췌: 빈 줄·표 구분선은 줄 수에 넣지 않고, 빠지거나 잘린 줄이 있으면 complete 가 아니다", () => {
  const text = "제목\n\n| a | b |\n|---|---|\n| 1 | 2 |\n<!-- 렌더 안내 -->\n끝";
  assert.deepEqual(excerpt(text, 10), { text: "제목\n| a | b |\n| 1 | 2 |\n<!-- 렌더 안내 -->\n끝", omitted: 0, complete: true });
  assert.deepEqual(excerpt(text, 2), { text: "제목\n| a | b |", omitted: 3, complete: false });
  assert.equal(excerpt(`제목\n${"가".repeat(100)}`, 5).complete, false);
});

test("질문 크기 검사: 본문 10줄·선택지 3줄을 넘으면 사유를 돌려준다", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}`).join("\n");
  assert.equal(questionScreenProblem(rows(QUESTION_ROWS), ["예", "아니오"]), undefined);
  assert.match(questionScreenProblem(rows(QUESTION_ROWS + 1), ["예", "아니오"]) ?? "", /긴 내용은 질문 전에 대화에 먼저 쓰고/);
  assert.match(questionScreenProblem("범위", ["예", rows(4)]) ?? "", /선택지 "1"가 3줄을 넘어/);
});

/** 동의 질문은 어떤 길이의 요약이어도 선택 화면에 다 들어가고, 전문 파일 경로와 질문 줄이 보인다 */
function assertBounded(fixture: PreparedConsentFixture): void {
  const record = loadConsent(root, fixture.id);
  const text = confirmationText(fixture);
  assert.ok(text.includes(record.summary), "전문 파일은 요약을 그대로 싣는다");
  assert.equal(record.fullText, `.code-agent/consents/confirm-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.md`, "이름은 내용 해시다");
  assert.ok(screenRows(record.summary) > QUESTION_ROWS, "시험 요약은 화면보다 길다");
  for (const question of fixture.questions) {
    assert.ok(screenRows(question.question) <= QUESTION_ROWS, `${screenRows(question.question)}줄: ${question.question}`);
    assert.equal(questionScreenProblem(question.question, question.options.map((o) => `${o.label}\n${o.description}`)), undefined);
  }
  const last = fixture.questions.at(-1)!.question;
  assert.ok(last.startsWith(record.summary.split("\n")[0]), "제목부터 보인다");
  assert.match(last, new RegExp(`… 이하 \\d+줄 생략\\n전문: ${record.fullText!.replace(/[.]/g, "\\.")}\\n이 내용으로 진행할까요\\?$`));
}

test("동의 질문: setup 요약은 앞부분·생략 줄 수·전문 경로·질문만 화면에 싣는다", () => {
  assertBounded(prepareConsentFixture(root, { action: "setup" }));
});

test("동의 질문: 가장 긴 deliver 확인도 화면 줄 수 안에 든다", async () => {
  await prepareDeliveryFixture(root);
  assertBounded(prepareConsentFixture(root, { action: "deliver" }));
});

test("동의 질문: 문서 변경 후보와 선택 목록도 줄여 싣고, 전문 파일이 없는 이전 기록은 전문을 질문에 싣는다", () => {
  const fixture = prepareConsentFixture(root, { action: "setup" });
  const file = join(root, `.code-agent/consents/${fixture.id}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  // 합성 후보 — 질문 렌더만 본다(전문 파일의 후보 절은 실제 준비가 쓴다)
  record.choices = Array.from({ length: 5 }, (_, i) => ({ shown: [`--- doc/knowledge/business-rules.md · \`rule-${i}\``, "[지금] 없음 — 새 항목입니다", "", "[제안]", ...Array.from({ length: 20 }, (_, j) => `규칙 ${j} ${"설명".repeat(30)}`)].join("\n"),
    prompt: "적용하려면 y", target: "doc/knowledge/business-rules.md", key: `rule-${i}` }));
  writeFileSync(file, JSON.stringify(record));
  const asked = JSON.parse(consentStatus(root, fixture.id)).questions as { question: string }[];
  assert.equal(asked.length, 4, "한 번에 4개까지");
  for (const [index, question] of asked.entries()) {
    assert.ok(screenRows(question.question) <= QUESTION_ROWS, question.question);
    assert.match(question.question, new RegExp(`^${index + 1}\\. --- doc/knowledge[\\s\\S]*전문: .*\\(${index + 1}번 후보\\)\\n이 문서 갱신을 적용할까요\\?$`));
  }
  record.choices = record.choices.map((choice: object) => ({ ...choice, answer: "적용" }));
  writeFileSync(file, JSON.stringify(record));
  const final = JSON.parse(consentStatus(root, fixture.id)).questions[0].question as string;
  assert.ok(screenRows(final) <= QUESTION_ROWS, final);
  assert.match(final, /문서 변경 선택:\n- 적용: doc\/knowledge\/business-rules\.md · rule-0\n- 적용: .* · rule-1\n… 외 3개\n이 내용으로 진행할까요\?$/);
  delete record.fullText;
  record.choices = [];
  writeFileSync(file, JSON.stringify(record));
  assert.equal(JSON.parse(consentStatus(root, fixture.id)).questions[0].question, `${record.summary}\n이 내용으로 진행할까요?`);
});

function hook(event: object): { code: number; stderr: string } {
  const write = process.stderr.write, saved = process.env.CLAUDE_PROJECT_DIR;
  let stderr = "";
  process.env.CLAUDE_PROJECT_DIR = root;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try { return { code: runConsentHook(JSON.stringify(event)), stderr }; }
  finally {
    process.stderr.write = write;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
}

test("Claude 업무 질문: 선택 화면을 넘는 질문은 PreToolUse 에서 돌려보내고, 짧은 질문·응답 관찰은 막지 않는다", () => {
  const base = { cwd: root, session_id: "main", tool_use_id: "tool-1", tool_name: "AskUserQuestion" };
  const asked = (question: string, description = "설명") => ({ questions: [{ question, header: "범위", multiSelect: false,
    options: [{ label: "추천", description }, { label: "보류", description: "나중에 정합니다." }] }] });
  const long = Array.from({ length: QUESTION_ROWS + 2 }, (_, i) => `배경 ${i + 1}`).join("\n");
  const blocked = hook({ ...base, hook_event_name: "PreToolUse", tool_input: asked(long) });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /선택 화면 12줄로 10줄을 넘어 화면에서 잘립니다/);
  assert.equal(hook({ ...base, hook_event_name: "PreToolUse", tool_input: asked("Q1. 범위를 어디까지 할까요?", "설명 ".repeat(60)) }).code, 2, "설명이 긴 선택지도 잘린다");
  assert.equal(hook({ ...base, hook_event_name: "PreToolUse", tool_input: asked("Q1. 범위를 어디까지 할까요?") }).code, 0);
  assert.equal(hook({ ...base, hook_event_name: "PostToolUse", tool_input: asked(long), tool_response: { answers: {} } }).code, 0, "응답 관찰은 크기로 막지 않는다");
});
