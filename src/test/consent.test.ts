import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { applyConsent, consentCommandGuard, finishConsent, loadConsent, observeConsent } from "../agent/consent";
import type { ConsentHookInput } from "../agent/consent";
import { hasBaseline } from "../agent/bootstrap";
import { checkProjectDocs, readDocLedger } from "../agent/docs";
import { deliveryPaths } from "../agent/deliver";
import { decide as guardTool } from "../agent/hook";
import { loadActive } from "../agent/layout";
import { modelOf } from "../agent/models";
import { loadRequestSession, readRequestLedger, requestState } from "../agent/request";
import { approvalOf, loadManifestIfAny, loadWork } from "../agent/work";
import { hashPlan, readLedger } from "../core/approval";
import {
  ACCEPT_CONSENT, CONSENT_SPEC, CONSENT_WORK_ID, DEFER_CONSENT,
  approveAndApplyFixture, consentEvent, gitFixture, nativeAnswers, nativeResponse, observeConsentFixture,
  prepareConsentFixture, prepareDeliveryFixture, preparePlanFixture, setupConsentProject,
  submitConsentRequest, writeFixture,
} from "./consentFixture";
import type { PreparedConsentFixture } from "./consentFixture";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-consent-")));
  setupConsentProject(root);
});
afterEach(() => {
  // Resolve and constrain the recursive cleanup to this test's newly allocated temp directory.
  const target = resolve(root);
  const temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-consent-"));
  rmSync(target, { recursive: true, force: true });
});

function docsFixture(): PreparedConsentFixture { return prepareConsentFixture(root, { action: "docs" }); }

