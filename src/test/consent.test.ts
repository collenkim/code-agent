import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyConsent, consentCommandGuard, finishConsent, loadConsent, observeConsent } from "../agent/consent";
import type { ConsentHookInput } from "../agent/consent";
import { hasBaseline } from "../agent/bootstrap";
import { checkProjectDocs, readDocLedger } from "../agent/docs";
import { decide as guardTool } from "../agent/hook";
import { loadManifestIfAny } from "../agent/work";
import { ACCEPT_CONSENT, DEFER_CONSENT, approveAndApplyFixture, consentEvent, gitFixture, nativeAnswers, nativeResponse, observeConsentFixture, prepareConsentFixture, writeFixture } from "./consentFixture";
import type { PreparedConsentFixture } from "./consentFixture";
import { deadPid } from "./deadPid";
import { root, docsFixture, assertNoDocs } from "./consentLifecycleFixture";

import "./consentLifecycleFixture";
test("finish는 응답 전에는 status와 같고(요약은 처음 한 번만 보여 주므로 빼고), 승인이 관찰된 뒤에만 한 번에 적용한다", () => {
  const fixture = docsFixture();
  const pending = JSON.parse(finishConsent(root, fixture.id));
  assert.equal(pending.status, "pending");
  assert.equal("summary" in pending, false);
  assert.deepEqual(pending.toolInput, fixture.toolInput);
  assertNoDocs();
  observeConsent(consentEvent(fixture, "PreToolUse"));
  observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
  const applied = JSON.parse(finishConsent(root, fixture.id));
  assert.equal(applied.status, "applied");
  assert.equal(readDocLedger(root).length, 4);
  assert.deepEqual(JSON.parse(finishConsent(root, fixture.id)), applied, "재호출은 다시 적용하지 않고 같은 결과를 돌려준다");
  assert.match(consentCommandGuard(root, `code-agent consent finish ${fixture.id}`, "other-session")!, /현재 세션/);
});

test("죽은 apply 가 남긴 잠금은 되찾고, 주인을 모르거나 살아 있는 잠금은 경로·pid 를 알린다", () => {
  const fixture = docsFixture();
  observeConsent(consentEvent(fixture, "PreToolUse"));
  observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
  const lock = join(root, ".code-agent/consents/apply.lock");
  writeFileSync(lock, "");
  assert.throws(() => applyConsent(root, fixture.id), /apply\.lock 을 지운 뒤/, "주인을 모르는 잠금은 훔치지 않는다");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: "t" }));
  assert.throws(() => applyConsent(root, fixture.id), new RegExp(`pid ${process.pid}`), "살아 있는 주인은 기다린다");
  const dead = deadPid();
  writeFileSync(lock, JSON.stringify({ pid: dead, host: hostname(), at: "t" }));
  applyConsent(root, fixture.id);
  assert.equal(loadConsent(root, fixture.id).status, "applied");
  assert.equal(existsSync(lock), false);
});

