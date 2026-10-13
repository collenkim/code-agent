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
import { checkChoiceConfig, choiceConfigProblem } from "../agent/choiceConfig";
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

test("동의 UI: 동일 세션 hook 티켓 → 서버 폼 응답 → 적용 원장에 UI 출처", async () => {
  const id = prepare();
  assert.deepEqual(open(id), {});
  const result: any = await confirmChoice(root, { id }, async form => {
    assert.match(form.message, /공통 POLICY/);
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