test("finish는 응답 전에는 status와 같고, 승인이 관찰된 뒤에만 한 번에 적용한다", () => {
  const fixture = docsFixture();
  const pending = JSON.parse(finishConsent(root, fixture.id));
  assert.equal(pending.status, "pending");
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
function assertNoDocs(): void { assert.equal(readDocLedger(root).length, 0); }

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

test("setup: one observed confirmation confirms POLICY and creates only the preparation baseline", () => {
  writeFixture(root, "src/not-ready.js", "throw Error('must not run');\n");
  writeFixture(root, "doc/work/private/raw.txt", "unconfirmed original\n");
  const fixture = prepareConsentFixture(root, { action: "setup" });
  assertNoDocs();
  assert.equal(hasBaseline(root), false);
  observeConsentFixture(fixture);
  assert.equal(hasBaseline(root), false);
  applyConsent(root, fixture.id);
  assert.equal(readDocLedger(root).length, 4);
  assert.equal(gitFixture(root, "rev-list", "--count", "HEAD"), "1");
  const committed = gitFixture(root, "ls-tree", "-r", "--name-only", "HEAD");
  assert.match(committed, /code-agent\.json/);
  assert.match(committed, /doc\/architecture\.md/);
  assert.doesNotMatch(committed, /not-ready|raw\.txt|consents\//);
  assert.equal(loadConsent(root, fixture.id).status, "applied");
});

test("baseline: successful consent commits preparation files without confirming docs", () => {
  approveAndApplyFixture(root, { action: "baseline" });
  assert.equal(hasBaseline(root), true);
  assert.equal(gitFixture(root, "rev-list", "--count", "HEAD"), "1");
  assertNoDocs();
});

test("H1: 기존 커밋이 있어도 setup 동의에 도입 커밋을 표시하고 승인 후 반영한다", () => {
  writeFixture(root, "existing.txt", "existing\n");
  gitFixture(root, "add", "existing.txt"); gitFixture(root, "commit", "-qm", "existing repository");
  const fixture = prepareConsentFixture(root, { action: "setup" });
  assert.match(loadConsent(root, fixture.id).summary, /준비 커밋|도입 파일/);
  assert.equal(gitFixture(root, "rev-list", "--count", "HEAD"), "1");
  observeConsentFixture(fixture); applyConsent(root, fixture.id);
  assert.equal(gitFixture(root, "rev-list", "--count", "HEAD"), "2");
  assert.match(gitFixture(root, "ls-tree", "-r", "--name-only", "HEAD"), /code-agent\.json/);
  assert.equal(readDocLedger(root).length, 4);
});

test("baseline: cancellation and a newly staged file leave HEAD absent and preserve the index", () => {
  const cancelled = prepareConsentFixture(root, { action: "baseline" });
  observeConsentFixture(cancelled, DEFER_CONSENT);
  assert.throws(() => applyConsent(root, cancelled.id));
  assert.equal(hasBaseline(root), false);
  const fixture = prepareConsentFixture(root, { action: "baseline" });
  observeConsentFixture(fixture);
  gitFixture(root, "add", "code-agent.json");
  const staged = gitFixture(root, "diff", "--cached", "--binary");
  assert.throws(() => applyConsent(root, fixture.id));
  assert.equal(hasBaseline(root), false);
  assert.equal(gitFixture(root, "diff", "--cached", "--binary"), staged);
});

test("request: preparation and observation preserve the original; apply records its exact hash", () => {
  submitConsentRequest(root);
  const before = readFileSync(join(root, CONSENT_SPEC));
  const fixture = prepareConsentFixture(root, { action: "request", id: CONSENT_WORK_ID });
  assert.equal(requestState(root, CONSENT_WORK_ID, CONSENT_SPEC).status, "none");
  observeConsentFixture(fixture);
  assert.equal(readRequestLedger(root, CONSENT_WORK_ID).length, 0);
  applyConsent(root, fixture.id);
  assert.equal(requestState(root, CONSENT_WORK_ID, CONSENT_SPEC).status, "confirmed");
  assert.deepEqual(readFileSync(join(root, CONSENT_SPEC)), before);
  const records = readRequestLedger(root, CONSENT_WORK_ID);
  assert.equal(records.length, 1);
  assert.equal(records[0].presence.channel, "claude-question");
  assert.equal(records[0].presence.verified, true);
  assert.equal(loadActive(root), undefined, "confirming requirements does not implicitly start work");
});

test("request: changed requirements invalidate a previously observed answer", () => {
  submitConsentRequest(root);
  const fixture = prepareConsentFixture(root, { action: "request", id: CONSENT_WORK_ID });
  observeConsentFixture(fixture);
  writeFixture(root, CONSENT_SPEC, readFileSync(join(root, CONSENT_SPEC), "utf8") + "\nNew requirement.\n");
  assert.throws(() => applyConsent(root, fixture.id));
  assert.equal(readRequestLedger(root, CONSENT_WORK_ID).length, 0);
});

test("request: cancellation leaves intake open without creating a request decision", () => {
  submitConsentRequest(root);
  const fixture = prepareConsentFixture(root, { action: "request", id: CONSENT_WORK_ID });
  observeConsentFixture(fixture, DEFER_CONSENT);
  assert.throws(() => applyConsent(root, fixture.id));
  assert.equal(readRequestLedger(root, CONSENT_WORK_ID).length, 0);
  assert.equal(loadRequestSession(root)?.id, CONSENT_WORK_ID);
  assert.equal(requestState(root, CONSENT_WORK_ID, CONSENT_SPEC).status, "none");
});

test("request: an explicitly confirmed rejection retains its reason instead of approving", () => {
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID, decision: "reject", comment: "범위를 줄여 주세요" });
  const state = requestState(root, CONSENT_WORK_ID, CONSENT_SPEC);
  assert.equal(state.status, "rejected");
  assert.equal(readRequestLedger(root, CONSENT_WORK_ID)[0].comment, "범위를 줄여 주세요");
});

test("model: applying observed consent changes only the selected agent", () => {
  writeFixture(root, ".claude/agents/ca-writer.md", "---\nname: ca-writer\nmodel: opus\n---\nWriter instructions.\n");
  const fixture = prepareConsentFixture(root, { action: "model", agent: "writer", model: "sonnet" });
  assert.equal(modelOf(root, "writer"), "opus");
  observeConsentFixture(fixture);
  assert.equal(modelOf(root, "writer"), "opus");
  applyConsent(root, fixture.id);
  assert.equal(modelOf(root, "writer"), "sonnet");
  assert.equal(modelOf(root, "reviewer"), "opus");
  assert.match(readFileSync(join(root, ".claude/agents/ca-writer.md"), "utf8"), /model: sonnet/);
});

test("abort: only apply closes intake, preserving requirements and their approval", () => {
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  const before = readFileSync(join(root, CONSENT_SPEC));
  const fixture = prepareConsentFixture(root, { action: "abort" });
  observeConsentFixture(fixture);
  assert.equal(loadRequestSession(root)?.id, CONSENT_WORK_ID);
  applyConsent(root, fixture.id);
  assert.equal(loadRequestSession(root), undefined);
  assert.deepEqual(readFileSync(join(root, CONSENT_SPEC)), before);
  assert.equal(requestState(root, CONSENT_WORK_ID, CONSENT_SPEC).status, "confirmed");
});

test("plan: real consent records the submitted snapshot and all approval bindings", () => {
  preparePlanFixture(root);
  const work = loadWork(root)!;
  assert.equal(approvalOf(work).status, "none");
  const fixture = prepareConsentFixture(root, { action: "plan" });
  observeConsentFixture(fixture);
  assert.equal(readLedger(root, CONSENT_WORK_ID).length, 0);
  applyConsent(root, fixture.id);
  const [record] = readLedger(root, CONSENT_WORK_ID);
  assert.equal(record.planHash, hashPlan(work.plan!));
  assert.ok(record.docsHash && record.manifestHash && record.orderHash);
  assert.deepEqual(JSON.parse(readFileSync(join(root, record.snapshot), "utf8")), work.plan);
  assert.equal(approvalOf(loadWork(root)!).status, "approved");
  assert.equal(loadActive(root)?.phase, "plan", "approval does not bypass next's implementation gates");
});

test("plan: a changed supporting document cannot receive the prepared approval", () => {
  preparePlanFixture(root);
  const fixture = prepareConsentFixture(root, { action: "plan" });
  observeConsentFixture(fixture);
  const doc = `doc/work/${CONSENT_WORK_ID}/03-design.md`;
  writeFixture(root, doc, readFileSync(join(root, doc), "utf8") + "\nDifferent design.\n");
  assert.throws(() => applyConsent(root, fixture.id));
  assert.equal(readLedger(root, CONSENT_WORK_ID).length, 0);
});

test("deliver: commits approved docs and validated work once, preserving unrelated staged evidence", async () => {
  await prepareDeliveryFixture(root);
  const unrelated = ".code-agent/work/OTHER-1/other.verify.json";
  writeFixture(root, unrelated, '{"work":"OTHER-1","unrelated":true}\n');
  gitFixture(root, "add", "--", unrelated);
  const staged = gitFixture(root, "ls-files", "--stage", "--", unrelated);
  const docsLedger = ".code-agent/approvals/docs.jsonl";
  const approvedDocs = readFileSync(join(root, docsLedger), "utf8");
  const paths = deliveryPaths(loadWork(root)!);
  assert.ok(paths.includes(docsLedger));
  assert.ok(!paths.includes(unrelated));
  const before = gitFixture(root, "rev-parse", "HEAD");
  const fixture = prepareConsentFixture(root, { action: "deliver" });
  assert.ok(fixture.questions.some(question => question.question.includes(docsLedger)), "final confirmation shows the docs ledger it will commit");
  assert.equal(gitFixture(root, "rev-parse", "HEAD"), before);
  observeConsentFixture(fixture);
  assert.equal(gitFixture(root, "rev-parse", "HEAD"), before);
  const result = applyConsent(root, fixture.id);
  const commit = gitFixture(root, "rev-parse", "HEAD");
  assert.notEqual(commit, before);
  assert.equal(gitFixture(root, "rev-list", "--count", `${before}..HEAD`), "1");
  assert.equal(loadActive(root), undefined);
  const files = gitFixture(root, "show", "--format=", "--name-only", "HEAD");
  for (const file of ["src/value.js", "tests/value.test.js", `doc/work/${CONSENT_WORK_ID}/10-pr.md`, docsLedger]) assert.ok(files.split(/\r?\n/).includes(file));
  assert.equal(gitFixture(root, "show", `HEAD:${docsLedger}`), approvedDocs.trim());
  assert.ok(!files.split(/\r?\n/).includes(unrelated));
  assert.equal(gitFixture(root, "ls-files", "--stage", "--", unrelated), staged);
  assert.equal(gitFixture(root, "diff", "--cached", "--name-only"), unrelated);
  assert.doesNotMatch(files, /\.code-agent\/consents\//);
  assert.equal(applyConsent(root, fixture.id), result);
  assert.equal(gitFixture(root, "rev-parse", "HEAD"), commit);
});

test("deliver: cancellation and changed code preserve HEAD, index and active work", async () => {
  await prepareDeliveryFixture(root);
  const before = gitFixture(root, "rev-parse", "HEAD");
  const cancelled = prepareConsentFixture(root, { action: "deliver" });
  observeConsentFixture(cancelled, DEFER_CONSENT);
  assert.throws(() => applyConsent(root, cancelled.id));
  assert.equal(gitFixture(root, "rev-parse", "HEAD"), before);
  assert.equal(loadActive(root)?.phase, "deliver");
  const fixture = prepareConsentFixture(root, { action: "deliver" });
  observeConsentFixture(fixture);
  writeFixture(root, "src/value.js", "module.exports=()=>999;\n");
  const index = gitFixture(root, "diff", "--cached", "--binary");
  assert.throws(() => applyConsent(root, fixture.id));
  assert.equal(gitFixture(root, "rev-parse", "HEAD"), before);
  assert.equal(gitFixture(root, "diff", "--cached", "--binary"), index);
  assert.equal(loadActive(root)?.phase, "deliver");
  assert.ok(existsSync(join(root, `doc/work/${CONSENT_WORK_ID}/10-pr.md`)));
});
