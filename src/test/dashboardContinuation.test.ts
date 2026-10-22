import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONSENT_WORK_ID, gitFixture, submitConsentRequest, writeFixture } from "./consentFixture";
import { listRuns, runPrompt, writeRunRecord } from "../agent/master/store";
import { currentInteractions } from "../agent/interactions";
import { drainInteraction } from "../agent/interactionService";
import { applyDashboardConsent, discardChangedConsents, loadConsent, prepareConsent } from "../agent/consent";
import { CONSENT_DIR, CONSENT_INDEX, CONSENT_LOCK } from "../agent/consentState";
import { loadActive } from "../agent/layout";
import { requestBegin } from "../agent/request";
import { applyHere, busyReasons } from "../agent/runtimeApply";
import { STATE_SCHEMA } from "../agent/runtimeSelect";


import { root, request, send, read, approval, approveDashboard, consentRequest, reject, orphanLease, previousRun } from "./dashboardFixture";

const owner = { binding: { id: "owner", host: "claude" as const } };
/** 동의 기록의 필드를 바꾼다 — 열린 창(30분) 밖의 동의, 적용 중인 동의를 만든다 */
function editConsent(id: string, change: (record: any) => void): void {
  const record = JSON.parse(readFileSync(join(root, CONSENT_DIR, `${id}.json`), "utf8")); change(record);
  writeFixture(root, `${CONSENT_DIR}/${id}.json`, JSON.stringify(record));
}
function age(id: string): void {
  const aged = new Date(Date.now() - 31 * 60_000).toISOString();
  editConsent(id, record => { record.createdAt = aged; });
  const index = JSON.parse(readFileSync(join(root, CONSENT_INDEX), "utf8")); index.open[id].createdAt = aged;
  writeFixture(root, CONSENT_INDEX, JSON.stringify(index));
}
const resumedPrompt = (previous: string) => readFileSync(runPrompt(root, listRuns(root).find(row => row.runId !== previous)!.runId), "utf8");

test("같은 승인의 중복 제출과 적용 중 재시작은 커밋·적용·재개를 한 번만 한다", () => {
  orphanLease();
  const run = previousRun(); writeRunRecord(root, run);
  const id = JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id, r = consentRequest(id);
  assert.equal(r.context.runId, run.runId);
  const req = request(r, approval(r));
  assert.equal(send(req).ok, true); assert.equal(send(req).result.replayed, true);
  // 다른 탭의 같은 승인 — 수신한 요청의 revision 이 바뀌어 받지 않는다
  const second = reject(request(r, approval(r)));
  assert.equal(second.code, "stale-state"); assert.equal(second.detail.received, false); assert.equal(second.detail.status, "responded");
  // 적용 중 재시작 — drain 이 동의를 적용(준비 커밋)한 뒤 질문 원장에 적용·재개 표지를 남기기 전에 프로세스가 끊긴 상태
  const received = consentRequest(id), response = received.response!;
  applyDashboardConsent(root, id, { receiptId: response.receiptId, channelId: response.channelId!, sessionId: "owner", shownHash: received.consent!.shownHash,
    verdict: "approve", choices: response.submission.choices ?? {}, at: response.at });
  const commits = gitFixture(root, "rev-list", "--count", "HEAD");
  assert.equal(loadConsent(root, id).status, "applied"); assert.equal(consentRequest(id).status, "responded");
  drainInteraction(root, r.requestId); drainInteraction(root, r.requestId);
  assert.equal(gitFixture(root, "rev-list", "--count", "HEAD"), commits, "적용한 동의를 다시 실행하지 않는다");
  assert.equal(listRuns(root).length, 2, "재개 실행은 하나다");
  const saved = consentRequest(id);
  assert.equal(saved.status, "applied"); assert.equal(saved.continuation?.state, "started");
});

test("작업을 열기 전 기준 커밋 승인은 원래 실행의 연결·세션으로 최초 접수를 잇는다", () => {
  orphanLease();
  const run = { ...previousRun(), links: { missionId: "mission-1", taskId: "T1", attemptId: "attempt-1" } }; writeRunRecord(root, run);
  approveDashboard(JSON.parse(prepareConsent(root, { action: "baseline" }, owner)).id);
  assert.equal(loadActive(root), undefined);
  const next = listRuns(root).find(row => row.runId !== run.runId)!;
  assert.deepEqual(next.links, run.links); assert.equal(next.sessionId, "owner"); assert.equal(next.resumeOf, "owner"); assert.equal(next.workId, null);
  const prompt = readFileSync(runPrompt(root, next.runId), "utf8");
  assert.match(prompt, /작업이 열리기 전/); assert.match(prompt, /최초 접수/); assert.doesNotMatch(prompt, /새로운 작업을 접수/);
  assert.match(prompt, /작업 ID를 임의로 만들거나/);
});

test("요구사항 동의로 작업이 열린 뒤의 재개는 그 작업을 잇고 새 접수를 금지한다", () => {
  approveDashboard(JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id);
  submitConsentRequest(root);
  const run = previousRun(); writeRunRecord(root, run);
  approveDashboard(JSON.parse(prepareConsent(root, { action: "request", id: CONSENT_WORK_ID }, owner)).id);
  assert.equal(loadActive(root)?.id, CONSENT_WORK_ID);
  const prompt = resumedPrompt(run.runId);
  assert.match(prompt, new RegExp(`기존 작업 ${CONSENT_WORK_ID}의 ID·종류를 유지`)); assert.match(prompt, /새로운 작업을 접수하거나/); assert.doesNotMatch(prompt, /최초 접수/);
});

