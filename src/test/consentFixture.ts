import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { applyConsent, consentStatus, observeConsent, prepareConsent } from "../agent/consent";
import type { ConsentAction, ConsentHookInput } from "../agent/consent";
import { next, requireValidatable, start, submitPlan } from "../agent/commands";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { loadActive } from "../agent/layout";
import { requestBegin, requestSubmit } from "../agent/request";
import { openRound, reviewDocFile } from "../agent/review";
import { setupProject } from "../agent/setup";
import { check, integrate, runTests } from "../agent/validate";
import { recordReviewFixture } from "./reviewFixture";
import { dispatchPlanning, preparePlanning } from "../agent/planning";
import { observePlanner } from "../agent/planningHook";
import { codexHook } from "../agent/codexHook";
import type { Host } from "../agent/hosts";

export const ACCEPT_CONSENT = "확인하고 진행";
export const DEFER_CONSENT = "보류";
export type NativeQuestions = NonNullable<NonNullable<ConsentHookInput["tool_input"]>["questions"]>;
export interface PreparedConsentFixture {
  root: string;
  id: string;
  status: string;
  questions: NativeQuestions;
  toolInput: NonNullable<ConsentHookInput["tool_input"]> & { questions: NativeQuestions };
  sessionId: string;
  toolUseId: string;
}

export function writeFixture(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

export function gitFixture(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}

/** Only creates an isolated project; no confirmation records are seeded. */
export function setupConsentProject(root: string): void {
  gitFixture(root, "init", "-q", "-b", "master");
  gitFixture(root, "config", "user.name", "consent-fixture");
  gitFixture(root, "config", "user.email", "consent-fixture@example.invalid");
  gitFixture(root, "config", "commit.gpgsign", "false");
  gitFixture(root, "config", "core.autocrlf", "false");
  docsBegin(root);
  setupProject(root, "node");
  docsEnd(root);
  writeFixture(root, ".gitignore", [
    ".code-agent/active.json", ".code-agent/request-session.json", ".code-agent/docs-session.json",
    ".code-agent/log/", ".code-agent/consents/", "node_modules/", "",
  ].join("\n"));
}

/** Synthetic runtime transport, not a real human response. Calls the production observer. */
export function prepareConsentFixture(root: string, action: ConsentAction): PreparedConsentFixture {
  const prepared = JSON.parse(prepareConsent(root, action));
  assert.equal(typeof prepared.id, "string");
  assert.equal(prepared.status, "pending");
  assert.ok(Array.isArray(prepared.questions) && prepared.questions.length > 0);
  assert.deepEqual(prepared.toolInput.questions, prepared.questions);
  return { root, ...prepared, sessionId: `session-${randomUUID()}`, toolUseId: `tool-${randomUUID()}` };
}

export function consentEvent(
  fixture: PreparedConsentFixture,
  event: "PreToolUse" | "PostToolUse",
  overrides: Partial<ConsentHookInput> = {},
): ConsentHookInput {
  return {
    cwd: fixture.root, hook_event_name: event, session_id: fixture.sessionId,
    tool_use_id: fixture.toolUseId, tool_name: "AskUserQuestion",
    tool_input: structuredClone(fixture.toolInput), ...overrides,
  };
}

export function nativeAnswers(fixture: PreparedConsentFixture, label = ACCEPT_CONSENT): Record<string, string> {
  for (const question of fixture.questions) {
    assert.ok(question.options.some(option => option.label === label), `Missing explicit test choice: ${label}`);
  }
  return Object.fromEntries(fixture.questions.map(question => [question.question, label]));
}

export function nativeResponse(fixture: PreparedConsentFixture, label = ACCEPT_CONSENT) {
  return { questions: structuredClone(fixture.questions), answers: nativeAnswers(fixture, label) };
}

export function observeConsentFixture(fixture: PreparedConsentFixture, label = ACCEPT_CONSENT): void {
  observeConsent(consentEvent(fixture, "PreToolUse"));
  observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture, label) }));
}