test("끝맺지 못한 applying 은 '응답 없음' 이 아니라 중단으로 알리고 같은 동의로 다시 돌리지 않는다", () => {
  const fixture = docsFixture();
  observeConsent(consentEvent(fixture, "PreToolUse"));
  observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
  const file = join(root, ".code-agent/consents", `${fixture.id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "applying" }));
  assert.throws(() => applyConsent(root, fixture.id), /이전 적용이 끝나지 않은 채 중단됐습니다/);
  const record = loadConsent(root, fixture.id);
  assert.equal(record.status, "failed");
  assert.equal(record.failure?.class, "consent-apply-failed");
  assert.equal(record.failure?.kind, "apply");
  assert.equal(record.failure?.detail, "이전 적용이 끝나지 않은 채 중단");
  assertNoDocs();
});

test("적용 중 도메인 함수가 실패하면 적용 실패(kind apply)로 남고 첫 줄을 사유로 적는다 — 같은 동의로 다시 적용하지 않는다", () => {
  // 진행 중인 작업도 접수도 없는 저장소의 abort — 준비(status 화면)는 되고 적용 때 abort 가 Stop 을 던진다
  const fixture = prepareConsentFixture(root, { action: "abort" });
  observeConsentFixture(fixture);
  assert.equal(loadConsent(root, fixture.id).status, "approved");
  assert.throws(() => applyConsent(root, fixture.id), /진행 중인 작업도 접수 중인 요구사항도 없습니다/);
  const record = loadConsent(root, fixture.id);
  assert.equal(record.status, "failed");
  assert.equal(record.failure?.class, "consent-apply-failed");
  assert.equal(record.failure?.kind, "apply");
  assert.equal(record.failure?.detail, "진행 중인 작업도 접수 중인 요구사항도 없습니다.");
  assert.throws(() => applyConsent(root, fixture.id), /명시적으로 확인한 응답이 없습니다/, "실패한 동의는 다시 적용하지 않는다");
});

/** Invalid runtime events may be ignored or rejected, but must never authorize an action. */
function assertNotAuthorized(fixture: PreparedConsentFixture, event: ConsentHookInput): void {
  try { observeConsent(event); } catch (error) { assert.ok(error instanceof Error); }
  assert.notEqual(loadConsent(root, fixture.id).status, "approved");
  assert.throws(() => applyConsent(root, fixture.id));
  assertNoDocs();
}

test("docs: prepare emits native questions and only a matched response plus apply confirms the documents", () => {
  const fixture = docsFixture();
  assertNoDocs();
  assert.equal(hasBaseline(root), false);
  assert.deepEqual(fixture.toolInput.metadata, { source: `code-agent:${fixture.id}` });
  for (const question of fixture.questions) {
    assert.ok(!question.question.includes(fixture.id), "internal IDs belong in metadata, not user-facing questions");
    assert.equal(question.multiSelect, false);
    assert.ok(question.header.length <= 12);
    assert.ok(question.options.length >= 2 && question.options.length <= 4);
    assert.ok(question.options.every(option => option.label && option.description));
  }
  assert.throws(() => applyConsent(root, fixture.id));
  observeConsent(consentEvent(fixture, "PreToolUse"));
  assert.throws(() => applyConsent(root, fixture.id), "merely asking is not consent");
  observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
  assertNoDocs();
  applyConsent(root, fixture.id);
  const ledger = readDocLedger(root);
  assert.equal(ledger.length, 4);
  assert.ok(ledger.every(record => record.presence.verified && record.presence.channel === "claude-question"));
  assert.ok(checkProjectDocs(root, loadManifestIfAny(root)).every(entry => entry.ok));
  assert.equal(hasBaseline(root), false, "docs approval does not authorize a commit");
});

for (const field of ["session_id", "tool_use_id", "cwd"] as const) {
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    test(`transport: missing ${field} in ${event} cannot authorize docs`, () => {
      const fixture = docsFixture();
      if (event === "PostToolUse") observeConsent(consentEvent(fixture, "PreToolUse"));
      assertNotAuthorized(fixture, consentEvent(fixture, event, {
        [field]: undefined, tool_response: nativeResponse(fixture),
      }));
    });
  }
}

for (const change of ["session", "tool id", "tool name", "question", "options"] as const) {
  test(`transport: PostToolUse with a different ${change} cannot authorize docs`, () => {
    const fixture = docsFixture();
    observeConsent(consentEvent(fixture, "PreToolUse"));
    const event = consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) });
    switch (change) {
      case "session": event.session_id = "unrelated-session"; break;
      case "tool id": event.tool_use_id = "unrelated-tool"; break;
      case "tool name": event.tool_name = "Bash"; break;
      case "question": event.tool_input!.questions![0].question += " altered"; break;
      case "options": event.tool_input!.questions![0].options[0].description = "different effect"; break;
    }
    assertNotAuthorized(fixture, event);
  });
}

test("transport: a PostToolUse result without an observed PreToolUse cannot approve", () => {
  const fixture = docsFixture();
  assertNotAuthorized(fixture, consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
});

test("transport: modified questions are rejected before asking", () => {
  const fixture = docsFixture();
  const event = consentEvent(fixture, "PreToolUse");
  event.tool_input!.questions![0].options[0].label = "approve anything";
  assertNotAuthorized(fixture, event);
  assert.equal(loadConsent(root, fixture.id).binding, undefined);
});

test("transport: prefilled answers cannot establish a binding", () => {
  const fixture = docsFixture();
  assertNotAuthorized(fixture, consentEvent(fixture, "PreToolUse", {
    tool_input: { ...fixture.toolInput, answers: nativeAnswers(fixture) },
  }));
  assert.equal(loadConsent(root, fixture.id).binding, undefined);
  assertNotAuthorized(fixture, consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
});

test("transport: a wrong consent metadata source cannot bind the pending question", () => {
  const fixture = docsFixture();
  const other = prepareConsentFixture(root, { action: "docs", kind: "architecture" });
  assertNotAuthorized(fixture, consentEvent(fixture, "PreToolUse", {
    tool_input: { ...fixture.toolInput, metadata: { source: `code-agent:${other.id}` } },
  }));
  assert.equal(loadConsent(root, fixture.id).binding, undefined);
  assert.equal(loadConsent(root, other.id).binding, undefined);
});

test("transport: answers supplied in PostToolUse tool_input are not user answers", () => {
  const fixture = docsFixture();
  observeConsent(consentEvent(fixture, "PreToolUse"));
  assertNotAuthorized(fixture, consentEvent(fixture, "PostToolUse", {
    tool_input: { ...fixture.toolInput, answers: nativeAnswers(fixture) }, tool_response: {},
  }));
});

const invalidResponses: [string, (fixture: PreparedConsentFixture) => unknown][] = [
  ["missing response", () => undefined],
  ["empty answers", fixture => ({ ...nativeResponse(fixture), answers: {} })],
  ["missing echoed questions", fixture => ({ answers: nativeAnswers(fixture) })],
  ["different echoed questions", fixture => ({ ...nativeResponse(fixture), questions: [] })],
  ["timeout response", fixture => ({ ...nativeResponse(fixture), response: "timeout" })],
  ["afk timeout", fixture => ({ ...nativeResponse(fixture), afkTimeoutMs: 1000 })],
  ["followUp response", fixture => ({ ...nativeResponse(fixture), followUp: true })],
  ["annotations alone", fixture => ({ questions: fixture.questions, annotations: nativeAnswers(fixture) })],
  ["qualifying annotation", fixture => ({ ...nativeResponse(fixture), annotations: { [fixture.questions[0].question]: { notes: "Only after changing the scope" } } })],
  ["annotation object as answer", fixture => ({ ...nativeResponse(fixture), answers: { [fixture.questions[0].question]: { label: ACCEPT_CONSENT, annotation: "suggested" } } })],
  ["unrecognized free text", fixture => ({ ...nativeResponse(fixture), answers: { [fixture.questions[0].question]: "probably yes" } })],
  ["empty answer", fixture => ({ ...nativeResponse(fixture), answers: { [fixture.questions[0].question]: "" } })],
  ["extra answer", fixture => ({ ...nativeResponse(fixture), answers: { ...nativeAnswers(fixture), "unasked question": ACCEPT_CONSENT } })],
];
for (const [name, response] of invalidResponses) {
  test(`transport: ${name} does not authorize an action`, () => {
    const fixture = docsFixture();
    observeConsent(consentEvent(fixture, "PreToolUse"));
    assertNotAuthorized(fixture, consentEvent(fixture, "PostToolUse", { tool_response: response(fixture) }));
  });
}

test("replay: an incomplete result cannot be repaired by replaying the same tool call", () => {
  const fixture = docsFixture();
  observeConsent(consentEvent(fixture, "PreToolUse"));
  assertNotAuthorized(fixture, consentEvent(fixture, "PostToolUse", {
    tool_response: { ...nativeResponse(fixture), answers: {} },
  }));
  assertNotAuthorized(fixture, consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
  assertNotAuthorized(fixture, consentEvent(fixture, "PreToolUse"));
});

test("transport: an ordinary question with an affirmative answer does not consume pending consent", () => {
  const fixture = docsFixture();
  const ordinary = structuredClone(fixture.questions);
  ordinary[0].question = "Which framework should we use?";
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    observeConsent(consentEvent(fixture, event, {
      tool_input: { questions: ordinary }, tool_response: { answers: { [ordinary[0].question]: ACCEPT_CONSENT } },
    }));
  }
  assert.equal(loadConsent(root, fixture.id).status, "pending");
  assert.equal(loadConsent(root, fixture.id).observed, undefined);
  assert.throws(() => applyConsent(root, fixture.id));
  assertNoDocs();
});

for (const label of [DEFER_CONSENT, "수정 요청"]) {
  test(`cancellation: ${label} cannot later be replayed as approval`, () => {
    const fixture = docsFixture();
    const before = readFileSync(join(root, "doc/architecture.md"));
    observeConsentFixture(fixture, label);
    assert.throws(() => applyConsent(root, fixture.id));
    assertNotAuthorized(fixture, consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
    assertNotAuthorized(fixture, consentEvent(fixture, "PreToolUse", { tool_use_id: "replacement-call" }));
    assert.deepEqual(readFileSync(join(root, "doc/architecture.md")), before);
    assert.equal(hasBaseline(root), false);
  });
}

test("replay: duplicate PostToolUse cannot create another observation or decision", () => {
  const fixture = docsFixture();
  observeConsentFixture(fixture);
  const count = loadConsent(root, fixture.id).observed!.length;
  try { observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) })); }
  catch (error) { assert.ok(error instanceof Error); }
  assert.equal(loadConsent(root, fixture.id).observed!.length, count);
  applyConsent(root, fixture.id);
  assert.equal(readDocLedger(root).length, 4);
});

test("replay: an applied consent returns its cached result without another decision", () => {
  const fixture = approveAndApplyFixture(root, { action: "docs" });
  const before = readFileSync(join(root, ".code-agent/approvals/docs.jsonl"));
  assert.equal(applyConsent(root, fixture.id), fixture.result);
  assert.deepEqual(readFileSync(join(root, ".code-agent/approvals/docs.jsonl")), before);
});

test("session guard: apply is allowed only from the session whose answer was observed", () => {
  const fixture = docsFixture();
  observeConsentFixture(fixture);
  const command = `code-agent consent apply ${fixture.id}`;
  assert.ok(consentCommandGuard(root, command));
  assert.ok(consentCommandGuard(root, command, "wrong-session"));
  assert.equal(consentCommandGuard(root, command, fixture.sessionId), undefined);
  for (const tool_name of ["Bash", "PowerShell"]) {
    assert.ok(guardTool({ cwd: root, tool_name, tool_input: { command }, session_id: "wrong-session" }));
    assert.equal(guardTool({ cwd: root, tool_name, tool_input: { command }, session_id: fixture.sessionId }), undefined);
    assert.ok(guardTool({ cwd: root, tool_name, tool_input: { command: "code-agent consent-event" }, session_id: fixture.sessionId }));
  }
  assertNoDocs();
});

test("transport: a custom main agent may confirm, but a subagent cannot", () => {
  const fixture = docsFixture();
  assertNotAuthorized(fixture, consentEvent(fixture, "PreToolUse", { agent_id: "child", agent_type: "ca-implementer" }));
  observeConsent(consentEvent(fixture, "PreToolUse", { agent_type: "custom-main" }));
  observeConsent(consentEvent(fixture, "PostToolUse", { agent_type: "custom-main", tool_response: nativeResponse(fixture) }));
  applyConsent(root, fixture.id);
  assert.equal(readDocLedger(root).length, 4);
});

for (const phase of ["before asking", "while answering", "before applying"] as const) {
  test(`snapshot: a file change ${phase} invalidates consent without writing a ledger`, () => {
    const fixture = docsFixture();
    if (phase !== "before asking") observeConsent(consentEvent(fixture, "PreToolUse"));
    if (phase === "before applying") {
      observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
    }
    writeFixture(root, "doc/architecture.md", readFileSync(join(root, "doc/architecture.md"), "utf8") + "\nChanged after preview.\n");
    if (phase === "before asking") assertNotAuthorized(fixture, consentEvent(fixture, "PreToolUse"));
    else if (phase === "while answering") assertNotAuthorized(fixture, consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
    else { assert.throws(() => applyConsent(root, fixture.id)); assertNoDocs(); }
    assert.equal(hasBaseline(root), false);
    // 세 시점 모두 그 동의를 대상 변경으로 폐기한다(응답 관찰 Pre·Post, 적용)
    const record = loadConsent(root, fixture.id);
    assert.equal(record.status, "failed");
    assert.equal(record.failure?.class, "consent-target-changed");
    assert.equal(record.failure?.kind, "target");
    assert.match(record.failure?.detail ?? "", /^확인 대상 변경: 파일 "doc\/architecture\.md"/);
  });
}

for (const change of ["index", "HEAD", "branch"] as const) {
  test(`snapshot: changed ${change} invalidates consent even when working file bytes stay the same`, () => {
    gitFixture(root, "add", "."); gitFixture(root, "commit", "-qm", "initial");
    writeFixture(root, "README.md", "unchanged during consent\n");
    const fixture = docsFixture();
    observeConsentFixture(fixture);
    const bytes = readFileSync(join(root, "README.md"));
    if (change === "index") gitFixture(root, "add", "README.md");
    if (change === "HEAD") gitFixture(root, "commit", "--allow-empty", "-qm", "concurrent commit");
    if (change === "branch") gitFixture(root, "switch", "-q", "-c", "another-branch");
    const head = gitFixture(root, "rev-parse", "HEAD");
    const index = gitFixture(root, "diff", "--cached", "--binary");
    assert.deepEqual(readFileSync(join(root, "README.md")), bytes);
    assert.throws(() => applyConsent(root, fixture.id));
    assertNoDocs();
    assert.equal(gitFixture(root, "rev-parse", "HEAD"), head);
    assert.equal(gitFixture(root, "diff", "--cached", "--binary"), index);
  });
}
