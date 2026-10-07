/**
 * 실패 원인별 재시도 규약(retryPolicy.ts) — 순수 판정 함수의 진리표.
 *
 * 원인 분류·카운터·한도·사람 허용·검증 회차 판정·계획 배정·교차 실행 분류·잠금·hook 실패 코드·안내 문구를
 * 파일 없이 본다. 교차 실패 분류 fixture 는 설계 sandbox(C1 rev3 40건, C6 모델·강도 문구)와 같다.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Stop } from "../agent/stop";
import {
  budgetOf, budgetText, classifyCrossFailure, consecutiveCrossStops, COUNTER_KEYS, COUNTER_LABEL, CROSS_NO_ANSWER, CROSS_PATTERNS, crossBudgets,
  crossFailureText, crossPointDecision, crossPointHint, crossPointState, crossPreflight, deriveLegacyCauses, environmentMatch, failure,
  FAILURE_CLASSES, grantFor, grantScope, GRANT_STEP, guidance, GUIDE_KEYS, GUIDE_VARIANT_KEYS, GUIDE_VARIANTS, hookFailureExit, hookFailureInput,
  isFailureClass, LIMITS, limitExceededText, limitOf, lockDecision, nextRoundDecision, nodeCounter, orphanState, placeholdersOf,
  planningDispatchDecision, POLICIES, recordedVariant, refuse, renderRetryPolicyTable, retrySummary, RetryRefused, roundStateOf, runCauseOf,
  runClass, sameRoundDecision, subagentExit, TIMING, verifyBudget, verifyNode, verifyRetryOf, verifyState, writeBlockReason,
  type AgentView, type Budget, type CrossAttemptView, type CrossProbe, type RetryGrant, type RunView,
  type VerifyBudget, type VerifyState,
} from "../agent/retryPolicy";

const HOST_SPECIFIC = [/(?<![\w/])\/ca-[a-z]/, /\$ca-/, /AskUserQuestion/, /\bBash\b/, /run_in_background/, /600000ms/];
const filled = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, "v"]));

describe("원인 정책 표는 21개 원인을 빠짐없이 같은 꼴로 정한다", () => {
  test("모든 원인에 정책이 있고 이름표가 겹치지 않는다", () => {
    assert.equal(FAILURE_CLASSES.length, 21);
    for (const cls of FAILURE_CLASSES) {
      const policy = POLICIES[cls];
      assert.equal(policy.id, cls);
      assert.ok(policy.label && policy.detect && policy.retryText && policy.limitText && policy.fixRoundText && policy.exceededText && policy.guide, cls);
      assert.ok(policy.enforcedAt.length > 0, cls);
      for (const key of policy.counters) assert.ok((COUNTER_KEYS as readonly string[]).includes(key), `${cls}: ${key}`);
    }
    assert.equal(new Set(FAILURE_CLASSES.map((cls) => POLICIES[cls].label)).size, 21);
    assert.deepEqual(FAILURE_CLASSES.filter((cls) => POLICIES[cls].auxiliary), ["precondition", "hook-failure"]);
    assert.equal(isFailureClass("code-defect"), true);
    assert.equal(isFailureClass("answered-input"), false);
  });

  test("안내 문구의 자리표시는 GUIDE_KEYS·GUIDE_VARIANT_KEYS 와 같고, 채우면 남는 자리표시가 없다", () => {
    for (const cls of FAILURE_CLASSES) {
      assert.deepEqual(placeholdersOf(POLICIES[cls].guide), [...GUIDE_KEYS[cls]], cls);
      assert.equal(/\{[A-Za-z]\w*\}/.test(guidance(cls, filled(GUIDE_KEYS[cls]))), false, cls);
      const variants = GUIDE_VARIANTS[cls] ?? {};
      assert.deepEqual(Object.keys(variants).sort(), Object.keys(GUIDE_VARIANT_KEYS[cls] ?? {}).sort(), cls);
      for (const [name, text] of Object.entries(variants)) {
        const keys = GUIDE_VARIANT_KEYS[cls]![name];
        assert.deepEqual(placeholdersOf(text), [...keys], `${cls}/${name}`);
        assert.equal(/\{[A-Za-z]\w*\}/.test(guidance(cls, filled(keys), name)), false, `${cls}/${name}`);
      }
    }
  });

  test("안내 문구는 호스트 중립이다 — 스킬 표기·Claude 도구 이름을 쓰지 않는다", () => {
    for (const cls of FAILURE_CLASSES) {
      const texts = [guidance(cls, filled(GUIDE_KEYS[cls])),
        ...Object.keys(GUIDE_VARIANTS[cls] ?? {}).map((name) => guidance(cls, filled(GUIDE_VARIANT_KEYS[cls]![name]), name))];
      for (const text of texts) for (const pattern of HOST_SPECIFIC) assert.equal(pattern.test(text), false, `${cls}: ${pattern} — ${text}`);
    }
  });

  test("동의 두 원인의 값 키는 detail 하나다(failureHint 계약)", () => {
    assert.deepEqual(GUIDE_KEYS["consent-target-changed"], ["detail"]);
    assert.deepEqual(GUIDE_KEYS["consent-apply-failed"], ["detail"]);
    const text = guidance("consent-apply-failed", { detail: "git commit 이 실패했습니다" });
    assert.match(text, /git commit 이 실패했습니다/);
    assert.equal(text.includes("{"), false);
  });

  test("값이 없는 자리표시는 그대로 남기고, 없는 변형은 오류다", () => {
    assert.match(guidance("same-input-repeat"), /\{limit\}번 실패/);
    assert.match(guidance("same-input-repeat", { limit: 3 }), /같은 입력으로 3번 실패했습니다/);
    assert.throws(() => guidance("code-defect", {}, "없는-변형"), /안내 문구가 없습니다/);
    assert.match(guidance("interrupted", { round: 3, phase: "test", rerunLeft: 1 }, "empty"), /^3회차 test 가 끝 기록 없이 끊겼습니다.*셸 명령의 제한 시간을 가장 길게/);
  });

  test("담당 형식·내용 오류 — 변형 없는 호출은 같은 담당에게 돌려보내는 문구(C2 SubagentStop), 기록된 시도는 record 변형", () => {
    // C2 §3.6 은 되돌림 경로에서 guidance(cls, { detail }) 를 변형 없이 부른다 — 기록 문구가 나가면 안 된다
    const format = guidance("agent-format-error", { detail: "JSON 아님" });
    assert.match(format, /^결과 형식 오류입니다 — JSON 아님\. 같은 배정의 resultShape 형태 JSON 하나로 다시 반환하세요/);
    const content = guidance("agent-content-error", { detail: "- 근거 없음" });
    assert.match(content, /^결과가 검사에 걸렸습니다 — 고친 뒤 같은 형태의 결과 JSON을 다시 반환하세요\(한 번만 돌려보냅니다\):\n- 근거 없음$/);
    for (const text of [format, content]) {
      assert.equal(/기록했습니다|planning advance|\{/.test(text), false, text);
    }
    const recorded = (cls: "agent-format-error" | "agent-content-error") => guidance(cls, { id: "design", detail: "d" }, recordedVariant({ class: cls }));
    assert.match(recorded("agent-format-error"), /^결과 형식 오류로 기록했습니다 — d\. planning advance 또는 planning repair design 로/);
    assert.match(recorded("agent-content-error"), /^결과가 검사에 걸려 실패로 기록했습니다 — d\. .*design 의 inputs/);
    assert.equal(recordedVariant({ class: "cross-timeout", kind: "interrupted" }), "interrupted");
    assert.equal(recordedVariant({ class: "cross-timeout", kind: "timeout" }), undefined);
    assert.equal(recordedVariant({ class: "dispatch-orphan" }), undefined);
    for (const cls of FAILURE_CLASSES) {
      const variant = recordedVariant({ class: cls, kind: "interrupted" });
      if (variant) assert.ok(GUIDE_VARIANTS[cls]?.[variant], `${cls}/${variant}`);
    }
  });

  test("표에 렌더되지 않는 정책 필드는 렌더되는 문구와 맞는다", () => {
    const exceeded: Readonly<Record<string, RegExp>> = {
      decision: /decision/, "consent:judgment": /사람|judgment/, "stop-record-proceed": /진행/, stop: /Stop|사람/, blocked: /사람 판단|같은 입력 규칙/,
    };
    const fixRound: Readonly<Record<string, RegExp>> = {
      true: /^씀/, false: /^(?:안 씀|—)/, "after-change": /^같은 코드면 안 씀, .*고치면 씀$/, "after-collect": /^수집 수정 1회는 안 씀, 그 뒤 씀$/,
    };
    for (const cls of FAILURE_CLASSES) {
      const policy = POLICIES[cls];
      assert.ok(exceeded[policy.onExhausted], `${cls}: onExhausted ${policy.onExhausted}`);
      assert.match(policy.exceededText, exceeded[policy.onExhausted], `${cls}: onExhausted ${policy.onExhausted} ↔ ${policy.exceededText}`);
      assert.match(policy.fixRoundText, fixRound[String(policy.consumesFixRound)], `${cls}: consumesFixRound ${policy.consumesFixRound} ↔ ${policy.fixRoundText}`);
    }
    // code-defect 한도 칸의 fixRounds 기본값은 매니페스트 스키마(core/manifest.ts)에서 온다 — retryPolicy 는 zod 모듈을 import 하지 않는다
    const manifest = readFileSync(join(__dirname, "..", "..", "src", "core", "manifest.ts"), "utf8");
    const fixDefault = /fixRounds: z[\s\S]*?\.default\((\d+)\)/.exec(manifest)?.[1];
    assert.ok(fixDefault, "manifest.ts 의 fixRounds 기본값을 찾지 못했습니다");
    assert.ok(POLICIES["code-defect"].limitText.includes(`fixRounds(기본 ${fixDefault})`), POLICIES["code-defect"].limitText);
  });

  test("한도 거부 문구는 카운터 이름표와 원래 원인을 쓴다", () => {
    const refused = failure("limit-exceeded", "x", { origin: "blocking-finding", counter: { key: "reviewRounds", used: 3, limit: 3 } });
    assert.match(limitExceededText(refused, "doc/work/W/09-review.md"), /^리뷰 회차 한도 3회를 모두 썼습니다\(원인: 차단 지적\)/);
    assert.match(limitExceededText(failure("limit-exceeded", "x", { origin: "environment", counter: { key: "rerun", used: 2, limit: 2 } }), "e"), /같은 코드 재실행 한도 2회/);
    assert.match(limitExceededText(failure("limit-exceeded", "x", { counter: { key: "integrateRerun", used: 2, limit: 2 } }), "e"), /통합 검증 재실행 한도 2회/);
    for (const key of COUNTER_KEYS) assert.ok(COUNTER_LABEL[key], key);
  });

  test("RetryRefused 는 Stop 이고 실패 기록을 지닌다", () => {
    assert.throws(() => refuse("precondition", "전제가 없습니다"), (error: unknown) =>
      error instanceof RetryRefused && error instanceof Stop && error.failure.class === "precondition" && error.message === "전제가 없습니다");
    const made = failure("cross-unavailable", "d", { kind: "auth", at: "2026-10-07T00:00:00.000Z" });
    assert.deepEqual(made, { class: "cross-unavailable", at: "2026-10-07T00:00:00.000Z", detail: "d", kind: "auth" });
    assert.equal(new RetryRefused(made, "다른 문구").message, "다른 문구");
  });
});

describe("한도와 사람 허용", () => {
  const grant = (key: RetryGrant["key"], scope: string, step = 1): RetryGrant => ({ key, scope, step, consent: "c", at: "t", reason: "r" });

  test("유효 한도는 기본 한도에 같은 key·scope 의 허용 합을 더한다", () => {
    assert.equal(limitOf("rerun", undefined), LIMITS.rerun);
    assert.equal(limitOf("fix", 2, [grant("fix", ""), grant("fix", ""), grant("fix", "round:1"), grant("rerun", "")]), 4);
    assert.equal(limitOf("rerun", undefined, [grant("rerun", "round:2"), grant("rerun", "round:3")], "round:2"), 3);
    assert.equal(limitOf("taskTotal", undefined, [grant("taskTotal", "planning:a", 3)], "planning:a"), 9);
    assert.equal(limitOf("rerun", undefined, [grant("rerun", "", -5), grant("rerun", "", Number.NaN), grant("rerun", "", 0.5), grant("rerun", "", 0)]), LIMITS.rerun,
      "손상된 허용(음수·NaN·소수·0)은 세지 않는다");
    assert.throws(() => limitOf("fix", undefined), /기본 한도가 없습니다/);
    assert.deepEqual(budgetOf("rerun", 2, undefined), { key: "rerun", used: 2, limit: 2, left: 0, exhausted: true });
    assert.deepEqual(budgetOf("rerun", 3, undefined, [grant("rerun", "")]), { key: "rerun", used: 3, limit: 3, left: 0, exhausted: true });
    assert.deepEqual(budgetOf("rerun", 1, undefined), { key: "rerun", used: 1, limit: 2, left: 1, exhausted: false });
  });

  test("grantScope 는 파일·카운터마다 정해진 범위 문자열을 만든다", () => {
    assert.equal(grantScope({ file: "verify", key: "fix" }), "");
    assert.equal(grantScope({ file: "verify", key: "reproAttempt" }), "");
    assert.equal(grantScope({ file: "verify", key: "rerun", round: 3 }), "round:3");
    assert.equal(grantScope({ file: "verify", key: "integrateRerun", round: 1 }), "round:1");
    assert.equal(grantScope({ file: "verify", key: "reproRerun", tree: "sha256:ab" }), "tree:sha256:ab");
    assert.equal(grantScope({ file: "review", key: "reviewRounds" }), "");
    assert.equal(grantScope({ file: "review", key: "crossPoint", round: 2 }), "round:2");
    assert.equal(grantScope({ file: "planning", key: "taskTotal", taskId: "design" }), "planning:design");
    assert.equal(grantScope({ file: "planning", key: "sameInput", taskId: "design", inputHash: "h1" }), "planning:design:h1");
    assert.equal(grantScope({ file: "planning", key: "crossError", criticDispatchId: "d-1" }), "critic:d-1");
  });

  test("허용은 늘릴 수 있는 카운터가 소진됐을 때만 만든다", () => {
    const exhausted = budgetOf("taskTotal", 6, undefined);
    assert.deepEqual(grantFor({ key: "taskTotal", scope: "planning:a", budget: exhausted, consent: "id", reason: "사유", at: "t" }),
      { key: "taskTotal", scope: "planning:a", step: GRANT_STEP.taskTotal, consent: "id", at: "t", reason: "사유" });
    assert.throws(() => grantFor({ key: "rerun", scope: "", budget: budgetOf("rerun", 1, undefined), consent: "id", reason: "r" }),
      (error: unknown) => error instanceof Stop && /한도가 남아 있어\(사용 1 \/ 한도 2\)/.test(error.message));
    for (const key of ["collect", "totalRounds", "agentReturn", "correction", "crossTimeout", "lockBusy", "없는키"]) {
      assert.throws(() => grantFor({ key, scope: "", budget: exhausted, consent: "id", reason: "r" }), /사람 허용으로 늘리지 않습니다/, key);
    }
    // 다른 카운터의 소진된 예산으로 소진 검사를 우회하지 못한다
    assert.throws(() => grantFor({ key: "fix", scope: "", budget: exhausted, consent: "id", reason: "r" }),
      (error: unknown) => error instanceof Error && !(error instanceof Stop) && /fix.*taskTotal/.test(error.message));
  });
});

// ---- 검증 ----

const run = (round: number, phase: string, outcome: RunView["outcome"], extra: Partial<RunView> = {}): RunView => ({ round, phase, kind: phase === "check" ? "build" : "test", outcome, ...extra });
type BudgetKey = keyof VerifyBudget;
function budgets(exhausted: Partial<Record<BudgetKey, boolean>> = {}): VerifyBudget {
  const make = (key: BudgetKey, counter: Budget["key"]): Budget => exhausted[key]
    ? { key: counter, used: 2, limit: 2, left: 0, exhausted: true } : { key: counter, used: 0, limit: 2, left: 2, exhausted: false };
  return { fix: make("fix", "fix"), collect: make("collect", "collect"), rerun: make("rerun", "rerun"), integrateRerun: make("integrateRerun", "integrateRerun"),
    reviewRounds: make("reviewRounds", "reviewRounds"), totalRounds: make("totalRounds", "totalRounds") };
}

describe("검증 실행 분류와 상태", () => {
  test("실행 원인은 필드가 우선이고, 옛 기록은 tail 문구로 추정한다", () => {
    assert.equal(runCauseOf(run(1, "test", "error", { cause: "timeout" })), "timeout");
    assert.equal(runCauseOf(run(1, "test", "failed", { environment: "Connection refused" })), "environment");
    assert.equal(runCauseOf(run(1, "test", "error", { tail: "실행 실패: 제한 시간 600초를 넘겨 중단했습니다" })), "timeout");
    assert.equal(runCauseOf(run(1, "test", "error", { tail: "실행 실패: 실행 파일을 찾을 수 없습니다: gradle" })), "missing-tool");
    assert.equal(runCauseOf(run(1, "test", "error", { tail: "실행 실패: spawn EINVAL" })), "spawn");
    assert.equal(runCauseOf(run(1, "test", "failed", { tail: "실행 실패: x" })), undefined, "failed 는 tail 로 추정하지 않는다");
    assert.equal(runClass(run(1, "test", "not-run")), "precondition");
    assert.equal(runClass(run(1, "test", "not-run", { kind: "plugin:lint" })), "environment");
    assert.equal(runClass(run(1, "test", "error")), "environment", "원인 미상 error 는 돌지 못한 것");
    assert.equal(runClass(run(1, "test", "failed")), "defect");
  });

  test("verifyState 8경우(T-P1)", () => {
    const at = (runs: RunView[], cases?: { status?: string }[]) => verifyState({ phase: "test", round: 1, runs, cases });
    assert.equal(at([run(1, "check", "passed")]), "interrupted", "그 단계 실행이 없는 회차");
    assert.equal(at([run(1, "test", "failed")]), "code-defect");
    assert.equal(at([run(1, "test", "failed", { environment: "Connection refused" })], [{ status: "failed" }]), "code-defect", "실패 TC 가 환경 문구보다 우선");
    assert.equal(at([run(1, "test", "not-run")]), "precondition");
    assert.equal(at([run(1, "test", "not-run", { kind: "plugin:x" })]), "environment");
    assert.equal(at([run(1, "test", "error", { tail: "실행 실패: 제한 시간 60초를 넘겨 중단했습니다" })]), "interrupted");
    assert.equal(at([run(1, "test", "failed", { cause: "environment" })]), "environment");
    assert.equal(at([run(1, "test", "passed")], [{ status: "passed" }, { status: "unknown" }]), "result-unconfirmed");
    assert.equal(at([run(1, "test", "passed")], [{ status: "passed" }]), "passed");
  });

  test("회차 상태는 끊긴 test 를 중단으로 보고, test 가 없으면 앞 회차의 test 상태를 이어받는다(T-P9)", () => {
    const started = { phase: "test" as const, round: 3, pid: 1, host: "h", at: "t" };
    assert.deepEqual(roundStateOf({ rounds: 3, runs: [run(3, "check", "passed")], started }), { state: "interrupted", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 3, runs: [run(2, "test", "failed"), run(3, "check", "passed")] }), { state: "code-defect", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 3, runs: [run(2, "test", "passed"), run(3, "check", "passed")] }), { state: "passed", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 3, runs: [run(2, "test", "failed")] }), { state: "interrupted", emptyRound: true });
    assert.deepEqual(roundStateOf({ rounds: 0, runs: [] }), { state: "none", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 2, runs: [run(2, "check", "passed"), run(2, "test", "passed")], testCases: [{ status: "unknown" }] }),
      { state: "result-unconfirmed", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 2, runs: [run(2, "check", "passed"), run(2, "integrate", "failed")] }), { state: "code-defect", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 2, runs: [run(2, "check", "passed")], started: { ...started, phase: "integrate", round: 2 } }),
      { state: "interrupted", emptyRound: false }, "시작 표지만 남은 통합 검증");
    assert.deepEqual(roundStateOf({ rounds: 2, runs: [run(2, "check", "passed")], started }), { state: "passed", emptyRound: false }, "다른 회차의 표지는 보지 않는다");
  });

  test("같은 회차 재사용이 지운 test·통합 검증 상태는 다시 돌기 전까지 회차 상태에 남는다", () => {
    const wiped = { test: { round: 1, state: "environment" as const } };
    // 재사용으로 test 기록이 지워졌다 — 앞 회차 이어받기(없음)가 아니라 지운 상태다
    assert.deepEqual(roundStateOf({ rounds: 1, runs: [run(1, "check", "passed")], wiped }), { state: "environment", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 1, runs: [run(1, "check", "passed")] }), { state: "passed", emptyRound: false }, "지운 상태가 없으면 통과로 보인다");
    // 지운 test 는 그 뒤 test 가 돌기 전까지 마지막 test 상태다 — 다음 회차도 이어받는다
    assert.deepEqual(roundStateOf({ rounds: 2, runs: [run(1, "test", "passed"), run(1, "check", "passed"), run(2, "check", "passed")], wiped: { test: { round: 1, state: "interrupted" } } }),
      { state: "interrupted", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 2, runs: [run(2, "check", "passed"), run(2, "test", "passed")], wiped }), { state: "passed", emptyRound: false }, "이 회차 test 기록이 우선이다");
    // 지운 통합 검증은 그 회차에만 든다
    const integrate = { integrate: { round: 1, state: "environment" as const } };
    assert.deepEqual(roundStateOf({ rounds: 1, runs: [run(1, "check", "passed"), run(1, "test", "passed")], wiped: integrate }), { state: "environment", emptyRound: false });
    assert.deepEqual(roundStateOf({ rounds: 2, runs: [run(2, "check", "passed"), run(2, "test", "passed")], wiped: integrate }), { state: "passed", emptyRound: false });
  });

  test("환경 분류는 같은 실행에 실패 결과가 없을 때만 한다(T-P5)", () => {
    const patterns = ["Connection refused"];
    assert.equal(environmentMatch("not ok 1 - TC-1\nConnection refused", patterns, [{ status: "failed" }]), undefined);
    assert.equal(environmentMatch("not ok 3 - other\nConnection refused", patterns, [{ status: "passed" }, { status: "failed" }]), undefined);
    assert.equal(environmentMatch("ok 1 - TC-1\nConnection refused", patterns, [{ status: "passed" }]), "Connection refused");
    assert.equal(environmentMatch("Connection refused", undefined, []), undefined);
    assert.equal(environmentMatch("other", patterns, []), undefined);
  });
});

describe("검증 카운터·회차 판정", () => {
  test("옛 증거의 회차 원인 추정(T-P6)", () => {
    assert.deepEqual(deriveLegacyCauses(3, [run(1, "test", "failed"), run(2, "test", "failed"), run(3, "test", "passed")]), { 1: "first", 2: "fix", 3: "fix" });
    assert.deepEqual(deriveLegacyCauses(4, [run(1, "test", "passed"), run(2, "test", "passed"), run(3, "test", "passed")]),
      { 1: "first", 2: "review", 3: "review", 4: "review" });
    assert.deepEqual(deriveLegacyCauses(3, [run(1, "check", "passed")]), { 1: "first", 2: "review", 3: "fix" }, "빈 회차 다음은 fix");
    assert.deepEqual(deriveLegacyCauses(2, [run(1, "test", "failed", { cause: "environment" })]), { 1: "first", 2: "fix" });
    assert.deepEqual(deriveLegacyCauses(0, []), {});
  });

  test("retry 가 없는 옛 증거는 추정하고(legacyRounds), 있으면 빠진 필드만 채운다", () => {
    const legacy = verifyRetryOf({ rounds: 3, runs: [run(1, "test", "failed"), run(2, "test", "failed"), run(3, "test", "passed")], reproAttempt: { testTreeHash: "h" } });
    assert.deepEqual(legacy, { version: 1, causes: { 1: "first", 2: "fix", 3: "fix" }, reruns: {}, integrateReruns: {}, repro: { trees: ["h"], reruns: {} }, grants: [], legacyRounds: 3 });
    assert.equal("legacyRounds" in verifyRetryOf({ rounds: 0, runs: [] }), false, "새로 만든 빈 증거에는 유예가 없다");
    const partial = verifyRetryOf({ rounds: 2, runs: [], retry: { causes: { 1: "first", 2: "collect" } } as never });
    assert.deepEqual(partial, { version: 1, causes: { 1: "first", 2: "collect" }, reruns: {}, integrateReruns: {}, repro: { trees: [], reruns: {} }, grants: [] });
    // 재현 트리별 원인과 지운 상태는 그대로 옮긴다(복사본이라 고쳐도 원본이 바뀌지 않는다)
    const classes = { a: "result-unconfirmed" as const };
    const copied = verifyRetryOf({ rounds: 1, runs: [], retry: { causes: { 1: "first" }, repro: { trees: ["a"], reruns: {}, classes }, wiped: { test: { round: 1, state: "environment" } } } as never });
    assert.deepEqual(copied.repro, { trees: ["a"], reruns: {}, classes });
    assert.notEqual(copied.repro.classes, classes);
    assert.deepEqual(copied.wiped, { test: { round: 1, state: "environment" } });
  });

  test("총 회차는 1+고쳐 쓰기+리뷰+수집이고 옛 증거는 한 회차 유예를 받는다(T-P7·T-P10)", () => {
    const retry = verifyRetryOf({ rounds: 1, runs: [], retry: { causes: { 1: "first" } } as never });
    const base = verifyBudget({ retry, round: 1, fixRounds: 2, reviewRounds: { used: 0, limit: 3 } });
    assert.deepEqual([base.fix.limit, base.collect.limit, base.rerun.limit, base.integrateRerun.limit, base.totalRounds.limit], [2, 1, 2, 2, 7]);
    assert.equal(verifyBudget({ retry: { ...retry, legacyRounds: 9 }, round: 9, fixRounds: 2, reviewRounds: { used: 0, limit: 3 } }).totalRounds.limit, 10);
    const granted = verifyBudget({ retry: { ...retry, grants: [{ key: "fix", scope: "", step: 1, consent: "c", at: "t", reason: "r" }] }, round: 1, fixRounds: 2, reviewRounds: { used: 0, limit: 3 } });
    assert.deepEqual([granted.fix.limit, granted.totalRounds.limit], [3, 8]);
    const fixWork = verifyBudget({ retry, round: 1, fixRounds: 2, collectLimit: 0, reviewRounds: { used: 0, limit: 3 } });
    assert.deepEqual([fixWork.collect.limit, fixWork.totalRounds.limit], [0, 6]);
    assert.deepEqual(nextRoundDecision({ previous: "result-unconfirmed", emptyRound: false, treeChanged: true, budget: fixWork, reviewOpenFindings: false }), { action: "new", cause: "fix" });
    const counted = verifyBudget({ retry: { ...retry, causes: { 1: "first", 2: "fix", 3: "collect", 4: "review" }, reruns: { 4: 2 }, integrateReruns: { 4: 1 },
      grants: [{ key: "rerun", scope: "round:4", step: 1, consent: "c", at: "t", reason: "r" }] }, round: 4, fixRounds: 2, reviewRounds: { used: 1, limit: 3 } });
    assert.deepEqual([counted.fix.used, counted.collect.used, counted.rerun.used, counted.rerun.limit, counted.integrateRerun.used, counted.totalRounds.used],
      [1, 1, 2, 3, 1, 4]);
  });

  test("budgetText 는 남은 수를 한 줄로 낸다(T-P8)", () => {
    const retry = verifyRetryOf({ rounds: 1, runs: [], retry: { causes: { 1: "first" } } as never });
    assert.equal(budgetText(verifyBudget({ retry, round: 1, fixRounds: 2, reviewRounds: { used: 0, limit: 3 } })),
      "남은 고쳐 쓰기 2회 · 수집 수정 1회 · 같은 코드 재실행 2회 · 리뷰 회차 3회 (총 1/7회차)");
  });

  test("nextRoundDecision 진리표 12행 — 소진·미소진(T-P2)", () => {
    const decide = (previous: VerifyState | "none", treeChanged: boolean, exhausted: Partial<Record<BudgetKey, boolean>> = {}, extra: { emptyRound?: boolean; reviewOpenFindings?: boolean } = {}) =>
      nextRoundDecision({ previous, emptyRound: extra.emptyRound ?? false, treeChanged, budget: budgets(exhausted), retry: true, reviewOpenFindings: extra.reviewOpenFindings ?? false });
    const refusedBy = (decision: ReturnType<typeof decide>) => decision.action === "refuse"
      ? [decision.failure.class, decision.failure.origin, decision.failure.counter?.key] : decision;
    // 1
    assert.deepEqual(decide("none", true, { fix: true, totalRounds: true }), { action: "new", cause: "first" });
    // 2 — 기록 없이 끊긴 회차, 같은 코드
    assert.deepEqual(decide("passed", false, {}, { emptyRound: true }), { action: "reuse", counter: "rerun" });
    assert.deepEqual(refusedBy(decide("passed", false, { rerun: true }, { emptyRound: true })), ["limit-exceeded", "interrupted", "rerun"]);
    // 3 — 끊긴 뒤 고침은 고쳐 쓰기
    assert.deepEqual(decide("passed", true, {}, { emptyRound: true }), { action: "new", cause: "fix" });
    assert.deepEqual(refusedBy(decide("passed", true, { fix: true }, { emptyRound: true })), ["limit-exceeded", "interrupted", "fix"]);
    assert.deepEqual(refusedBy(decide("passed", true, { totalRounds: true }, { emptyRound: true })), ["limit-exceeded", "interrupted", "totalRounds"]);
    // 4·5 — 통과 뒤
    assert.deepEqual(decide("passed", false, { totalRounds: true }), { action: "reuse", counter: null });
    assert.deepEqual(decide("passed", true, { fix: true }), { action: "new", cause: "review" }, "통과 뒤 변경은 고쳐 쓰기를 쓰지 않는다");
    assert.deepEqual(refusedBy(decide("passed", true, { reviewRounds: true })), ["limit-exceeded", "code-defect", "reviewRounds"]);
    assert.deepEqual(refusedBy(decide("passed", true, { reviewRounds: true }, { reviewOpenFindings: true })), ["limit-exceeded", "blocking-finding", "reviewRounds"]);
    assert.deepEqual(refusedBy(decide("passed", true, { totalRounds: true })), ["limit-exceeded", "code-defect", "totalRounds"]);
    // 6 — 결함은 같은 코드의 재실행도 고쳐 쓰기
    assert.deepEqual(decide("code-defect", false), { action: "new", cause: "fix" });
    assert.deepEqual(decide("code-defect", true), { action: "new", cause: "fix" });
    assert.deepEqual(refusedBy(decide("code-defect", true, { fix: true })), ["limit-exceeded", "code-defect", "fix"]);
    assert.deepEqual(refusedBy(decide("code-defect", true, { totalRounds: true })), ["limit-exceeded", "code-defect", "totalRounds"]);
    for (const previous of ["environment", "interrupted"] as const) {
      // 7·8
      assert.deepEqual(decide(previous, false, { fix: true }), { action: "reuse", counter: "rerun" });
      assert.deepEqual(refusedBy(decide(previous, false, { rerun: true })), ["limit-exceeded", previous, "rerun"]);
      assert.deepEqual(decide(previous, true, { rerun: true }), { action: "new", cause: "fix" });
      assert.deepEqual(refusedBy(decide(previous, true, { fix: true })), ["limit-exceeded", previous, "fix"]);
    }
    // 9·10 — 결과 미확인
    assert.deepEqual(decide("result-unconfirmed", false), { action: "reuse", counter: "rerun" });
    assert.deepEqual(refusedBy(decide("result-unconfirmed", false, { rerun: true })), ["limit-exceeded", "result-unconfirmed", "rerun"]);
    assert.deepEqual(decide("result-unconfirmed", true, { fix: true }), { action: "new", cause: "collect" });
    assert.deepEqual(decide("result-unconfirmed", true, { collect: true }), { action: "new", cause: "fix" });
    assert.deepEqual(refusedBy(decide("result-unconfirmed", true, { collect: true, fix: true })), ["limit-exceeded", "result-unconfirmed", "fix"]);
    assert.deepEqual(refusedBy(decide("result-unconfirmed", true, { totalRounds: true })), ["limit-exceeded", "result-unconfirmed", "totalRounds"]);
    // 11·12 — 전제 미충족
    assert.deepEqual(refusedBy(decide("precondition", false)), ["precondition", undefined, undefined]);
    assert.deepEqual(decide("precondition", true), { action: "new", cause: "fix" });
    assert.deepEqual(refusedBy(decide("precondition", true, { fix: true })), ["limit-exceeded", "precondition", "fix"]);
  });

  test("test·integrate 의 같은 회차 재실행", () => {
    assert.deepEqual(sameRoundDecision({ previous: "passed", budget: budgets({ rerun: true }), key: "rerun" }), { action: "run", counter: null });
    assert.deepEqual(sameRoundDecision({ previous: "environment", budget: budgets(), key: "integrateRerun" }), { action: "run", counter: "integrateRerun" });
    const exhausted = sameRoundDecision({ previous: "interrupted", budget: budgets({ integrateRerun: true }), key: "integrateRerun" });
    assert.ok(exhausted.action === "refuse" && exhausted.failure.class === "limit-exceeded" && exhausted.failure.counter?.key === "integrateRerun" && exhausted.failure.origin === "interrupted");
    const defect = sameRoundDecision({ previous: "code-defect", budget: budgets(), key: "rerun" });
    assert.ok(defect.action === "refuse" && defect.failure.class === "code-defect" && /코드 결함으로 실패한 트리입니다/.test(defect.failure.detail));
    const precondition = sameRoundDecision({ previous: "precondition", budget: budgets(), key: "rerun" });
    assert.ok(precondition.action === "refuse" && precondition.failure.class === "precondition");
  });

  test("verify 노드와 소진 카운터(T-P3)", () => {
    const node = (state: VerifyState, exhausted: Partial<Record<BudgetKey, boolean>> = {}) => [verifyNode(state, budgets(exhausted)), nodeCounter(state, budgets(exhausted))];
    assert.deepEqual(node("passed", { fix: true }), ["passed", undefined]);
    assert.deepEqual(node("code-defect"), ["repair", undefined]);
    assert.deepEqual(node("code-defect", { fix: true }), ["decision", "fix"]);
    assert.deepEqual(node("code-defect", { totalRounds: true }), ["decision", "totalRounds"]);
    assert.deepEqual(node("environment"), ["diagnose", undefined]);
    assert.deepEqual(node("interrupted", { rerun: true }), ["decision", "rerun"]);
    assert.deepEqual(node("result-unconfirmed", { rerun: true, fix: true }), ["diagnose", undefined], "수집 수정이 남았다");
    assert.deepEqual(node("result-unconfirmed", { collect: true, fix: true, rerun: true }), ["decision", "fix"]);
    assert.deepEqual(node("result-unconfirmed", { totalRounds: true }), ["diagnose", undefined], "같은 코드 재실행은 회차를 열지 않아 총 회차와 무관하다");
    assert.deepEqual(node("result-unconfirmed", { totalRounds: true, rerun: true }), ["decision", "totalRounds"]);
    assert.deepEqual(node("result-unconfirmed", { fix: true, totalRounds: true, rerun: true }), ["decision", "totalRounds"], "수집 수정이 남았으면 막는 것은 총 회차");
    assert.deepEqual(node("precondition"), ["diagnose", undefined]);
    // nodeCounter 는 VerifyBudget 의 키다 — C3 assess 의 budget[counter] 가 그대로 컴파일된다
    const exhausted = budgets({ fix: true });
    const key = nodeCounter("code-defect", exhausted);
    assert.equal(key && exhausted[key].limit, 2);
  });

  test("결과 미확인 노드는 재개 가능성과 같다 — 같은 코드 재실행과 고친 뒤 회차가 모두 거부될 때만 decision 이고, 카운터는 고치는 길을 막은 것", () => {
    const keys: BudgetKey[] = ["fix", "collect", "rerun", "totalRounds"];
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const budget = budgets(Object.fromEntries(keys.map((key, index) => [key, (mask >> index & 1) === 1])));
      const decide = (treeChanged: boolean) => nextRoundDecision({ previous: "result-unconfirmed", emptyRound: false, treeChanged, budget, reviewOpenFindings: false });
      const same = decide(false), changed = decide(true);
      const blocked = same.action === "refuse" && changed.action === "refuse";
      assert.equal(verifyNode("result-unconfirmed", budget) === "decision", blocked, `mask ${mask}`);
      if (blocked && changed.action === "refuse") assert.equal(nodeCounter("result-unconfirmed", budget), changed.failure.counter?.key, `mask ${mask}`);
    }
  });

  test("쓰기 차단은 다음 회차가 거부될 때와 정확히 같다(T-P4)", () => {
    const states: (VerifyState | "none")[] = ["none", "passed", "code-defect", "environment", "interrupted", "result-unconfirmed", "precondition"];
    const keys: BudgetKey[] = ["fix", "collect", "rerun", "reviewRounds", "totalRounds"];
    for (const state of states) for (const emptyRound of [false, true]) for (let mask = 0; mask < 1 << keys.length; mask++) {
      const exhausted = Object.fromEntries(keys.map((key, index) => [key, (mask >> index & 1) === 1]));
      const budget = budgets(exhausted);
      const blocked = writeBlockReason({ state, emptyRound, budget, path: "src/a.ts", questionsPath: "doc/work/W/questions.md" });
      const decision = nextRoundDecision({ previous: state, emptyRound, treeChanged: true, budget, reviewOpenFindings: budget.reviewRounds.used > 0 });
      assert.equal(blocked !== undefined, decision.action === "refuse", `${state}/${emptyRound}/${mask}`);
    }
    assert.match(writeBlockReason({ state: "code-defect", emptyRound: false, budget: budgets({ fix: true }), path: "src/a.ts", questionsPath: "q.md" })!, /^고쳐 쓰기 2회를 넘겨 계획 파일을 더 고칠 수 없습니다: src\/a\.ts\. q\.md 에/);
    assert.match(writeBlockReason({ state: "passed", emptyRound: false, budget: budgets({ reviewRounds: true }), path: "p", questionsPath: "q" })!, /^리뷰 회차 한도 2회를 모두 써서/);
    assert.match(writeBlockReason({ state: "passed", emptyRound: false, budget: budgets({ totalRounds: true }), path: "p", questionsPath: "q" })!, /^검증 회차가 총 2회에 닿아/);
    assert.equal(writeBlockReason({ state: "passed", emptyRound: false, budget: budgets({ fix: true }), path: "p", questionsPath: "q" }), undefined, "통과 뒤 수정은 막지 않는다");
  });
});

// ---- 계획 ----

describe("계획 배정 한도·고아·hook 종료 코드", () => {
  const attempt = (status: string, inputHash = "h1", at = "2026-10-07T01:00:00.000Z") => ({ dispatchId: `d-${Math.random()}`, inputHash, at, status });

  test("같은 입력은 failed 만 세고, 작업 총 배정은 이행 시각 이후 모든 시도를 센다", () => {
    const decide = (attempts: ReturnType<typeof attempt>[], extra: Partial<Parameters<typeof planningDispatchDecision>[0]> = {}) =>
      planningDispatchDecision({ attempts, inputHash: "h1", taskId: "design", since: "2026-10-07T00:00:00.000Z", ...extra });
    assert.deepEqual(decide([attempt("failed"), attempt("failed"), attempt("cancelled"), attempt("orphaned")]), { allow: true });
    const same = decide([attempt("failed"), attempt("failed"), attempt("failed")]);
    assert.ok(!same.allow && same.failure.class === "same-input-repeat" && /3번 실패/.test(same.failure.detail));
    assert.deepEqual(!same.allow && same.failure.counter, { key: "sameInput", used: 3, limit: 3 });
    assert.deepEqual(decide([attempt("failed"), attempt("failed"), attempt("failed", "h2"), attempt("failed", "h2")]), { allow: true }, "다른 입력의 실패는 따로 센다");
    const grants: RetryGrant[] = [{ key: "sameInput", scope: "planning:design:h1", step: 1, consent: "c", at: "t", reason: "r" }];
    assert.deepEqual(decide([attempt("failed"), attempt("failed"), attempt("failed")], { grants }), { allow: true });
    const six = Array.from({ length: 6 }, () => attempt("cancelled"));
    const total = decide(six);
    assert.ok(!total.allow && total.failure.class === "reassign-total" && /작업 design의 배정이 총 6회/.test(total.failure.detail));
    assert.deepEqual(!total.allow && total.failure.counter, { key: "taskTotal", used: 6, limit: 6 });
    assert.deepEqual(decide([...six.slice(0, 3), ...Array.from({ length: 3 }, () => attempt("cancelled", "h1", "2026-10-06T00:00:00.000Z"))]), { allow: true }, "이행 전 시도는 세지 않는다");
    assert.deepEqual(decide(six, { since: undefined }), { allow: true }, "since 가 없으면 아직 세지 않는다");
    assert.deepEqual(decide(six, { grants: [{ key: "taskTotal", scope: "planning:design", step: 3, consent: "c", at: "t", reason: "r" }] }), { allow: true });
    assert.deepEqual(decide(six, { repair: true }), { allow: true }, "교정은 같은 시도다");
    assert.equal(decide([attempt("failed"), attempt("failed"), attempt("failed")], { repair: true }).allow, false, "교정도 같은 입력 한도는 본다");
  });

  test("orphanState 8갈래 — 연결·모호·미관찰과 기준 시각", () => {
    const now = Date.parse("2026-10-07T02:00:00.000Z");
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    const dispatched = { dispatchId: "D", inputHash: "h", at: ago(13), status: "running" };
    const agent = (extra: Partial<AgentView>): AgentView => ({ id: "a", session: "s", type: "ca-explorer", startedAt: ago(12), ...extra });
    const state = (agents: AgentView[], agentType?: string, at = dispatched) => orphanState({ attempt: at, agents, now, ...(agentType ? { agentType } : {}) });
    assert.equal(state([agent({ dispatchId: "D", startedAt: ago(5) })]), "running");
    assert.equal(state([agent({ dispatchId: "D", startedAt: ago(61) })]), "suspect", "시작 관찰 60분");
    assert.equal(state([agent({ dispatchId: "D", finished: true })]), "orphaned", "연결 담당이 모두 끝났다");
    assert.equal(state([agent({ startedAt: ago(5) })], "ca-explorer"), "running", "연결하지 못한 같은 종류 담당");
    assert.equal(state([agent({ startedAt: ago(5), type: "ca-writer" })]), "running", "종류를 모르면 가리지 않는다(T6d)");
    assert.equal(state([agent({ startedAt: ago(12), type: "ca-writer" })], "ca-explorer"), "suspect", "다른 종류는 보지 않는다 — 미관찰 기준으로");
    assert.equal(state([]), "suspect", "시작 미관찰 10분");
    assert.equal(state([], undefined, { ...dispatched, at: ago(3) }), "running");
    assert.equal(state([agent({ dispatchId: "L", finished: true, endedAt: ago(2) })]), "running", "다른 담당 활동 2분 전부터 잰다(T6c)");
    assert.equal(state([agent({ dispatchId: "L", finished: true, endedAt: ago(11) })]), "suspect");
  });

  test("subagentExit — Codex 는 언제나 0, Claude 는 기록 전 첫 Stop 만 되돌린다", () => {
    for (const event of ["SubagentStart", "SubagentStop", undefined]) for (const stopHookActive of [false, true]) for (const recorded of [false, true]) {
      assert.equal(subagentExit({ host: "codex", event, stopHookActive, recorded }), 0);
      const expected = event === "SubagentStop" ? (recorded || stopHookActive ? 0 : 2) : (recorded ? 0 : 2);
      assert.equal(subagentExit({ host: "claude", event, stopHookActive, recorded, failure: "agent-format-error" }), expected, `${event}/${stopHookActive}/${recorded}`);
    }
  });
});

// ---- 교차 ----

const banner = ["OpenAI Codex v0.160.1 (research preview)", "--------", "workdir: C:/w/repo", "model: gpt-6.1-sol", "provider: openai", "approval: never",
  "sandbox: read-only", "reasoning effort: high", "reasoning summaries: auto", "session id: 0199-…", "--------"].join("\n");
const prompt = "code-agent 교차 리뷰 — 작업 X 2회차.\n직전 회차의 교차 지적이다 —\n| X1 | src/agent/modelPolicy.ts | 계획 안 | 열림 | 'ERROR: unknown model' 와 429 quota 를 분류하지 않는다 |\nERROR: invalid model gpt-x";
const toolOut = "exec\nnode -e … in C:/w/repo\n succeeded in 12ms:\nconst config = [/selected model/i, /unknown (?:option|argument)/i];";
const CROSS_FIXTURES: [string, string, CrossProbe][] = [
  ["cross-unavailable/quota", "spend cap", { host: "codex", sentPrompt: "", stderr: "ERROR: You hit your spend cap set by the owner of your workspace.", status: 1 }],
  ["cross-unavailable/auth", "Not logged in", { host: "codex", sentPrompt: "", stderr: "Not logged in. Run codex login.", status: 1 }],
  ["cross-unavailable/missing", "BIN 없음", { host: "codex", sentPrompt: "", unresolved: "CODE_AGENT_CODEX_BIN 가 가리키는 파일이 없습니다" }],
  ["cross-config-error/config", "unexpected argument", { host: "codex", sentPrompt: "", stderr: "error: unexpected argument '--ephemeral' found\n\nUsage: codex exec [OPTIONS] [PROMPT]", status: 2 }],
  ["cross-config-error/config", "unknown option", { host: "claude", stderr: "error: unknown option '--permission-prompts'", status: 1 }],
  ["cross-config-error/config", "selected model", { host: "claude", status: 1, stdout: JSON.stringify({ is_error: true, result: "There's an issue with the selected model (claude-sonnet-9). It may not exist or you may not have access to it." }) }],
  ["cross-config-error/config", "model does not exist", { host: "codex", sentPrompt: "", stderr: "stream error: model gpt-6.1-sol does not exist", status: 1 }],
  ["cross-config-error/config", "invalid value effort", { host: "codex", sentPrompt: "", stderr: "Error: invalid value 'ultra' for model_reasoning_effort", status: 1 }],
  ["cross-unavailable/quota", "usage limit reached", { host: "claude", status: 1, stdout: JSON.stringify({ is_error: true, result: "Claude AI usage limit reached|1760000000", usage: { input_tokens: 500 } }) }],
  ["cross-unavailable/auth", "Invalid API key", { host: "claude", status: 1, stdout: JSON.stringify({ is_error: true, result: "Invalid API key · Please run /login" }) }],
  ["cross-unavailable/network", "ENOTFOUND", { host: "codex", sentPrompt: "", stderr: "ERROR: request failed: getaddrinfo ENOTFOUND api.openai.com", status: 1 }],
  ["cross-unavailable/outage", "529", { host: "claude", stderr: "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}", status: 1 }],
  ["cross-timeout/timeout", "ETIMEDOUT", { host: "codex", sentPrompt: "", spawnCode: "ETIMEDOUT" }],
  ["host-sandbox-denied/sandbox", "spawn EPERM", { host: "claude", spawnCode: "EPERM" }],
  ["host-sandbox-denied/sandbox", "stderr EPERM", { host: "claude", stderr: "Error: spawn EPERM", status: 1 }],
  ["cross-config-error/unclassified", "panic", { host: "codex", sentPrompt: "", stderr: "panic: something odd", status: 101 }],
  ["cross-config-error/unclassified", "JSON 아님", { host: "claude", stdout: "not json at all", status: 0 }],
  ["host-sandbox-denied/sandbox-network", "ENOTFOUND+sandboxed", { host: "claude", stderr: "Error: getaddrinfo ENOTFOUND api.anthropic.com", status: 1, sandboxed: true }],
  // 반박 검토의 거짓 양성 — 사용량 숫자·전사가 화이트리스트에 걸리면 안 된다
  ["cross-config-error/unclassified", "claude error_during_execution + usage 500", { host: "claude", status: 1, stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 12, usage: { input_tokens: 500, output_tokens: 1873 }, total_cost_usd: 0.31 }) }],
  ["cross-config-error/unclassified", "claude error_max_turns + usage 429", { host: "claude", status: 1, stdout: JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, usage: { input_tokens: 9123, output_tokens: 429 } }) }],
  ["cross-config-error/unclassified", "codex panic + 전사 429·401", { host: "codex", sentPrompt: "", status: 101, stderr: "exec bash -lc 'sed -n 1,80p src/api/client.ts'\n  if (res.status === 429) return retry();\n  if (res.status === 401) throw new Unauthorized();\nthread 'main' panicked at core/src/foo.rs:88: index out of bounds" }],
  ["cross-config-error/unclassified", "codex quota.ts 전사 + EOF", { host: "codex", sentPrompt: "", status: 1, stderr: "codex> reading src/billing/quota.ts\n export function checkQuota() {}\nError: unexpected EOF while parsing event stream" }],
  ["cross-config-error/unclassified", "codex 전사 끝줄 status 500", { host: "codex", sentPrompt: "", status: 1, stderr: "exec\ncat src/http.ts\n succeeded in 3ms:\nif (status === 500) throw new Error('internal');" }],
  ["cross-config-error/unclassified", "claude 거부된 도구 입력에 rate limit", { host: "claude", status: 1, stdout: JSON.stringify({ is_error: true, subtype: "error_during_execution", permission_denials: [{ tool_input: { command: "grep -n 'rate limit\\|quota exceeded\\|401' src" } }] }) }],
  // C6 모델·강도 문구와 배너·되풀이된 프롬프트
  ["cross-unavailable/quota", "C6 codex 배너 + spend cap", { host: "codex", sentPrompt: prompt, stderr: `${banner}\nuser\n${prompt}\nERROR: You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.` }],
  ["cross-unavailable/auth", "C6 codex 배너 + Not logged in", { host: "codex", sentPrompt: prompt, stderr: `${banner}\nuser\n${prompt}\nNot logged in` }],
  ["cross-unavailable/quota", "C6 codex 도구 출력 뒤 usage limit", { host: "codex", sentPrompt: prompt, stderr: `${banner}\nuser\n${prompt}\n${toolOut}\nERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex` }],
  ["cross-config-error/config", "C6 codex unknown variant", { host: "codex", sentPrompt: prompt, stderr: "Error loading config.toml: unknown variant `ultra2`, expected one of `low`, `medium`, `high`, `xhigh`" }],
  ["cross-config-error/config", "C6 codex clap unexpected", { host: "codex", sentPrompt: prompt, stderr: "error: unexpected argument '--ephemeral' found\n\nUsage: codex exec [OPTIONS] [PROMPT]" }],
  ["cross-config-error/config", "C6 codex model 없음", { host: "codex", sentPrompt: prompt, stderr: `${banner}\nuser\n${prompt}\nERROR: The model \`gpt-x\` does not exist or you do not have access to it.` }],
  ["cross-config-error/config", "C6 claude is_error 모델", { host: "claude", status: 1, stdout: JSON.stringify({ type: "result", is_error: true, result: "There's an issue with the selected model (sonnet-x). It may not exist or you may not have access to it. Run /model to pick a different model." }) }],
  ["cross-unavailable/quota", "C6 claude 한도 + 거부 도구", { host: "claude", status: 1, stdout: JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1760000000", permission_denials: [{ tool_name: "Bash", tool_input: { command: "x --unknown-option; echo unknown option" } }] }) }],
  ["cross-config-error/config", "C6 claude unknown option(--effort)", { host: "claude", status: 1, stderr: "error: unknown option '--effort'", stdout: "" }],
  ["cross-config-error/config", "C6 claude fable 계정", { host: "claude", status: 1, stderr: "Claude Fable 5.1 isn't available for your account yet.", stdout: "" }],
  // 문맥이 있는 숫자 코드·일반어
  ["cross-unavailable/quota", "status 429 Too Many Requests", { host: "codex", sentPrompt: "", stderr: "ERROR: unexpected status 429 Too Many Requests: rate limited", status: 1 }],
  ["cross-unavailable/auth", "status 401 Unauthorized", { host: "codex", sentPrompt: "", stderr: "ERROR: unexpected status 401 Unauthorized", status: 1 }],
  ["cross-unavailable/outage", "API Error 503", { host: "claude", stderr: "API Error: 503 upstream connect error", status: 1 }],
  ["cross-unavailable/quota", "quota exceeded", { host: "codex", sentPrompt: "", stderr: "ERROR: You exceeded your current quota", status: 1 }],
  // 오류 줄 없는 실패 — 전사에 화이트리스트 문구가 있고 마지막 줄이 알 수 없는 종료
  ["cross-config-error/unclassified", "codex 전사(usage limit 주석) + panicked 끝줄", { host: "codex", sentPrompt: "", status: 101, stderr: ["exec", "rg -n 'limit' src", " succeeded in 9ms:", "src/billing.ts:12: // usage limit reached -> stop", "src/billing.ts:30: // Not logged in -> login", "thread 'main' panicked at core/src/exec.rs:88: index out of bounds"].join("\n") }],
  ["cross-config-error/unclassified", "claude JSON 아님 + 끝 몇 줄에 rate limit 주석", { host: "claude", status: 1, stdout: ["reading src/net.ts", "// rate limit handled upstream", "// retry on overload", "x", "y", "z", "segfault"].join("\n") }],
  // 독립 검토의 거짓 양성 — 전사(읽은 파일)의 error 로 시작하는 줄·모델 문장·Claude stderr 의 안내 줄이 화이트리스트로 새면 안 된다
  ["cross-config-error/unclassified", "codex 전사 로그 줄(Error: connect ECONNREFUSED) + panic", { host: "codex", sentPrompt: prompt, status: 101,
    stderr: [banner, "user", prompt, "exec", "cat test/fixtures/server.log", " succeeded in 4ms:", "Error: connect ECONNREFUSED 127.0.0.1:5432", "thread 'main' panicked at core/src/exec.rs:88: index out of bounds"].join("\n") }],
  ["cross-config-error/unclassified", "codex 전사 TS 객체(error: \"Not logged in\") + 끊김", { host: "codex", sentPrompt: prompt, status: 1,
    stderr: [banner, "user", prompt, "exec", "sed -n 1,20p src/messages.ts", " succeeded in 3ms:", "export const MESSAGES = {", "  error: \"Not logged in\",", "};", "stream disconnected before completion"].join("\n") }],
  ["cross-config-error/unclassified", "codex 전사 Rust(Error::Unauthorized) + panicked", { host: "codex", sentPrompt: prompt, status: 101,
    stderr: [banner, "user", prompt, "exec", "rg -n -A3 'match' src/api.rs", "    Error::Unauthorized => retry_login(),", "thread 'main' panicked at core/src/foo.rs:1"].join("\n") }],
  ["cross-config-error/unclassified", "codex 전사 문서(Error handling for rate limits) + Killed", { host: "codex", sentPrompt: prompt, status: 137,
    stderr: [banner, "user", prompt, "exec", "cat docs/api.md", "## Errors", "Error handling for rate limits is done by the gateway.", "Killed"].join("\n") }],
  ["cross-config-error/unclassified", "codex 마지막 응답 문장(Error path for usage limit)", { host: "codex", sentPrompt: prompt, status: 1,
    stdout: "| F1 | src/a.ts | 계획 안 | 열림 | 처리 누락 |\nError path for 'usage limit' responses is untested.", stderr: "" }],
  ["cross-config-error/unclassified", "claude stderr 경고(rate limit) + Segmentation fault", { host: "claude", status: 1, stdout: "",
    stderr: "Warning: rate limit headers missing from proxy response\nSegmentation fault (core dumped)" }],
  ["cross-config-error/unclassified", "claude stderr hook 안내(Not logged in) + TypeError", { host: "claude", status: 1, stdout: "",
    stderr: "SessionStart hook: npm notice: Not logged in to registry (optional)\nError: Cannot read properties of undefined (reading 'x')" }],
  ["cross-config-error/unclassified", "codex 반향이 접두(> )로 바뀌어 남음 + panicked", { host: "codex", sentPrompt: prompt, status: 101,
    stderr: [banner, "user", ...prompt.split("\n").map((line) => `> ${line}`), "thread 'main' panicked"].join("\n") }],
  // 맺음 줄(CROSS_NO_ANSWER·토큰 줄)은 꼬리로 보지 않는다 — 앞의 오류를 그대로 분류한다
  ["cross-unavailable/quota", "codex 세션 ERROR + 마지막 응답 없음 줄", { host: "codex", sentPrompt: prompt, status: 1,
    stderr: [banner, "user", prompt, toolOut, "ERROR: You've hit your usage limit.", "tokens used", "1,234", CROSS_NO_ANSWER].join("\n") }],
  ["cross-unavailable/auth", "codex 세션 전 Not logged in + 마지막 응답 없음 줄", { host: "codex", sentPrompt: prompt, status: 1, stderr: ["Not logged in", CROSS_NO_ANSWER].join("\n") }],
  ["cross-config-error/unclassified", "codex 출력 없이 마지막 응답 없음 줄만", { host: "codex", sentPrompt: prompt, status: 0, stderr: CROSS_NO_ANSWER }],
  // 교차 검증 독립 검토 — 세션 출력은 stderr 마지막 한 줄이 Codex 의 ERROR: 줄일 때만 본다(이어진 묶음·전사 끝 줄·stdout·신호 종료는 보지 않는다)
  ["cross-config-error/unclassified", "codex 읽은 로그 끝 줄 ERROR: 한도 + 바로 뒤 Codex ERROR(모르는 원인)", { host: "codex", sentPrompt: prompt, status: 1,
    stderr: [banner, "user", prompt, "exec", "cat logs/app.log in C:/w/repo", " succeeded in 12ms:", "ERROR: You've hit your usage limit. Upgrade to Pro", "ERROR: unexpected status 400 Bad Request: invalid_request_error"].join("\n") }],
  ["cross-config-error/unclassified", "codex 읽은 Python 로그 끝 줄 ERROR:root: + Codex ERROR 400", { host: "codex", sentPrompt: prompt, status: 1,
    stderr: [banner, "user", prompt, "exec", "cat worker.log", " succeeded in 3ms:", "ERROR:root:quota exceeded for tenant 7", "[2026-10-08T00:00:00Z] ERROR: unexpected status 400 Bad Request"].join("\n") }],
  ["cross-config-error/unclassified", "codex 신호로 종료 — 마지막 줄이 읽은 파일 본문(인증 문구)", { host: "codex", sentPrompt: prompt, status: null,
    stderr: [banner, "user", prompt, "exec", "cat src/http.js in C:/w/repo", " succeeded in 12ms:", "// HTTP 401 Unauthorized 면 다시 로그인"].join("\n") }],
  ["cross-config-error/unclassified", "codex 강제 종료(Windows 종료 코드 1) — 마지막 줄이 파일 본문(quota exceeded)", { host: "codex", sentPrompt: prompt, status: 1,
    stderr: [banner, "user", prompt, "exec", "cat README.md in C:/w/repo", " succeeded in 3ms:", "If the quota is exceeded the job retries."].join("\n") }],
  ["cross-config-error/unclassified", "codex stdout 끝 ERROR: 한도(모델 문장) + stderr panic", { host: "codex", sentPrompt: prompt, status: 1,
    stdout: "결과\nERROR: usage limit reached", stderr: [banner, "user", prompt, "thread main panicked"].join("\n") }],
  ["cross-config-error/unclassified", "codex 신호로 종료 — 끝 줄이 Codex 의 ERROR: 한도여도 보지 않는다", { host: "codex", sentPrompt: prompt, status: null,
    stderr: [banner, "user", prompt, toolOut, "ERROR: You've hit your usage limit."].join("\n") }],
  ["cross-config-error/unclassified", "codex 전사 라벨이 바뀌어도 남은 줄이 둘 이상이면 끝 줄만 오류 줄로 본다", { host: "codex", sentPrompt: prompt, status: 1,
    stderr: [banner, "user", prompt, "assistant>", "rate limit 처리를 살펴봤습니다"].join("\n") }],
  ["cross-config-error/unclassified", "spawn ENOBUFS — 잘린 출력의 한도 문구를 보지 않는다", { host: "codex", sentPrompt: "", spawnCode: "ENOBUFS", spawnMessage: "spawnSync codex ENOBUFS",
    stderr: "If the quota is exceeded the job retries.\n".repeat(3), stdout: "" }],
  // Claude 네트워크 문구(claude 2.1.292 문자열)
  ["cross-unavailable/network", "claude Unable to connect to API", { host: "claude", status: 1, stderr: "Unable to connect to API (ConnectionRefused)", stdout: "" }],
  ["cross-unavailable/network", "claude is_error API Error: Connection error.", { host: "claude", status: 1, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: Connection error." }) }],
];

describe("교차 실행 실패 분류", () => {
  test("분류 fixture 61건 — 실행 불가는 화이트리스트뿐이고 알 수 없는 실패는 게이트를 막는다", () => {
    assert.equal(CROSS_FIXTURES.length, 61);
    for (const [expected, name, probe] of CROSS_FIXTURES) {
      const got = classifyCrossFailure(probe);
      assert.equal(`${got.class}/${got.kind}`, expected, `${name} — text=${JSON.stringify(crossFailureText(probe))}`);
    }
  });

  test("분류 범위는 오류 채널뿐이다 — 배너·되풀이된 프롬프트·결과 밖 JSON 필드를 넣지 않는다", () => {
    const spendCap = CROSS_FIXTURES.find(([, name]) => name === "C6 codex 배너 + spend cap")![2];
    const text = crossFailureText(spendCap);
    assert.equal(text, "ERROR: You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.");
    const reason = classifyCrossFailure(spendCap).reason;
    assert.match(reason, /^사용 한도\(quota\): ERROR: You hit your spend cap/);
    for (const leaked of ["reasoning effort", "workdir", "교차 리뷰", "invalid model"]) assert.equal(reason.includes(leaked), false, leaked);
    const codexNoError = crossFailureText({ host: "codex", sentPrompt: prompt, stderr: `${banner}\nuser\n${prompt}\nNot logged in` });
    assert.equal(codexNoError, "Not logged in", "오류 줄이 없으면 마지막 한 줄");
    const claude = crossFailureText({ host: "claude", stderr: "warn\nboom", stdout: JSON.stringify({ is_error: true, result: "r", subtype: "s", usage: { input_tokens: 401 }, total_cost_usd: 1, permission_denials: [{ x: "quota exceeded" }] }) });
    assert.equal(claude, "boom\nr\ns", "Claude stderr 도 오류 줄(없으면 마지막 한 줄)만");
    assert.equal(crossFailureText({ host: "claude", stderr: "hook: rate limit note\nError: x\n    at f (a.js:1:1)" }), "Error: x");
    // Codex 세션 출력은 stderr 마지막 한 줄이 Codex 의 ERROR: 줄일 때만 — 전사 중간·끝의 인용은 보지 않는다(분류되지 않은 종료)
    const quoted = crossFailureText({ host: "codex", sentPrompt: "", stderr: [banner, "exec", "cat ops.log", " succeeded in 2ms:", "ERROR: You've hit your usage limit", "codex", "검토를 마쳤습니다", "thread 'main' panicked"].join("\n") });
    assert.equal(quoted, "");
    assert.match(classifyCrossFailure({ host: "codex", sentPrompt: "", status: 101, stderr: [banner, "exec", "cat ops.log", " succeeded in 2ms:", "thread 'main' panicked"].join("\n") }).reason,
      /^분류되지 않은 종료\(unclassified\): 종료 코드 101$/, "전사 끝 줄을 사유로 보이지 않고 종료 코드만 남긴다");
    // 이어진 ERROR: 묶음은 합치지 않는다 — 마지막 줄이 이번 실패다
    assert.equal(crossFailureText({ host: "codex", sentPrompt: "", stderr: `${banner}\nERROR: stream disconnected - retrying turn (1/5)\nERROR: unexpected status 503 Service Unavailable` }),
      "ERROR: unexpected status 503 Service Unavailable");
    // 모델 차례가 시작되기 전(전사 없음)에 남은 줄이 하나면 그 줄이 Codex 자신의 출력이다
    assert.equal(crossFailureText({ host: "codex", sentPrompt: prompt, status: 1, stderr: `${banner}\nuser\n${prompt}\nNot logged in` }), "Not logged in");
    assert.equal(crossFailureText({ host: "codex", sentPrompt: prompt, status: 1, stderr: `${banner}\nuser\n${prompt}\ncodex\nNot logged in` }), "", "codex 라벨 뒤 줄은 모델 문장일 수 있다");
    // stdout 은 Codex 의 마지막 응답(모델 문장)이라 보지 않는다
    assert.equal(crossFailureText({ host: "codex", sentPrompt: "", stdout: "검토 결과\nERROR: You've hit your usage limit", stderr: "" }), "");
    assert.equal(crossFailureText({ host: "claude", stderr: "only stderr", stdout: JSON.stringify({ is_error: false, result: "fine" }) }), "only stderr", "성공 JSON 은 넣지 않는다");
    const many = crossFailureText({ host: "codex", sentPrompt: "", stderr: ["error: 1", "error: 2", "error: 3", "error: 4", "error: 5", "error: 6", "[2026-10-07] ERROR: 7"].join("\r\n") });
    assert.equal(many, "error: 3\nerror: 4\nerror: 5\nerror: 6\n[2026-10-07] ERROR: 7", "오류 줄은 마지막 5줄");
    assert.equal(classifyCrossFailure({ host: "codex", sentPrompt: "", spawnCode: "ENOENT", spawnMessage: "spawn codex ENOENT" }).reason, "실행 파일 없음(missing): spawn codex ENOENT");
  });

  test("설정 패턴은 고정된 꼴만 쓴다 — Codex 배너의 reasoning effort 에 걸리지 않는다", () => {
    const sources = CROSS_PATTERNS.config.map((pattern) => pattern.source);
    for (const banned of ["reasoning[_ ]effort", "model_reasoning_effort", "unknown variant"]) assert.equal(sources.includes(banned), false, banned);
    assert.equal(CROSS_PATTERNS.config.some((pattern) => pattern.test("reasoning effort: high")), false);
    assert.equal(classifyCrossFailure({ host: "codex", sentPrompt: "", stderr: `${banner}\nreasoning effort: high\npanic: x` }).kind, "unclassified");
  });

  test("Codex 샌드박스 사전 판정", () => {
    assert.equal(crossPreflight("claude", { CODEX_SANDBOX_NETWORK_DISABLED: "1" })?.kind, "preflight");
    assert.equal(crossPreflight("claude", { CODEX_SANDBOX: "seatbelt" })?.class, "host-sandbox-denied");
    assert.equal(crossPreflight("codex", { CODEX_SANDBOX: "seatbelt" }), undefined);
    assert.equal(crossPreflight("claude", { CODEX_SANDBOX: "seatbelt", CODE_AGENT_CROSS_PREFLIGHT: "off" }), undefined);
    assert.equal(crossPreflight("claude", { CODEX_SANDBOX_NETWORK_DISABLED: "0" }), undefined);
  });
});

describe("교차 지점 상태와 판정", () => {
  let seq = 0;
  const ended = (cls?: CrossAttemptView["class"], extra: Partial<CrossAttemptView> = {}): CrossAttemptView =>
    ({ n: ++seq, host: "codex", mode: "review", startedAt: "2026-10-07T00:00:00.000Z", endedAt: "2026-10-07T00:01:00.000Z", class: cls, ...extra });
  const timeout = () => ended("cross-timeout", { kind: "timeout" });
  const interrupted = (extra: Partial<CrossAttemptView> = {}) => ended("cross-timeout", { kind: "interrupted", ...extra });
  const before = (attempts: CrossAttemptView[], extra: { grants?: RetryGrant[]; rawExists?: (path: string) => boolean } = {}) =>
    crossPointDecision({ attempts, scope: "round:1", phase: "before", ...extra });
  const refusal = (decision: ReturnType<typeof before>) => decision.action === "refuse" ? [decision.refusal, decision.failure.class, decision.failure.counter?.key] : decision.action;

  test("지점 상태 — 실행 중이 먼저, 완료는 중지보다 먼저, 끊긴 실행은 중지가 아니다", () => {
    assert.equal(crossPointState([]).state, "none");
    assert.equal(crossPointState([ended("cross-unavailable"), { ...ended(), endedAt: undefined }]).state, "running");
    assert.equal(crossPointState([ended("cross-unavailable"), ended("completed")]).state, "completed");
    assert.equal(crossPointState([timeout(), timeout()]).state, "stopped");
    assert.equal(crossPointState([timeout(), interrupted()]).state, "open");
    assert.equal(crossPointState([ended("answered-input")]).state, "open", "질문을 다 답한 needs-input 은 완료가 아니다");
    const human = ended("cross-stop", { mode: "human" });
    const stopped = crossPointState([ended("cross-unavailable"), human]);
    assert.equal(stopped.stoppedBy, human, "사람 중지가 있으면 그것");
    assert.equal(crossPointState([ended("cross-config-error"), ended("completed")]).lastFailure?.class, "cross-config-error");
  });

  test("실행 전 판정 진리표", () => {
    assert.equal(refusal(before([])), "run");
    assert.deepEqual(refusal(before([ended("completed")])), ["cross-done", "precondition", undefined]);
    assert.equal(refusal(before([ended("cross-unavailable")])), "run", "사람이 아닌 중지는 지점 한도 안에서 다시 실행한다");
    const unavailable3 = before([ended("cross-unavailable"), ended("cross-unavailable"), ended("cross-unavailable")]);
    assert.deepEqual(refusal(unavailable3), ["point-limit", "limit-exceeded", "crossPoint"]);
    assert.ok(unavailable3.action === "refuse" && unavailable3.failure.detail.endsWith("(게이트는 막히지 않습니다)") && unavailable3.failure.origin === "cross-unavailable");
    assert.equal(refusal(before([timeout()])), "run");
    assert.equal(refusal(before([timeout(), timeout()])), "run");
    assert.equal(refusal(before([interrupted(), interrupted()])), "run");
    const interrupted3 = before([interrupted(), interrupted(), interrupted()]);
    assert.deepEqual(refusal(interrupted3), ["point-limit", "limit-exceeded", "crossPoint"]);
    assert.ok(interrupted3.action === "refuse" && !interrupted3.failure.detail.includes("게이트는 막히지"), "끊긴 실행만으로는 중지가 아니다");
    assert.deepEqual(before([ended("cross-result-invalid", { rawPath: "handoff/r.md" })], { rawExists: () => true }), { action: "correct", rawPath: "handoff/r.md" });
    assert.deepEqual(before([ended("cross-result-invalid", { rawPath: "handoff/r.md" })], { rawExists: () => false }), { action: "run" });
    assert.equal(refusal(before([ended("cross-result-invalid")])), "run", "원문이 없는 옛 기록은 다시 실행");
    assert.deepEqual(refusal(before([ended("cross-result-invalid"), ended("cross-result-invalid", { mode: "correct" })])), ["format-limit", "limit-exceeded", "crossFormat"]);
    assert.equal(refusal(before([ended("cross-config-error")])), "run");
    assert.deepEqual(refusal(before([ended("cross-config-error"), ended("cross-config-error")])), ["error-limit", "limit-exceeded", "crossError"]);
    assert.equal(refusal(before([ended("cross-config-error"), ended("cross-config-error")], { grants: [{ key: "crossError", scope: "round:1", step: 1, consent: "c", at: "t", reason: "r" }] })), "run");
    assert.deepEqual(refusal(before([ended("cross-config-error"), ended("cross-config-error")], { grants: [{ key: "crossError", scope: "round:2", step: 1, consent: "c", at: "t", reason: "r" }] })),
      ["error-limit", "limit-exceeded", "crossError"], "다른 지점의 허용은 효력이 없다");
    const preflight = () => ended("host-sandbox-denied", { mode: "preflight", kind: "preflight" });
    assert.equal(refusal(before([preflight(), preflight(), preflight(), preflight()])), "run", "사전 판정은 지점 시도에 세지 않는다");
    assert.deepEqual(refusal(before([ended("cross-stop", { mode: "human" })])), ["cross-stopped", "precondition", undefined]);
    assert.deepEqual(refusal(before([ended("cross-config-error"), ended("cross-stop", { mode: "human" })])), ["cross-stopped", "precondition", undefined]);
    assert.deepEqual(refusal(before([{ ...ended(), endedAt: undefined }])), ["cross-busy", "lock-stale", undefined]);
  });

  test("실행 뒤 판정 — 두 번째 제한 시간은 중지, 이전 중지 지점의 다른 실패는 중지 기록을 그대로 둔다", () => {
    const after = (attempts: CrossAttemptView[], wasStopped = false) => crossPointDecision({ attempts, scope: "round:1", phase: "after", wasStopped });
    assert.deepEqual(after([ended("cross-unavailable", { detail: "Not logged in" })]), { action: "record-unavailable", reason: "Not logged in" });
    const first = after([timeout()]);
    assert.ok(first.action === "refuse" && first.failure.class === "cross-timeout");
    assert.deepEqual(first.action === "refuse" && first.failure.counter, { key: "crossTimeout", used: 0, limit: 1 }, "첫 제한 시간 초과 뒤 재실행 1회가 남았다");
    const second = after([timeout(), timeout()]);
    assert.ok(second.action === "record-unavailable" && /^두 번 연속 9분 제한/.test(second.reason));
    const apart = after([timeout(), ended("cross-config-error"), timeout()]);
    assert.ok(apart.action === "record-unavailable" && /^이 지점에서 두 번 9분 제한/.test(apart.reason), "연속이 아니면 연속이라 쓰지 않는다");
    const config = after([ended("cross-config-error", { detail: "unknown option" })]);
    assert.deepEqual(config.action === "refuse" && config.failure.counter, { key: "crossError", used: 0, limit: 1 }, "첫 설정 오류 뒤 남은 1회");
    const config2 = after([ended("cross-config-error"), ended("cross-config-error")]);
    assert.deepEqual(config2.action === "refuse" && config2.failure.counter, { key: "crossError", used: 1, limit: 1 }, "두 번째 설정 오류 뒤 남은 0회");
    const invalid = after([ended("cross-result-invalid", { detail: "표 아님" })]);
    assert.deepEqual(invalid.action === "refuse" && [invalid.failure.class, invalid.failure.counter], ["cross-result-invalid", { key: "crossFormat", used: 0, limit: 1 }]);
    const sandbox = after([ended("host-sandbox-denied", { detail: "EPERM" })]);
    assert.ok(sandbox.action === "refuse" && sandbox.failure.class === "host-sandbox-denied");
    const rerunConfig = after([ended("cross-unavailable"), ended("cross-config-error", { detail: "x" })], true);
    assert.ok(rerunConfig.action === "refuse" && rerunConfig.failure.detail.endsWith("이전 중지 기록대로 교차 검증 없이 진행합니다(게이트는 막히지 않습니다)"));
    assert.equal(after([ended("cross-unavailable"), ended("cross-unavailable", { detail: "spend cap" })], true).action, "record-unavailable");
    const rerunTimeout = after([ended("cross-unavailable"), timeout(), timeout()], true);
    assert.equal(rerunTimeout.action, "refuse", "이전 중지 지점은 중지 줄을 바꾸지 않는다");
    assert.throws(() => after([ended("completed")]), /실패로 끝난 시도에만/);
  });

  test("교차 예산은 Budget 규약을 따른다 — 남은 횟수는 실행이 받아 주는 횟수와 같고, 사람 허용은 소진된 뒤에만", () => {
    const left = (attempts: CrossAttemptView[]) => Object.fromEntries(Object.entries(crossBudgets(attempts, [], "round:1")).map(([key, budget]) => [key, budget.left]));
    assert.deepEqual(left([]), { crossPoint: 3, crossTimeout: 1, crossError: 1, crossFormat: 1 });
    assert.deepEqual(left([ended("cross-config-error")]), { crossPoint: 2, crossTimeout: 1, crossError: 1, crossFormat: 1 });
    assert.deepEqual(left([ended("cross-config-error"), ended("cross-config-error")]), { crossPoint: 1, crossTimeout: 1, crossError: 0, crossFormat: 1 });
    assert.deepEqual(left([timeout(), interrupted()]), { crossPoint: 1, crossTimeout: 1, crossError: 1, crossFormat: 1 }, "끊긴 실행은 시간 초과 재실행에 세지 않는다");
    assert.deepEqual(left([ended("cross-result-invalid"), ended("cross-result-invalid", { mode: "correct" })]), { crossPoint: 1, crossTimeout: 1, crossError: 1, crossFormat: 0 });
    // 실행 전 판정의 원인별 거부는 그 원인의 예산이 소진됐을 때와 같다
    const kinds: (() => CrossAttemptView)[] = [() => ended("cross-config-error"), () => ended("cross-result-invalid"), () => ended("cross-result-invalid", { mode: "correct" }),
      () => ended("cross-unavailable"), timeout, interrupted, () => ended("host-sandbox-denied")];
    const refusalKey = { "point-limit": "crossPoint", "format-limit": "crossFormat", "error-limit": "crossError" } as const;
    const walk = (attempts: CrossAttemptView[]): void => {
      {
        const decision = before(attempts);
        const budgets = crossBudgets(attempts, [], "round:1");
        if (decision.action === "refuse" && decision.refusal in refusalKey) {
          const key = refusalKey[decision.refusal as keyof typeof refusalKey];
          assert.equal(budgets[key].exhausted, true, `${attempts.map((a) => a.class).join(",")} → ${decision.refusal}`);
          assert.deepEqual(decision.failure.counter, { key, used: budgets[key].used, limit: budgets[key].limit });
        }
        if (decision.action !== "refuse") assert.equal(budgets.crossPoint.exhausted || budgets.crossError.exhausted && attempts.at(-1)?.class !== "cross-result-invalid", false,
          `${attempts.map((a) => a.class).join(",")} → ${decision.action}`);
      }
      if (attempts.length < 3) for (const make of kinds) walk([...attempts, make()]);
    };
    walk([]);
    // C5 retryGrant 의 소진 검사 — 첫 설정 오류 뒤에는 아직 재실행이 남아 허용을 기록하지 않는다
    const grant = (attempts: CrossAttemptView[]) => grantFor({ key: "crossError", scope: "round:1", budget: crossBudgets(attempts, [], "round:1").crossError, consent: "c", reason: "r", at: "t" });
    assert.throws(() => grant([ended("cross-config-error")]), /한도가 남아 있어\(사용 0 \/ 한도 1\)/);
    assert.equal(grant([ended("cross-config-error"), ended("cross-config-error")]).step, 1);
    const granted = crossBudgets([ended("cross-config-error"), ended("cross-config-error")], [{ key: "crossError", scope: "round:1", step: 1, consent: "c", at: "t", reason: "r" }], "round:1");
    assert.deepEqual([granted.crossError.limit, granted.crossError.left], [2, 1]);
  });

  test("지점 안내는 열린 지점에서만 낸다 — 한도 거부도 시도 기록 없이 보인다", () => {
    const hint = (attempts: CrossAttemptView[]) => crossPointHint({ attempts, scope: "round:1" });
    const config = hint([ended("cross-config-error", { detail: "unknown option", kind: "config" })]);
    assert.deepEqual(config && [config.class, config.detail, config.kind, config.counter], ["cross-config-error", "unknown option", "config", { key: "crossError", used: 0, limit: 1 }]);
    const limit = hint([interrupted(), interrupted(), interrupted({ endedAt: "2026-10-07T03:00:00.000Z" })]);
    assert.deepEqual(limit && [limit.class, limit.counter?.key, limit.at], ["limit-exceeded", "crossPoint", "2026-10-07T03:00:00.000Z"], "거부 갈래의 at 도 마지막 실패의 endedAt");
    assert.equal(hint([ended("completed")]), undefined);
    assert.equal(hint([timeout(), timeout()]), undefined, "중지 지점");
    assert.equal(hint([]), undefined);
    assert.equal(hint([{ ...ended(), endedAt: undefined }]), undefined, "실행 중");
    // 끊긴 실행의 안내는 제한 시간 문구가 아니다 — recordedVariant 가 interrupted 변형을 고른다
    const cut = hint([interrupted()])!;
    assert.deepEqual([cut.class, cut.kind, cut.counter], ["cross-timeout", "interrupted", { key: "crossPoint", used: 1, limit: 3 }]);
    const text = guidance(cut.class, { host: "codex", left: cut.counter!.limit - cut.counter!.used, min: 9 }, recordedVariant(cut));
    assert.match(text, /^codex 교차 실행이 끝 기록 없이 끊겼습니다 — 끊긴 실행은 중지로 기록하지 않고 .*남은 지점 시도 2회/);
    assert.equal(/두 번째도 넘기면|제한을 넘겨/.test(text), false);
    const timedOut = hint([timeout()])!;
    assert.match(guidance(timedOut.class, { host: "codex", min: 9 }, recordedVariant(timedOut)), /9분 제한을 넘겨 중단했습니다/);
  });

  test("연속 중지 — 사람 중지는 건너뛰고 완료에서 멈춘다", () => {
    assert.equal(consecutiveCrossStops([{ state: "stopped" }, { state: "stopped", by: "cross-stop" }, { state: "stopped" }, { state: "completed" }, { state: "stopped" }]), 2);
    assert.equal(consecutiveCrossStops([]), 0);
    assert.equal(consecutiveCrossStops([{ state: "open" }, { state: "stopped" }, { state: "none" }, { state: "stopped" }]), 2);
  });
});

describe("잠금·hook 실패 코드", () => {
  test("lockDecision 진리표", () => {
    const owner = { pid: 10, host: "pc", at: "t" };
    assert.equal(lockDecision({ owner, sameHost: false, ageMs: 0, ageReclaim: true }), "stop", "다른 PC");
    assert.equal(lockDecision({ owner, sameHost: true, alive: true, ageMs: 10 * TIMING.lockStaleMs, ageReclaim: true }), "wait", "살아 있으면 나이와 무관하게 기다린다");
    assert.equal(lockDecision({ owner, sameHost: true, alive: false, ageMs: 0, ageReclaim: false }), "reclaim", "죽은 주인은 나이 회수 허용과 무관하다");
    assert.equal(lockDecision({ sameHost: false, ageMs: TIMING.lockStaleMs + 1, ageReclaim: true }), "reclaim");
    assert.equal(lockDecision({ sameHost: false, ageMs: TIMING.lockStaleMs - 1, ageReclaim: true }), "stop");
    assert.equal(lockDecision({ sameHost: false, ageMs: TIMING.lockStaleMs * 2, ageReclaim: false }), "stop");
    assert.equal(lockDecision({ owner: { pid: 10 }, sameHost: true, alive: false, ageMs: 0, ageReclaim: false }), "stop", "호스트가 없는 주인은 주인 없음과 같다");
  });

  test("hookFailureExit — 판정·동의는 막고, Stop·SessionStart·SubagentStop·업무 질문·사용자 메시지는 막지 않는다", () => {
    const exit = (command: Parameters<typeof hookFailureInput>[0], stdin: string) => hookFailureExit(hookFailureInput(command, stdin), "모듈 없음");
    assert.deepEqual(exit("hook", "{}"), { code: 2 });
    assert.deepEqual(exit("hook", "not json"), { code: 2 });
    assert.deepEqual(exit("stop", "{}"), { code: 0 });
    assert.deepEqual(exit("session-event", "{\"source\":\"startup\"}"), { code: 0 });
    assert.deepEqual(exit("consent-event", JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { questions: [], metadata: { source: "code-agent:plan" } } })), { code: 2 });
    assert.deepEqual(exit("consent-event", JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { questions: [] } })), { code: 0 }, "업무 질문");
    assert.deepEqual(exit("consent-event", "{\"hook_event_name\":\"PreToolUse\"}"), { code: 2 }, "질문을 알 수 없으면 막는다");
    assert.deepEqual(exit("consent-event", "not json"), { code: 2 });
    for (const command of ["planning-event", "review-event"] as const) {
      assert.deepEqual(exit(command, "{\"hook_event_name\":\"SubagentStart\"}"), { code: 2 });
      assert.deepEqual(exit(command, "{\"hook_event_name\":\"SubagentStop\"}"), { code: 0 });
    }
    for (const stdin of ["{\"hook_event_name\":\"PreToolUse\"}", "not json"]) {
      const result = exit("codex-event", stdin);
      assert.equal(result.code, 0);
      const output = JSON.parse(result.stdout!);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(output.hookSpecificOutput.permissionDecisionReason, "code-agent codex-event 가 판정에 실패해 막았습니다: 모듈 없음");
    }
    assert.deepEqual(exit("codex-event", "{\"hook_event_name\":\"Stop\"}"), { code: 0, stdout: "{}" });
    assert.deepEqual(exit("codex-event", "{\"hook_event_name\":\"SubagentStop\"}"), { code: 0, stdout: "{}" });
    assert.deepEqual(exit("codex-event", JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "  code-agent consent respond x 1" })), { code: 2 });
    assert.deepEqual(exit("codex-event", JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "안녕하세요" })), { code: 0, stdout: "{}" });
    assert.deepEqual(exit("codex-event", "{\"hook_event_name\":\"UserPromptSubmit\"}"), { code: 2 }, "메시지를 알 수 없으면 막는다");
  });

  test("hookFailureInput 은 stdin 에서 판정 입력만 읽는다", () => {
    assert.deepEqual(hookFailureInput("hook", "[1]"), { command: "hook", parsed: false });
    assert.deepEqual(hookFailureInput("consent-event", JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { metadata: { source: "other" } } })),
      { command: "consent-event", parsed: true, event: "PostToolUse", consentQuestion: false });
    assert.deepEqual(hookFailureInput("codex-event", JSON.stringify({ prompt: "code-agent consent respond" })),
      { command: "codex-event", parsed: true, consentReply: true });
  });
});

describe("측정 — 작업 기록에서 센 카운터(읽기 전용)", () => {
  test("verify·planning·review 기록의 카운터를 합한다", () => {
    const summary = retrySummary({
      evidence: { rounds: 3, runs: [], retry: { version: 1, causes: { 1: "first", 2: "fix", 3: "collect" }, reruns: { 1: 1, 3: 2 }, integrateReruns: { 3: 1 },
        repro: { trees: ["a", "b"], reruns: { a: 1 } }, grants: [] } },
      planning: {
        tasks: [{ attempts: [{ status: "failed" }, { status: "failed" }, { status: "completed", correction: { used: true } }] }, { attempts: [{ status: "cancelled" }] }],
        agents: [{ returns: 1 }, {}],
        crossAttempts: [{ mode: "review", class: "cross-config-error" }, { mode: "correct", class: "cross-result-invalid" }, { mode: "review", class: "cross-timeout", kind: "timeout" },
          { mode: "review", class: "cross-timeout", kind: "interrupted" }, { mode: "preflight", class: "host-sandbox-denied" }],
      },
      review: { rounds: [
        { reviewers: [{ returns: 1 }, { ignored: { reason: "completed-round" } }, { ignored: { reason: "orphaned" } }], cross: { unavailable: "x" } },
        { reviewer: { completedAt: "t" }, crossAttempts: [{ mode: "review", class: "completed" }] },
      ] },
    });
    assert.deepEqual(Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== 0)), {
      fix: 1, collect: 1, rerun: 3, integrateRerun: 1, reproRerun: 1, reproAttempt: 2, totalRounds: 3,
      reviewRounds: 2, reviewerRuns: 3, agentReturn: 2, correction: 1, sameInput: 2, taskTotal: 4,
      crossPoint: 6, crossTimeout: 1, crossError: 1, crossFormat: 1,
    });
    assert.equal(Object.keys(summary).length, COUNTER_KEYS.length);
  });

  test("retry 가 없는 옛 증거는 추정하고, 깨진 값은 0 으로 센다", () => {
    const legacy = retrySummary({ evidence: { rounds: 3, runs: [{ round: 1, phase: "test", kind: "test", outcome: "failed" }, { round: 2, phase: "test", kind: "test", outcome: "failed" }] } });
    assert.equal(legacy.fix, 2);
    const broken = retrySummary({ evidence: "x", planning: { tasks: "no" }, review: { rounds: [null, 3] } });
    assert.ok(Object.values(broken).every((value) => value === 0));
  });
});

describe("문서 생성 블록", () => {
  test("원인 표는 21행이고 FAILURE_CLASSES 순서다", () => {
    const lines = renderRetryPolicyTable().split("\n");
    assert.equal(lines[0], "| 원인 | 판별 | 재시도 | 한도 | 고쳐 쓰기 회차 | 넘으면 |");
    assert.equal(lines.length, 2 + FAILURE_CLASSES.length);
    FAILURE_CLASSES.forEach((cls, index) => assert.ok(lines[index + 2].startsWith(`| \`${cls}\` ${POLICIES[cls].label}`), cls));
    for (const line of lines) assert.equal(line.split(/(?<!\\)\|/).length, 8, line);
    assert.match(lines.find((line) => line.includes("`cross-timeout`"))!, /두 번째 제한 시간은 중지 기록 후 진행, 끊긴 실행은 지점 한도 뒤 decision/);
    assert.match(lines.find((line) => line.includes("`dispatch-orphan`"))!, /시작 미관찰 10분·시작 관찰 60분/);
  });
});

describe("순수 모듈 — hook 이 매번 읽으므로 무거운 의존이 없다", () => {
  const PROBE = "const M=require('module');const s=new Set();const o=M._load;M._load=function(r,p,i){const x=o.apply(this,arguments);try{s.add(M._resolveFilename(r,p,i))}catch{}return x};require(process.argv[1]);process.stdout.write(JSON.stringify([...s]))";
  const loaded = (file: string): string[] => JSON.parse(execFileSync(process.execPath, ["-e", PROBE, file], { encoding: "utf8" })) as string[];
  const agentDir = join(__dirname, "..", "agent");
  const heavy = (entry: string) => /^(?:node:)?(?:fs|child_process|path)$/.test(entry) || /[\\/]node_modules[\\/]zod[\\/]/.test(entry);
  const local = (entries: string[]) => entries.filter((entry) => entry.startsWith(agentDir)).map((entry) => entry.slice(agentDir.length + 1)).sort();

  test("retryPolicy.js 는 stop.js 말고 아무것도 읽지 않는다", () => {
    const entries = loaded(join(agentDir, "retryPolicy.js"));
    assert.deepEqual(entries.filter(heavy), []);
    assert.deepEqual(local(entries), ["retryPolicy.js", "stop.js"]);
  });

  test("crossEnv.js 는 아무것도 읽지 않는다", () => {
    const entries = loaded(join(agentDir, "crossEnv.js"));
    assert.deepEqual(entries.filter(heavy), []);
    assert.deepEqual(local(entries), ["crossEnv.js"]);
  });

  test("hostText.js 는 로드할 때 crossEnv.js 말고 읽지 않는다(hosts.json 은 notationFor 가 부를 때만 fs 를 지연 로드)", () => {
    const entries = loaded(join(agentDir, "hostText.js"));
    assert.deepEqual(entries.filter(heavy), []);
    assert.deepEqual(local(entries), ["crossEnv.js", "hostText.js"]);
  });
});
