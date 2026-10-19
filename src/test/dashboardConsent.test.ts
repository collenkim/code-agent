import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFixture } from "./consentFixture";
import { readBinding, writeBinding } from "../agent/master/store";
import { currentInteractions } from "../agent/interactions";
import { drainInteraction } from "../agent/interactionService";
import { prepareConsent, loadConsent, observeConsent } from "../agent/consent";
import { openConsent } from "../agent/consentState";
import { readDocLedger } from "../agent/docs";


import { root, publish, request, choose, send, approveDashboard } from "./dashboardFixture";

test("독립 문서 동의는 서명된 전문 확인 뒤 기존 적용 함수와 승인 원장을 사용한다", () => {
  const id = JSON.parse(prepareConsent(root, { action: "docs" }, { binding: { id: "owner", host: "claude" } })).id;
  const r = currentInteractions(root).requests.find(r => r.origin.id === id)!;
  assert.equal(send(request(r, choose())).ok, false, "일반 답을 동의로 바꾸지 않는다");
  const submit = { intent: "submit", explicit: true, verdict: "approve", shownHash: r.consent!.shownHash, choices: {} };
  assert.equal(send(request(r, { ...submit, shownHash: "wrong" })).ok, false);
  const req = request(r, submit); assert.equal(send(req).ok, true); assert.equal(loadConsent(root, id).status, "pending", "수신은 적용이 아니다");
  drainInteraction(root, r.requestId);
  assert.equal(loadConsent(root, id).status, "applied"); assert.equal(loadConsent(root, id).observed, undefined);
  assert.ok(readDocLedger(root).every(row => row.presence.channel === "dashboard-human" && row.presence.verified));
  const count = readDocLedger(root).length; drainInteraction(root, r.requestId); assert.equal(readDocLedger(root).length, count);
  assert.equal(send(req).result.replayed, true);
});

test("동의 취소는 승인 없이 원래 대기를 닫고 새 확인을 준비할 수 있다", () => {
  const id = JSON.parse(prepareConsent(root, { action: "docs" }, { binding: { id: "owner", host: "claude" } })).id;
  const r = currentInteractions(root).requests.find(r => r.origin.id === id)!;
  assert.equal(send(request(r, { intent: "cancel", explicit: true })).ok, true);
  assert.equal(loadConsent(root, id).status, "deferred"); assert.equal(openConsent(root), undefined);
  assert.equal(readDocLedger(root).length, 0);
  const next = JSON.parse(prepareConsent(root, { action: "docs" }, { binding: { id: "owner", host: "claude" } })).id;
  assert.notEqual(next, id); approveDashboard(next);
});

test("응답 수신 뒤 대상 변경은 동의 적용을 막고 실패 영수증을 남긴다", () => {
  const id = JSON.parse(prepareConsent(root, { action: "docs" }, { binding: { id: "owner", host: "claude" } })).id;
  const r = currentInteractions(root).requests.find(r => r.origin.id === id)!;
  assert.equal(send(request(r, { intent: "submit", explicit: true, verdict: "approve", shownHash: r.consent!.shownHash, choices: {} })).ok, true);
  writeFixture(root, "doc/architecture.md", "달라진 아키텍처\n"); drainInteraction(root, r.requestId);
  assert.equal(currentInteractions(root).requests.find(i => i.requestId === r.requestId)!.status, "failed"); assert.notEqual(loadConsent(root, id).status, "applied");
});

test("대시보드 동의 수신 뒤 호스트 응답은 거부하고 권한 회수 뒤에는 적용하지 않는다", () => {
  const prepared = JSON.parse(prepareConsent(root, { action: "docs" }, { binding: { id: "owner", host: "claude" } }));
  const r = currentInteractions(root).requests[0];
  assert.equal(send(request(r, { intent: "submit", explicit: true, verdict: "approve", shownHash: r.consent!.shownHash, choices: {} })).ok, true);
  assert.throws(() => observeConsent({ cwd: root, session_id: "owner", tool_use_id: "late", tool_name: "AskUserQuestion", hook_event_name: "PreToolUse", tool_input: prepared.toolInput }, root), /대시보드/);
  const binding = readBinding(root)!; delete binding.humanChannel; writeBinding(root, binding);
  assert.deepEqual(drainInteraction(root, r.requestId), { waiting: "human-channel" }); assert.equal(loadConsent(root, prepared.id).status, "pending");
});

test("수정 요청은 반영 없이 끝나고 응답을 수신한 질문 본문은 덮어쓰지 않는다", () => {
  const prepared = JSON.parse(prepareConsent(root, { action: "docs" }, { binding: { id: "owner", host: "claude" } }));
  const r = currentInteractions(root).requests[0];
  assert.equal(send(request(r, { intent: "submit", explicit: true, verdict: "request-changes", shownHash: r.consent!.shownHash })).ok, true);
  drainInteraction(root, r.requestId); assert.equal(loadConsent(root, prepared.id).status, "changes-requested"); assert.equal(readDocLedger(root).length, 0);
  const q = publish(); assert.equal(send(request(q, choose())).ok, true);
  assert.throws(() => publish("setup", { title: "다른 질문" }), /먼저 소비/);
});