/** For simple final-confirmation actions. Choice batches must be answered explicitly by the caller. */
export function approveAndApplyFixture(root: string, action: ConsentAction, host: Host = "claude"): PreparedConsentFixture & { result: string } {
  const fixture = prepareConsentFixture(root, action);
  if (host === "codex") codexHook({cwd:root, hook_event_name:"UserPromptSubmit", session_id:fixture.sessionId,
    turn_id:fixture.toolUseId, prompt:`code-agent consent respond ${fixture.id} 1`});
  else observeConsentFixture(fixture);
  assert.equal(JSON.parse(consentStatus(root, fixture.id)).status, "approved");
  const result = applyConsent(root, fixture.id);
  assert.equal(JSON.parse(consentStatus(root, fixture.id)).status, "applied");
  return { ...fixture, result };
}

export const CONSENT_WORK_ID = "CONSENT-1";
export const CONSENT_SPEC = `doc/work/${CONSENT_WORK_ID}/requirement.md`;

export function submitConsentRequest(root: string): void {
  requestBegin(root, CONSENT_WORK_ID, "feature");
  const draft = `doc/work/${CONSENT_WORK_ID}/request.json`;
  writeFixture(root, draft, JSON.stringify({
    id: CONSENT_WORK_ID, kind: "feature", title: "값과 오류", target: ["value"],
    original: "값 1을 반환한다. 음수는 거부한다.", requirements: ["값 1을 반환한다.", "음수는 거부한다."],
  }));
  requestSubmit(root, join(root, draft));
}

/** 모델 대신 합성한 런타임 이벤트로 신규 관찰 계약을 통과시킨다. 실제 모델 실측은 아니다. */
function completePlanningFixture(root: string, id: string, artifacts: Record<string, string>, host: Host): void {
  preparePlanning(root);
  const dispatch = JSON.parse(dispatchPlanning(root, id));
  const event = { cwd: root, session_id: "planning-fixture", agent_id: randomUUID(), agent_type: dispatch.agent,
    ...(host === "codex" ? {transcript_path:"/codex/parent.jsonl",agent_transcript_path:"/codex/child.jsonl"} : {}) };
  const observe = host === "codex" ? codexHook : observePlanner;
  observe({ ...event, hook_event_name: "SubagentStart" });
  observe({ ...event, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify({
    ...dispatch.resultShape, status: "completed", summary: "고정된 테스트 자료 확인", evidence: [{ path: CONSENT_SPEC, line: 1 }],
    artifacts: Object.entries(artifacts).map(([path, content]) => ({ path, content })),
  }) });
}

