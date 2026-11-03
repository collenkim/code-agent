import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyConsent, finishConsent, loadConsent } from "../agent/consent";
import { loadActive } from "../agent/layout";
import { approvalOf, loadWork } from "../agent/work";
import { hashPlan, readLedger } from "../core/approval";
import { CONSENT_WORK_ID, approveAndApplyFixture, observeConsentFixture, prepareConsentFixture, preparePlanFixture, writeFixture } from "./consentFixture";
import { recordReviewFixture } from "./reviewFixture";
import { next, requireValidatable } from "../agent/commands";
import { reviewDocFile } from "../agent/review";
import { check, runTests } from "../agent/validate";
import { root } from "./consentLifecycleFixture";

import "./consentLifecycleFixture";
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

test("plan: finish 로 승인을 적용하면 커서를 구현으로 옮기고 첫 Task 의 context 파일을 써 둔다 — next·context --file 왕복이 없다", () => {
  preparePlanFixture(root);
  const fixture = prepareConsentFixture(root, { action: "plan" });
  observeConsentFixture(fixture);
  const applied = JSON.parse(finishConsent(root, fixture.id));
  assert.equal(applied.status, "applied");
  assert.equal(applied.phase, "implement");
  assert.equal(loadActive(root)?.task, "T1");
  assert.equal(applied.contextAgent, "ca-tester", "첫 Task 는 테스트 단계라 ca-tester 가 맡는다");
  assert.match(readFileSync(join(root, applied.contextFile), "utf8"), /^# code-agent context — CONSENT-1 · 구현/);
  const again = JSON.parse(finishConsent(root, fixture.id));
  assert.equal(again.phase, "implement", "다시 불러도 커서를 더 옮기지 않는다");
  assert.equal(loadActive(root)?.task, "T1");
});

test("next·review CLI 는 담당을 부를 자리의 context 파일을 함께 쓰고, 통과한 integrate 는 커서를 deliver 로 넘긴다", async () => {
  preparePlanFixture(root);
  approveAndApplyFixture(root, { action: "plan" });
  const cli = (...args: string[]): string => {
    const run = spawnSync(process.execPath, [join(__dirname, "../agent/cli.js"), ...args], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    return run.stdout;
  };
  const first = cli("next");
  assert.match(first, /^스테이지: 구현/m);
  assert.match(first, /^- 담당: ca-tester$/m);
  assert.match(first, /^- 전문: \S+\/context\.md — /m);
  writeFixture(root, "tests/value.test.js", "const test=require('node:test'),a=require('node:assert/strict'),v=require('../src/value');\ntest('TC-1',()=>a.equal(v(1),1));\ntest('TC-2',()=>a.throws(()=>v(-1)));\n");
  assert.match(cli("next"), /^- 담당: ca-implementer$/m);
  writeFixture(root, "src/value.js", "module.exports=n=>{if(n<0)throw Error('negative');return 1;};\n");
  assert.doesNotMatch(cli("next"), /- 전문:/, "check 로 넘어가면 부를 담당이 없다");
  await check(requireValidatable(root, "check")); next(root);
  await runTests(requireValidatable(root, "test")); next(root);
  const opened = cli("review");
  assert.match(opened, /^- 담당: ca-reviewer$/m);
  assert.match(readFileSync(join(root, /^- 전문: (\S+)/m.exec(opened)![1]), "utf8"), /^# code-agent context — CONSENT-1 · 코드 리뷰/);
  const review = reviewDocFile(CONSENT_WORK_ID);
  writeFixture(root, review, readFileSync(join(root, review), "utf8").replace("## 지적\n", "## 지적\n\n- 없음\n"));
  recordReviewFixture(root);
  next(root);
  const integrated = cli("integrate");
  assert.match(integrated, /전부 통과했습니다\.\n/);
  assert.match(integrated, /^스테이지: 반영/m);
  assert.equal(loadActive(root)?.phase, "deliver");
});

test("plan: a changed supporting document cannot receive the prepared approval", () => {
  preparePlanFixture(root);
  const fixture = prepareConsentFixture(root, { action: "plan" });
  observeConsentFixture(fixture);
  const doc = `doc/work/${CONSENT_WORK_ID}/03-design.md`;
  writeFixture(root, doc, readFileSync(join(root, doc), "utf8") + "\nDifferent design.\n");
  assert.throws(() => applyConsent(root, fixture.id));
  assert.equal(readLedger(root, CONSENT_WORK_ID).length, 0);
  assert.equal(loadConsent(root, fixture.id).status, "failed");
  assert.equal(loadConsent(root, fixture.id).failure?.kind, "target");
});
