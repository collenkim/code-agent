/**
 * 실패 원인별 재시도 규약 — 원인 분류·카운터·한도·사람 허용·안내 문구의 단일 원천.
 *
 * 원칙: 원인 판정은 코드가 하고(모델은 결과의 failure.class 를 읽고 따른다), CLI 는 스스로 다시 실행하지 않는다.
 * 같은 입력으로 같은 실패를 되풀이하지 않고, 재실행으로 완료 기록을 지우지 않으며, 상한에 닿으면 사람에게 넘긴다.
 *
 * 순수 모듈이다: fs·zod·child_process·path 를 import 하지 않는다(hook 이 매번 읽는다 — 순수성 테스트가 지킨다).
 * 파일 입출력이 필요한 잠금은 lock.ts, 사람 허용 기록은 retryGrant.ts 가 맡는다.
 * doc/process-flow.md §6.4 의 생성 블록은 renderRetryPolicyTable() 출력과 바이트가 같아야 한다(docSync 테스트).
 */
import { Stop } from "./stop";

export const RETRY_POLICY_VERSION = 1 as const;

// ---- 원인·카운터 ----

export const FAILURE_CLASSES = [
  "code-defect", "environment", "interrupted", "result-unconfirmed", "precondition",
  "agent-format-error", "agent-content-error", "dispatch-orphan", "same-input-repeat", "reassign-total",
  "cross-unavailable", "cross-config-error", "cross-timeout", "cross-result-invalid", "host-sandbox-denied",
  "blocking-finding", "limit-exceeded",
  "consent-target-changed", "consent-apply-failed", "lock-stale", "hook-failure",
] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];
export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === "string" && (FAILURE_CLASSES as readonly string[]).includes(value);
}

/** 재시도 방식 — 무엇이 바뀌어야 다시 시도할 수 있는가 */
export type RetryMode = "fix-then-verify" | "env-then-retry" | "correct-once" | "same-input-reassign" | "rerun-once" | "auto" | "no-retry";
/** 인계 — repair·diagnose·decision 은 verify 노드, blocked 는 planning advance, consent:judgment 는 사람 판단 동의 */
export type Handoff = "repair" | "diagnose" | "decision" | "blocked" | "consent:judgment" | "stop-record-proceed" | "stop" | "none";

export const COUNTER_KEYS = [
  "fix", "collect", "rerun", "integrateRerun", "reproRerun", "reproAttempt",
  "reviewRounds", "totalRounds", "reviewerRuns",
  "agentReturn", "correction", "sameInput", "taskTotal",
  "crossPoint", "crossTimeout", "crossError", "crossFormat", "lockBusy",
] as const;
export type CounterKey = typeof COUNTER_KEYS[number];

/**
 * 카운터 이름표의 단일 원천 — 한도 문구(`{counterLabel} 한도 N회`)·거부 문구·사람 허용 미리보기(retryGrant)·측정 보고(retryReport)가
 * 모두 이 표를 import 해 쓴다. 다른 모듈에 이름표를 따로 정의하지 않는다(같은 동의 흐름에서 이름이 갈리지 않게).
 */
export const COUNTER_LABEL: Readonly<Record<CounterKey, string>> = {
  fix: "고쳐 쓰기", collect: "수집 수정", rerun: "같은 코드 재실행", integrateRerun: "통합 검증 재실행",
  reproRerun: "재현 재실행", reproAttempt: "재현 시도", reviewRounds: "리뷰 회차", totalRounds: "검증 회차 총합",
  reviewerRuns: "리뷰어 호출", agentReturn: "담당 되돌림", correction: "형식 교정", sameInput: "같은 입력 실패",
  taskTotal: "작업 총 배정", crossPoint: "교차 지점 시도", crossTimeout: "교차 시간 초과 재실행",
  crossError: "교차 설정 오류 재실행", crossFormat: "교차 형식 교정 재실행", lockBusy: "잠금 대기 재실행",
};

/** 기본 한도. fix 는 매니페스트 fixRounds(증거에 고정), totalRounds 는 구성 한도에서 나온다 — 여기 없다 */
export const LIMITS = {
  collect: 1, rerun: 2, integrateRerun: 2, reproRerun: 2, reproAttempt: 3,
  reviewRounds: 3, reviewerRuns: 2, agentReturn: 1, correction: 1,
  sameInput: 3, taskTotal: 6, crossPoint: 3, crossTimeout: 1, crossError: 1, crossFormat: 1, lockBusy: 1,
} as const satisfies Partial<Record<CounterKey, number>>;
/** 사람 허용(judgment retry-grant) 한 번에 늘리는 양. 여기 없는 카운터는 사람 허용으로 늘리지 않는다 */
export const GRANT_STEP = {
  fix: 1, rerun: 1, integrateRerun: 1, reproRerun: 1, reproAttempt: 1, reviewRounds: 1,
  reviewerRuns: 1, sameInput: 1, taskTotal: 3, crossPoint: 1, crossError: 1, crossFormat: 1,
} as const satisfies Partial<Record<CounterKey, number>>;
export const TIMING = {
  /** CLI 맥락의 잠금 대기 */
  lockWaitMs: 2_000,
  /** hook 맥락의 잠금 대기 */
  hookLockWaitMs: 10_000,
  /** 주인 기록이 없는 잠금을 회수하는 나이(나이 회수를 허용한 잠금만) */
  lockStaleMs: 600_000,
  /** 배정(또는 그 뒤 관찰된 마지막 담당 활동) 뒤 담당 시작이 관찰되지 않으면 의심 고아 */
  orphanStartGraceMs: 600_000,
  /** 시작이 관찰된 담당이 끝나지 않은 채 이만큼 지나면 의심 고아 */
  orphanRunMs: 3_600_000,
  /** 교차 실행의 기본 제한(분) — CODE_AGENT_CROSS_TIMEOUT_MIN 으로 바꾼다 */
  crossTimeoutMin: 9,
  /** 받아들인 리뷰어 실행이 이 시간 넘게 끝나지 않으면 고아로 보고 새 호출을 받는다 */
  reviewerOrphanMs: 900_000,
  /** 동의 준비·적용 티켓의 유효 기간 */
  consentTicketTtlMs: 900_000,
  /** 세션 밖에서 응답·적용을 기다리는 동의가 셸을 좁히는 기간 */
  consentOpenWindowMs: 1_800_000,
} as const;

const limitTable = LIMITS as Readonly<Partial<Record<CounterKey, number>>>;
const grantTable = GRANT_STEP as Readonly<Partial<Record<CounterKey, number>>>;
const minutes = (ms: number): number => Math.round(ms / 60_000);

// ---- 실패 기록·거부 ----

export interface RetryGrant { key: CounterKey; scope: string; step: number; consent: string; at: string; reason: string }
export interface FailureRecord {
  class: FailureClass; at: string; detail: string;
  /** limit-exceeded 의 원래 원인 */
  origin?: FailureClass;
  counter?: { key: CounterKey; used: number; limit: number };
  /** 세부 갈래 — 교차(missing·auth·…·preflight)·동의(target·apply…) 등. 판정은 class 로만 한다 */
  kind?: string;
}

/** 재시도를 거부한다. Stop 의 하위 클래스라 CLI 는 exit 1 이다. 거부는 아무것도 저장하기 전에 한다 */
export class RetryRefused extends Stop {
  constructor(readonly failure: FailureRecord, message?: string) { super(message ?? failure.detail); }
}
export function failure(cls: FailureClass, detail: string, extra: Partial<Omit<FailureRecord, "class" | "detail">> = {}): FailureRecord {
  const { at, ...rest } = extra;
  return { class: cls, at: at ?? new Date().toISOString(), detail, ...rest };
}
export function refuse(cls: FailureClass, detail: string, extra?: Partial<Omit<FailureRecord, "class" | "detail">>, message?: string): never {
  throw new RetryRefused(failure(cls, detail, extra), message);
}

// ---- 한도·사람 허용 ----

/** 유효 한도 = 기본 한도 + 같은 key·scope 의 사람 허용 합. base 를 주지 않으면 LIMITS 의 값이다. 양의 정수가 아닌 step(손상 기록)은 세지 않는다 */
export function limitOf(key: CounterKey, base: number | undefined, grants: readonly RetryGrant[] = [], scope = ""): number {
  const start = base ?? limitTable[key];
  if (start === undefined) throw new Error(`${key} 의 기본 한도가 없습니다 — base 를 넘기세요`);
  return grants
    .filter((grant) => grant.key === key && grant.scope === scope)
    .reduce((sum, grant) => sum + (Number.isInteger(grant.step) && grant.step > 0 ? grant.step : 0), start);
}
export interface Budget { key: CounterKey; used: number; limit: number; left: number; exhausted: boolean }
export function budgetOf(key: CounterKey, used: number, base: number | undefined, grants?: readonly RetryGrant[], scope?: string): Budget {
  const limit = limitOf(key, base, grants, scope);
  return { key, used, limit, left: Math.max(0, limit - used), exhausted: used >= limit };
}

/** 사람 허용의 범위 — 문자열을 손으로 만들지 않고 이 함수로 만든다(판정·기록이 같은 값을 쓴다) */
export type GrantPoint =
  | { file: "verify"; key: "fix" | "reproAttempt" }
  | { file: "verify"; key: "rerun" | "integrateRerun"; round: number }
  | { file: "verify"; key: "reproRerun"; tree: string }
  | { file: "review"; key: "reviewRounds" }
  | { file: "review"; key: "reviewerRuns" | "crossPoint" | "crossError" | "crossFormat"; round: number }
  | { file: "planning"; key: "taskTotal"; taskId: string }
  | { file: "planning"; key: "sameInput"; taskId: string; inputHash: string }
  | { file: "planning"; key: "crossPoint" | "crossError" | "crossFormat"; criticDispatchId: string };
export function grantScope(point: GrantPoint): string {
  if ("round" in point) return `round:${point.round}`;
  if ("tree" in point) return `tree:${point.tree}`;
  if ("inputHash" in point) return `planning:${point.taskId}:${point.inputHash}`;
  if ("taskId" in point) return `planning:${point.taskId}`;
  if ("criticDispatchId" in point) return `critic:${point.criticDispatchId}`;
  return "";
}
export function grantable(key: string): key is keyof typeof GRANT_STEP { return key in GRANT_STEP; }
/**
 * 관찰된 사람 판단으로 남길 허용 한 건. 늘리지 않는 카운터와 소진되지 않은 카운터는 거부한다 —
 * 한도를 미리 늘려 두는 길을 닫는다.
 */
export function grantFor(input: { key: string; scope: string; budget: Budget; consent: string; reason: string; at?: string }): RetryGrant {
  if (!grantable(input.key)) {
    throw new Stop(`이 카운터는 사람 허용으로 늘리지 않습니다: ${input.key} — 재계획·재승인이나 작업 종료(abort)를 고르게 하세요. ` +
      `허용할 수 있는 카운터: ${Object.keys(GRANT_STEP).join(", ")}`);
  }
  const { budget } = input;
  // 다른 카운터의 예산으로 소진 검사를 우회하지 못하게 한다(호출자 실수)
  if (budget.key !== input.key) throw new Error(`grantFor: 허용할 카운터(${input.key})와 예산의 카운터(${budget.key})가 다릅니다`);
  if (!budget.exhausted) {
    throw new Stop(`${COUNTER_LABEL[budget.key]} 한도가 남아 있어(사용 ${budget.used} / 한도 ${budget.limit}) 허용을 기록하지 않습니다 — 한도를 미리 늘리지 않습니다.`);
  }
  return { key: input.key, scope: input.scope, step: GRANT_STEP[input.key], consent: input.consent, at: input.at ?? new Date().toISOString(), reason: input.reason };
}

// ---- 원인별 정책 ----

export type PolicyGroup = "verify" | "planning" | "cross" | "review" | "consent" | "infra";
export interface ClassPolicy {
  id: FailureClass; label: string; group: PolicyGroup;
  /** 분류 밖으로 새는 Stop·hook 예외를 담는 보조 분류 */
  auxiliary: boolean;
  /** 판별 규칙 요지 */
  detect: string;
  retry: RetryMode;
  /** 재시도 요지 */
  retryText: string;
  counters: readonly CounterKey[];
  /** 한도 요지 */
  limitText: string;
  /** 고쳐 쓰기 회차(fix)를 쓰는가 — after-change: 같은 코드면 안 쓰고 고치면 쓴다, after-collect: 수집 수정 1회 뒤부터 쓴다 */
  consumesFixRound: boolean | "after-change" | "after-collect";
  fixRoundText: string;
  handoff: Handoff; onExhausted: Handoff;
  /** 상한 초과·금지 때의 인계 요지 */
  exceededText: string;
  /** 기본 안내 문구 — 자리표시 `{이름}` 은 GUIDE_KEYS 와 같아야 한다 */
  guide: string;
  enforcedAt: readonly string[];
}

const MIN_START = minutes(TIMING.orphanStartGraceMs), MIN_RUN = minutes(TIMING.orphanRunMs), MIN_LOCK = minutes(TIMING.lockStaleMs);
const SEC_WAIT = TIMING.lockWaitMs / 1000, SEC_HOOK_WAIT = TIMING.hookLockWaitMs / 1000;