/** Small Node workflow adapted from process.test.ts; all approvals use real consent events. */
export function preparePlanFixture(root: string, host: Host = "claude"): void {
  approveAndApplyFixture(root, { action: "setup" }, host);
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID }, host);
  start(root, join(root, CONSENT_SPEC));
  let artifacts: Record<string, string> = {};
  const document = (path: string, content: string) => { artifacts[path] = content; };
  const prefix = `doc/work/${CONSENT_WORK_ID}/`;
  document(prefix + "01-requirements.md", '## R1 · 값\n출처: REQ-1\n근거: "값 1을 반환한다."\n## R2 · 오류\n출처: REQ-2\n근거: "음수는 거부한다."\n## 가정\n- 없음\n');
  completePlanningFixture(root, "analysis", artifacts, host); artifacts = {};
  next(root);
  document(prefix + "02-analysis.md", "## 기존 시스템 분석\n새 기능\n## 영향 범위\n| R | 파일 | 호출 | 파급 |\n|---|---|---|---|\n| R1 | src/value.js | 없음 | 새 기능 |\n| R2 | src/value.js | 없음 | 예외 |\n## Risk\n잘못된 입력\n");
  completePlanningFixture(root, "explore", {}, host);
  completePlanningFixture(root, "synthesis", artifacts, host); artifacts = {};
  next(root);
  document(prefix + "03-design.md", "## 구성 요소\nvalue 함수\n## 처리 흐름\n입력 검사 후 값 반환\n## API\n해당 없음 — 외부 접점 없음\n## 데이터\n해당 없음 — 저장 없음\n## 설계 결정\n순수 함수\n");
  document(prefix + "04-functional.md", "## 기능 정의\n값과 오류\n## 업무 규칙\n음수 거부\n## 예외\n음수는 Error\n## 수락 기준\n- AC-R1-1: 양수이면 1\n- AC-R2-1: 음수이면 Error\n");
  completePlanningFixture(root, "design", artifacts, host); artifacts = {};
  next(root);
  document(prefix + "07-test-spec.md", "## 테스트 케이스\n| TC | 수준 | AC | 케이스 | 기대 결과 |\n|---|---|---|---|---|\n| TC-1 | Unit | AC-R1-1 | 양수 | 1 |\n| TC-2 | Unit | AC-R2-1 | 음수 | Error |\n");
  const plan = {
    domainName: "Value", domainLabel: "값", domainRoot: "", domainDirName: "value",
    files: [
      { stage: "code", path: "src/value.js", purpose: "값과 오류", requirements: ["R1", "R2"] },
      { stage: "test", path: "tests/value.test.js", purpose: "검증", requirements: ["R1", "R2"] },
    ],
    sequence: [{ step: "test", why: "동작을 먼저 명시" }, { step: "code", why: "명시한 동작 구현" }],
    tasks: [
      { id: "T1", stage: "test", title: "동작 테스트", requirements: ["R1", "R2"], files: ["tests/value.test.js"], dependsOn: [], acceptance: ["AC-R1-1", "AC-R2-1"] },
      { id: "T2", stage: "code", title: "함수 구현", requirements: ["R1", "R2"], files: ["src/value.js"], dependsOn: ["T1"], acceptance: ["AC-R1-1", "AC-R2-1"] },
    ],
    approach: "순수 함수", conventions: [], conflicts: [], openQuestions: [], reasoning: "테스트 먼저",
  };
  document(prefix + "plan.json", JSON.stringify(plan));
  completePlanningFixture(root, "plan", artifacts, host);
  completePlanningFixture(root, "critic", {}, host);
  submitPlan(root, join(root, prefix + "plan.json"));
  assert.equal(loadActive(root)?.phase, "plan");
}

export async function prepareDeliveryFixture(root: string, host: Host = "claude"): Promise<void> {
  preparePlanFixture(root, host);
  approveAndApplyFixture(root, { action: "plan" }, host);
  next(root);
  writeFixture(root, "tests/value.test.js", "const test=require('node:test'),a=require('node:assert/strict'),v=require('../src/value');\ntest('TC-1',()=>a.equal(v(1),1));\ntest('TC-2',()=>a.throws(()=>v(-1)));\n");
  next(root);
  writeFixture(root, "src/value.js", "module.exports=n=>{if(n<0)throw Error('negative');return 1;};\n");
  next(root);
  await check(requireValidatable(root, "check")); next(root);
  await runTests(requireValidatable(root, "test")); next(root);
  openRound(requireValidatable(root, "review"));
  const review = reviewDocFile(CONSENT_WORK_ID);
  writeFixture(root, review, readFileSync(join(root, review), "utf8").replace("## 지적\n", "## 지적\n\n- 없음\n"));
  recordReviewFixture(root, host);
  next(root);
  await integrate(requireValidatable(root, "integrate")); next(root);
  writeFixture(root, prefixPr(), "## 요약\n값과 오류 구현\n## 확인 방법\n함수 호출\n## 위험·되돌리기\n새 파일을 되돌린다.\n");
  assert.equal(loadActive(root)?.phase, "deliver");
}

function prefixPr(): string { return `doc/work/${CONSENT_WORK_ID}/10-pr.md`; }
