import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { askChoice, confirmChoice } from "../agent/choiceServer";
import { codexHook } from "../agent/codexHook";
import { applyConsent, loadConsent, prepareConsent } from "../agent/consent";
import { takeTicket } from "../agent/consentTicket";
import { readDocLedger } from "../agent/docs";
import { init } from "../agent/init";
import { applyTemplates, hostGuidance } from "../agent/runtimeApply";
import { checkChoiceConfig, choiceConfigProblem } from "../agent/choiceConfig";
import { QUESTION_ROWS, screenRows } from "../agent/screenText";
import { currentInteractions } from "../agent/interactions";
import { setupConsentProject, writeFixture } from "./consentFixture";

let root: string;
beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-choice-"))); setupConsentProject(root); });
afterEach(() => {
  assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep));
  assert.ok(root.includes("ca-choice-"));
  rmSync(root, { recursive: true, force: true });
});
function prepare() {
  return JSON.parse(prepareConsent(root, { action: "docs" }, { binding: { id: "owner", host: "codex" }, form: "codex" })).id as string;
}
function open(id: string, session_id = "owner", extra: object = {}) {
  return codexHook({ cwd: root, hook_event_name: "PreToolUse", session_id, tool_name: "mcp__code_agent__confirm", tool_input: { id }, ...extra });
}
const selected = (label: string) => async () => ({ action: "accept", content: { q1: label } });

test("2-11 동시에 열린 MCP 질문은 실제 호출 세션의 티켓만 소비한다", async () => {
  const questions = [{ title: "환경", options: ["개발", "운영"] }];
  const hook = (session: string, claimed?: string) => codexHook({ cwd: root, hook_event_name: "PreToolUse", session_id: session,
    tool_name: "mcp__code_agent__ask", tool_input: { questions, ...(claimed ? { sessionId: claimed } : {}) } });
  assert.match(JSON.stringify(hook("A")), /sessionId/);
  assert.match(JSON.stringify(hook("A", "B")), /deny/);
  assert.deepEqual(hook("A", "A"), {}); assert.deepEqual(hook("B", "B"), {});
  await assert.rejects(askChoice({ questions }, selected("개발"), root), /sessionId/);
  await assert.rejects(askChoice({ questions, sessionId: "C" }, selected("개발"), root), /hook/);
  await askChoice({ questions, sessionId: "A" }, selected("개발"), root);
  await askChoice({ questions, sessionId: "B" }, selected("운영"), root);
  const requests = currentInteractions(root).requests;
  assert.equal(requests.length, 2);
  for (const [session, answer] of [["A", "개발"], ["B", "운영"]]) {
    const r = requests.find(r => r.context.sessionId === session)!;
    const selectedId = r.response!.submission.answers![0].optionIds[0];
    assert.equal(r.questions[0].options.find(o => o.optionId === selectedId)!.label, answer);
  }
});

test("선택 UI: 독립 질문 두 개의 실제 선택만 반환하고 취소·미응답·주입 답을 수락하지 않는다", async () => {
  const args = { questions: [{ title: "테스트", options: ["추천", "수정", "보류"] }, { title: "품질", options: ["추천", "수정", "보류"] }] };
  const result = await askChoice(args, async form => {
    assert.deepEqual(form.requestedSchema.required, ["q1", "q2"]);
    assert.doesNotMatch(JSON.stringify(form), /"default"/);
    return { action: "accept", content: { q1: "수정", q2: "추천" } };
  });
  assert.deepEqual(result, { status: "answered", answers: [{ question: "테스트", answer: "수정" }, { question: "품질", answer: "추천" }] });
  assert.equal((await askChoice(args, async () => ({ action: "cancel" })) as any).status, "cancelled");
  await assert.rejects(askChoice(args, selected("추천")), /모든 질문/);
  await assert.rejects(askChoice({ ...args, answers: ["추천"] }, selected("추천")));
});

test("선택 UI: 폼 화면을 넘는 질문·선택지는 표시하지 않고 줄이라고 돌려보낸다", async () => {
  let shown = 0;
  const count = async () => { shown++; return { action: "cancel" }; };
  const long = Array.from({ length: QUESTION_ROWS + 1 }, (_, i) => `${i + 1}. 배경 설명`).join("\n");
  await assert.rejects(askChoice({ questions: [{ title: long, options: ["추천", "보류"] }] }, count), /질문 본문이 선택 화면 11줄로 10줄을 넘어/);
  await assert.rejects(askChoice({ questions: [{ title: "범위", options: ["가".repeat(120), "보류"] }] }, count), /선택지 "가+…"가 3줄을 넘어/);
  assert.equal(shown, 0, "잘릴 질문은 폼을 열지 않는다");
  await askChoice({ questions: [{ title: Array.from({ length: QUESTION_ROWS }, (_, i) => `${i + 1}줄`).join("\n"), options: ["추천", "보류"] }] }, count);
  assert.equal(shown, 1);
});

