import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyConsent, consentSnapshot, consentStatus, loadConsent, observeConsent } from "../agent/consent";
import { readDocLedger } from "../agent/docs";
import { CONSENT_WORK_ID, DEFER_CONSENT, approveAndApplyFixture, consentEvent, nativeResponse, observeConsentFixture, prepareConsentFixture, submitConsentRequest, writeFixture } from "./consentFixture";
import { root, codexReply, prepared, touchDoc } from "./consentBindingFixture";

import "./consentBindingFixture";
test("T-RP-1·T-RP-2 대상 변경은 동의를 폐기하고 되돌려도 다시 적용하지 않는다", () => {
  const first = prepareConsentFixture(root, { action: "docs" });
  touchDoc();
  assert.throws(() => observeConsent(consentEvent(first, "PreToolUse")), /확인 대상이 바뀌었습니다/);
  const record = loadConsent(root, first.id);
  assert.equal(record.status, "failed");
  assert.deepEqual([record.failure?.class, record.failure?.kind], ["consent-target-changed", "target"]);
  assert.match(record.failure!.detail, /^확인 대상 변경:.*doc\/architecture\.md/);
  const before = readFileSync(join(root, "doc/architecture.md"), "utf8");
  const second = prepareConsentFixture(root, { action: "docs" });
  observeConsentFixture(second);
  writeFixture(root, "doc/architecture.md", before + "x");
  assert.throws(() => applyConsent(root, second.id), /확인 이후/);
  assert.equal(loadConsent(root, second.id).status, "failed");
  writeFixture(root, "doc/architecture.md", before);
  assert.throws(() => applyConsent(root, second.id), /이미 응답했거나|명시적으로 확인한 응답이 없습니다/);
  assert.equal(readDocLedger(root).length, 0);
});

test("T-RP-3 응답 갈래 — 명시적 선택 없음·선택지 밖·수정 요청·보류마다 갈래와 안내가 다르다", () => {
  const timeout = prepareConsentFixture(root, { action: "docs" });
  observeConsent(consentEvent(timeout, "PreToolUse"));
  assert.throws(() => observeConsent(consentEvent(timeout, "PostToolUse", { tool_response: { ...nativeResponse(timeout), afkTimeoutMs: 1000 } })));
  const none = JSON.parse(consentStatus(root, timeout.id)).failure;
  assert.equal(loadConsent(root, timeout.id).status, "failed");
  assert.equal(none.kind, "response-none");
  assert.match(none.detail, /^응답: 명시적 선택 없음/);
  assert.match(none.guide, /다시 묻지 않습니다/);
  const free = prepareConsentFixture(root, { action: "docs" });
  observeConsent(consentEvent(free, "PreToolUse"));
  assert.throws(() => observeConsent(consentEvent(free, "PostToolUse", { tool_response: { ...nativeResponse(free), answers: { [free.questions[0].question]: "아마도" } } })));
  assert.equal(loadConsent(root, free.id).failure?.kind, "response-invalid");
  const change = prepareConsentFixture(root, { action: "docs" });
  observeConsentFixture(change, "수정 요청");
  const changed = JSON.parse(consentStatus(root, change.id));
  assert.equal(changed.status, "changes-requested");
  assert.equal(changed.failure.kind, "response-change");
  assert.match(changed.failure.guide, /고칠지 업무 질문으로/);
  for (let index = 0; index < 2; index++) {
    const defer = prepareConsentFixture(root, { action: "docs" });
    observeConsentFixture(defer, DEFER_CONSENT);
    const deferred = JSON.parse(consentStatus(root, defer.id));
    assert.equal(deferred.status, "deferred");
    assert.equal(deferred.failure.kind, "response-defer");
    assert.match(deferred.failure.guide, /다시 묻지 않습니다/);
    assert.doesNotMatch(deferred.failure.guide, /새로 준비해 다시 확인/);
  }
  assert.equal(prepared({ action: "docs" }).warning, undefined, "보류는 외부 변경의 징후가 아니다 — 대상 변경만 센다");
});

test("T-RP-4 같은 동작이 연속 두 번 대상 변경으로 폐기되면 준비 결과에 경고가 붙는다", () => {
  const discardOnce = () => {
    const fixture = prepareConsentFixture(root, { action: "docs" });
    touchDoc();
    assert.throws(() => observeConsent(consentEvent(fixture, "PreToolUse")));
  };
  discardOnce();
  assert.equal(prepared({ action: "docs" }).warning, undefined, "한 번은 경고하지 않는다");
  discardOnce();
  discardOnce();
  const third = prepared({ action: "docs" });
  assert.match(third.warning ?? "", /연속 2회 대상 변경/);
  assert.match(third.warning ?? "", /doc\/architecture\.md/);
});

