/**
 * 검증 재시도 — 증거를 판정 입력으로 바꾸는 자리(evidence.ts)와 ⑧ 렌더의 하위 호환.
 *
 * 순수 판정 함수의 진리표(verifyState·nextRoundDecision·verifyNode·writeBlockReason·verifyBudget·budgetText —
 * 명세 T-P1~T-P10)는 retryPolicy.test.ts 에 있다. 여기서는 파일 없이 부를 수 있는 증거 쪽 함수와,
 * 새 필드가 없는 옛 증거의 ⑧ 이 바이트 그대로인지(T-L3)를 본다.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { collectWindowOpen, renderValidationDoc, reviewRoundUsageOf, testFrozen } from "../agent/evidence";
import type { Evidence, VerifyRun, VerifyView } from "../agent/evidence";
import type { ReviewLog, ReviewRound } from "../agent/review";
import { verifyBudget, verifyRetryOf } from "../agent/retryPolicy";
import { legacyReproClass } from "../agent/validate";
import type { Work } from "../agent/work";

const work = { active: { id: "ORD-1", target: "order" }, plan: { files: [{ path: "a.java" }, { path: "b.java" }, { path: "t.java" }] } } as unknown as Work;

function run(round: number, phase: VerifyRun["phase"], outcome: VerifyRun["outcome"], extra: Partial<VerifyRun> = {}): VerifyRun {
  return { round, phase, kind: phase === "check" ? "build" : "test", command: "node t", outcome, status: outcome === "passed" ? 0 : 3, tail: "", at: `t${round}`, ...extra };
}

/** 구현 전 dist 로 렌더한 옛 증거(retry·cause·testFreeze 없음, 2회차 실패 포함) */
const LEGACY: Evidence = {
  id: "ORD-1", target: "order", baseCommit: "c".repeat(40), treeHash: "sha256:1111222233334444", manifestHash: "sha256:m", planHash: "sha256:p",
  rounds: 2, fixRounds: 2,
  runs: [
    { round: 1, phase: "check", kind: "build", command: "node -e 0", outcome: "passed", status: 0, tail: "ok", at: "t1" },
    { round: 1, phase: "test", kind: "test", command: "node t", outcome: "failed", status: 3, tail: "not ok 1 - TC-1", at: "t2", logFile: ".code-agent/log/test-1-test.log" },
    { round: 2, phase: "check", kind: "build", command: "node -e 0", outcome: "error", status: null, tail: "실행 실패: 제한 시간 600초를 넘겨 중단했습니다", at: "t3" },
  ],
  testCases: [{ id: "TC-1", status: "failed", source: "출력", where: "테스트 실행 결과 (TAP)" }, { id: "TC-2", source: "없음" }],
  at: "t4",
};
const LEGACY_GOLDEN = "# ORD-1 검증 보고서\n\n<!-- 이 파일은 code-agent check · test 가 .code-agent/work/ORD-1/order.verify.json 에서 렌더한다. 손으로 고치면 게이트가 거부한다. -->\n\n## 검증 기준\n\n- 기준 커밋: cccccccccccccccccccccccccccccccccccccccc\n- 계획 파일 부분 트리 해시: sha256:1111222233334444\n- planHash: sha256:p\n- manifestHash: sha256:m\n- 대상: order · 계획 파일 3개\n- 고쳐 쓰기 회차: 2\n\n## 실행 결과\n\n| 회차 | 스테이지 | 종류 | 명령 | 결과 | exit |\n|---|---|---|---|---|---|\n| 1 | check | build | node -e 0 | passed | 0 |\n| 1 | test | test | node t | failed | 3 |\n| 2 | check | build | node -e 0 | error (돌지 못함) | - |\n\n## 테스트\n\n| TC | 결과 | 확인된 곳 | 근거 |\n|---|---|---|---|\n| TC-1 | failed | 출력 | 테스트 실행 결과 (TAP) |\n| TC-2 | unknown | 없음 | - |\n\n## 수정 루프\n\n- 1회차: 실패 test(failed)\n- 2회차: 실패 build(error)\n\n## 실패 로그\n\n### 1회차 test — failed\n\n```\nnot ok 1 - TC-1\n```\n\n### 2회차 build — error (돌지 못함)\n\n```\n실행 실패: 제한 시간 600초를 넘겨 중단했습니다\n```\n";

