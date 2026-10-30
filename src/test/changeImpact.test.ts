import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";

import { impactAfter, impactBrief, requirementImpact, type RequirementImpact } from "../agent/changeImpact";
import { context, next, requireValidatable } from "../agent/commands";
import { loadEvidence, reviewRoundUsage, stageProblems } from "../agent/evidence";
import { loadActive, saveActive } from "../agent/layout";
import { loadReview, openRound, reviewProblems } from "../agent/review";
import { integrate } from "../agent/validate";
import { verify } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { ORDER, repo, toDeliver, toIntegrate, writeFindings, createStageRepo, removeStageRepo } from "./stageFixture";

/**
 * 요구 개정의 영향(changeImpact.ts) — 바뀐 항목 ID → 01 R → 계획 Task·AC → ⑦ TC → 파일, 보안 낱말, 범위 미입증의 보수 판정과
 * 영향 뒤의 검증·리뷰 재요구. 영향 기록은 흐름이 개정을 따를 때 커서에 남는다(그 경로는 requestRevisionFlow.test 가 본다).
 */
const ANALYSIS = [
  "## R1 · 조회", "출처: REQ-1", "근거: \"주문을 조회한다.\"",
  "## R2 · 권한", "출처: REQ-2, CON-1", "근거: \"관리자만 취소한다.\"",
].join("\n");
const PLAN = {
  files: [{ path: "src/Order.java", requirements: ["R1"] }, { path: "src/Auth.java", requirements: ["R2"] }, { path: "test/OrderTest.java", requirements: ["R1", "R2"] }],
  tasks: [
    { id: "T1", requirements: ["R1"], files: ["src/Order.java"], acceptance: ["AC-R1-1"] },
    { id: "T2", requirements: ["R2"], files: ["src/Auth.java"], acceptance: ["AC-R2-1", "AC-R2-2"] },
    { id: "T3", requirements: ["R1", "R2"], files: ["test/OrderTest.java"], acceptance: ["AC-R1-1", "AC-R2-1", "AC-R2-2"] },
  ],
};
const SPEC = ["## 테스트 케이스", "| TC | 수준 | AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
  "| TC-1 | Unit | AC-R1-1 | 조회 | 주문 |", "| TC-2 | Unit | AC-R2-1 | 관리자 취소 | 취소됨 |", "| TC-3 | Unit | AC-R2-2 | 일반 사용자 취소 | 403 |"].join("\n");
const input = { analysis: ANALYSIS, plan: PLAN, testSpec: SPEC, at: "2026-10-30T00:00:00.000Z" };

describe("영향 계산", () => {
  test("수정한 항목은 출처 R → Task·AC → TC → 파일로 좁히고, 권한·JWT 글이면 보안 영향이다", () => {
    const impact = requirementImpact({ ...input, changes: [{ op: "modify", id: "REQ-2", before: "관리자만 취소한다.", text: "JWT 의 ADMIN 권한이 있는 사용자만 취소한다." }], revision: 3, previous: 2 });
    assert.deepEqual([impact.items, impact.requirements, impact.tasks, impact.acceptance, impact.cases, impact.files],
      [["REQ-2"], ["R2"], ["T2", "T3"], ["AC-R2-1", "AC-R2-2"], ["TC-2", "TC-3"], ["src/Auth.java", "test/OrderTest.java"]]);
    assert.deepEqual(impact.security, ["권한", "JWT·토큰"]);
    assert.deepEqual(impact.conservative, []);
    assert.equal(impactBrief(impact), "요구 개정 3: 항목 REQ-2 · R R2 · Task T2, T3 · TC 2개 · 파일 2개 · 보안 영향(권한·JWT·토큰)");
  });

  test("보안과 무관한 글 수정은 그 R 의 파일만이고, 데이터 계약 낱말은 보안 영향으로 본다", () => {
    const plain = requirementImpact({ ...input, changes: [{ op: "modify", id: "REQ-1", before: "주문을 조회한다.", text: "주문을 최신순으로 조회한다." }] });
    assert.deepEqual([plain.files, plain.security, plain.conservative], [["src/Order.java", "test/OrderTest.java"], [], []]);
    const contract = requirementImpact({ ...input, changes: [{ op: "modify", id: "REQ-1", before: "주문을 조회한다.", text: "주문 조회 응답 형식에 status 컬럼을 더한다." }] });
    assert.deepEqual(contract.security, ["데이터 계약"]);
  });

  test("범위를 입증하지 못하면 보수적으로 전체로 본다 — 새 항목·추적되지 않는 ID·범위 밖·범위 머리말·문서 없음·개정 기록 없음", () => {
    const reasons = (impact: RequirementImpact) => impact.conservative.join(" / ");
    assert.match(reasons(requirementImpact({ ...input, changes: [{ op: "add", id: "REQ-3", text: "주문을 내보낸다." }] })), /새 항목 REQ-3/);
    assert.match(reasons(requirementImpact({ ...input, changes: [{ op: "modify", id: "DONE-1", before: "a", text: "b" }] })), /DONE-1 을 출처로 둔 R 이 01 에 없습니다/);
    assert.match(reasons(requirementImpact({ ...input, changes: [{ op: "remove", id: "OUT-1", before: "결제", reason: "범위로" }] })), /범위 밖 OUT-1/);
    assert.match(reasons(requirementImpact({ ...input, changes: [{ op: "header", field: "target", before: "order", after: "billing" }] })), /작업 범위 머리말\(target\)/);
    assert.deepEqual(requirementImpact({ ...input, changes: [{ op: "header", field: "title", before: "a", after: "b" }] }).conservative, [], "제목은 범위가 아니다");
    assert.match(reasons(requirementImpact({ changes: [{ op: "modify", id: "REQ-1", before: "a", text: "b" }] })), /01 이 아직 없어[\s\S]*승인된 계획이 아직 없어/);
    assert.match(reasons(requirementImpact({ ...input, changes: [], unknownChanges: true })), /개정 기록이 없어/);
  });
});

