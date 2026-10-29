import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { next, status } from "../agent/commands";
import { applyConsent } from "../agent/consent";
import { loadActive, saveActive } from "../agent/layout";
import { planningStatus, preparePlanning } from "../agent/planning";
import { loadPlanning } from "../agent/planningState";
import { requestSubmit } from "../agent/request";
import { readTimeline } from "../agent/timeline";
import { approvalOf, loadWork } from "../agent/work";
import { confirmForTest, start } from "./confirmedStart";
import {
  approveAndApplyFixture, CONSENT_SPEC, CONSENT_WORK_ID, observeConsentFixture, preparePlanFixture, prepareConsentFixture, prepareReviewFixture,
  setupConsentProject, writeFixture,
} from "./consentFixture";
import { advance, DIR, finish, REQUIREMENTS, root, SPEC, throughDesign, write } from "./planningFixture";

/**
 * 확정된 요구 개정과 흐름 — 변경안 대기 중 배정 멈춤, 분석 중 개정 전환의 작업 정의 갱신, 이후 단계의 분석 되감기(브랜치·코드 보존),
 * 늦은 결과·이전 승인 응답 거부, 머리말만 바뀐 개정과 따르던 기록 없는 커서.
 */

const analysisTask = () => loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "analysis")!;
const revised = (lines: string[]) => `---\nkind: feature\nid: PLAN-1\ntitle: 값 반환\ntarget: value\n---\n\n${lines.join("\n")}\n`;
const applied = (repo: string) => readTimeline(repo).filter((event) => event.type === "revision.applied");

describe("계획 흐름 — 손으로 쓴 지시서", () => {
  test("확정 전 바뀐 지시서로는 준비·배정하지 않고, 분석 중 확정되면 분석 작업의 요구 범위를 그 개정에 맞춘다 — 같은 확정본 위 재준비는 정의를 바꾸지 않는다", () => {
    preparePlanning(root);
    assert.deepEqual(analysisTask().task.requirements, ["REQ-1"]);
    write(SPEC, revised(["값을 반환한다.", "추가 값을 반환한다."]));
    assert.throws(() => preparePlanning(root), /요구사항이 확정 뒤 바뀌었습니다/);
    assert.deepEqual(analysisTask().task.requirements, ["REQ-1"], "확정 전에는 작업 정의를 바꾸지 않는다");
    confirmForTest(root, join(root, SPEC));
    assert.equal(loadActive(root)!.phase, "analysis");
    assert.deepEqual(JSON.parse(preparePlanning(root)).aligned, ["analysis"]);
    assert.deepEqual(analysisTask().task.requirements, ["REQ-1", "REQ-2"]);
    const basis = analysisTask().basis;
    assert.equal(basis, loadActive(root)!.request!.hash);
    assert.equal(JSON.parse(preparePlanning(root)).aligned, undefined);
    assert.equal(analysisTask().basis, basis);
    const [event] = applied(root);
    assert.deepEqual([event.phase, event.detail?.rewound, event.detail?.from, event.reason], ["analysis", false, "analysis", "바뀐 요구 확정 — 분석 중 반영"]);
  });

  test("늦은 결과 — 이전 확정본으로 배정한 담당의 완료는 받지 않고 새 요구 범위로 다시 배정한다", async () => {
    const [item] = (await advance()).assignments;
    write(SPEC, revised(["값을 반환한다.", "추가 값을 반환한다."]));
    confirmForTest(root, join(root, SPEC));
    assert.throws(() => finish(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), /실행 중 입력이 바뀌었습니다/);
    assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false, "늦은 결과의 문서는 쓰지 않는다");
    const [view] = JSON.parse(planningStatus(root)).tasks;
    assert.notEqual(view.state, "completed");
    const again = await advance();
    assert.equal(again.action, "dispatch");
    assert.notEqual(again.assignments[0].resultShape.dispatchId, item.resultShape.dispatchId);
    assert.deepEqual(again.assignments[0].task.requirements, ["REQ-1", "REQ-2"]);
  });

  test("분석 뒤 단계에서 요구 항목이 바뀌어 확정되면 분석으로 되감고 문서·브랜치를 보존한다 — 재개·같은 확정은 다시 되감지 않는다", () => {
    throughDesign();
    const before = loadActive(root)!;
    assert.equal(before.phase, "plan");
    write(SPEC, revised(["값을 반환한다.", "추가 값을 반환한다."]));
    assert.throws(() => next(root), /요구사항이 확정 뒤 바뀌었습니다/);
    assert.equal(loadActive(root)!.phase, "plan", "확정 전에는 커서를 움직이지 않는다");
    confirmForTest(root, join(root, SPEC));
    const after = loadActive(root)!;
    assert.deepEqual([after.phase, after.branch, after.baseCommit], ["analysis", before.branch, before.baseCommit]);
    assert.notEqual(after.request!.hash, before.request!.hash);
    for (const doc of ["01-requirements.md", "02-analysis.md", "03-design.md", "04-functional.md"]) assert.ok(existsSync(join(root, DIR, doc)), doc);
    const [event] = applied(root);
    assert.deepEqual([event.detail?.from, event.detail?.to, event.detail?.rewound], ["plan", "analysis", true]);
    assert.match(start(root, join(root, SPEC)), /^이미 진행 중입니다: PLAN-1 · 요구사항 분석\n\n/);
    // 분석 게이트가 새 항목의 추적을 요구한다 — 같은 개정으로는 다시 되감지 않는다
    assert.throws(() => next(root), /REQ-2/);
    assert.equal(loadActive(root)!.phase, "analysis");
    assert.equal(applied(root).length, 1);
  });

  test("따르던 기록이 없는 커서(이 기능 전 작업)는 첫 진행에서 지금 확정본을 기록만 하고, 머리말만 바뀐 개정은 되감지 않는다", () => {
    throughDesign();
    const { request: _none, ...legacy } = loadActive(root)!;
    saveActive(root, legacy);
    assert.throws(() => next(root));
    assert.equal(loadActive(root)!.phase, "plan");
    assert.ok(loadActive(root)!.request, "지금 확정본을 기록한다");
    assert.equal(applied(root).length, 0);
    write(SPEC, readFileSync(join(root, SPEC), "utf8").replace("title: 값 반환", "title: 값 반환 — 고침"));
    confirmForTest(root, join(root, SPEC));
    assert.equal(loadActive(root)!.phase, "plan");
    const [event] = applied(root);
    assert.deepEqual([event.detail?.rewound, event.reason], [false, "바뀐 요구 확정 — 요구 항목은 그대로"]);
  });
});