export const POLICIES: Readonly<Record<FailureClass, ClassPolicy>> = {
  "code-defect": {
    id: "code-defect", label: "코드 결함", group: "verify", auxiliary: false,
    detect: "환경이 아닌 failed 실행·failed TC(환경 문구보다 우선), 계획 안 리뷰 지적",
    retry: "fix-then-verify", retryText: "계획 안에서 고친 뒤 `verify`. 같은 코드의 `--retry`도 고쳐 쓰기 회차를 쓴다",
    counters: ["fix", "reviewRounds", "totalRounds"],
    limitText: `고쳐 쓰기 ≤ fixRounds(기본 2), 리뷰 회차 ≤ ${LIMITS.reviewRounds}, 총 회차 ≤ 1+고쳐 쓰기+리뷰+수집`,
    consumesFixRound: true, fixRoundText: "씀(통과 뒤 변경은 리뷰 회차)",
    handoff: "repair", onExhausted: "decision", exceededText: "decision",
    guide: "검증이 실패했습니다({failed}). 승인된 계획 안에서 고친 뒤 code-agent verify 로 다시 검증하세요 — check 부터 다시 돕니다. 같은 코드의 --retry 도 고쳐 쓰기 회차를 씁니다. ({budget})",
    enforcedAt: ["validate.ts check()", "verificationFlow.ts assess·check.execute", "hook.ts freezeReason", "commands.ts nextHint·context", "review.ts openRound"],
  },
  environment: {
    id: "environment", label: "환경", group: "verify", auxiliary: false,
    detect: "선언 문구가 있고 그 실행에 실패 TC 없음(재현은 실패 결과가 있어도 문구만으로), 실행 파일 없음·실행 실패, prepare 실패",
    retry: "env-then-retry", retryText: "환경을 확인받은 뒤 `verify --retry`(같은 회차). 통합 검증은 `integrate`, 재현은 `repro`",
    counters: ["rerun", "integrateRerun", "reproRerun"],
    limitText: `같은 코드 재실행 ≤ ${LIMITS.rerun}/회차, 통합 재실행 ≤ ${LIMITS.integrateRerun}/회차, 재현 재실행 ≤ ${LIMITS.reproRerun}/테스트 트리`,
    consumesFixRound: "after-change", fixRoundText: "같은 코드면 안 씀, 고치면 씀",
    handoff: "diagnose", onExhausted: "decision", exceededText: "decision",
    guide: "환경 문제로 실행하지 못했습니다({kind}: {reason}). 코드를 고치지 말고 사용자에게 환경을 확인받은 뒤 code-agent verify --retry 로 같은 회차를 다시 돌리세요 — 고쳐 쓰기 회차를 쓰지 않습니다(남은 같은 코드 재실행 {rerunLeft}회). 같은 실패가 반복되는데 선언이 없으면 code-agent.json 의 environmentErrors 선언을 사용자에게 제안합니다.",
    enforcedAt: ["validate.ts runSpecs·check()·integrate()·repro()", "verificationFlow.ts assess"],
  },
  interrupted: {
    id: "interrupted", label: "중단·시간 초과", group: "verify", auxiliary: false,
    detect: "명령 제한 시간 초과, 실행 기록 없는 회차, 시작 표지만 남은 test·통합 검증",
    retry: "env-then-retry", retryText: "셸 명령의 제한 시간을 길게 주거나 백그라운드로 같은 명령, 같은 회차",
    counters: ["rerun", "integrateRerun"],
    limitText: `같은 코드 재실행 ≤ ${LIMITS.rerun}/회차, 통합 재실행 ≤ ${LIMITS.integrateRerun}/회차`,
    consumesFixRound: "after-change", fixRoundText: "같은 코드면 안 씀, 끊긴 뒤 고치면 씀",
    handoff: "diagnose", onExhausted: "decision", exceededText: "decision",
    guide: "{kind} 이(가) 제한 시간 {minutes}분을 넘겨 중단됐습니다. 끝나지 않는 테스트(대기·무한 루프)인지 로그({logFile})로 확인하고, 정상인데 오래 걸리면 사용자가 code-agent.json 의 commandTimeoutMinutes 를 늘립니다. 그 뒤 code-agent verify --retry — 같은 회차를 다시 쓰고 고쳐 쓰기 회차를 쓰지 않습니다(남은 같은 코드 재실행 {rerunLeft}회).",
    enforcedAt: ["core/build.ts runCommand(timedOut)", "validate.ts runSpecs·check()·integrate()", "verificationFlow.ts"],
  },
  "result-unconfirmed": {
    id: "result-unconfirmed", label: "결과 미확인", group: "verify", auxiliary: false,
    detect: "실패 없이 ⑦ TC 가 unknown·skipped·not-run, 재현 못함",
    retry: "fix-then-verify", retryText: "수집(TC 이름·보고 형식)을 고친 뒤 `verify`, 보고 위치만 고쳤으면 `verify --retry`",
    counters: ["collect", "fix", "rerun", "reproAttempt"],
    limitText: `수집 수정 ${LIMITS.collect}(fix 작업 0), 재현 시도 ${LIMITS.reproAttempt}`,
    consumesFixRound: "after-collect", fixRoundText: "수집 수정 1회는 안 씀, 그 뒤 씀",
    handoff: "diagnose", onExhausted: "decision", exceededText: "decision, 재현은 repro-log 동의",
    guide: "명령은 끝났지만 ⑦ 의 TC 결과가 확인되지 않았습니다: {cases}. 테스트 이름에 TC id 를 넣거나 결과 형식을 맞춘 뒤 code-agent verify 로 다시 검증하세요. {collectNote} 코드·테스트를 그대로 두고 보고서 위치·환경만 고쳤으면 code-agent verify --retry (남은 같은 코드 재실행 {rerunLeft}회).",
    enforcedAt: ["evidence.ts stageProblems", "validate.ts check()·repro()", "hook.ts freezeReason(수집 예외)"],
  },
  precondition: {
    id: "precondition", label: "전제·선언 미충족", group: "infra", auxiliary: true,
    detect: "명령 미선언(not-run), 단계·순서·승인·계획 밖 변경 등 전제 Stop",
    retry: "no-retry", retryText: "없음 — 전제를 채운 뒤 한 번",
    counters: [], limitText: "—",
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "stop", onExhausted: "stop", exceededText: "Stop(사유 그대로)",
    guide: "검증 전제가 맞지 않습니다: {problems}. 실행 결과가 아니라 전제·대조의 문제라 이 상태 그대로 다시 돌려도 같습니다. 계획 밖 변경·바뀐 동결/보존 테스트는 되돌리거나 치운 뒤, 재현 기록이 없으면 code-agent repro 뒤에 code-agent verify 로 다시 검증하세요. 명령 선언·승인·계획 변경이 필요하면 사유를 사용자에게 알리고 멈추세요 — 사람이 정하고 재승인합니다.",
    enforcedAt: ["각 명령의 Stop(RetryRefused 가 아닌 Stop)", "verificationFlow.ts assess"],
  },
  "agent-format-error": {
    id: "agent-format-error", label: "담당 출력 형식 오류", group: "planning", auxiliary: false,
    detect: "결과 JSON·스키마 위반, 리뷰 결과가 지적 표·`- 없음`이 아님",
    retry: "correct-once", retryText: "Claude 는 같은 담당에게 1회 되돌림, 그다음(Codex 는 바로) 형식만 교정 1회. 리뷰어는 같은 회차 재호출",
    counters: ["agentReturn", "correction", "reviewerRuns"],
    limitText: `되돌림 ${LIMITS.agentReturn}, 교정 ${LIMITS.correction}, 리뷰어 호출 ${LIMITS.reviewerRuns}/회차`,
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "none", onExhausted: "blocked", exceededText: "같은 입력 규칙, 리뷰어는 decision",
    // 기본 문구는 기록 전에 같은 담당에게 돌려보내는 문구다(C2 SubagentStop). 기록된 시도는 record 변형(recordedVariant)
    guide: "결과 형식 오류입니다 — {detail}. 같은 배정의 resultShape 형태 JSON 하나로 다시 반환하세요(문서 본문은 staging 그대로).",
    enforcedAt: ["planningHook.ts observePlanner", "reviewHook.ts observeReviewer", "retryPolicy.subagentExit", "planning.ts repairState"],
  },
  "agent-content-error": {
    id: "agent-content-error", label: "담당 결과 내용 오류", group: "planning", auxiliary: false,
    detect: "근거·출력 집합·질문 범위·결정적 문서 검사 실패",
    retry: "fix-then-verify", retryText: "Claude 되돌림 1, 그다음 실패 기록 → 수정 피드백을 입력에 넣어 재배정",
    counters: ["agentReturn", "sameInput", "taskTotal"],
    limitText: `되돌림 ${LIMITS.agentReturn}, 같은 입력 실패 ${LIMITS.sameInput}, 작업 총 배정 ${LIMITS.taskTotal}`,
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "none", onExhausted: "blocked", exceededText: "총 배정 상한 → 사람 판단",
    // 기본 문구는 기록 전에 같은 담당에게 돌려보내는 문구다(C2 SubagentStop). 기록된 시도는 record 변형(recordedVariant)
    guide: "결과가 검사에 걸렸습니다 — 고친 뒤 같은 형태의 결과 JSON을 다시 반환하세요(한 번만 돌려보냅니다):\n{detail}",
    enforcedAt: ["planningHook.ts observePlanner", "stagedChecks.ts(결정적 문서 검사)", "commands.ts next(최종 게이트)"],
  },
  "dispatch-orphan": {
    id: "dispatch-orphan", label: "배정 식별 불일치·고아 실행", group: "planning", auxiliary: false,
    detect: `식별 불일치·특정 불가·출처 검증 실패, 연결 담당이 끝났는데 running, 시작 미관찰 ${MIN_START}분·시작 관찰 ${MIN_RUN}분`,
    retry: "same-input-reassign", retryText: "Claude 식별 되돌림 1. 확실한 고아는 advance 가 자동 재배정, 의심 고아는 `planning cancel` 뒤 advance",
    counters: ["agentReturn", "taskTotal"],
    limitText: "같은 입력 실패에 안 셈, 작업 총 배정에 셈",
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "none", onExhausted: "blocked", exceededText: "총 배정 상한 → 사람 판단",
    guide: "배정 {id}의 결과가 기록되지 않았습니다 — {detail}. 이 대화에서 아직 담당을 호출하지 않은 배정이면 지금 호출합니다. 호출했는데 결과가 없으면 기다리지 말고 planning cancel {id} 뒤 planning advance 로 다시 배정합니다.",
    enforcedAt: ["planningHook.ts observePlanner", "planning.ts advancePlanning·dispatchState·cancelPlanning", "codexHook.ts runCodexHook"],
  },
  "same-input-repeat": {
    id: "same-input-repeat", label: "같은 입력 반복 실패", group: "planning", auxiliary: false,
    detect: `같은 작업·같은 inputHash 로 failed ${LIMITS.sameInput}`,
    retry: "same-input-reassign", retryText: "입력을 보완한 뒤 `planning dispatch`로 명시할 때만",
    counters: ["sameInput"],
    limitText: `같은 입력 실패 ${LIMITS.sameInput}(+${GRANT_STEP.sameInput}/사람)`,
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "blocked", onExhausted: "consent:judgment", exceededText: "질문·사람 판단",
    guide: "같은 입력으로 {limit}번 실패했습니다(취소·고아는 세지 않습니다). 원인·질문을 확인하고 입력이나 작업 정의를 보완하세요. 보완할 수 없으면 사용자에게 보고하고 사람 판단을 받습니다.",
    enforcedAt: ["planning.ts dispatchState·repairState·advancePlanning"],
  },
  "reassign-total": {
    id: "reassign-total", label: "입력 변경 재배정 총 상한", group: "planning", auxiliary: false,
    detect: "작업별 배정 수(이행 시각 이후, 취소·고아 포함)",
    retry: "no-retry", retryText: "없음 — 자동 재배정을 멈춘다",
    counters: ["taskTotal"],
    limitText: `작업 총 배정 ${LIMITS.taskTotal}(+${GRANT_STEP.taskTotal}/사람)`,
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "blocked", onExhausted: "consent:judgment", exceededText: "사람 판단(judgment)",
    // 실행할 수 있는 선택지만 적는다 — 사람 허용(judgment retry-grant)을 부르는 동의가 연결되기 전에도 거짓이 되지 않는 문구.
    // 같은 작업을 다시 준비해도 시도 기록이 남으므로 "재계획"으로 한도가 풀린다고 안내하지 않는다
    guide: "작업 {id}의 배정이 총 {limit}회에 닿았습니다(취소·고아 포함) — 자동 재배정을 멈춥니다. 같은 작업을 다시 준비(planning prepare)해도 배정 기록은 그대로라 한도가 풀리지 않습니다. 막힌 이유와 기록(code-agent planning status)을 사용자에게 보고하고 지시를 받으세요.",
    enforcedAt: ["planning.ts dispatchState·repairState"],
  },
  "cross-unavailable": {
    id: "cross-unavailable", label: "교차 호스트 실행 불가", group: "cross", auxiliary: false,
    detect: "오류 채널의 미설치·인증·한도·네트워크·장애 문구, 실행 파일 없음",
    retry: "no-retry", retryText: "없음 — 중지 기록 후 진행. 사람이 아닌 중지 지점은 지점 한도 안에서 다시 실행할 수 있다",
    counters: ["crossPoint"],
    limitText: `지점 시도 ${LIMITS.crossPoint}`,
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "stop-record-proceed", onExhausted: "stop-record-proceed", exceededText: "진행",
    guide: "{host} 교차 검증 중지 — 다른 호스트를 실행할 수 없습니다: {detail}. 이 지점은 교차 검증 없이 진행합니다. 두 호스트를 모두 쓸 수 있게 되면(설치·로그인·사용 한도) 다음 지점부터 다시 돕니다.",
    enforcedAt: ["crossCheck.ts(classifyCrossFailure)", "review.ts reviewProblems", "planningState.ts crossCriticProblems"],
  },
  "cross-config-error": {
    id: "cross-config-error", label: "교차 호출 설정 오류", group: "cross", auxiliary: false,
    detect: "알 수 없는 옵션·모델 없음·강도 오류, 화이트리스트 밖 비정상 종료, JSON 아님",
    retry: "rerun-once", retryText: "설정을 고친 뒤 같은 명령 1회",
    counters: ["crossError", "crossPoint"],
    limitText: `설정 오류 재실행 ${LIMITS.crossError}, 지점 시도 ${LIMITS.crossPoint}`,
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "stop", onExhausted: "decision", exceededText: "decision(게이트 막힘)",
    guide: "{host} 교차 호출 설정 오류 — {detail}\n중지로 기록하지 않았고 게이트는 막혀 있습니다. 원인을 사용자에게 전하세요 — 모델 설정은 사용자 확인을 받아 ca-answer 동의 model 로 바꾸고(지금 값은 code-agent model --host {host}), CLI 옵션은 사람이 별도 터미널에서 code-agent doctor --cross 로 점검하며(작업 중에는 모델이 doctor 를 실행할 수 없다), CODE_AGENT_CLAUDE_BIN·CODE_AGENT_CODEX_BIN 과 CLI 설치는 사람이 셸에서 고칩니다. 고친 뒤 같은 명령을 한 번 더 실행할 수 있습니다(남은 {left}회). 고칠 수 없으면 사람이 중지를 결정해 ca-answer 동의 judgment cross-stop 으로 기록합니다.",
    enforcedAt: ["crossCheck.ts", "retryPolicy.CROSS_PATTERNS·classifyCrossFailure"],
  },
  "cross-timeout": {
    id: "cross-timeout", label: "교차 시간 초과", group: "cross", auxiliary: false,
    detect: "ETIMEDOUT(제한 시간), 끝 기록 없이 끊긴 실행",
    retry: "rerun-once", retryText: "제한 시간이면 백그라운드 1회",
    counters: ["crossTimeout", "crossPoint"],
    limitText: `시간 초과 ${LIMITS.crossTimeout}, 지점 ${LIMITS.crossPoint}`,
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "stop", onExhausted: "stop-record-proceed", exceededText: "두 번째 제한 시간은 중지 기록 후 진행, 끊긴 실행은 지점 한도 뒤 decision",
    guide: "{host} 교차 실행이 {min}분 제한을 넘겨 중단했습니다 — 이 지점에서 한 번 더 실행할 수 있습니다. 같은 명령을 백그라운드로 다시 실행하세요. 두 번째도 넘기면 중지로 기록하고 진행합니다.",
    enforcedAt: ["crossCheck.ts", "crossRecord.ts orphanView"],
  },
  "cross-result-invalid": {
    id: "cross-result-invalid", label: "교차 결과 형식 오류", group: "cross", auxiliary: false,
    detect: "지적 표·JSON 아님, 표 규칙·근거 범위 위반(F→X 정규화 뒤)",
    retry: "correct-once", retryText: "같은 명령으로 원문의 형식만 교정 1회",
    counters: ["crossFormat", "crossPoint"],
    limitText: `형식 교정 ${LIMITS.crossFormat}, 지점 시도 ${LIMITS.crossPoint}`,
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "stop", onExhausted: "decision", exceededText: "decision(게이트 막힘)",
    guide: "{host} 교차 결과 형식이 맞지 않습니다({point}: {detail}) — 원문을 {raw} 에 보존했습니다. 같은 명령을 한 번 더 실행하면 원문의 형식만 교정합니다(남은 {left}회).",
    enforcedAt: ["crossCheck.ts"],
  },
  "host-sandbox-denied": {
    id: "host-sandbox-denied", label: "Codex 샌드박스 제한", group: "cross", auxiliary: false,
    detect: "샌드박스 표지(사전 판정), EPERM·EACCES·거부 문구, 샌드박스 안 네트워크 오류(Codex 가 부른 claude 의 지점 첫 네트워크 오류 포함)",
    retry: "no-retry", retryText: "권한 상승을 요청해 같은 명령",
    counters: [], limitText: "—",
    consumesFixRound: false, fixRoundText: "안 씀",
    handoff: "stop", onExhausted: "consent:judgment", exceededText: "사람(judgment cross-stop)",
    guide: "Codex 샌드박스가 {host} 실행을 막았습니다({detail}) — 셸 도구의 권한 상승(샌드박스 밖 실행)을 요청해 같은 명령을 다시 실행하세요. 중지로 기록하지 않았습니다. 사용자가 권한 상승을 거절하면 ca-answer 동의 judgment cross-stop 으로 이 지점의 중지를 기록합니다.",
    enforcedAt: ["crossCheck.ts(crossPreflight)", "retryPolicy.classifyCrossFailure"],
  },
  "blocking-finding": {
    id: "blocking-finding", label: "차단 지적", group: "review", auxiliary: false,
    detect: "열린 F·X 지적, critic·교차 critic 의 blocking 지적",
    retry: "fix-then-verify", retryText: "재실행으로 지우지 못한다 — 계획 안은 고친 뒤 새 회차, 계획 밖은 질문·재계획",
    counters: ["reviewRounds", "taskTotal"],
    limitText: `리뷰 회차 ${LIMITS.reviewRounds}`,
    consumesFixRound: false, fixRoundText: "안 씀(리뷰 회차를 쓴다)",
    handoff: "repair", onExhausted: "consent:judgment", exceededText: "사람 기각(judgment waive-finding)",
    guide: "열린 지적 {ids} — 같은 회차를 다시 리뷰하거나 같은 지점을 다시 실행해 지울 수 없습니다. 계획 안이면 고친 뒤 code-agent verify 로 다시 검증하고 새 회차를 엽니다. 계획 밖이거나 의견이 갈리면 사용자 판단을 ca-answer 동의 judgment waive-finding 으로 기록합니다.",
    enforcedAt: ["reviewHook.ts(완료 뒤 교체 금지)", "crossCheck.ts(완료 지점 재실행 거부)", "review.ts reviewProblems", "planningState.ts"],
  },
  "limit-exceeded": {
    id: "limit-exceeded", label: "상한 초과", group: "infra", auxiliary: false,
    detect: "사람 허용을 더한 한도를 다 쓴 카운터의 재시도",
    retry: "no-retry", retryText: "없음 — 자동 재시도 금지",
    counters: [], limitText: "카운터별",
    consumesFixRound: false, fixRoundText: "—",
    handoff: "decision", onExhausted: "consent:judgment", exceededText: "사람 판단(judgment retry-grant)·재계획·abort",
    guide: "{counterLabel} 한도 {limit}회를 모두 썼습니다(원인: {originLabel}). 자동으로 다시 시도하지 않습니다 — 막힌 이유와 증거({evidence})를 사용자에게 보고하세요. 사람이 고릅니다: 한 번 더 허용(ca-answer 의 judgment 동의) · 계획을 고쳐 재승인 · 작업 종료(abort).",
    enforcedAt: ["retryPolicy.limitOf·nextRoundDecision·crossPointDecision", "각 강제 지점"],
  },
  "consent-target-changed": {
    id: "consent-target-changed", label: "동의 대상 변경·취소", group: "consent", auxiliary: false,
    detect: "준비·응답·적용 직전의 스냅샷 불일치, 승인이 아닌 응답",
    retry: "no-retry", retryText: "같은 동의를 다시 묻지 않는다 — 새로 준비",
    counters: [], limitText: "—",
    consumesFixRound: false, fixRoundText: "—",
    handoff: "stop", onExhausted: "stop", exceededText: "사람",
    guide: "이 동의는 쓸 수 없습니다: {detail}. 같은 ID로 다시 묻거나 적용하지 않습니다 — 바뀐 대상이나 응답을 사용자에게 알리고, 필요하면 현재 내용으로 새로 준비해 다시 확인받으세요.",
    enforcedAt: ["consent.ts observeConsent·applyLocked·prepareConsent"],
  },
  "consent-apply-failed": {
    id: "consent-apply-failed", label: "동의 적용 중단·실패", group: "consent", auxiliary: false,
    detect: "applying 잔존, 앞선 확인 뒤 확인 화면 불일치, 도메인 함수 실패",
    retry: "no-retry", retryText: "같은 동의로 다시 적용하지 않는다 — 상태 확인 뒤 새로 준비",
    counters: [], limitText: "0",
    consumesFixRound: false, fixRoundText: "—",
    handoff: "stop", onExhausted: "stop", exceededText: "사람",
    guide: "적용이 중단(실패)됐습니다 — 일부만 반영됐을 수 있습니다: {detail}. code-agent status 와 git status 로 상태를 확인한 뒤 새로 준비하세요. 같은 ID로 다시 적용하지 않습니다.",
    enforcedAt: ["consent.ts applyLocked", "deliver.ts", "sourceUpdate.ts"],
  },
  "lock-stale": {
    id: "lock-stale", label: "잠금 고착", group: "infra", auxiliary: false,
    detect: `같은 PC 의 죽은 pid, 주인 기록 없는 ${MIN_LOCK}분 잠금`,
    retry: "auto", retryText: `같은 호출에서 회수. 살아 있으면 대기(${SEC_WAIT}초·hook ${SEC_HOOK_WAIT}초) 뒤 같은 명령 1회`,
    counters: ["lockBusy"],
    limitText: `대기 재실행 ${LIMITS.lockBusy}`,
    consumesFixRound: false, fixRoundText: "—",
    handoff: "none", onExhausted: "stop", exceededText: "다른 PC·판정 불가면 사람",
    guide: "잠금 때문에 멈췄습니다 — {detail}. 같은 명령은 잠시 뒤 한 번만 다시 실행하고, 계속 막히면 실행 중인 code-agent 가 없는지 확인한 뒤 사람이 별도 터미널에서 잠금 파일을 지웁니다.",
    enforcedAt: ["lock.ts acquireLock(판정은 lockDecision)", "planning.ts mutatePlanning", "consent.ts withConsentLock", "review.ts 저장"],
  },
  "hook-failure": {
    id: "hook-failure", label: "hook 판정 실패", group: "infra", auxiliary: true,
    detect: "hook 판정 함수 예외, hook 모듈 로드 실패",
    retry: "no-retry", retryText: "같은 호출을 반복하지 않는다. 종료 코드는 이벤트별(hookFailureExit·subagentExit)",
    counters: ["agentReturn"],
    limitText: `담당 되돌림 ${LIMITS.agentReturn}`,
    consumesFixRound: false, fixRoundText: "—",
    handoff: "stop", onExhausted: "stop", exceededText: "사람(doctor 점검)",
    guide: "code-agent hook 이 판정에 실패했습니다: {detail}. 같은 호출을 반복하지 말고 사유를 사용자에게 알리세요 — 같은 실패가 반복되면 사람이 별도 터미널에서 code-agent doctor 로 점검합니다.",
    enforcedAt: ["hook.ts runHook", "codexHook.ts runCodexHook", "stopHook.ts", "reviewHook.ts·planningHook.ts run 함수", "consent.ts runConsentHook", "cli.ts hook 진입(모듈 로드 실패)"],
  },
};