describe("⑧ 렌더의 하위 호환", () => {
  test("새 필드가 없는 옛 증거의 ⑧ 은 바이트가 그대로다(T-L3) — 진행 중 작업의 ⑧ 대조가 깨지지 않는다", () => {
    assert.equal(renderValidationDoc(work, LEGACY), LEGACY_GOLDEN);
  });

  test("새 필드가 있으면 원인 표지·회차 원인·재실행·동결 기준이 붙는다", () => {
    const evidence: Evidence = {
      ...LEGACY,
      runs: [LEGACY.runs[0], LEGACY.runs[1], { ...LEGACY.runs[2], cause: "timeout" }],
      retry: { version: 1, causes: { 1: "first", 2: "fix" }, reruns: { 2: 1 }, integrateReruns: {}, grants: [] },
      testFreeze: { round: 1, at: "t", files: { "t.java": "sha256:x" }, rebased: [{ round: 2, at: "t", by: "finding", files: ["t.java"] }] },
    };
    const doc = renderValidationDoc(work, evidence);
    // rounds 는 검증 회차 총수다 — 고쳐 쓰기 수는 회차 원인에서 따로 센다(옛 증거는 위 골든 그대로)
    assert.match(doc, /^- 검증 회차: 2 · 고쳐 쓰기 1\/2회$/m);
    assert.doesNotMatch(doc, /고쳐 쓰기 회차:/);
    assert.match(doc, /\| 2 \| check \| build \| node -e 0 \| error \(돌지 못함\) · 시간 초과 \| - \|/);
    assert.match(doc, /- 테스트 동결: 1회차부터 · kind:test 파일 1개/);
    assert.match(doc, /- 1회차 \(첫 실행\): 실패 test\(failed\)/);
    assert.match(doc, /- 2회차 \(고쳐 쓰기\): 실패 build\(error\) · 같은 코드 재실행 1회 · ⑨ 지적으로 바뀐 테스트 파일: t\.java/);
    assert.match(doc, /### 2회차 build — error \(돌지 못함\) · 시간 초과/);
  });
});

describe("리뷰 회차 사용량 — 판정 함수는 하나다", () => {
  const binding = { baseCommit: "b", planHash: "p", manifestHash: "m" };
  const round = (n: number, extra: Partial<ReviewRound> = {}): ReviewRound => ({ round: n, at: "t", treeHash: `h${n}`, ...binding, ...extra });
  const log = (rounds: ReviewRound[], extra: Partial<ReviewLog> = {}): ReviewLog => ({ id: "ORD-1", target: "order", rounds, ...extra });

  test("기록이 없거나 묶임이 다른 회차가 있으면 회차를 버린다(stale) — 사람 허용도 함께 버린다", () => {
    assert.deepEqual(reviewRoundUsageOf(undefined, binding), { used: 0, base: 3, limit: 3, usedPaths: [], stale: true });
    const grants = [{ key: "reviewRounds" as const, scope: "", step: 1, consent: "c", at: "t", reason: "r" }];
    assert.equal(reviewRoundUsageOf(log([round(1), round(2, { planHash: "other" })], { grants }), binding).stale, true);
    assert.equal(reviewRoundUsageOf(log([round(1), round(2, { planHash: "other" })], { grants }), binding).limit, 3);
  });

  test("한도는 기록된 limit 에 사람 허용을 더한다. limit 이 없는 옛 기록은 3회차 이상이면 유예 1회를 받는다", () => {
    assert.deepEqual(reviewRoundUsageOf(log([round(1), round(2)], { used: [{ id: "F1", path: "t.java", round: 1 }] }), binding),
      { used: 2, base: 3, limit: 3, usedPaths: ["t.java"], stale: false });
    assert.equal(reviewRoundUsageOf(log([round(1), round(2), round(3), round(4)]), binding).limit, 5);
    assert.equal(reviewRoundUsageOf(log([round(1), round(2), round(3), round(4)], { limit: 3 }), binding).limit, 3, "고정된 한도는 유예하지 않는다");
    const grants = [{ key: "reviewRounds" as const, scope: "", step: 1, consent: "c", at: "t", reason: "r" }, { key: "fix" as const, scope: "", step: 1, consent: "c", at: "t", reason: "r" }];
    assert.equal(reviewRoundUsageOf(log([round(1), round(2), round(3)], { limit: 3, grants }), binding).limit, 4);
  });
});

describe("테스트 동결과 수집 수정 창", () => {
  test("결과가 인식된(또는 코드 결함으로 실패한) test 실행이나 재현부터 언다 — 결과 미확인 실행은 얼리지 않는다", () => {
    const base = { ...LEGACY, runs: [run(1, "check", "passed"), run(1, "test", "passed")], testCases: [{ id: "TC-1", source: "테스트 파일" as const, status: "unknown" as const }] };
    assert.equal(testFrozen(base), false);
    assert.equal(testFrozen({ ...base, testCases: [{ id: "TC-1", source: "출력", status: "passed" }] }), true);
    assert.equal(testFrozen({ ...base, runs: [run(1, "test", "failed")] }), true);
    assert.equal(testFrozen({ ...base, runs: [run(1, "test", "error", { cause: "environment" })] }), false, "환경 오류로 돌지 못한 실행은 얼리지 않는다");
    assert.equal(testFrozen({ ...base, testFreeze: { round: 1, at: "t", files: {} } }), true);
    assert.equal(testFrozen({ ...base, repro: { at: "t", testTreeHash: "h", cases: ["TC-1"], found: [] } }), true);
  });

  test("수집 수정 창은 이 회차 test 가 결과 미확인이고 수집·총 회차가 남았을 때만이다 — fix 작업(수집 한도 0)은 없다(T-P10)", () => {
    const retry = verifyRetryOf({ rounds: 1, runs: [], retry: { causes: { 1: "first" } } });
    const view = (testState: VerifyView["testState"], collectLimit?: number): VerifyView => ({
      round: 1, state: "result-unconfirmed", emptyRound: false, testState, retry,
      budget: verifyBudget({ retry, round: 1, fixRounds: 2, collectLimit, reviewRounds: { used: 0, limit: 3 } }),
    });
    assert.equal(collectWindowOpen(view("result-unconfirmed")), true);
    assert.equal(collectWindowOpen(view("passed")), false);
    assert.equal(collectWindowOpen(view(undefined)), false, "앞 회차를 이어받지 않는다");
    assert.equal(collectWindowOpen(view("result-unconfirmed", 0)), false);
    assert.equal(view("result-unconfirmed", 0).budget.totalRounds.limit, 6);
  });
});

describe("재현 시도의 원인 추정", () => {
  test("class 가 없는 옛 시도는 문구로 추정한다 — 종류 이름에 -·: 가 있어도 맞는다", () => {
    assert.equal(legacyReproClass("재현 실행이 환경 오류로 실패했습니다 (test: 출력에 \"x\")"), "environment");
    assert.equal(legacyReproClass("재현 명령이 돌지 못했습니다 (e2e-test: error) — 재현은"), "environment");
    assert.equal(legacyReproClass("재현 명령이 돌지 못했습니다 (plugin:x: not-run) — 재현은"), "precondition");
    assert.equal(legacyReproClass("재현하지 못했습니다 — test: passed."), "result-unconfirmed");
  });
});