describe("동의 흐름 — 렌더한 지시서의 변경안", () => {
  function consentRepo(run: (repo: string) => void | Promise<void>): () => Promise<void> {
    return async () => {
      const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-revision-flow-")));
      try { setupConsentProject(repo); await run(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
    };
  }
  function amend(repo: string, said: string, text: string): string {
    const draft = `doc/work/${CONSENT_WORK_ID}/request.json`;
    const { requirements: _listed, ...request } = JSON.parse(readFileSync(join(repo, draft), "utf8"));
    writeFixture(repo, draft, JSON.stringify({ ...request, original: said, revision: { parent: 1, mode: "amend" },
      changes: [{ op: "add", section: "REQ", text }], sourceMap: [{ quote: said, targets: ["REQ-3"] }] }));
    return requestSubmit(repo, join(repo, draft));
  }

  test("리뷰 중 추가 요구 — 변경안 대기 중에는 진행을 멈추고, 확정하면 분석으로 되감아 코드·브랜치를 보존하며 확정 결과에 바뀐 요구가 보인다", consentRepo(async (repo) => {
    await prepareReviewFixture(repo);
    const before = loadActive(repo)!;
    assert.deepEqual([before.phase, before.request?.revision], ["review", 1]);
    const code = readFileSync(join(repo, "src/value.js"), "utf8");
    assert.match(amend(repo, "0이면 0을 반환해 주세요.", "0이면 0을 반환한다."), /개정 2\(부모 1 · 추가 1\)/);
    assert.throws(() => next(repo), /변경안 개정 2\(부모 1 · 추가 1\)이 확정을 기다립니다/);
    assert.match(status(repo), /요구사항: 변경안 확정 대기 — 개정 2\(부모 1 · 추가 1\)/);
    const { result } = approveAndApplyFixture(repo, { action: "request", id: CONSENT_WORK_ID });
    assert.match(result, /요구 변경안을 개정 2 으로 확정했습니다[\s\S]*요구 개정 2 확정 — 흐름을 코드 리뷰 에서 요구사항 분석 으로 되감았습니다 \(따르던 개정 1\)[\s\S]*추가 \[REQ-3\] 0이면 0을 반환한다\./);
    const after = loadActive(repo)!;
    assert.deepEqual([after.phase, after.branch, after.baseCommit, after.request?.revision, after.stage, after.task], ["analysis", before.branch, before.baseCommit, 2, undefined, undefined]);
    assert.equal(readFileSync(join(repo, "src/value.js"), "utf8"), code, "구현 결과를 그대로 둔다");
    assert.match(status(repo), /요구사항: 확정됨 \(개정 2 · /);
    const [event] = applied(repo);
    assert.deepEqual([event.revision, event.detail?.previous, event.detail?.changes], [2, 1, "추가 1"]);
  }));

  test("계획 승인 응답이 적용되기 전에 요구 변경안이 확정되면 그 승인은 적용되지 않는다", consentRepo((repo) => {
    preparePlanFixture(repo);
    const approval = prepareConsentFixture(repo, { action: "plan" });
    observeConsentFixture(approval);
    amend(repo, "0이면 0을 반환해 주세요.", "0이면 0을 반환한다.");
    approveAndApplyFixture(repo, { action: "request", id: CONSENT_WORK_ID });
    assert.equal(loadActive(repo)!.phase, "analysis");
    assert.throws(() => applyConsent(repo, approval.id));
    assert.notEqual(approvalOf(loadWork(repo)!).status, "approved");
    assert.ok(existsSync(join(repo, CONSENT_SPEC)));
  }));
});