// ---- 안내 문구 ----

/** 원인마다 기본 문구 말고 고르는 변형 — guidance(cls, values, variant) */
export const GUIDE_VARIANTS: Readonly<Partial<Record<FailureClass, Readonly<Record<string, string>>>>> = {
  "code-defect": {
    /** sameRoundDecision 의 거부 사유 — 같은 코드로 다시 돌리지 않는다 */
    "same-tree": "코드 결함으로 실패한 트리입니다 — 같은 코드로 다시 돌리지 않습니다. 계획 안에서 고친 뒤 code-agent verify, 같은 코드를 다시 확인하려면 code-agent verify --retry(고쳐 쓰기 회차를 씁니다).",
  },
  environment: {
    /** 통합 검증 — 같은 회차는 code-agent integrate 로 다시 돈다(verify --retry 는 check 로 되감아 같은 코드 재실행을 쓴다) */
    integrate: "환경 문제로 통합 검증을 마치지 못했습니다({kind}: {reason}). 계획 파일을 고치지 말고 사용자에게 환경·매니페스트를 확인받은 뒤 code-agent integrate 로 같은 회차를 다시 돌리세요 — 고쳐 쓰기 회차를 쓰지 않습니다(남은 통합 검증 재실행 {rerunLeft}회). 같은 실패가 반복되는데 선언이 없으면 code-agent.json 의 environmentErrors 선언을 사용자에게 제안합니다.",
  },
  interrupted: {
    /** 기록 없이 끊긴 회차·시작 표지만 남은 test·통합 검증 */
    empty: "{round}회차 {phase} 가 끝 기록 없이 끊겼습니다(도구 시간 제한·강제 종료). 셸 명령의 제한 시간을 가장 길게 주거나 백그라운드로 같은 명령을 다시 실행하세요. 코드가 그대로면 같은 회차를 다시 씁니다(남은 같은 코드 재실행 {rerunLeft}회). 끊긴 뒤 코드를 고치면 고쳐 쓰기 회차를 씁니다.",
    /** 통합 검증의 명령 시간 초과 */
    integrate: "{kind} 이(가) 제한 시간 {minutes}분을 넘겨 중단됐습니다. 끝나지 않는 테스트(대기·무한 루프)인지 로그({logFile})로 확인하고, 정상인데 오래 걸리면 사용자가 code-agent.json 의 commandTimeoutMinutes 를 늘립니다. 그 뒤 code-agent integrate — 같은 회차를 다시 돌리고 고쳐 쓰기 회차를 쓰지 않습니다(남은 통합 검증 재실행 {rerunLeft}회).",
  },
  "result-unconfirmed": {
    /** 통합 검증 — 같은 코드 재실행은 code-agent integrate, 고치면 verify 로 check 부터 */
    integrate: "명령은 끝났지만 통합 검증에서 ⑦ 의 TC 결과가 확인되지 않았습니다: {cases}. 코드·테스트를 그대로 두고 보고서 위치·환경만 고쳤으면 code-agent integrate 로 같은 회차를 다시 돌리세요(남은 통합 검증 재실행 {rerunLeft}회). 계획 파일을 고쳐야 하면 고친 뒤 code-agent verify 로 check 부터 다시 검증합니다(얼어 있는 kind:test 파일은 ⑨ 지적이나 재승인이 있어야 고칠 수 있습니다).",
  },
  precondition: {
    /** 실행은 모두 통과했고 다시 돌리면 맞춰지는 대조만 남았다(diagnose). ⑧ 만 어긋났으면 plain verify 는 판정부터 들어가 다시 렌더하지 않는다 */
    rerun: "실행은 모두 통과했지만 증거가 지금과 맞지 않습니다: {problems}. 코드 결함이 아닙니다 — 검증 명령이 계획 파일을 고쳤거나(포맷터 등) ⑧ 이 손으로 바뀌었거나 회차·묶임이 어긋난 경우라 code-agent verify --retry 로 check 부터 다시 돌리면 맞춰집니다. 다시 돈 회차는 통과 뒤 변경으로 세며 고쳐 쓰기 회차를 쓰지 않습니다({budget}). 돌 때마다 같은 문제가 되풀이되면(검증 명령이 매번 계획 파일을 바꿈) 고치지 말고 사용자에게 보고하세요.",
  },
  "agent-format-error": {
    /** 기록된 형식 오류(needs-correction·failed) — planning advance 의 blocked 줄 등. 기본 문구는 기록 전 되돌림이다 */
    record: "결과 형식 오류로 기록했습니다 — {detail}. planning advance 또는 planning repair {id} 로 원본 결과의 형식만 한 번 교정하세요.",
  },
  "agent-content-error": {
    /** 기록된 내용 오류(failed). 기본 문구는 기록 전 되돌림이다 */
    record: "결과가 검사에 걸려 실패로 기록했습니다 — {detail}. 사유를 수정 피드백 파일로 남겨 {id} 의 inputs 에 넣고 planning prepare 뒤 planning advance 로 다시 배정하세요.",
  },
  "cross-timeout": {
    /** 끝 기록 없이 끊긴 실행(kind interrupted) — 중지가 되지 않고 지점 시도 한도에만 든다 */
    interrupted: "{host} 교차 실행이 끝 기록 없이 끊겼습니다 — 끊긴 실행은 중지로 기록하지 않고 게이트는 막혀 있습니다. 같은 명령을 백그라운드로 다시 실행할 수 있습니다(남은 지점 시도 {left}회).",
  },
  "cross-unavailable": {
    /** 지점 한도가 남아 같은 지점을 다시 실행할 수 있을 때 */
    rerunnable: "{host} 교차 검증 중지 — 다른 호스트를 실행할 수 없습니다: {detail}. 이 지점은 교차 검증 없이 진행합니다. 두 호스트를 모두 쓸 수 있게 되면(설치·로그인·사용 한도) 다음 지점부터 다시 돕니다. 사용자가 원하면 고친 뒤 같은 명령으로 이 지점을 다시 실행할 수 있습니다(남은 {left}회).",
  },
  "limit-exceeded": {
    /** 교차 지점 시도 한도(사람 판단 필요) */
    "cross-point": "이 지점의 교차 실행 한도 {limit}회를 모두 썼습니다({counts}) — 자동으로 다시 실행하지 않습니다. 사용자에게 보고하고 사람 판단(ca-answer 동의 judgment cross-stop 또는 retry-grant crossPoint)을 받으세요.",
    /** 교차 지점 시도 한도 — 사람이 아닌 중지로 이미 게이트를 통과한 지점 */
    "cross-point-stopped": "이 지점의 교차 실행 한도 {limit}회를 모두 썼습니다({counts}) — 자동으로 다시 실행하지 않습니다. 이 지점은 중지 기록대로 교차 검증 없이 진행합니다(게이트는 막히지 않습니다).",
    /** 교차 원인별 재실행 한도(crossError·crossFormat) */
    "cross-cause": "{counterLabel} 한도 {limit}회를 썼습니다 — 사용자에게 보고하고 사람 판단(ca-answer 동의 judgment cross-stop 또는 retry-grant {key})을 받으세요.",
  },
};

