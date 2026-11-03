import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyConsent, finishConsent, loadConsent } from "../agent/consent";
import { hasBaseline } from "../agent/bootstrap";
import { readDocLedger } from "../agent/docs";
import { loadActive } from "../agent/layout";
import { claudeModelOf, modelOf } from "../agent/models";
import { loadRequestSession, readRequestLedger, requestState } from "../agent/request";
import { CONSENT_SPEC, CONSENT_WORK_ID, DEFER_CONSENT, approveAndApplyFixture, confirmationText, gitFixture, observeConsentFixture, prepareConsentFixture, submitConsentRequest, writeFixture } from "./consentFixture";

import { root, assertNoDocs } from "./consentLifecycleFixture";

import "./consentLifecycleFixture";
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
  assert.equal(loadActive(root), undefined, "apply 만으로는 시작하지 않는다 — 시작은 finish 가 잇는다");
});

test("request: finish 로 확정을 적용하면 접수 세션의 기준으로 작업을 시작한다 — start 왕복이 없다", () => {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  const fixture = prepareConsentFixture(root, { action: "request", id: CONSENT_WORK_ID });
  assert.match(confirmationText(fixture), /확정을 적용하면 작업을 시작합니다 — 작업 브랜치 feature\/CONSENT-1 를 master 에서 만들고 분석 단계로 갑니다/);
  observeConsentFixture(fixture);
  const applied = JSON.parse(finishConsent(root, fixture.id));
  assert.equal(applied.phase, "analysis");
  assert.match(applied.started, /^시작했습니다: CONSENT-1 /);
  assert.doesNotMatch(applied.started, /^다음:/m, "지금 할 일은 next 하나가 말한다");
  assert.equal(loadActive(root)?.phase, "analysis");
  assert.equal(gitFixture(root, "branch", "--show-current"), "feature/CONSENT-1");
  assert.equal(loadRequestSession(root), undefined, "접수 세션을 닫았다");
  const again = JSON.parse(finishConsent(root, fixture.id));
  assert.equal(again.phase, "analysis");
  assert.equal(again.started, undefined, "다시 불러도 다시 시작하지 않는다");
  const midWork = prepareConsentFixture(root, { action: "request", id: CONSENT_WORK_ID });
  assert.doesNotMatch(confirmationText(midWork), /작업을 시작합니다/, "진행 중인 작업의 재확정은 시작하지 않는다");
});

test("request: 시작이 막히면 확정만 남기고 막힌 사유와 다시 시작할 명령을 돌려준다", () => {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  writeFixture(root, "src/stray.js", "module.exports = 0;\n");
  const fixture = prepareConsentFixture(root, { action: "request", id: CONSENT_WORK_ID });
  assert.match(confirmationText(fixture), /시작 전 정리 필요: \[A\] src\/stray\.js — 이대로면 확정만 남고 시작은 막힙니다/);
  observeConsentFixture(fixture);
  const applied = JSON.parse(finishConsent(root, fixture.id));
  assert.equal(applied.status, "applied");
  assert.equal(applied.phase, undefined);
  assert.match(applied.startBlocked, /커밋하지 않은 변경이 있어 시작하지 않았습니다/);
  assert.match(applied.next, new RegExp(`code-agent start ${CONSENT_SPEC}$`));
  assert.equal(requestState(root, CONSENT_WORK_ID, CONSENT_SPEC).status, "confirmed");
  assert.equal(loadActive(root), undefined);
  assert.equal(loadRequestSession(root)?.id, CONSENT_WORK_ID, "접수는 열린 채로 남는다");
  assert.equal(gitFixture(root, "branch", "--show-current"), "master");
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
  const fixture = approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID, decision: "reject", comment: "범위를 줄여 주세요" });
  const state = requestState(root, CONSENT_WORK_ID, CONSENT_SPEC);
  assert.equal(state.status, "rejected");
  assert.equal(readRequestLedger(root, CONSENT_WORK_ID)[0].comment, "범위를 줄여 주세요");
  assert.doesNotMatch(confirmationText(fixture), /작업을 시작합니다/);
  assert.equal(JSON.parse(finishConsent(root, fixture.id)).started, undefined, "반려는 시작하지 않는다");
  assert.equal(loadActive(root), undefined);
});