test("동의 UI: 동일 세션 hook 티켓 → 서버 폼 응답 → 적용 원장에 UI 출처", async () => {
  const id = prepare();
  assert.deepEqual(open(id), {});
  const result: any = await confirmChoice(root, { id }, async form => {
    // 요약 전문은 대화·전문 파일에 있다 — 폼에는 짧은 안내와 화면에 다 들어가는 질문만 싣는다(Codex 폼은 넘치는 줄을 자른다)
    const field = (form.requestedSchema.properties as Record<string, { title: string }>).q1;
    assert.doesNotMatch(form.message, /공통 POLICY/);
    assert.match(field.title, /공통 POLICY[\s\S]*전문: \.code-agent\/consents\/confirm-[a-f0-9]{12}\.md\n이 내용으로 진행할까요\?$/);
    assert.ok(screenRows(`${form.message}\n\n${field.title}`) <= QUESTION_ROWS + 2);
    assert.equal(loadConsent(root, id).status, "pending");
    assert.equal(loadConsent(root, id).channel, "codex-elicitation");
    return { action: "accept", content: { q1: "확인하고 진행" } };
  });
  assert.equal(result.status, "approved");
  applyConsent(root, id, { sessionId: "owner" });
  assert.equal(loadConsent(root, id).status, "applied");
  assert.equal(readDocLedger(root).length, 4);
  assert.ok(readDocLedger(root).every(row => row.presence.channel === "codex-elicitation"));
  await assert.rejects(confirmChoice(root, { id }, selected("확인하고 진행")), /hook/);
});

test("동의 UI: hook 없는 호출·타 세션·하위 담당·미리 채운 답을 거부한다", async () => {
  const id = prepare();
  await assert.rejects(confirmChoice(root, { id }, selected("확인하고 진행")), /hook/);
  assert.match(JSON.stringify(open(id, "other")), /현재 세션/);
  assert.equal(takeTicket(root, "question", id), undefined);
  assert.throws(() => open(id, "owner", { agent_id: "child" }), /메인 세션/);
  const previousCross = process.env.CODE_AGENT_CROSS;
  try {
    process.env.CODE_AGENT_CROSS = "codex";
    assert.throws(() => open(id), /메인 세션/);
  } finally {
    if (previousCross === undefined) delete process.env.CODE_AGENT_CROSS; else process.env.CODE_AGENT_CROSS = previousCross;
  }
  assert.throws(() => open(id, "owner", { tool_input: { id, answers: [1] } }), /답을 미리/);
  await assert.rejects(confirmChoice(root, { id, answer: "확인하고 진행" }, selected("확인하고 진행")));
  assert.equal(loadConsent(root, id).status, "pending");
});

for (const action of ["cancel", "decline"] as const) {
  test(`동의 UI: ${action}은 보류이며 자동 승인·재질문하지 않는다`, async () => {
    const id = prepare(); open(id);
    const result: any = await confirmChoice(root, { id }, async () => ({ action, content: null }));
    assert.equal(result.status, "deferred");
    assert.equal(readDocLedger(root).length, 0);
    open(id);
    await assert.rejects(confirmChoice(root, { id }, selected("확인하고 진행")), /응답 가능한 동의가 아닙니다/);
  });
}

test("동의 UI: 표시 뒤 대상 변경·잘못된 응답·연결 종료는 승인하지 않는다", async () => {
  let id = prepare(); open(id);
  await assert.rejects(confirmChoice(root, { id }, async () => {
    appendFileSync(join(root, "doc/architecture.md"), "\nchanged");
    return { action: "accept", content: { q1: "확인하고 진행" } };
  }), /확인 대상/);
  assert.equal(loadConsent(root, id).status, "failed");
  id = prepare(); open(id);
  await assert.rejects(confirmChoice(root, { id }, selected("임의 답")));
  assert.equal(loadConsent(root, id).status, "failed");
  id = prepare(); open(id);
  await assert.rejects(confirmChoice(root, { id }, async () => { throw new Error("disconnected"); }));
  assert.equal(loadConsent(root, id).status, "failed");
  assert.equal(readDocLedger(root).length, 0);
});

test("Codex 설치: MCP 블록만 갱신하고 다른 설정을 보존하며 재설치가 안정적이다", () => {
  const original = 'model = "existing-model"\n[mcp_servers.other]\ncommand = "other-server"\n';
  writeFixture(root, ".codex/config.toml", original);
  init(root, { host: "codex" });
  const first = readFileSync(join(root, ".codex/config.toml"), "utf8");
  assert.ok(first.startsWith(original));
  assert.match(first, /choice-server/);
  assert.equal(choiceConfigProblem(root), undefined);
  init(root, { host: "codex" });
  assert.equal(readFileSync(join(root, ".codex/config.toml"), "utf8"), first);
  writeFixture(root, ".codex/config.toml", '[mcp_servers.code_agent]\ncommand = "user-owned"\n');
  assert.throws(() => checkChoiceConfig(root), /이름 충돌/);
  assert.throws(() => init(root, { host: "codex" }), /이름 충돌/);
});

test("2-11 이전 MCP 도구 목록의 갱신은 설정 변경으로 세션 재시작을 안내한다", () => {
  init(root, { host: "codex" });
  const path = join(root, ".codex/config.toml");
  writeFixture(root, ".codex/config.toml", readFileSync(path, "utf8").replace(/^# code-agent:choices:schema=.*\r?\n/m, ""));
  assert.match(choiceConfigProblem(root) ?? "", /세션.*다시/);
  const changed = applyTemplates(root, { host: "codex" });
  assert.equal(changed.changes.mcp, true);
  assert.match(hostGuidance(changed.changes, ["codex"], true).join("\n"), /다시 열어야.*MCP/);
  assert.equal(choiceConfigProblem(root), undefined);
  assert.equal(applyTemplates(root, { host: "codex" }).changes.mcp, false);
});