/** 기본 문구(POLICIES[cls].guide)의 자리표시 — 원인을 렌더하는 호출은 이 키를 모두 넘긴다(테스트가 문구와 대조한다) */
export const GUIDE_KEYS: Readonly<Record<FailureClass, readonly string[]>> = {
  "code-defect": ["budget", "failed"],
  environment: ["kind", "reason", "rerunLeft"],
  interrupted: ["kind", "logFile", "minutes", "rerunLeft"],
  "result-unconfirmed": ["cases", "collectNote", "rerunLeft"],
  precondition: ["problems"],
  "agent-format-error": ["detail"],
  "agent-content-error": ["detail"],
  "dispatch-orphan": ["detail", "id"],
  "same-input-repeat": ["limit"],
  "reassign-total": ["id", "limit"],
  "cross-unavailable": ["detail", "host"],
  "cross-config-error": ["detail", "host", "left"],
  "cross-timeout": ["host", "min"],
  "cross-result-invalid": ["detail", "host", "left", "point", "raw"],
  "host-sandbox-denied": ["detail", "host"],
  "blocking-finding": ["ids"],
  "limit-exceeded": ["counterLabel", "evidence", "limit", "originLabel"],
  "consent-target-changed": ["detail"],
  "consent-apply-failed": ["detail"],
  "lock-stale": ["detail"],
  "hook-failure": ["detail"],
};
/** 변형 문구의 자리표시 */
export const GUIDE_VARIANT_KEYS: Readonly<Partial<Record<FailureClass, Readonly<Record<string, readonly string[]>>>>> = {
  "code-defect": { "same-tree": [] },
  environment: { integrate: ["kind", "reason", "rerunLeft"] },
  interrupted: { empty: ["phase", "rerunLeft", "round"], integrate: ["kind", "logFile", "minutes", "rerunLeft"] },
  "result-unconfirmed": { integrate: ["cases", "rerunLeft"] },
  precondition: { rerun: ["budget", "problems"] },
  "agent-format-error": { record: ["detail", "id"] },
  "agent-content-error": { record: ["detail", "id"] },
  "cross-timeout": { interrupted: ["host", "left"] },
  "cross-unavailable": { rerunnable: ["detail", "host", "left"] },
  "limit-exceeded": { "cross-point": ["counts", "limit"], "cross-point-stopped": ["counts", "limit"], "cross-cause": ["counterLabel", "key", "limit"] },
};

/** 문구 조각 — 결과 미확인 문구의 {collectNote} 와 꼬리 */
export const VERIFY_NOTES = {
  collectOpen: "이번 수정은 수집 수정 회차라 고쳐 쓰기 회차를 쓰지 않고, 그동안 kind:test 파일의 TC 이름을 고칠 수 있습니다(단언·기대값은 고치지 않습니다).",
  collectUsed: "이번 수정은 고쳐 쓰기 회차를 씁니다.",
  reportTruncated: "보고서 탐색이 2만 항목·깊이 12에서 끊겨 JUnit 보고서를 찾지 못했을 수 있습니다.",
} as const;
/** 환경 문구의 {reason} — 선언 문구는 `출력에 선언된 문구 "X"` 로 쓴다 */
export const ENVIRONMENT_REASON = { "missing-tool": "실행 파일 없음", spawn: "실행 실패", prepare: "준비 명령 실패" } as const;

/** 문구의 자리표시 이름(중복 없이 정렬) */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Za-z]\w*)\}/g)].map((match) => match[1]))].sort();
}
/**
 * 원인별 안내 문구. 값이 없는 자리표시는 그대로 남긴다 — 호출은 GUIDE_KEYS(변형은 GUIDE_VARIANT_KEYS)를 모두 넘긴다.
 * 문구는 호스트 중립이다(스킬 이름·도구 이름을 쓰지 않는다).
 */
export function guidance(cls: FailureClass, values: Readonly<Record<string, string | number>> = {}, variant?: string): string {
  const text = variant === undefined ? POLICIES[cls].guide : GUIDE_VARIANTS[cls]?.[variant];
  if (text === undefined) throw new Error(`${cls} 에 ${variant} 안내 문구가 없습니다`);
  return text.replace(/\{([A-Za-z]\w*)\}/g, (whole, key: string) => Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole);
}
/**
 * 기록된 실패를 안내할 때 고르는 변형 — 기록(시도의 failure·지점 안내의 crossPointHint·blocked[].class)을 렌더하는 호출은
 * `guidance(record.class, values, recordedVariant(record))` 로 쓴다. 담당 형식·내용 오류의 기본 문구는 기록 전 같은 담당에게
 * 돌려보내는 문구라 기록된 시도에는 record 변형을, 끊긴 교차 실행(cross-timeout·interrupted)에는 제한 시간 문구 대신
 * interrupted 변형을 쓴다. 그 밖은 기본 문구(undefined)다.
 */
export function recordedVariant(record: { class: string; kind?: string }): string | undefined {
  if (record.class === "agent-format-error" || record.class === "agent-content-error") return "record";
  if (record.class === "cross-timeout" && record.kind === "interrupted") return "interrupted";
  return undefined;
}
/** 한도 거부의 안내 — failure 의 counter·origin 으로 limit-exceeded 기본 문구를 채운다 */
export function limitExceededText(record: FailureRecord, evidence: string): string {
  const counter = record.counter;
  return guidance("limit-exceeded", {
    counterLabel: counter ? COUNTER_LABEL[counter.key] : "재시도",
    limit: counter?.limit ?? 0,
    originLabel: record.origin ? POLICIES[record.origin].label : POLICIES[record.class].label,
    evidence,
  });
}

// ---- 검증 (check·test·integrate·repro) ----

export type RunCause = "timeout" | "spawn" | "missing-tool" | "environment";
export interface RunView {
  round: number; phase: string; kind: string; command?: string;
  outcome: "passed" | "failed" | "not-run" | "error";
  environment?: string; cause?: RunCause; tail?: string;
}
/** 실행이 끝난 원인. 필드가 없는 옛 기록은 tail 문구(validate.ts 가 쓰던 문구)로 추정한다 */
export function runCauseOf(run: RunView): RunCause | undefined {
  if (run.cause) return run.cause;
  if (run.environment !== undefined) return "environment";
  if (run.outcome !== "error") return undefined;
  const tail = run.tail ?? "";
  if (/실행 실패: 제한 시간 /.test(tail)) return "timeout";
  if (/실행 실패: 실행 파일을 찾을 수 없습니다/.test(tail)) return "missing-tool";
  if (/실행 실패: /.test(tail)) return "spawn";
  return undefined;
}
export type RunClass = "passed" | "defect" | "environment" | "timeout" | "precondition";
export function runClass(run: RunView): RunClass {
  if (run.outcome === "passed") return "passed";
  // 선언이 없어 돌리지 않은 명령만 전제 미충족이다. 플러그인의 not-run 은 돌지 못한 것이다
  if (run.outcome === "not-run") return run.kind.startsWith("plugin:") ? "environment" : "precondition";
  const cause = runCauseOf(run);
  if (cause === "timeout") return "timeout";
  if (cause) return "environment";
  return run.outcome === "error" ? "environment" : "defect";
}

export type VerifyState = "passed" | "code-defect" | "environment" | "interrupted" | "result-unconfirmed" | "precondition";
const STATE_RANK: Readonly<Record<VerifyState, number>> = {
  "code-defect": 5, precondition: 4, interrupted: 3, environment: 2, "result-unconfirmed": 1, passed: 0,
};
/** 한 단계·한 회차의 상태. 앞 규칙이 우선한다: 기록 없음 → 결함 → 전제 → 시간 초과 → 환경 → 결과 미확인 → 통과 */
export function verifyState(input: { phase: string; round: number; runs: readonly RunView[]; cases?: readonly { status?: string }[] }): VerifyState {
  const current = input.runs.filter((run) => run.round === input.round && run.phase === input.phase);
  if (current.length === 0) return "interrupted";
  const classes = current.map(runClass);
  if (classes.includes("defect") || input.cases?.some((entry) => entry.status === "failed")) return "code-defect";
  if (classes.includes("precondition")) return "precondition";
  if (classes.includes("timeout")) return "interrupted";
  if (classes.includes("environment")) return "environment";
  if (input.cases?.some((entry) => entry.status !== "passed")) return "result-unconfirmed";
  return "passed";
}

export type RoundCause = "first" | "fix" | "collect" | "review";
export interface ReproRetry {
  trees: string[]; reruns: Record<string, number>;
  /** 테스트 트리 → 그 트리의 마지막 시도가 끝난 원인. 뒤 트리의 시도 기록(reproAttempt)이 덮어도 트리별 원인이 남는다 */
  classes?: Record<string, Exclude<VerifyState, "passed" | "code-defect">>;
}
/** 같은 회차 재사용(check)이 지운 test·통합 검증의 상태 — 다시 돌기 전까지 회차 상태 판정에 남긴다 */
export interface WipedRuns { test?: { round: number; state: VerifyState }; integrate?: { round: number; state: VerifyState } }
export interface VerifyRetryState {
  version: 1;
  /** 회차 번호(문자열) → 그 회차를 연 원인 */
  causes: Record<string, RoundCause>;
  /** 회차 → 같은 코드 재실행 수(check 재사용 + test 재실행) */
  reruns: Record<string, number>;
  /** 회차 → 통합 검증 재실행 수 */
  integrateReruns: Record<string, number>;
  /** test·통합 검증의 시작 표지 — 실행 전 저장에 넣고 끝 저장에서 지운다. 남아 있으면 그 실행은 끊겼다 */
  started?: { phase: "test" | "integrate"; round: number; pid: number; host: string; at: string };
  /** check 의 같은 회차 재사용이 지운 test·통합 검증 상태 — test 는 다음 test 가, 통합 검증은 다음 통합 검증이 끝 저장에서 지운다 */
  wiped?: WipedRuns;
  repro?: ReproRetry;
  grants: RetryGrant[];
  /** 옛 증거를 처음 이행할 때의 rounds(총 회차 유예) */
  legacyRounds?: number;
}
/** verifyRetryOf 의 결과 — 재현 카운터까지 채워져 있다 */
export type VerifyRetryView = VerifyRetryState & { repro: ReproRetry };

/**
 * 회차 전체 상태(evidence.ts roundState 가 증거로 부른다). 회차 r 의 실행·표지가 하나도 없으면 기록 없이 끊긴 회차다.
 * test 기록이 없는 회차는 앞 회차의 마지막 test 상태를 이어받는다 — 실패한 test 뒤 test 를 건너뛰고 고쳐도 고쳐 쓰기를 쓴다.
 * 같은 회차 재사용이 지운 test(wiped.test)는 그 뒤 test 가 돌기 전까지 마지막 test 상태다. 지운 통합 검증(wiped.integrate)은
 * 그 회차에만 든다 — test 를 끊거나 환경으로 실패시킨 뒤 check 로 지우고 고쳐 카운터를 피하는 길을 닫는다.
 */
