import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { finishConsent } from "../agent/consent";
import { loadActive } from "../agent/layout";
import { requestBegin, requestSubmit } from "../agent/request";
import { CONSENT_WORK_ID, approveAndApplyFixture, confirmationText, gitFixture, observeConsentFixture, prepareConsentFixture, prepareDeliveryFixture, writeFixture } from "./consentFixture";
import { root } from "./consentLifecycleFixture";
import "./consentLifecycleFixture";

test("병합된 작업의 요구 확정 finish는 startBlocked를 반환하고 브랜치를 유지한다", async () => {
  await prepareDeliveryFixture(root);
  approveAndApplyFixture(root, { action: "deliver" });
  const delivered = gitFixture(root, "rev-parse", "HEAD");
  gitFixture(root, "update-ref", "refs/heads/master", delivered);
  assert.match(requestBegin(root, CONSENT_WORK_ID, "feature"), /시작 전 정리 필요:[\s\S]*병합된 기록/);
  const draft = `doc/work/${CONSENT_WORK_ID}/request.json`;
  const { requirements: _requirements, ...request } = JSON.parse(readFileSync(join(root, draft), "utf8"));
  writeFixture(root, draft, JSON.stringify({ ...request, original: "0이면 0을 반환해 주세요.", revision: { parent: 1, mode: "amend" },
    changes: [{ op: "add", section: "REQ", text: "0이면 0을 반환한다." }], sourceMap: [{ quote: "0이면 0을 반환해 주세요.", targets: ["REQ-3"] }] }));
  requestSubmit(root, join(root, draft));
  const consent = prepareConsentFixture(root, { action: "request", id: CONSENT_WORK_ID });
  assert.match(confirmationText(consent), /확정만 남고 시작은 막힙니다/);
  observeConsentFixture(consent);
  const result = JSON.parse(finishConsent(root, consent.id));
  assert.match(result.startBlocked, /병합된 기록/);
  assert.equal(loadActive(root), undefined);
  assert.equal(gitFixture(root, "branch", "--show-current"), `feature/${CONSENT_WORK_ID}`);
});