describe("영향 뒤 다시 검증", () => {
  beforeEach(() => createStageRepo("ca-impact-"));
  afterEach(() => removeStageRepo());

  /** 흐름이 보안 영향이 있는 개정을 따른 자리 — 계획·트리는 그대로라 검증 증거의 묶임이 유지된다 */
  function followImpact(files: string[], security: string[]): RequirementImpact {
    const active = loadActive(repo)!;
    assert.ok(active.request, "시작한 작업은 따르는 확정 요구를 기록한다");
    const impact: RequirementImpact = { at: new Date(Date.now() + 1).toISOString(), revision: 2, previous: 1, items: ["REQ-1"], requirements: ["R1"], tasks: [],
      acceptance: ["AC-R1-1"], cases: ["TC-1"], files, security, conservative: [] };
    saveActive(repo, { ...active, request: { ...active.request, impacts: [impact] } });
    return impact;
  }

  test("권한·JWT 영향 — 계획이 그대로여도 check·test 를 같은 회차로 다시 돌리고, 같은 트리의 요구 변경 회차로 전체를 다시 리뷰하며, 통합 검증도 다시 돈다", async () => {
    await toDeliver();
    const rounds = loadEvidence(repo, "ORD-1", "order")!.rounds;
    const impact = followImpact([`${ORDER}/domain/Order.java`], ["권한", "JWT·토큰"]);
    const work = loadWork(repo)!;
    assert.ok(impactAfter(work.active, undefined));
    assert.match(stageProblems(work, "check").join("\n"), /요구 개정 2: [^\n]*보안 영향\(권한·JWT·토큰\) — 이 영향 뒤 check 를 다시 돌리지 않았습니다/);
    assert.match(stageProblems(work, "integrate").join("\n"), /이 영향 뒤 integrate 를 다시 돌리지 않았습니다/);
    assert.match(reviewProblems(work).join("\n"), /이 영향 뒤 리뷰 회차가 없습니다/);

    // verify 가 반영 자리에서 check 로 되감아 같은 트리를 다시 돈다 — 회차를 쓰지 않는다
    assert.equal((await verify(repo)).node, "review");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.rounds, rounds, "같은 트리의 다시 실행은 새 회차가 아니다");
    assert.deepEqual(stageProblems(loadWork(repo)!, "test"), []);

    const used = reviewRoundUsage(loadWork(repo)!).used;
    openRound(requireValidatable(repo, "review"));
    const last = loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!;
    assert.deepEqual([last.cause, last.impact], ["requirement", impact.at]);
    assert.equal(reviewRoundUsage(loadWork(repo)!).used, used, "요구 변경 회차는 리뷰 회차 한도에 세지 않는다");
    assert.match(context(repo), /요구 변경 재검토[^\n]*재검토 범위: 계획 파일 3개[^\n]*보안 영향이라 인증·권한·토큰·데이터 계약 경로/);
    assert.throws(() => openRound(requireValidatable(repo, "review")), /이미 지금 트리를 보고 있습니다/, "같은 영향으로 두 번 열지 않는다");
    writeFindings();
    assert.deepEqual(reviewProblems(loadWork(repo)!), []);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
    await integrate(requireValidatable(repo, "integrate"));
    assert.deepEqual(stageProblems(loadWork(repo)!, "integrate"), []);
  });

  test("파일·보안·범위 미입증이 없는 영향은 검증을 다시 요구하지 않는다", async () => {
    await toIntegrate();
    followImpact([], []);
    const work = loadWork(repo)!;
    assert.equal(impactAfter(work.active, undefined), undefined);
    assert.deepEqual(stageProblems(work, "check"), []);
    assert.deepEqual(reviewProblems(work), []);
  });
});