export function roundStateOf(input: {
  rounds: number; runs: readonly RunView[]; started?: VerifyRetryState["started"]; wiped?: WipedRuns;
  testCases?: readonly { status?: string }[]; integrationTestCases?: readonly { status?: string }[];
}): { state: VerifyState | "none"; emptyRound: boolean } {
  const r = input.rounds;
  if (r === 0) return { state: "none", emptyRound: false };
  const started = input.started?.round === r ? input.started : undefined;
  const inRound = input.runs.filter((run) => run.round === r && ["check", "test", "integrate"].includes(run.phase));
  if (inRound.length === 0 && !started) return { state: "interrupted", emptyRound: true };
  const states: VerifyState[] = [verifyState({ phase: "check", round: r, runs: input.runs })];
  const has = (phase: string, round: number) => input.runs.some((run) => run.phase === phase && run.round === round);
  if (started?.phase === "test") states.push("interrupted");
  else if (has("test", r)) states.push(verifyState({ phase: "test", round: r, runs: input.runs, cases: input.testCases }));
  else if (input.wiped?.test && input.wiped.test.round <= r) states.push(input.wiped.test.state);
  else {
    const previous = input.runs.filter((run) => run.phase === "test" && run.round < r).map((run) => run.round);
    if (previous.length) states.push(verifyState({ phase: "test", round: Math.max(...previous), runs: input.runs }));
  }
  if (started?.phase === "integrate") states.push("interrupted");
  else if (has("integrate", r)) states.push(verifyState({ phase: "integrate", round: r, runs: input.runs, cases: input.integrationTestCases ?? [] }));
  else if (input.wiped?.integrate?.round === r) states.push(input.wiped.integrate.state);
  return { state: states.reduce((worst, state) => STATE_RANK[state] > STATE_RANK[worst] ? state : worst, "passed"), emptyRound: false };
}

/**
 * 원인 기록이 없는 옛 증거의 회차 원인 추정 — 직전 회차가 모두 통과면 review, 그 밖(기록 없음 포함)은 fix.
 * 옛 규칙은 실패한 채 한도를 넘는 회차를 거부했으므로 추정한 fix 수는 rounds−1 과 fixRounds 를 넘지 않는다 — 추정 카운터는
 * 옛 규칙보다 엄격해지지 않는다. 엄격해지는 것은 판정 규칙 하나다: 마지막 회차가 실행 기록 없이 끊긴 뒤 코드를 고치면
 * 새 규칙은 고쳐 쓰기를 쓴다(옛 규칙은 마지막으로 기록된 실행을 봤다). 진행 중 작업이 여기서 막히면 judgment retry-grant 로 넘긴다.
 */
export function deriveLegacyCauses(rounds: number, runs: readonly RunView[]): Record<string, RoundCause> {
  const causes: Record<string, RoundCause> = {};
  if (rounds >= 1) causes["1"] = "first";
  for (let r = 2; r <= rounds; r++) {
    const previous = runs.filter((run) => run.round === r - 1 && ["check", "test", "integrate"].includes(run.phase));
    causes[String(r)] = previous.length > 0 && previous.every((run) => runClass(run) === "passed") ? "review" : "fix";
  }
  return causes;
}
/** 증거의 재시도 카운터 — 없으면 옛 기록에서 추정한다(읽을 때 추정하고, 쓸 때 기록한다) */
export function verifyRetryOf(evidence: { rounds: number; runs: readonly RunView[]; retry?: Partial<VerifyRetryState>; reproAttempt?: { testTreeHash: string } }): VerifyRetryView {
  const retry = evidence.retry;
  if (retry) {
    return {
      ...retry,
      version: 1,
      causes: { ...(retry.causes ?? {}) }, reruns: { ...(retry.reruns ?? {}) }, integrateReruns: { ...(retry.integrateReruns ?? {}) },
      repro: { trees: [...(retry.repro?.trees ?? [])], reruns: { ...(retry.repro?.reruns ?? {}) },
        ...(retry.repro?.classes ? { classes: { ...retry.repro.classes } } : {}) },
      grants: [...(retry.grants ?? [])],
    };
  }
  return {
    version: 1, causes: deriveLegacyCauses(evidence.rounds, evidence.runs), reruns: {}, integrateReruns: {},
    repro: { trees: evidence.reproAttempt ? [evidence.reproAttempt.testTreeHash] : [], reruns: {} }, grants: [],
    ...(evidence.rounds > 0 ? { legacyRounds: evidence.rounds } : {}),
  };
}

export interface VerifyBudget { fix: Budget; collect: Budget; rerun: Budget; integrateRerun: Budget; reviewRounds: Budget; totalRounds: Budget }
/** 검증 카운터 예산. collectLimit 은 재현으로 테스트가 언 fix 작업이면 0 이다(기본 LIMITS.collect) */
export function verifyBudget(input: { retry: VerifyRetryState; round: number; fixRounds: number; collectLimit?: number;
  reviewRounds: { used: number; limit: number } }): VerifyBudget {
  const { retry, round } = input;
  const causes = Object.values(retry.causes ?? {});
  const count = (cause: RoundCause) => causes.filter((value) => value === cause).length;
  const make = (key: CounterKey, used: number, limit: number): Budget => ({ key, used, limit, left: Math.max(0, limit - used), exhausted: used >= limit });
  const fix = budgetOf("fix", count("fix"), input.fixRounds, retry.grants, grantScope({ file: "verify", key: "fix" }));
  const collect = make("collect", count("collect"), input.collectLimit ?? LIMITS.collect);
  const rerun = budgetOf("rerun", retry.reruns?.[String(round)] ?? 0, LIMITS.rerun, retry.grants, grantScope({ file: "verify", key: "rerun", round }));
  const integrateRerun = budgetOf("integrateRerun", retry.integrateReruns?.[String(round)] ?? 0, LIMITS.integrateRerun, retry.grants,
    grantScope({ file: "verify", key: "integrateRerun", round }));
  const reviewRounds = make("reviewRounds", input.reviewRounds.used, input.reviewRounds.limit);
  const totalRounds = make("totalRounds", round, Math.max(1 + fix.limit + reviewRounds.limit + collect.limit, (retry.legacyRounds ?? 0) + 1));
  return { fix, collect, rerun, integrateRerun, reviewRounds, totalRounds };
}

function limitFailure(budget: Budget, origin: FailureClass): FailureRecord {
  return failure("limit-exceeded", `${COUNTER_LABEL[budget.key]} 한도 ${budget.limit}회 소진`, { origin, counter: { key: budget.key, used: budget.used, limit: budget.limit } });
}

export type RoundDecision =
  | { action: "reuse"; counter: "rerun" | null }
  | { action: "new"; cause: RoundCause }
  | { action: "refuse"; failure: FailureRecord };
/**
 * check() 가 회차를 다시 쓸지·새로 열지·거부할지. retry 는 판정에 쓰지 않는다 — 같은 코드 재실행은 --retry 든
 * code-agent check 직접 호출이든 같은 카운터를 쓴다. reviewOpenFindings 는 한도 거부의 원래 원인만 고른다.
 */
export function nextRoundDecision(input: { previous: VerifyState | "none"; emptyRound: boolean; treeChanged: boolean;
  budget: VerifyBudget; retry?: boolean; reviewOpenFindings: boolean }): RoundDecision {
  const { previous, budget } = input;
  const rerun = (origin: FailureClass): RoundDecision =>
    budget.rerun.exhausted ? { action: "refuse", failure: limitFailure(budget.rerun, origin) } : { action: "reuse", counter: "rerun" };
  const open = (cause: RoundCause, origin: FailureClass, guard: Budget | undefined): RoundDecision => {
    if (guard?.exhausted) return { action: "refuse", failure: limitFailure(guard, origin) };
    if (budget.totalRounds.exhausted) return { action: "refuse", failure: limitFailure(budget.totalRounds, origin) };
    return { action: "new", cause };
  };
  if (previous === "none") return { action: "new", cause: "first" };
  if (input.emptyRound) return input.treeChanged ? open("fix", "interrupted", budget.fix) : rerun("interrupted");
  switch (previous) {
    case "passed":
      return input.treeChanged ? open("review", input.reviewOpenFindings ? "blocking-finding" : "code-defect", budget.reviewRounds) : { action: "reuse", counter: null };
    case "code-defect":
      return open("fix", "code-defect", budget.fix);
    case "environment": case "interrupted":
      return input.treeChanged ? open("fix", previous, budget.fix) : rerun(previous);
    case "result-unconfirmed":
      if (!input.treeChanged) return rerun("result-unconfirmed");
      return budget.collect.left > 0 ? open("collect", "result-unconfirmed", undefined) : open("fix", "result-unconfirmed", budget.fix);
    case "precondition":
      return input.treeChanged ? open("fix", "precondition", budget.fix)
        : { action: "refuse", failure: failure("precondition", "선언되지 않은 명령은 다시 돌려도 같습니다") };
  }
}
/** test·integrate — 회차를 열지 않고 같은 회차를 다시 돈다 */
export function sameRoundDecision(input: { previous: VerifyState; budget: VerifyBudget; key: "rerun" | "integrateRerun" }):
  | { action: "run"; counter: "rerun" | "integrateRerun" | null } | { action: "refuse"; failure: FailureRecord } {
  switch (input.previous) {
    case "passed": return { action: "run", counter: null };
    case "code-defect": return { action: "refuse", failure: failure("code-defect", guidance("code-defect", {}, "same-tree")) };
    case "precondition": return { action: "refuse", failure: failure("precondition", "선언되지 않은 명령은 다시 돌려도 같습니다") };
    default: {
      const budget = input.budget[input.key];
      return budget.exhausted ? { action: "refuse", failure: limitFailure(budget, input.previous) } : { action: "run", counter: input.key };
    }
  }
}
/**
 * verify 노드. precondition 은 assess 가 Stop 을 던지므로 노드로 오지 않는다(오면 diagnose).
 * 같은 코드 재실행(rerun)은 회차를 열지 않으므로 총 회차와 무관하다 — nextRoundDecision(treeChanged=false)이 재실행을
 * 받아 주는 동안은 decision 이 아니다(환경·중단과 결과 미확인이 같은 규칙이다).
 */
export function verifyNode(state: VerifyState, budget: VerifyBudget): "passed" | "repair" | "diagnose" | "decision" {
  switch (state) {
    case "passed": return "passed";
    case "code-defect": return budget.fix.left > 0 && budget.totalRounds.left > 0 ? "repair" : "decision";
    case "environment": case "interrupted": return budget.rerun.left > 0 ? "diagnose" : "decision";
    case "result-unconfirmed":
      return budget.rerun.left > 0 || ((budget.collect.left > 0 || budget.fix.left > 0) && budget.totalRounds.left > 0) ? "diagnose" : "decision";
    case "precondition": return "diagnose";
  }
}
/**
 * decision 일 때 소진된 카운터 — VerifyBudget 의 키라 `budget[counter]` 로 바로 읽는다. 코드를 고치는 길은
 * nextRoundDecision(treeChanged=true)과 같은 카운터가 막는다(결과 미확인은 수집 수정이 남았으면 총 회차).
 */
export function nodeCounter(state: VerifyState, budget: VerifyBudget): "fix" | "rerun" | "totalRounds" | undefined {
  if (verifyNode(state, budget) !== "decision") return undefined;
  if (state === "environment" || state === "interrupted") return "rerun";
  if (state === "result-unconfirmed" && budget.collect.left > 0) return "totalRounds";
  return budget.fix.exhausted ? "fix" : "totalRounds";
}
/**
 * hook 의 계획 파일 쓰기 차단(한도 부분) — 고쳐도 다음 회차가 거부될 때만 막는다. nextRoundDecision(treeChanged)과
 * 같은 판정이라 hook 과 check() 가 갈라지지 않는다.
 */
export function writeBlockReason(input: { state: VerifyState | "none"; emptyRound: boolean; budget: VerifyBudget; path: string; questionsPath: string }): string | undefined {
  const decision = nextRoundDecision({ previous: input.state, emptyRound: input.emptyRound, treeChanged: true, budget: input.budget,
    retry: false, reviewOpenFindings: input.budget.reviewRounds.used > 0 });
  if (decision.action !== "refuse" || !decision.failure.counter) return undefined;
  const { key, limit } = decision.failure.counter;
  const { path, questionsPath } = input;
  if (key === "fix") return `고쳐 쓰기 ${limit}회를 넘겨 계획 파일을 더 고칠 수 없습니다: ${path}. ${questionsPath} 에 무엇이 막혔는지 적고 사람에게 보고하세요 — 덮지 않고 보고하는 자리입니다. 사람이 한 회차를 더 허용하거나(ca-answer 의 judgment 동의) 계획을 고쳐 재승인해야 합니다.`;
  if (key === "reviewRounds") return `리뷰 회차 한도 ${limit}회를 모두 써서 계획 파일을 더 고칠 수 없습니다: ${path}. 남은 지적은 사람이 판단합니다 — ${questionsPath} 에 적고 보고하세요. 회차 추가·지적 기각은 ca-answer 의 judgment 동의, 범위 변경은 재계획·재승인입니다.`;
  if (key === "totalRounds") return `검증 회차가 총 ${limit}회에 닿아 계획 파일을 더 고칠 수 없습니다: ${path}. ${questionsPath} 에 적고 사람에게 보고하세요 — 사람이 한 회차를 더 허용하거나 계획을 고쳐 재승인해야 합니다.`;
  return undefined;
}
/** 남은 수 한 줄 — remainingNote·nextHint·context·renderVerification 공용 */
export function budgetText(budget: VerifyBudget): string {
  return `남은 고쳐 쓰기 ${budget.fix.left}회 · 수집 수정 ${budget.collect.left}회 · 같은 코드 재실행 ${budget.rerun.left}회 · ` +
    `리뷰 회차 ${budget.reviewRounds.left}회 (총 ${budget.totalRounds.used}/${budget.totalRounds.limit}회차)`;
}
/** 실패한 실행의 출력에서 선언된 환경 문구를 찾는다. 같은 실행에 실패한 테스트 결과가 하나라도 있으면 환경이 아니다 */
export function environmentMatch(log: string, patterns: readonly string[] | undefined, results: readonly { status: string }[]): string | undefined {
  if (!patterns?.length || results.some((result) => result.status === "failed")) return undefined;
  return patterns.find((pattern) => log.includes(pattern));
}