test("T-RP-5 상태 출력의 failure — 이전 기록에는 키가 없다", () => {
  const fixture = prepareConsentFixture(root, { action: "docs" });
  touchDoc();
  assert.throws(() => observeConsent(consentEvent(fixture, "PreToolUse")));
  const status = JSON.parse(consentStatus(root, fixture.id));
  assert.deepEqual([status.failure.class, status.failure.kind], ["consent-target-changed", "target"]);
  assert.match(status.failure.guide, /새로 준비해 다시 확인받으세요/);
  const legacy = prepareConsentFixture(root, { action: "docs", kind: "architecture" });
  const file = join(root, ".code-agent/consents", `${legacy.id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "failed" }));
  assert.equal("failure" in JSON.parse(consentStatus(root, legacy.id)), false);
});

test("T-RP-6 살아 있는 주인의 동의 잠금은 2초 기다린 뒤 pid 를 알린다", () => {
  const fixture = prepareConsentFixture(root, { action: "docs" });
  observeConsentFixture(fixture);
  writeFileSync(join(root, ".code-agent/consents/apply.lock"), JSON.stringify({ pid: process.pid, host: hostname(), at: "t" }));
  const started = Date.now();
  assert.throws(() => applyConsent(root, fixture.id), new RegExp(`pid ${process.pid}.*한 번 다시 실행`));
  assert.ok(Date.now() - started >= 1900);
});

test("T-RP-7 hook·CLI 로그와 작업 임대는 열린 동의를 깨지 않고, 업무 답 기록은 깬다", () => {
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  const { id } = prepared({ action: "abort" }, { id: "MAIN", host: "codex" });
  const before = consentSnapshot(root, loadConsent(root, id).action);
  for (const file of [".code-agent/log/prompts.jsonl", ".code-agent/log/codex-tools.json", ".code-agent/log/stages.jsonl", ".code-agent/lease.json"]) writeFixture(root, file, "{}\n");
  assert.equal(consentSnapshot(root, loadConsent(root, id).action), before);
  codexReply(id, "MAIN");
  assert.equal(loadConsent(root, id).status, "approved");
  const other = prepared({ action: "abort" }, { id: "MAIN", host: "codex" });
  writeFixture(root, `.code-agent/work/${CONSENT_WORK_ID}/answers.jsonl`, "{\"type\":\"ask\"}\n");
  assert.throws(() => codexReply(other.id, "MAIN"), /확인 대상이 바뀌었습니다/);
  assert.equal(loadConsent(root, other.id).failure?.kind, "target");
  assert.match(loadConsent(root, other.id).failure!.detail, /answers\.jsonl/);
});

test("T-RP-8 적용 때 확인 화면 불일치 — 첫 확인 전이면 대상 변경, 앞선 확인 뒤면 적용 실패", () => {
  const edit = (id: string, index: number) => {
    const file = join(root, ".code-agent/consents", `${id}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.confirmations[index].shown += "\n(업그레이드로 바뀐 화면)";
    writeFileSync(file, JSON.stringify(record));
  };
  const setup = prepareConsentFixture(root, { action: "setup" });
  observeConsentFixture(setup);
  edit(setup.id, 1);
  assert.throws(() => applyConsent(root, setup.id), /확인한 내용과 실행할 내용이 다릅니다/);
  assert.equal(loadConsent(root, setup.id).failure?.kind, "apply");
  assert.match(loadConsent(root, setup.id).failure!.detail, /앞선 확인 1건 통과 뒤/);
});

test("T-RP-8b 첫 확인 전 화면 불일치는 대상 변경이다(업그레이드로 바뀐 기준 커밋 확인 화면)", () => {
  const fixture = prepareConsentFixture(root, { action: "baseline" });
  observeConsentFixture(fixture);
  const file = join(root, ".code-agent/consents", `${fixture.id}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.confirmations[0].shown += "\n(업그레이드로 바뀐 화면)";
  writeFileSync(file, JSON.stringify(record));
  assert.throws(() => applyConsent(root, fixture.id), /확인한 내용과 실행할 내용이 다릅니다/);
  assert.deepEqual([loadConsent(root, fixture.id).status, loadConsent(root, fixture.id).failure?.kind, loadConsent(root, fixture.id).failure?.detail],
    ["failed", "target", "확인 대상 변경: 확인 화면"]);
});

// ---- Codex 확인 코드 ----

test("T-5-1·T-5-2·T-5-3 Codex 응답은 확인 코드를 요구하고, 이전 형식 기록은 코드 없이도 받는다", () => {
  const record = prepared({ action: "docs" });
  assert.match(record.codexReply!.format, /<확인 코드>$/);
  assert.match(record.codexReply!.questions.at(-1)!.question, /확인 코드: [a-f0-9]{6} — /);
  assert.ok(record.toolInput.questions.every((question) => !question.question.includes("확인 코드")), "Claude 질문은 그대로다");
  assert.throws(() => codexReply(record.id, "S", "1", ""), /확인 코드가 없거나 다릅니다/);
  assert.throws(() => codexReply(record.id, "S", "1", "000000"), /확인 코드가 없거나 다릅니다/);
  assert.equal(loadConsent(root, record.id).status, "pending");
  codexReply(record.id, "S");
  assert.equal(loadConsent(root, record.id).status, "approved");
  const legacy = prepared({ action: "docs", kind: "architecture" });
  const file = join(root, ".code-agent/consents", `${legacy.id}.json`);
  const value = JSON.parse(readFileSync(file, "utf8"));
  delete value.format;
  writeFileSync(file, JSON.stringify(value));
  assert.doesNotMatch(JSON.parse(consentStatus(root, legacy.id)).codexReply.format, /확인 코드/);
  codexReply(legacy.id, "S2", "1", "");
  assert.equal(loadConsent(root, legacy.id).status, "approved");
});

// ---- judgment ----
