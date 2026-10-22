import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSENT_WORK_ID, gitFixture, submitConsentRequest, writeFixture } from "./consentFixture";
import { prepareConsent } from "../agent/consent";
import { loadActive, questionsFile } from "../agent/layout";
import { releaseLease } from "../agent/lease";
import { writeRunRecord } from "../agent/master/store";
import { requestBegin } from "../agent/request";


import { root, publish, request, choose, send, read, approveDashboard, reject, writeLease, orphanLease, previousRun } from "./dashboardFixture";

const owner = { binding: { id: "owner", host: "claude" as const } };
function openWork(): NonNullable<ReturnType<typeof loadActive>> {
  approveDashboard(JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id);
  submitConsentRequest(root);
  approveDashboard(JSON.parse(prepareConsent(root, { action: "request", id: CONSENT_WORK_ID }, owner)).id);
  return loadActive(root)!;
}
const view = (requestId: string) => read("interaction", { requestId }).result;

test("작업이 없으면 끝난 작업의 남은 임대는 준비 질문·동의의 조회와 수신을 막지 않는다", () => {
  orphanLease();
  assert.equal(loadActive(root), undefined);
  const q = publish("setup");
  assert.equal(view(q.requestId).canRespond, true); assert.equal(view(q.requestId).leaseConflict, null);
  assert.equal(send(request(q, choose())).ok, true);
  approveDashboard(JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id);
});

test("지금 작업과 다른 작업·대상의 임대, 푼 임대, 무활동 임대는 조회·수신의 거절 근거가 아니다", () => {
  const active = openWork(), now = new Date().toISOString();
  const leases = [
    { id: "OTHER-WORK", target: active.target, session: "intruder" },
    { id: active.id, target: "other-target", session: "intruder" },
    { id: active.id, target: active.target, session: "intruder", released: { at: now } },
    { id: active.id, target: active.target, session: "intruder", seenAt: new Date(Date.now() - 31 * 60_000).toISOString() },
  ];
  for (const [index, lease] of leases.entries()) {
    writeLease(lease);
    const q = publish("planning", { key: `lease-${index}` });
    assert.equal(view(q.requestId).canRespond, true, JSON.stringify(lease)); assert.equal(view(q.requestId).leaseConflict, null);
    assert.equal(send(request(q, choose())).ok, true, JSON.stringify(lease));
  }
});

test("지금 작업을 다른 세션·호스트가 쥐면 조회부터 응답 불가이고, 수신 거절은 대기를 유지하며 원인 해결 뒤 새 제출을 받는다", () => {
  const active = openWork();
  const q = publish("planning");
  writeLease({ id: active.id, target: active.target, host: "codex", session: "owner" });
  assert.equal(view(q.requestId).canRespond, false, "같은 세션 ID라도 다른 호스트의 임대는 주인이 아니다");
  writeLease({ id: active.id, target: active.target, session: "intruder" });
  const blocked = view(q.requestId);
  assert.equal(blocked.canRespond, false); assert.match(blocked.unavailableReason, /intruder/);
  assert.deepEqual(blocked.leaseConflict.currentWork, { id: active.id, target: active.target });
  assert.equal(blocked.leaseConflict.lease.workId, active.id); assert.equal(blocked.leaseConflict.lease.session, "intruder");
  const rejected = reject(request(q, choose()));
  assert.equal(rejected.code, "busy"); assert.equal(rejected.message, blocked.unavailableReason);
  assert.deepEqual({ received: rejected.detail.received, status: rejected.detail.status, requestId: rejected.detail.requestId }, { received: false, status: "pending", requestId: q.requestId });
  const without = ({ lease: { idleMs: _idle, ...lease }, ...rest }: any) => ({ ...rest, lease });
  assert.deepEqual(without(rejected.detail.leaseConflict), without(blocked.leaseConflict), "조회와 수신이 같은 판정을 낸다");
  const result = read("interaction.result", { requestId: q.requestId }).result;
  assert.equal(result.status, "pending"); assert.equal(result.response, undefined);
  // 원인 해결 뒤 최신 요청을 다시 조회해 제출한다 — 거절은 요청·challenge 를 바꾸지 않았다
  releaseLease(root);
  const latest = view(q.requestId);
  assert.equal(latest.canRespond, true); assert.equal(latest.revision, q.revision); assert.equal(latest.challenge, q.challenge);
  assert.equal(send(request(latest, choose())).ok, true);
});

test("조회 뒤 제출 직전에 소유·HEAD가 바뀌면 수신 때 다시 검사해 거절하고 대기를 유지한다", () => {
  const active = openWork();
  const q = publish("planning");
  assert.equal(view(q.requestId).canRespond, true);
  writeLease({ id: active.id, target: active.target, session: "intruder" });
  const busy = reject(request(q, choose()));
  assert.equal(busy.code, "busy"); assert.equal(busy.detail.received, false);
  releaseLease(root);
  gitFixture(root, "commit", "-q", "--allow-empty", "-m", "다른 진행");
  const stale = reject(request(q, choose()));
  assert.equal(stale.code, "stale-state"); assert.equal(stale.detail.received, false); assert.equal(stale.detail.status, "pending");
  assert.equal(read("interaction.result", { requestId: q.requestId }).result.status, "pending");
});

test("접수 중 질문 문서의 요청은 끝난 작업의 임대 세션이 아니라 그 접수를 연 실행의 세션에 묶인다", () => {
  orphanLease();
  requestBegin(root, "REQ-7", "feature");
  writeRunRecord(root, { ...previousRun(), workId: "REQ-7" });
  writeFixture(root, questionsFile("REQ-7"), "# 질문\n\n## Q1 규칙\n[Answer]:\n[Status]: open\n");
  const listed = read("interactions").result.requests.filter((r: any) => r.origin.type === "questions");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].context.sessionId, "owner"); assert.equal(listed[0].canRespond, true); assert.equal(listed[0].leaseConflict, null);
});