// ---- 계획 배정 ----

export interface AttemptView { dispatchId: string; inputHash: string; at: string; status: string; correction?: { used: boolean } }
export interface AgentView { id: string; session: string; type: string; startedAt: string; finished?: boolean; dispatchId?: string; returns?: number; endedAt?: string }

/**
 * 배정·교정을 허용할지 — 같은 입력의 failed 만 sameInput 으로, retry.since 이후의 모든 시도를 taskTotal 로 센다.
 * 교정(repair)은 같은 시도라 taskTotal 을 쓰지 않는다. 계획 쪽 한도는 limit-exceeded 로 감싸지 않는다.
 */
export function planningDispatchDecision(input: { attempts: readonly AttemptView[]; inputHash: string; since?: string;
  grants?: readonly RetryGrant[]; taskId: string; repair?: boolean }): { allow: true } | { allow: false; failure: FailureRecord } {
  const sameScope = grantScope({ file: "planning", key: "sameInput", taskId: input.taskId, inputHash: input.inputHash });
  const same = input.attempts.filter((attempt) => attempt.inputHash === input.inputHash && attempt.status === "failed").length;
  const sameLimit = limitOf("sameInput", LIMITS.sameInput, input.grants, sameScope);
  if (same >= sameLimit) {
    return { allow: false, failure: failure("same-input-repeat", guidance("same-input-repeat", { id: input.taskId, limit: sameLimit }),
      { counter: { key: "sameInput", used: same, limit: sameLimit } }) };
  }
  if (input.repair) return { allow: true };
  const since = input.since === undefined ? Infinity : Date.parse(input.since);
  const total = input.attempts.filter((attempt) => Date.parse(attempt.at) >= since).length;
  const totalLimit = limitOf("taskTotal", LIMITS.taskTotal, input.grants, grantScope({ file: "planning", key: "taskTotal", taskId: input.taskId }));
  if (total >= totalLimit) {
    return { allow: false, failure: failure("reassign-total", guidance("reassign-total", { id: input.taskId, limit: totalLimit }),
      { counter: { key: "taskTotal", used: total, limit: totalLimit } }) };
  }
  return { allow: true };
}

/**
 * running 시도의 세 갈래. orphaned: 연결된 담당이 모두 끝났는데 결과가 없다(확실). suspect: 시작 관찰 60분이 지났거나
 * 시작이 관찰되지 않은 채 10분이 지났다(배정 시각과 그 뒤 마지막 담당 활동 중 늦은 시각부터 잰다).
 * agentType 이 없으면 미연결 담당의 종류를 가리지 않는다 — 고아로 덜 판정하는 쪽이다.
 */
export function orphanState(input: { attempt: AttemptView; agentType?: string; agents: readonly AgentView[]; now: number }): "running" | "orphaned" | "suspect" {
  const dispatched = Date.parse(input.attempt.at);
  const linked = input.agents.filter((agent) => agent.dispatchId === input.attempt.dispatchId);
  const open = linked.filter((agent) => !agent.finished);
  if (open.length) return input.now - Math.max(...open.map((agent) => Date.parse(agent.startedAt))) > TIMING.orphanRunMs ? "suspect" : "running";
  if (linked.length) return "orphaned";
  const ambiguous = input.agents.filter((agent) => !agent.dispatchId && (input.agentType === undefined || agent.type === input.agentType)
    && Date.parse(agent.startedAt) >= dispatched && !agent.finished);
  if (ambiguous.length) return input.now - Math.min(...ambiguous.map((agent) => Date.parse(agent.startedAt))) > TIMING.orphanRunMs ? "suspect" : "running";
  const activity = input.agents.flatMap((agent) => [agent.startedAt, agent.endedAt]).filter((at): at is string => !!at)
    .map(Date.parse).filter((at) => at >= dispatched);
  return input.now - Math.max(dispatched, ...activity) > TIMING.orphanStartGraceMs ? "suspect" : "running";
}

/**
 * 계획·리뷰 담당 hook 의 종료 코드. Codex 는 exit 2 로 턴을 잇지 않으므로 언제나 기록 후 0 이다.
 * Claude SubagentStop 은 기록된 실패나 이미 한 번 막힌 재시도(stop_hook_active)면 0, 그 밖은 같은 담당에게 한 번 돌려보낸다(2).
 */
export function subagentExit(input: { host: "claude" | "codex"; event?: string; stopHookActive?: boolean; failure?: FailureClass; recorded: boolean }): 0 | 2 {
  if (input.host === "codex") return 0;
  if (input.event !== "SubagentStop") return input.recorded ? 0 : 2;
  if (input.recorded || input.stopHookActive) return 0;
  return 2;
}

// ---- 교차 실행 ----

export type CrossClass = "completed" | "cross-unavailable" | "cross-config-error" | "cross-timeout" | "cross-result-invalid" | "host-sandbox-denied" | "cross-stop";
export type CrossKind = "missing" | "auth" | "quota" | "network" | "outage" | "config" | "unclassified" | "timeout" | "sandbox" | "sandbox-network";

/** 숫자 상태 코드는 문맥이 있을 때만 맞춘다 — 사용량 숫자·코드 전사(`res.status === 429`)가 화이트리스트에 걸리지 않게 */
const statusCode = (codes: string): RegExp[] => [
  new RegExp(String.raw`\b(?:status(?:\s*code)?|http(?:\/\d(?:\.\d)?)?|api error|error code)\s*[:=]?\s*(?:${codes})\b`, "i"),
  new RegExp(String.raw`\b(?:${codes})\s+(?:unauthori[sz]ed|too many requests|internal server error|bad gateway|service unavailable|overloaded)`, "i"),
];
/**
 * 교차 실패 문구. 오류 채널(crossFailureText)에만 댄다. 검사 순서는 sandbox → config → auth → quota → network → outage —
 * config 가 화이트리스트보다 먼저인 것은 모델 오류 문장의 access·account·available 이 인증·한도로 새지 않게 하려는 것이다.
 */
