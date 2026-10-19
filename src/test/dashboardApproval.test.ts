import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { submitConsentRequest, CONSENT_WORK_ID, preparePlanFixture } from "./consentFixture";
import { loadActive } from "../agent/layout";
import { currentInteractions } from "../agent/interactions";
import { drainInteraction } from "../agent/interactionService";
import { prepareConsent, loadConsent } from "../agent/consent";


import { root, request, approveDashboard } from "./dashboardFixture";

test("설정과 접수 동의는 실제 도메인 처리 후 최초 feature 작업을 한 번만 연다", () => {
  approveDashboard(JSON.parse(prepareConsent(root, { action: "setup" }, { binding: { id: "owner", host: "claude" } })).id);
  submitConsentRequest(root);
  const id = JSON.parse(prepareConsent(root, { action: "request", id: CONSENT_WORK_ID }, { binding: { id: "owner", host: "claude" } })).id;
  approveDashboard(id);
  assert.equal(loadActive(root)?.id, CONSENT_WORK_ID); assert.equal(JSON.parse(readFileSync(join(root, `doc/work/${CONSENT_WORK_ID}/request.json`), "utf8")).kind, "feature");
  drainInteraction(root, currentInteractions(root).requests.find(r => r.origin.id === id)!.requestId);
  assert.equal(loadActive(root)?.id, CONSENT_WORK_ID);
});

test("계획 동의는 기존 계획 검사·승인 기록을 거쳐 구현으로 이어진다", () => {
  preparePlanFixture(root);
  const id = JSON.parse(prepareConsent(root, { action: "plan" }, { binding: { id: "owner", host: "claude" } })).id;
  approveDashboard(id); assert.equal(loadActive(root)?.phase, "implement"); assert.equal(loadConsent(root, id).observed, undefined);
});