test("model: applying observed consent changes only the selected agent", () => {
  writeFixture(root, ".claude/agents/ca-writer.md", "---\nname: ca-writer\nmodel: sonnet\neffort: medium\n---\nWriter instructions.\n");
  const fixture = prepareConsentFixture(root, { action: "model", agent: "writer", model: "opus", reasoning: "low" });
  assert.equal(modelOf(root, "writer"), "sonnet");
  observeConsentFixture(fixture);
  assert.equal(modelOf(root, "writer"), "sonnet");
  applyConsent(root, fixture.id);
  assert.equal(modelOf(root, "writer"), "opus");
  assert.deepEqual(claudeModelOf(root, "writer"), { model: "opus", effort: "low" });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".code-agent/models.json"), "utf8")), { writer: "opus", effort: { writer: "low" } });
  assert.equal(modelOf(root, "reviewer"), "opus");
  const writer = readFileSync(join(root, ".claude/agents/ca-writer.md"), "utf8");
  assert.match(writer, /^model: opus$/m);
  assert.match(writer, /^effort: low$/m);
});

test("model: all 은 모델만 바꾸고 역할별 강도를 유지하며, default 는 모델·강도를 함께 되돌린다", () => {
  for (const agent of ["writer", "reviewer"]) writeFixture(root, `.claude/agents/ca-${agent}.md`, `---\nname: ca-${agent}\nmodel: x\n---\n본문\n`);
  approveAndApplyFixture(root, { action: "model", host: "claude", agent: "all", model: "opus" });
  assert.deepEqual(claudeModelOf(root, "writer"), { model: "opus", effort: "medium" });
  assert.deepEqual(claudeModelOf(root, "reviewer"), { model: "opus", effort: "high" });
  const file = () => JSON.parse(readFileSync(join(root, ".code-agent/models.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(file(), { surveyor: "opus", explorer: "opus", writer: "opus", implementer: "opus", tester: "opus" });
  assert.ok(Object.values(file()).every((value) => typeof value === "string"));
  approveAndApplyFixture(root, { action: "model", host: "claude", agent: "reviewer", model: "opus", reasoning: "max" });
  assert.deepEqual(file().effort, { reviewer: "max" });
  assert.equal("reviewer" in file(), false);
  assert.match(readFileSync(join(root, ".claude/agents/ca-reviewer.md"), "utf8"), /^effort: max$/m);
  approveAndApplyFixture(root, { action: "model", host: "claude", agent: "all", model: "default" });
  assert.deepEqual(file(), {});
  assert.match(readFileSync(join(root, ".claude/agents/ca-writer.md"), "utf8"), /^model: sonnet\neffort: medium\n---/m);
});

test("model: 동의 스냅샷은 모델 정책을 묶는다 — 정책 상태가 없는 이전 동의는 다시 준비하게 된다", () => {
  const fixture = prepareConsentFixture(root, { action: "model", host: "claude", agent: "writer", model: "opus" });
  assert.ok("모델 정책" in loadConsent(root, fixture.id).snapshotEntries!.state);
  observeConsentFixture(fixture);
  const record = loadConsent(root, fixture.id);
  delete record.snapshotEntries!.state["모델 정책"];
  record.snapshot = "0".repeat(64);
  writeFixture(root, `.code-agent/consents/${fixture.id}.json`, JSON.stringify(record));
  assert.throws(() => applyConsent(root, fixture.id), /변경 대상: .*모델 정책\n이 동의를 준비한 code-agent와 지금 code-agent의 모델 정책이 다릅니다\. .*PATH의 code-agent와 hook 명령이 같은 설치본인지/);
  assert.equal(existsSync(join(root, ".code-agent/models.json")), false);
});

test("동의 스냅샷: 모델 정책이 아닌 변경에는 설치본 안내를 붙이지 않는다", () => {
  const fixture = prepareConsentFixture(root, { action: "model", host: "claude", agent: "writer", model: "opus" });
  observeConsentFixture(fixture);
  writeFixture(root, "doc/extra.md", "바뀐 문서\n");
  assert.throws(() => applyConsent(root, fixture.id), (error: unknown) =>
    error instanceof Error && /변경 대상: 파일 "doc\/extra\.md"/.test(error.message) && !error.message.includes("설치본"));
});

test("model: 강도를 받지 않는 모델에 강도를 함께 준비하면 미리보기에서 거부한다", () => {
  assert.throws(() => prepareConsentFixture(root, { action: "model", host: "claude", agent: "reviewer", model: "haiku", reasoning: "high" }), /받지 않습니다/);
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