export const CROSS_PATTERNS: Readonly<Record<"sandbox" | "config" | "auth" | "quota" | "network" | "outage", readonly RegExp[]>> = {
  sandbox: [/operation not permitted/i, /\bEPERM\b/, /\bEACCES\b/, /sandbox(?:ed)?\b.{0,40}\b(?:denied|blocked|restrict\w*|not allowed)/i, /network (?:access )?is disabled/i],
  config: [/unknown (?:option|argument|flag|subcommand|variant)/i, /unexpected argument/i, /unrecognized (?:option|argument)/i, /invalid value .{0,80} for/i,
    /\bmodel\b.{0,80}\b(?:not found|does not exist|not supported|unsupported|is not available|may not exist)/i, /selected model/i, /invalid[_ ]model/i,
    /no such (?:agent|model)/i, /\bagent\b.{0,40}\bnot found/i, /unknown agent/i, /error (?:loading|parsing) config/i, /invalid config/i,
    /\binvalid (?:effort|reasoning)\b/i,
    // 모델·강도 오류(claude 2.1.292·codex 0.160.1 문자열). Codex 배너 `reasoning effort: high` 에 걸리는 맨 reasoning effort 는 넣지 않는다
    /issue with the selected model/i, /may not exist or you may not have access to it/i, /is not available on your .{0,40}deployment/i,
    /model '[^']*' not found/i, /(?:isn't|is not(?: currently)?) available for your account/i, /not_found_error/i, /unknown model/i,
    /not supported (?:on|for) this model|model_unsupported/i, /unknown --effort value/i, /effort '[^']*' is not supported/i,
    /unknown variant `[^`]*`, expected/i, /does not exist or you do not have access/i, /model_not_found/i, /not supported when using codex/i],
  auth: [/not logged in/i, /please (?:run )?\/?login/i, /\blog ?in\b.{0,40}\b(?:required|expired)/i, /invalid (?:api|x-api) key/i, /authentication[_ ]error/i,
    /\bunauthori[sz]ed\b(?!\s*\()/i, ...statusCode("401"), /oauth token (?:has )?expired/i],
  quota: [/usage limit/i, /spend cap/i, /rate[_ ]limit/i, ...statusCode("429"), /too many requests/i,
    /\bquota\b.{0,30}\b(?:exceeded|reached|exhausted)\b|\b(?:exceeded|insufficient)\b.{0,30}\bquota\b/i, /credit balance/i, /limit reached/i],
  network: [/\bENOTFOUND\b/, /\bECONNREFUSED\b/, /\bECONNRESET\b/, /\bEAI_AGAIN\b/, /\bENETUNREACH\b/, /\bEHOSTUNREACH\b/, /\bConnectionRefused\b/, /getaddrinfo/i, /fetch failed/i,
    /socket hang up/i, /network (?:error|is unreachable)/i, /could not resolve host/i,
    // claude 2.1.292 문자열 — "Unable to connect to API (…)"·"Unable to connect to API. Check your internet connection", SDK 의 "Connection error." 에 붙는 "API Error" 머리
    /unable to connect to api\b/i, /\bapi error:\s*connection error\b/i],
  outage: [/overloaded/i, /service unavailable/i, /internal server error/i, /bad gateway/i, ...statusCode("500|502|503|529")],
};

interface CrossProbeOutput {
  /** hostCommand 가 실행 파일을 찾지 못한 이유 */
  unresolved?: string;
  spawnCode?: string; spawnMessage?: string;
  status?: number | null; stderr?: string; stdout?: string;
  /**
   * 네트워크 오류를 샌드박스 거부로 볼 것인가 — 지금 프로세스 환경에 Codex 샌드박스 표지가 있거나(crossEnv.sandboxMarkers),
   * Codex 가 부른 `--by claude` 의 그 지점 첫 네트워크 오류다(호출자 crossCheck 가 정한다 — 표지 없는 Codex 샌드박스일 수 있다)
   */
  sandboxed?: boolean;
}
export type CrossProbe = CrossProbeOutput & (
  | { host: "claude"; sentPrompt?: string }
  /**
   * Codex 는 보낸 프롬프트를 전사에 되풀이하므로 sentPrompt(지침 + 프롬프트 전문)가 필수다 — 되풀이된 줄을 분류에서 뺀다.
   * 프롬프트를 만들기 전에 실패했으면 "" 를 넘긴다.
   */
  | { host: "codex"; sentPrompt: string });

/** 교차 실행이 Codex 마지막 응답 파일을 남기지 않았을 때 호출자가 출력 끝에 더하는 줄 — 분류는 이 줄을 꼬리로 보지 않는다 */
export const CROSS_NO_ANSWER = "마지막 응답을 남기지 않았습니다";
/** Codex exec 사람용 출력의 배너 줄 — 라벨이 바뀌면 이 식을 고친다 */
const CODEX_BANNER = /^(?:OpenAI Codex v.*|-{4,}|user|codex|(?:workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):.*)$/i;
const STAMP = String.raw`(?:\[[^\]\n]*\]\s*)?`;
/**
 * Codex 세션이 시작됐다는 표지 — 배너 첫 줄·설정 줄·전사 라벨(user·codex·exec·thinking)·명령 끝 줄(`succeeded in 12ms:`)·토큰 줄.
 * 이 표지가 있는 출력에는 읽은 파일·도구 출력·모델 문장이 섞인다(전사). 라벨이 바뀌면 이 식을 고친다.
 */
const CODEX_SESSION = new RegExp(String.raw`^${STAMP}(?:OpenAI Codex v|(?:workdir|session id):|(?:user|codex|exec|thinking)$|tokens used\b|.*\b(?:succeeded|exited -?\d+) in \d[\d.]*\s*m?s:$)`, "i");
/** 세션 안에서 Codex 가 직접 내는 오류 줄의 라벨(대문자 `ERROR:`). 전사의 `Error:`·`error:` 줄(로그·코드·문서)은 여기에 맞지 않는다 */
const CODEX_ERROR = new RegExp(String.raw`^${STAMP}ERROR:`);
/** 모델 차례가 시작됐다는 표지 — 전사 라벨(codex·exec·thinking)·명령 끝 줄·토큰 줄. 이 뒤의 줄에는 읽은 파일·도구 출력·모델 문장이 섞인다 */
const CODEX_TURN = new RegExp(String.raw`^${STAMP}(?:(?:codex|exec|thinking)$|tokens used\b|.*\b(?:succeeded|exited -?\d+) in \d[\d.]*\s*m?s:$)`, "i");
/** 세션 밖(실행 전 실패 — 인자·설정·인증) 출력의 오류 줄 */
const ERROR_LINE = /^(?:\[[^\]\n]*\]\s*)?(?:error|fatal)\b/i;
const lines = (text?: string): string[] => (text ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
/** 오류 줄(error·fatal 로 시작)이 있으면 그 마지막 5줄, 없으면 마지막 1줄 — 앞줄을 분류에 넣지 않는다 */
const tailErrors = (all: readonly string[]): string => {
  const errors = all.filter((line) => ERROR_LINE.test(line));
  return (errors.length ? errors.slice(-5) : all.slice(-1)).join("\n");
};
const epilogue = (line: string): boolean => line.includes(CROSS_NO_ANSWER) || /^tokens used\b/i.test(line) || /^[\d,]+$/.test(line);
/** 끝의 맺음 줄(토큰 줄·CROSS_NO_ANSWER)을 뗀다 */
const withoutEpilogue = (all: readonly string[]): string[] => {
  let end = all.length;
  while (end > 0 && epilogue(all[end - 1])) end--;
  return all.slice(0, end);
};
/**
 * 분류에 쓰는 글 — 호스트의 오류 채널만. 전사·사용량·배너·되풀이된 프롬프트·모델 문장은 넣지 않는다. 이 함수 하나가 분류 범위의 정의다.
 * claude: stderr 마지막 10줄의 오류 줄(없으면 마지막 1줄) + stdout JSON 이 실패(is_error·result 없음)면 result·subtype,
 *   JSON 이 아니면 stdout 의 오류 줄(없으면 마지막 1줄).
 * codex: 보낸 프롬프트의 줄과 배너를 뺀다. stdout 은 Codex 의 마지막 응답(모델 문장)이라 보지 않는다.
 *   세션이 시작된 출력(CODEX_SESSION)은 stderr 의 맺음 줄 앞 **마지막 한 줄**만 본다 — 그 줄이 Codex 자신의 `ERROR:` 줄일 때만이다.
 *   이어진 `ERROR:` 묶음을 합치지 않는다(읽은 로그의 끝 줄이 Codex 의 오류 줄과 붙을 수 있다). 예외는 모델 차례가 시작되지 않았고
 *   (CODEX_TURN 없음) 남은 줄이 하나뿐일 때다 — 전사가 섞일 수 없으니 그 줄이 Codex 자신의 출력이다. 신호로 끝난 세션(status null)은
 *   Codex 가 스스로 낸 오류가 아니라 보지 않는다. 그 밖(마지막 줄이 전사)은 빈 글 → 분류되지 않은 종료다.
 *   세션 전 출력은 오류 줄(없으면 맺음 줄 앞 마지막 1줄)이다.
 */
export function crossFailureText(probe: CrossProbe): string {
  if (probe.host === "claude") {
    const parts = [tailErrors(lines(probe.stderr).slice(-10))];
    let json: unknown;
    try { json = JSON.parse(probe.stdout ?? ""); } catch { json = undefined; }
    if (json && typeof json === "object") {
      const value = json as { is_error?: unknown; result?: unknown; subtype?: unknown };
      if (value.is_error === true || typeof value.result !== "string") {
        parts.push(typeof value.result === "string" ? value.result : "", typeof value.subtype === "string" ? value.subtype : "");
      }
    } else parts.push(tailErrors(lines(probe.stdout)));
    return parts.filter(Boolean).join("\n").slice(-4000);
  }
  const sent = new Set(lines(probe.sentPrompt));
  const rawErr = lines(probe.stderr), rawOut = lines(probe.stdout);
  const session = [...rawErr, ...rawOut].some((line) => CODEX_SESSION.test(line));
  const keep = (line: string) => !sent.has(line) && !CODEX_BANNER.test(line);
  const err = rawErr.filter(keep), body = withoutEpilogue(err);
  if (session) {
    const last = body.at(-1);
    if (probe.status === null || last === undefined) return "";
    const ownOutput = body.length === 1 && !rawErr.some((line) => CODEX_TURN.test(line));
    return CODEX_ERROR.test(last) || ownOutput ? last.slice(-4000) : "";
  }
  const errors = body.filter((line) => ERROR_LINE.test(line));
  return (errors.length ? errors.slice(-5) : (body.length ? body : err).slice(-1)).join("\n").slice(-4000);
}
const KIND_LABEL: Readonly<Record<CrossKind, string>> = {
  missing: "실행 파일 없음", auth: "인증", quota: "사용 한도", network: "네트워크", outage: "서비스 장애",
  config: "설정 오류", unclassified: "분류되지 않은 종료", timeout: "제한 시간 초과", sandbox: "샌드박스 거부", "sandbox-network": "샌드박스 네트워크 차단",
};
/**
 * 교차 실행 실패의 원인. "실행할 수 없음"(중지 기록 후 진행)은 화이트리스트뿐이고, 어디에도 맞지 않는 비정상 종료는
 * cross-config-error(unclassified — 게이트를 막는 안전 쪽)다.
 */
export function classifyCrossFailure(probe: CrossProbe): { class: "cross-unavailable" | "cross-config-error" | "cross-timeout" | "host-sandbox-denied"; kind: CrossKind; reason: string } {
  const result = (cls: "cross-unavailable" | "cross-config-error" | "cross-timeout" | "host-sandbox-denied", kind: CrossKind, text: string) => {
    const tail = text.replace(/\s+/g, " ").trim().slice(-300);
    return { class: cls, kind, reason: `${KIND_LABEL[kind]}(${kind})${tail ? `: ${tail}` : ""}` };
  };
  if (probe.unresolved) return result("cross-unavailable", "missing", probe.unresolved);
  if (probe.spawnCode === "ENOENT") return result("cross-unavailable", "missing", probe.spawnMessage ?? "");
  if (probe.spawnCode === "ETIMEDOUT") return result("cross-timeout", "timeout", probe.spawnMessage ?? "");
  if (probe.spawnCode === "EPERM" || probe.spawnCode === "EACCES") return result("host-sandbox-denied", "sandbox", probe.spawnMessage ?? "");
  // 그 밖의 spawn 오류(출력이 maxBuffer 를 넘은 ENOBUFS 등)는 실행이 비정상으로 끊긴 것이다 — 잘린 출력을 화이트리스트에 대지 않는다
  if (probe.spawnCode) return result("cross-config-error", "unclassified", probe.spawnMessage ?? probe.spawnCode);
  const text = crossFailureText(probe);
  for (const kind of ["sandbox", "config", "auth", "quota", "network", "outage"] as const) {
    if (!CROSS_PATTERNS[kind].some((pattern) => pattern.test(text))) continue;
    if (kind === "network" && probe.sandboxed) return result("host-sandbox-denied", "sandbox-network", text);
    return result(kind === "sandbox" ? "host-sandbox-denied" : kind === "config" ? "cross-config-error" : "cross-unavailable", kind, text);
  }
  // 분류할 오류 줄이 없으면(전사 끝·신호 종료) 종료 코드만 사유에 남긴다 — 전사 줄을 사유로 보이지 않는다(출력 원문은 logPath)
  const exit = probe.status === undefined ? "" : `종료 코드 ${probe.status === null ? "없음(신호로 종료)" : probe.status}`;
  return result("cross-config-error", "unclassified", text || exit);
}
/**
 * 실행 전 판정 — Codex 샌드박스 안에서는 claude 를 띄울 수 없다(네트워크·홈 쓰기 제한). 사람이 셸 설정의
 * CODE_AGENT_CROSS_PREFLIGHT=off 로만 끈다.
 */
export function crossPreflight(target: "claude" | "codex", env: Readonly<Record<string, string | undefined>>): FailureRecord | undefined {
  if (env.CODE_AGENT_CROSS_PREFLIGHT === "off") return undefined;
  if (target === "claude" && (!!env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED === "1")) {
    return failure("host-sandbox-denied", "Codex 샌드박스 안에서는 claude 를 실행할 수 없습니다(네트워크·홈 쓰기 제한)", { kind: "preflight" });
  }
  return undefined;
}

/** 교차 지점의 시도 보기. "answered-input" 은 저장하지 않는 보기 전용 값(질문을 모두 답한 needs-input 계획 검토) */
export interface CrossAttemptView {
  n: number; startedAt: string; endedAt?: string; class?: CrossClass | "answered-input"; kind?: string;
  mode: "review" | "correct" | "preflight" | "human"; rawPath?: string; host: string; detail?: string;
}
export function crossPointState(attempts: readonly CrossAttemptView[]): {
  state: "none" | "open" | "running" | "completed" | "stopped";
  completed?: CrossAttemptView; stoppedBy?: CrossAttemptView; running?: CrossAttemptView; lastFailure?: CrossAttemptView;
} {
  const ended = attempts.filter((attempt) => attempt.endedAt !== undefined);
  const lastFailure = [...ended].reverse().find((attempt) => attempt.class !== undefined && attempt.class !== "completed" && attempt.class !== "answered-input");
  const last = attempts.at(-1);
  if (!last) return { state: "none" };
  const base = lastFailure ? { lastFailure } : {};
  if (last.endedAt === undefined) return { state: "running", running: last, ...base };
  const completed = attempts.find((attempt) => attempt.class === "completed");
  if (completed) return { state: "completed", completed, ...base };
  const human = [...attempts].reverse().find((attempt) => attempt.class === "cross-stop");
  const timeouts = attempts.filter((attempt) => attempt.class === "cross-timeout" && attempt.kind === "timeout");
  const stops = attempts.filter((attempt) => attempt.class === "cross-unavailable"
    || (attempt.class === "cross-timeout" && attempt.kind === "timeout" && timeouts.length >= 1 + LIMITS.crossTimeout));
  if (human) return { state: "stopped", stoppedBy: human, ...base };
  if (stops.length) return { state: "stopped", stoppedBy: stops.at(-1), ...base };
  return { state: "open", ...base };
}

export type CrossCounterKey = "crossPoint" | "crossTimeout" | "crossError" | "crossFormat";
/**
 * 교차 지점의 카운터 예산 — Budget 규약(used = 이미 쓴 시도·재실행 수, exhausted = used ≥ limit 이면 그 원인으로 다시 실행하지
 * 않는다)을 따르는 유일한 계산이다. crossPointDecision·crossPointHint 와 리뷰·계획 쪽 예산 보고(C1 reviewBudgets·
 * planningCrossBudgets)·사람 허용(retryGrant)·안내의 `{left}` 는 이 값만 쓴다(원인별 수를 따로 세지 않는다).
 * - crossPoint: 지점 시도(review·correct — preflight·human 제외) 수.
 * - crossFormat: 형식 교정(correct) 수.
 * - crossError: 첫 설정 오류 뒤의 재실행 수(설정 오류 수 − 1). 첫 오류 뒤에는 used 0 이라 1회 남았고 허용 대상이 아니다.
 * - crossTimeout: 첫 제한 시간 초과 뒤의 재실행 수(kind timeout 수 − 1, 끊긴 실행은 세지 않는다).
 */
export function crossBudgets(attempts: readonly CrossAttemptView[], grants: readonly RetryGrant[] = [], scope = ""): Record<CrossCounterKey, Budget> {
  const runs = attempts.filter((attempt) => attempt.mode === "review" || attempt.mode === "correct");
  const after = (count: number) => Math.max(0, count - 1);
  return {
    crossPoint: budgetOf("crossPoint", runs.length, undefined, grants, scope),
    crossTimeout: budgetOf("crossTimeout", after(attempts.filter((attempt) => attempt.class === "cross-timeout" && attempt.kind === "timeout").length), undefined, grants, scope),
    crossError: budgetOf("crossError", after(runs.filter((attempt) => attempt.class === "cross-config-error").length), undefined, grants, scope),
    crossFormat: budgetOf("crossFormat", runs.filter((attempt) => attempt.mode === "correct").length, undefined, grants, scope),
  };
}
const counterOf = (budget: Budget): NonNullable<FailureRecord["counter"]> => ({ key: budget.key, used: budget.used, limit: budget.limit });

/** 교차 지점 거부의 종류 — 호출자가 그 자리의 값(지점 이름·열린 지적 수·회차)으로 문구를 만든다 */
export type CrossRefusal = "cross-busy" | "cross-done" | "cross-stopped" | "point-limit" | "format-limit" | "error-limit" | "failed";
export type CrossPointDecision =
  | { action: "run" } | { action: "correct"; rawPath: string } | { action: "record-unavailable"; reason: string }
  | { action: "refuse"; failure: FailureRecord; refusal: CrossRefusal };
const STOPPED_SUFFIX = " — 이 지점은 중지 기록대로 교차 검증 없이 진행합니다(게이트는 막히지 않습니다)";
const WAS_STOPPED_SUFFIX = " — 이 지점은 이전 중지 기록대로 교차 검증 없이 진행합니다(게이트는 막히지 않습니다)";
/**
 * 교차 지점 판정. before(실행 전, 호출자가 고아를 먼저 정리한 뒤): 실행·형식 교정·거부.
 * after(방금 끝난 실패 시도를 포함한 배열): 중지 기록 또는 거부. completed 지점은 다시 실행하지 않고,
 * 사람이 아닌 중지 지점은 지점 한도 안에서 다시 실행할 수 있다(게이트를 강하게만 한다). 한도는 crossBudgets 다.
 */
export function crossPointDecision(input: { attempts: readonly CrossAttemptView[]; grants?: readonly RetryGrant[]; scope: string;
  phase?: "before" | "after"; rawExists?: (path: string) => boolean; wasStopped?: boolean; timeoutMin?: number }): CrossPointDecision {
  const budgets = crossBudgets(input.attempts, input.grants, input.scope);
  const runs = input.attempts.filter((attempt) => attempt.mode === "review" || attempt.mode === "correct");
  const point = crossPointState(input.attempts);
  const reject = (record: FailureRecord, refusal: CrossRefusal): CrossPointDecision => ({ action: "refuse", failure: record, refusal });
  const spent = (budget: Budget) => `${COUNTER_LABEL[budget.key]} 한도 ${budget.limit}회 소진`;
  if ((input.phase ?? "before") === "before") {
    if (point.state === "running") return reject(failure("lock-stale", "다른 교차 실행이 진행 중입니다 — 끝날 때까지 기다리세요. 같은 명령을 다시 실행하지 않습니다"), "cross-busy");
    if (point.state === "completed") return reject(failure("precondition", "이미 기록한 교차 지점입니다 — 같은 지점을 다시 실행해 결과를 바꾸지 않습니다"), "cross-done");
    if (point.state === "stopped" && point.stoppedBy?.class === "cross-stop") {
      return reject(failure("precondition", "사람 판단으로 중지한 교차 지점입니다 — 같은 지점을 다시 실행하지 않습니다"), "cross-stopped");
    }
    if (budgets.crossPoint.exhausted) {
      const origin = point.lastFailure?.class;
      return reject(failure("limit-exceeded", `${spent(budgets.crossPoint)}${point.state === "stopped" ? STOPPED_SUFFIX : ""}`, {
        ...(isFailureClass(origin) ? { origin } : {}), counter: counterOf(budgets.crossPoint),
      }), "point-limit");
    }
    const last = runs.filter((attempt) => attempt.endedAt !== undefined).at(-1);
    if (last?.class === "cross-result-invalid") {
      if (budgets.crossFormat.exhausted) {
        return reject(failure("limit-exceeded", spent(budgets.crossFormat), { origin: "cross-result-invalid", counter: counterOf(budgets.crossFormat) }), "format-limit");
      }
      const exists = input.rawExists ?? (() => true);
      return last.rawPath && exists(last.rawPath) ? { action: "correct", rawPath: last.rawPath } : { action: "run" };
    }
    if (budgets.crossError.exhausted) {
      return reject(failure("limit-exceeded", spent(budgets.crossError), { origin: "cross-config-error", counter: counterOf(budgets.crossError) }), "error-limit");
    }
    return { action: "run" };
  }
  const last = input.attempts.at(-1);
  if (!last || last.endedAt === undefined || last.class === undefined || last.class === "completed" || last.class === "answered-input") {
    throw new Error("crossPointDecision(after) 는 실패로 끝난 시도에만 쓴다");
  }
  if (last.class === "cross-unavailable") return { action: "record-unavailable", reason: last.detail ?? "" };
  const min = input.timeoutMin ?? TIMING.crossTimeoutMin;
  const isTimeout = (attempt?: CrossAttemptView) => attempt?.class === "cross-timeout" && attempt.kind === "timeout";
  if (isTimeout(last) && budgets.crossTimeout.used >= LIMITS.crossTimeout && !input.wasStopped) {
    // 두 번째 제한 시간 초과 — 바로 앞 시도도 제한 시간 초과일 때만 "연속"이다
    const consecutive = isTimeout(runs.filter((attempt) => attempt !== last && attempt.endedAt !== undefined).at(-1));
    return { action: "record-unavailable", reason: `${consecutive ? "두 번 연속" : "이 지점에서 두 번"} ${min}분 제한을 넘겼습니다(CODE_AGENT_CROSS_TIMEOUT_MIN)` };
  }
  const suffix = input.wasStopped ? WAS_STOPPED_SUFFIX : "";
  switch (last.class) {
    case "cross-timeout":
      return reject(failure("cross-timeout", `${min}분 제한을 넘겨 중단했습니다${suffix}`, { kind: last.kind, counter: counterOf(budgets.crossTimeout) }), "failed");
    case "cross-config-error":
      return reject(failure("cross-config-error", `${last.detail ?? ""}${suffix}`, { kind: last.kind, counter: counterOf(budgets.crossError) }), "failed");
    case "cross-result-invalid":
      return reject(failure("cross-result-invalid", `${last.detail ?? ""}${suffix}`, { kind: last.kind, counter: counterOf(budgets.crossFormat) }), "failed");
    case "host-sandbox-denied":
      return reject(failure("host-sandbox-denied", `${last.detail ?? ""}${suffix}`, { kind: last.kind }), "failed");
    default:
      return reject(failure("precondition", `${last.detail ?? ""}${suffix}`), "failed");
  }
}
/**
 * 지금 지점이 막혀 있다면 그 실패 — 게이트·status 안내가 쓴다(마지막 시도의 class 를 직접 읽지 않는다 — 한도 거부는
 * 시도로 저장되지 않는다). 지점이 open 일 때만 값이 있다. at 은 마지막 실패 시도의 endedAt 이다(부를 때마다 바뀌지 않는다).
 * 렌더는 guidance(hint.class, values, recordedVariant(hint)) — 끊긴 실행(kind interrupted)은 제한 시간 문구가 아니다.
 */
export function crossPointHint(input: { attempts: readonly CrossAttemptView[]; grants?: readonly RetryGrant[]; scope: string;
  rawExists?: (path: string) => boolean }): FailureRecord | undefined {
  const point = crossPointState(input.attempts);
  if (point.state !== "open") return undefined;
  const last = point.lastFailure;
  const at = last?.endedAt ? { at: last.endedAt } : {};
  const decision = crossPointDecision({ ...input, phase: "before" });
  if (decision.action === "refuse") return { ...decision.failure, ...at };
  if (!last || !isFailureClass(last.class)) return undefined;
  const budgets = crossBudgets(input.attempts, input.grants, input.scope);
  const key: CrossCounterKey = last.class === "cross-config-error" ? "crossError" : last.class === "cross-result-invalid" ? "crossFormat"
    : last.class === "cross-timeout" && last.kind === "timeout" ? "crossTimeout" : "crossPoint";
  return failure(last.class, last.detail ?? "", { ...(last.kind ? { kind: last.kind } : {}), ...at, counter: counterOf(budgets[key]) });
}
/**
 * 최근 지점부터 이어진 "사람이 아닌 중지" 수 — status·doctor 경고. completed 를 만나면 멈추고,
 * 사람 중지·open·none·running 은 건너뛴다.
 */
export function consecutiveCrossStops(points: readonly { state: string; by?: string }[]): number {
  let count = 0;
  for (const point of points) {
    if (point.state === "completed") break;
    if (point.state === "stopped" && point.by !== "cross-stop") count++;
  }
  return count;
}

// ---- 잠금 ----

export interface LockOwner { pid?: number; host?: string; at?: string }
/**
 * 잠금 판정. 같은 PC 의 주인이 살아 있으면 wait(busy), 죽었으면 reclaim. 다른 PC 는 살았는지 알 수 없어 stop(사람).
 * 주인 기록이 없으면(옛 빈 잠금·쓰는 중·손상) 나이 회수를 허용한 잠금만 10분 뒤 reclaim, 그 밖은 stop.
 */
export function lockDecision(input: { owner?: LockOwner; sameHost: boolean; alive?: boolean; ageMs: number; ageReclaim: boolean }): "reclaim" | "wait" | "stop" {
  if (typeof input.owner?.pid === "number" && typeof input.owner.host === "string") {
    if (!input.sameHost) return "stop";
    return input.alive ? "wait" : "reclaim";
  }
  return input.ageReclaim && input.ageMs > TIMING.lockStaleMs ? "reclaim" : "stop";
}

// ---- hook 실패 ----

export interface HookFailureInput {
  command: "hook" | "consent-event" | "stop" | "session-event" | "review-event" | "planning-event" | "codex-event";
  /** stdin 의 hook_event_name(읽었으면) */
  event?: string;
  /** consent-event: tool_input.metadata.source 가 "code-agent:" 로 시작한다. tool_input 이 없어 알 수 없으면 undefined */
  consentQuestion?: boolean;
  /** codex-event UserPromptSubmit: prompt 가 "code-agent consent respond" 로 시작한다. prompt 가 없어 알 수 없으면 undefined */
  consentReply?: boolean;
  /** stdin JSON 을 읽었는가 */
  parsed: boolean;
}
/** 실패 경로에서 stdin 을 다시 읽어 판정 입력을 만든다(JSON 이 아니면 parsed:false) */
export function hookFailureInput(command: HookFailureInput["command"], stdin: string): HookFailureInput {
  let value: unknown;
  try { value = JSON.parse(stdin); } catch { return { command, parsed: false }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { command, parsed: false };
  const input = value as { hook_event_name?: unknown; tool_input?: unknown; prompt?: unknown };
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : undefined;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as { metadata?: { source?: unknown } } : undefined;
  const source = toolInput?.metadata?.source;
  return {
    command, parsed: true, ...(event !== undefined ? { event } : {}),
    ...(toolInput ? { consentQuestion: typeof source === "string" && source.startsWith("code-agent:") } : {}),
    ...(typeof input.prompt === "string" ? { consentReply: input.prompt.trim().startsWith("code-agent consent respond") } : {}),
  };
}
/**
 * hook 이 판정(또는 모듈 로드)에 실패했을 때의 종료 코드와 stdout. 판정하는 PreToolUse 와 동의 질문·응답은 막고(fail-closed),
 * Stop·SessionStart·SubagentStop·업무 질문·사용자 메시지는 막지 않는다. 알 수 없으면(읽지 못함·필드 없음) 막는 쪽이다.
 * 입력은 언제나 hookFailureInput(command, stdin) 으로 만든다 — `{ command, event }` 를 손으로 만들거나 parsed 를 채워 넣지 않는다
 * (parsed:false 는 "stdin 을 읽지 못함"이라 codex-event Stop 에도 deny JSON 을 낸다). 진입점의 꼴:
 * hookFailureExit(hookFailureInput(command, stdin), "hook 을 실행하지 못했습니다: " + message).
 */
export function hookFailureExit(input: HookFailureInput, message = "판정 모듈을 실행하지 못했습니다"): { code: 0 | 2; stdout?: string } {
  switch (input.command) {
    case "hook": return { code: 2 };
    case "consent-event": return { code: !input.parsed || input.consentQuestion !== false ? 2 : 0 };
    case "stop": case "session-event": return { code: 0 };
    case "review-event": case "planning-event": return { code: input.event === "SubagentStart" ? 2 : 0 };
    case "codex-event": {
      if (!input.parsed || input.event === "PreToolUse") {
        return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
          permissionDecisionReason: `code-agent codex-event 가 판정에 실패해 막았습니다: ${message}` } }) };
      }
      if (input.event === "UserPromptSubmit") return input.consentReply !== false ? { code: 2 } : { code: 0, stdout: "{}" };
      return { code: 0, stdout: "{}" };
    }
  }
}

// ---- 측정(읽기 전용) ----

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const sumValues = (value: unknown): number => Object.values(record(value) ?? {}).reduce<number>((sum, item) => sum + count(item), 0);
function runViews(value: unknown): RunView[] {
  return list(value).map(record).filter((run): run is Json => !!run && typeof run.round === "number" && typeof run.phase === "string"
    && typeof run.outcome === "string").map((run) => ({ ...run, kind: typeof run.kind === "string" ? run.kind : "" }) as unknown as RunView);
}
function addCross(totals: Record<CounterKey, number>, attempts: unknown[], legacy: unknown): void {
  const views = attempts.map(record).filter((attempt): attempt is Json => !!attempt);
  if (views.length === 0) { if (record(legacy)) totals.crossPoint += 1; return; }
  for (const attempt of views) {
    const mode = attempt.mode ?? "review";
    if (mode === "review" || mode === "correct") totals.crossPoint += 1;
    if (mode === "correct") totals.crossFormat += 1;
    if (attempt.class === "cross-timeout" && attempt.kind !== "interrupted") totals.crossTimeout += 1;
    if (attempt.class === "cross-config-error") totals.crossError += 1;
  }
}
/**
 * 작업 기록(verify.json·planning.json·review.json 의 파싱 결과)에서 센 재시도 카운터 합계 — 측정(usage)이 읽기만 한다.
 * 판정에는 쓰지 않는다. 모르는 필드·깨진 값은 0 으로 센다.
 */
export function retrySummary(input: { evidence?: unknown; planning?: unknown; review?: unknown }): Record<CounterKey, number> {
  const totals = Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])) as Record<CounterKey, number>;
  const evidence = record(input.evidence);
  if (evidence) {
    const rounds = count(evidence.rounds);
    const retryValue = record(evidence.retry);
    const reproAttempt = record(evidence.reproAttempt);
    const retry = verifyRetryOf({ rounds, runs: runViews(evidence.runs), retry: retryValue as Partial<VerifyRetryState> | undefined,
      reproAttempt: typeof reproAttempt?.testTreeHash === "string" ? { testTreeHash: reproAttempt.testTreeHash } : undefined });
    const causes = Object.values(record(retry.causes) ?? {});
    totals.fix = causes.filter((cause) => cause === "fix").length;
    totals.collect = causes.filter((cause) => cause === "collect").length;
    totals.rerun = sumValues(retry.reruns);
    totals.integrateRerun = sumValues(retry.integrateReruns);
    totals.reproRerun = sumValues(record(retry.repro)?.reruns);
    totals.reproAttempt = list(record(retry.repro)?.trees).length;
    totals.totalRounds = rounds;
  }
  const planning = record(input.planning);
  if (planning) {
    const attempts = list(planning.tasks).map(record).flatMap((task) => list(task?.attempts).map(record)).filter((attempt): attempt is Json => !!attempt);
    totals.taskTotal = attempts.length;
    totals.sameInput = attempts.filter((attempt) => attempt.status === "failed").length;
    totals.correction = attempts.filter((attempt) => record(attempt.correction)?.used === true).length;
    totals.agentReturn += list(planning.agents).reduce<number>((sum, agent) => sum + count(record(agent)?.returns), 0);
    addCross(totals, list(planning.crossAttempts), planning.cross);
  }
  const review = record(input.review);
  if (review) {
    const rounds = list(review.rounds).map(record).filter((round): round is Json => !!round);
    totals.reviewRounds = rounds.length;
    for (const round of rounds) {
      const reviewers = Array.isArray(round.reviewers) ? round.reviewers.map(record).filter((run): run is Json => !!run) : record(round.reviewer) ? [record(round.reviewer)!] : [];
      totals.reviewerRuns += reviewers.filter((run) => { const ignored = record(run.ignored); return !ignored || ignored.reason === "orphaned"; }).length;
      totals.agentReturn += reviewers.reduce<number>((sum, run) => sum + count(run.returns), 0);
      addCross(totals, list(round.crossAttempts), round.cross);
    }
  }
  return totals;
}

// ---- 문서 ----

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
/** doc/process-flow.md §6.4 생성 블록 — 원인별 규약 표. 문서의 그 구간은 이 출력과 바이트가 같아야 한다 */
export function renderRetryPolicyTable(): string {
  const rows = FAILURE_CLASSES.map((cls) => {
    const policy = POLICIES[cls];
    const name = `\`${cls}\` ${policy.label}${policy.auxiliary ? "(보조)" : ""}`;
    return `| ${[name, policy.detect, policy.retryText, policy.limitText, policy.fixRoundText, policy.exceededText].map(cell).join(" | ")} |`;
  });
  return ["| 원인 | 판별 | 재시도 | 한도 | 고쳐 쓰기 회차 | 넘으면 |", "|---|---|---|---|---|---|", ...rows].join("\n");
}