test("작업도 접수도 없을 때 모델 변경 승인의 재개는 접수를 지시하지 않는다", () => {
  const run = previousRun(); writeRunRecord(root, run);
  approveDashboard(JSON.parse(prepareConsent(root, { action: "model", host: "claude", agent: "writer", model: "opus" }, owner)).id);
  const prompt = resumedPrompt(run.runId);
  assert.match(prompt, /지금 열린 작업이 없습니다/); assert.match(prompt, /작업 ID를 만들지 마세요/); assert.doesNotMatch(prompt, /최초 접수|작업이 열리기 전/);
});

test("접수 중의 준비 승인은 그 접수 ID로 최초 접수를 잇는다", () => {
  orphanLease();
  const run = previousRun(); writeRunRecord(root, run);
  requestBegin(root, "REQ-7", "feature");
  const id = JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id;
  assert.equal(consentRequest(id).context.workId, "REQ-7");
  approveDashboard(id);
  const next = listRuns(root).find(row => row.runId !== run.runId)!;
  assert.match(readFileSync(runPrompt(root, next.runId), "utf8"), /접수 ID REQ-7를 그대로 씁니다/);
});

test("버전 적용이 확인 대상을 바꾼 미응답 동의는 대상 변경으로 닫고 같은 세션의 재준비 요청이 응답을 받는다", () => {
  orphanLease();
  writeFixture(root, ".code-agent/runtime.json", JSON.stringify({ schema: 1, applied: "1.0.0-000000000000", appliedAt: new Date().toISOString(), stateSchema: STATE_SCHEMA }));
  const run = previousRun(); writeRunRecord(root, run);
  const id = JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id, old = consentRequest(id);
  assert.deepEqual(busyReasons(root), ["응답·적용을 기다리는 확인: 초기 설정 확정"]);
  // 열린 창(30분) 밖의 동의 — 버전 적용은 바쁘지 않다고 보고 진행한다
  age(id);
  assert.deepEqual(busyReasons(root), []);
  const applied = applyHere(root, { trigger: "bundled" });
  assert.equal(applied.status, "applied"); assert.match(applied.text, /대상 변경으로 닫았습니다/);
  const closed = loadConsent(root, id);
  assert.equal(closed.status, "failed"); assert.equal(closed.failure?.kind, "target"); assert.match(closed.failure!.detail, /버전 적용\(1\.0\.0-000000000000 → 번들/);
  const shown = read("interaction", { requestId: old.requestId }).result;
  assert.equal(shown.status, "superseded"); assert.equal(shown.canRespond, false); assert.match(shown.unavailableReason, /응답을 받기 전에/);
  assert.equal(reject(request(old, approval(old))).detail.received, false);
  // 같은 세션이 다시 준비한 요청 — 원래 실행에 연결되고 응답을 받아 한 번 재개한다
  const next = JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id;
  assert.equal(consentRequest(next).context.runId, run.runId);
  approveDashboard(next);
  assert.equal(listRuns(root).filter(row => row.resumeOf === "owner").length, 1);
  assert.equal(currentInteractions(root).requests.find(r => r.requestId === old.requestId)!.status, "superseded", "닫은 요청의 기록은 남는다");
});

test("같은 내용으로 템플릿을 다시 반영하면 응답을 기다리는 동의를 닫지 않는다", () => {
  assert.equal(applyHere(root, { trigger: "templates-only" }).status, "applied");
  const id = JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id; age(id);
  // 적용은 버전 적용 잠금 안에서 동의를 대조한다 — 그 잠금 파일은 확인 대상이 아니다
  const again = applyHere(root, { trigger: "templates-only" });
  assert.equal(again.status, "applied"); assert.doesNotMatch(again.text, /닫았습니다|정리하지 못했습니다/);
  assert.equal(loadConsent(root, id).status, "pending");
});

test("갱신 동의를 적용하는 부모가 동의 잠금을 쥐고 있을 때만 그 잠금 아래에서 확인 대상이 바뀐 동의를 닫는다", () => {
  const keep = JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id;
  const other = JSON.parse(prepareConsent(root, { action: "setup" }, { binding: { id: "other", host: "claude" as const } })).id;
  editConsent(keep, record => { record.status = "applying"; });
  writeFixture(root, "notes.txt", "바뀐 대상\n");
  const lock = (pid: number) => writeFixture(root, CONSENT_LOCK, JSON.stringify({ pid, host: hostname(), at: new Date().toISOString(), nonce: "fixture" }));
  // 부모가 아닌 살아 있는 주인 — 기다리지 않고 멈추며 동의는 그대로다
  lock(process.pid);
  assert.throws(() => discardChangedConsents(root, "시험 적용", keep, 0), /다른 확인·적용이 진행 중입니다/);
  assert.equal(loadConsent(root, other).status, "pending");
  lock(process.ppid);
  assert.deepEqual(discardChangedConsents(root, "시험 적용", keep, 0), [other]);
  assert.equal(loadConsent(root, other).failure?.kind, "target"); assert.equal(loadConsent(root, keep).status, "applying");
});

test("수신 중 동의 대상이 바뀐 것을 찾으면 invalid-state 로 거절하고 요청은 다음 조회에서 대상 변경으로 닫힌다", () => {
  const id = JSON.parse(prepareConsent(root, { action: "setup" }, owner)).id, r = consentRequest(id);
  writeFixture(root, "notes.txt", "바뀐 대상\n");
  const rejected = reject(request(r, approval(r)));
  assert.equal(rejected.code, "invalid-state");
  assert.deepEqual({ received: rejected.detail.received, requestId: rejected.detail.requestId }, { received: false, requestId: r.requestId });
  assert.equal(loadConsent(root, id).failure?.kind, "target");
  const shown = read("interaction", { requestId: r.requestId }).result;
  assert.equal(shown.status, "superseded"); assert.match(shown.unavailableReason, /대상 변경으로 닫혔습니다/);
});
