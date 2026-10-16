/**
 * 교차 검증·리뷰어 실행의 기록 — 타입과 접근 함수.
 *
 * 기록은 append-only 배열이다: 회차마다 리뷰어 실행(`reviewers`)과 교차 시도(`crossAttempts`), 계획은 critic 배정마다
 * 교차 시도(`planning.json` `crossAttempts`). 판정은 언제나 이 배열(옛 기록은 읽을 때 추정한 배열)만 본다.
 * 옛 필드(`reviewer`·`cross`)는 지우지 않고 파생 사본으로 다시 쓴다(syncLegacyRound·syncLegacyPlanning) — 이전 판 CLI·외부
 * 스크립트가 읽을 수 있게.
 *
 * 순환을 피하려고 review.ts·planningState.ts 에서는 타입만 가져온다(`import type`).
 */
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { z } from "zod";

import type { HostName } from "./crossEnv";
import { pidAlive } from "./lock";
import {
  consecutiveCrossStops, COUNTER_LABEL, crossPointState, guidance, recordedVariant, TIMING, type CrossAttemptView, type CrossClass, type FailureRecord,
} from "./retryPolicy";
import type { PlanningState } from "./planningState";
import type { ReviewLog, ReviewRound } from "./review";

export type { CrossClass } from "./retryPolicy";

/** 독립 리뷰 지적 id */
export const REVIEWER_ID = /^F\d+$/;
/** 교차 리뷰 지적 id */
export const CROSS_ID = /^X\d+$/;
export const FINDING_OPEN = "열림";
export const FINDING_CLOSED = "해결";

// ---- 타입 ----

export interface ReviewerRun {
  sessionId: string; agentId: string; startedAt: string; host?: HostName;
  completedAt?: string; result?: string;
  /** 같은 agent id 로 끝난 실행을 재개(resume)한 Start — 새 실행으로 append 한다 */
  resumed?: boolean;
  /** Claude SubagentStop 에서 같은 담당에게 돌려보낸 횟수(agentReturn, 한도 1) */
  returns?: number;
  /** 형식 오류(표 규칙) 또는 완료 hook 의 판정 실패(리뷰 도중 트리·계획 변경 등 — 담당이 고칠 수 없다). 둘 다 새 호출을 받는다 */
  failure?: { class: "agent-format-error" | "hook-failure"; at: string; detail: string; raw?: string };
  /**
   * 결과를 게이트에 쓰지 않는 실행 — 완료된 회차의 재호출, 호출 한도 초과, 받아들인 실행이 끝나지 않은 동안의 동시 호출,
   * 15분 넘게 끝나지 않아 고아로 본 실행(뒤늦은 결과도 쓰지 않는다)
   */
  ignored?: { at: string; reason: "completed-round" | "run-limit" | "concurrent" | "orphaned"; result?: string };
}
/** 교차 실행 사용량 — 토큰·비용은 claude 성공 JSON 에서만 온다(inputTokens 는 캐시 밖 입력이고 캐시 생성·읽기는 따로 센다) */
export interface CrossUsage {
  durationMs: number; costUsd?: number; inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; turns?: number;
  /** Codex 만 — 사람용 출력 끝 `tokens used` 의 수(codex-cli 0.162.1 `blended_total`: 캐시 아닌 입력 + 출력) */
  codexTokens?: number;
}
export interface CrossAttempt {
  /** 지점 안 순번, 1부터 */
  n: number;
  /** 실행한(--by) 호스트 */
  host: HostName;
  /** 명령을 부른 호스트(판별 못 하면 없음) */
  caller?: HostName;
  mode: "review" | "correct" | "preflight" | "human";
  startedAt: string; endedAt?: string;
  /** 실행한 CLI 프로세스 — 고아 판정용 */
  pid?: number; machine?: string;
  model?: string;
  class?: CrossClass;
  kind?: string;
  /** 사유 + 분류에 쓴 오류 채널 꼬리(≤ 600자) */
  detail?: string;
  /**
   * completed 의 결과 본문(리뷰: 정규화한 표 또는 "- 없음"). 옛 기록에서 추정한 형식 오류 시도에는 옛 완료 결과 원문이 남는다
   * (배열을 만들 때 rawPath 로 옮겨 형식만 교정한다) — 판정·렌더는 completed 의 result 만 읽는다
   */
  result?: string;
  /** F→X 로 다시 매겼다 */
  normalized?: boolean;
  /** 형식·내용 오류 원문 handoff 경로(교정 입력) */
  rawPath?: string;
  /** 설정 오류·분류 안 됨 실패의 출력 원문 handoff 경로 */
  logPath?: string;
  /** cross-stop 동의 id */
  consent?: string;
  usage?: CrossUsage;
}
export interface Waiver {
  source: "reviewer" | "cross"; id: string; path: string;
  /** 표에 적힌 범위 칸 그대로 */
  scope: string;
  verdict: "기각" | "범위 밖 확인" | "형식 문제 기각";
  /** 지적 칸을 trim·공백 1칸으로 정규화한 sha256 앞 16자 */
  detailHash: string;
  /** 지적 칸 원문(≤ 300자) */
  detail: string;
  round: number; reason: string; consent: string; at: string;
}
export interface CrossFinding { id: string; severity: "blocking" | "advisory"; detail: string; source: { path: string; line: number } }
export interface CriticOutcome {
  status: "completed" | "needs-input" | "failed"; summary: string; findings: CrossFinding[]; questions: number;
  /** 이 시도가 questions.md 에 쓴 질문 번호 — 옛 기록에는 없다 */
  questionIds?: string[];
}
export type PlanningCrossAttempt = CrossAttempt & { criticDispatchId: string; outcome?: CriticOutcome };
export interface CrossWaiver { criticDispatchId: string; id: string; reason: string; consent: string; at: string }
/** 판정용 보기 — "answered-input" 은 저장하지 않는 보기 전용 class */
export type PlanningCrossView = Omit<PlanningCrossAttempt, "class"> & { class?: CrossClass | "answered-input" };

// ---- 리뷰 결과 표 규칙 ----

const TABLE_SHAPE = "지적 표 또는 '- 없음' 이 아닙니다";
export const RESULT_SHAPE_PROBLEM = TABLE_SHAPE;
const cellsOf = (line: string): string[] => {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
};
const OPEN_WORDS = /^(?:open|opened|unresolved|열린|미해결)$/i;
const CLOSED_WORDS = /^(?:resolved|closed|fixed|해결됨)$/i;
/** 설명은 판단 문장이 아닌 검토 위치 목록으로 분리한다. 실제 지적은 findings에만 둔다. */
const ReviewEnvelope = z.object({
  findings: z.string().min(1),
  checked: z.array(z.object({ path: z.string().min(1), acceptance: z.array(z.string().regex(/^AC-R\d+-\d+$/)).max(100) }).strict()).max(100),
}).strict();
/**
 * 판단을 바꾸지 않는 표 칸 정규화 — 기록 전에 reviewResultProblems 앞에서 부른다. 형식만 틀린 결과로 판단 등급 담당을
 * 다시 부르지 않게 한다. 범위 칸은 계획 파일 목록에서 정해지는 값이라 다시 쓰고, 계획 파일 칸의 백틱·`./`·역슬래시·끝 줄번호는
 * 걷어 내며(줄번호가 붙은 원래 위치는 지적 칸 앞에 옮긴다), 상태 칸의 영어·동의어(open·resolved 등)는 열림·해결로 바꾼다.
 * 고친 줄이 없으면 본문을 그대로 돌려준다. `fixed` 는 고친 칸 수다.
 */
export function normalizeReviewTable(body: string, planned: readonly string[], idPattern: RegExp): { body: string; fixed: number } {
  if (body.trim().startsWith("{")) {
    try {
      const envelope = ReviewEnvelope.parse(JSON.parse(body));
      if (envelope.findings.trim().startsWith("{") || envelope.checked.some(item => !planned.includes(item.path))) return { body, fixed: 0 };
      const normalized = normalizeReviewTable(envelope.findings, planned, idPattern);
      if (reviewResultProblems(normalized.body, planned, idPattern).length) return { body, fixed: 0 };
      return { body: normalized.body, fixed: normalized.fixed + 1 };
    } catch { return { body, fixed: 0 }; }
  }
  const allowed = new Set(planned);
  let fixed = 0;
  const lines = body.split("\n").map((line) => {
    if (!/^\|.*\|$/.test(line.trim())) return line;
    const cells = cellsOf(line);
    if (!idPattern.test(cells[0] ?? "") || cells.length < 5) return line;
    const [id, path, written, status, ...rest] = cells;
    let detail = rest.join(" | ");
    const bare = path.replace(/[`*]/g, "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
    const located = /^(.+?):(\d+(?::\d+)?)$/.exec(bare);
    const cleanPath = located ? located[1] : bare;
    if (located && !detail.includes(bare)) detail = `${bare} — ${detail}`;
    const plain = status.replace(/[`*]/g, "").trim();
    const cleanStatus = OPEN_WORDS.test(plain) || plain === FINDING_OPEN ? FINDING_OPEN : CLOSED_WORDS.test(plain) || plain === FINDING_CLOSED ? FINDING_CLOSED : status;
    const scope = allowed.has(cleanPath) ? "계획 안" : "계획 밖";
    const changes = Number(cleanPath !== path) + Number(cleanStatus !== status) + Number(scope !== written);
    if (!changes || !cleanPath) return line;
    fixed += changes;
    return `| ${id} | ${cleanPath} | ${scope} | ${cleanStatus} | ${detail} |`;
  });
  return fixed ? { body: lines.join("\n"), fixed } : { body, fixed: 0 };
}

/**
 * 리뷰 결과(독립 리뷰 F·교차 리뷰 X)의 형식·내용 검사 — 표 모양·id·다섯 칸·id 중복·상태 값·경로 형식·범위 칸.
 * hook(observeReviewer)과 교차(crossReview)가 기록 **전에** 부르고, 옛 기록은 같은 함수로 유효 결과에서 거른다.
 * 게이트(reviewProblems)의 상태·범위 검사는 손으로 쓴 문서를 위한 방어로 남는다. 결과는 문제 줄(최대 10개)이다.
 */
export function reviewResultProblems(body: string, planned: readonly string[], idPattern: RegExp): string[] {
  if (body.trim() === "- 없음") return [];
  const rows = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const letter = /([A-Z])\\d/.exec(idPattern.source)?.[1] ?? "F";
  if (!rows.length || !rows.every((line) => /^\|.*\|$/.test(line)) || !rows.some((line) => idPattern.test(cellsOf(line)[0] ?? ""))) return [TABLE_SHAPE];
  const allowed = new Set(planned);
  const problems: string[] = [];
  const seen = new Set<string>();
  const separator = (line: string) => /^\|[\s:|-]+\|$/.test(line);
  rows.forEach((line, index) => {
    if (separator(line) || (index + 1 < rows.length && separator(rows[index + 1]))) return;
    const cells = cellsOf(line);
    const id = cells[0] ?? "";
    if (!idPattern.test(id)) { problems.push(`표의 줄은 지적 id(${letter}<번호>)로 시작합니다: ${id.slice(0, 40)}`); return; }
    if (cells.length < 5) { problems.push(`${id} 줄은 id · 계획 파일 · 범위 · 상태 · 지적 다섯 칸입니다`); return; }
    if (seen.has(id)) problems.push(`${id} 가 여러 줄입니다`);
    seen.add(id);
    const [, path, written, status] = cells;
    if (status !== FINDING_OPEN && status !== FINDING_CLOSED) problems.push(`${id} 상태 칸은 열림 · 해결 둘뿐입니다(${status || "빈 칸"})`);
    if (!path || path.includes("`") || /:\d+(?::\d+)?$/.test(path)) problems.push(`${id} 계획 파일 칸은 저장소 기준 경로만 씁니다(${path || "빈 칸"}) — 줄번호는 지적 칸에`);
    const judged = allowed.has(path) ? "계획 안" : "계획 밖";
    if (written !== judged) problems.push(`${id} 범위 칸이 계획과 다릅니다(${written || "빈 칸"} → ${judged})`);
  });
  return problems.slice(0, 10);
}

/** 기각 판단 종류 — undefined 면 게이트를 막는 지적이 아니라 기각할 것이 없다 */
export function waiveVerdict(finding: { status: string; written: string; scope: string }): Waiver["verdict"] | undefined {
  const status = finding.status.trim();
  if ((status !== FINDING_OPEN && status !== FINDING_CLOSED) || finding.written !== finding.scope) return "형식 문제 기각";
  if (finding.scope === "계획 밖") return "범위 밖 확인";
  if (status === FINDING_OPEN) return "기각";
  return undefined;
}
/** 지적 칸 정규화 해시 — 다음 회차로 기각을 이어 줄지 판정한다(공백 차이만 무시) */
export function findingDetailHash(detail: string): string {
  return createHash("sha256").update(detail.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16);
}

// ---- 리뷰어 실행 ----

export function reviewersOf(round: ReviewRound): ReviewerRun[] {
  return round.reviewers ?? (round.reviewer ? [{ ...round.reviewer }] : []);
}
/**
 * 기록할 배열 — 저장된 배열이 없으면 옛 reviewer 에서 만든다. 옛 완료 결과가 지금 표 규칙에 걸리면 형식 오류로 기록한 실행으로 옮긴다
 * (유효 결과가 아니고 호출 1회로 센다 — 파생 사본이 그 결과를 다시 보이지 않게).
 */
export function materializeReviewers(round: ReviewRound, planned: readonly string[]): ReviewerRun[] {
  if (round.reviewers) return round.reviewers;
  round.reviewers = reviewersOf(round).map((run) => {
    if (!run.completedAt || run.result === undefined) return run;
    const problems = reviewResultProblems(run.result, planned, REVIEWER_ID);
    if (!problems.length) return run;
    const { completedAt, result, ...rest } = run;
    return { ...rest, failure: { class: "agent-format-error" as const, at: completedAt, detail: problems.join(" · ").slice(0, 300), raw: result.slice(0, 2000) } };
  });
  return round.reviewers;
}
/** 받아들인(ignored·failure 없는) 실행 중 완료되고 표 규칙을 지킨 첫 실행. 옛 기록(hook 이 내용 검사를 하지 않던 때)은 여기서 걸러진다 */
export function effectiveReviewer(round: ReviewRound, planned: readonly string[]): ReviewerRun | undefined {
  return reviewersOf(round).find((run) => !run.ignored && !run.failure && !!run.completedAt && run.result !== undefined
    && reviewResultProblems(run.result, planned, REVIEWER_ID).length === 0);
}
export interface ReviewerState {
  effective?: ReviewerRun;
  /** 받아들인 끝나지 않은 실행 */
  running?: ReviewerRun;
  /** running 이 리뷰어 고아 기한을 넘겼다 */
  orphanable: boolean;
  /** 형식 오류·hook 판정 실패로 기록됐거나 완료됐지만 표 규칙에 걸린(옛 기록) 실행 수 */
  failures: number;
  /** failures 중 hook 판정 실패 */
  hookFailures: number;
  /** 호출 한도에 세는 실행 수 — 무시되지 않은 실행과 고아로 처리한 실행 */
  runs: number;
  /** 완료됐지만 표 규칙에 걸린 마지막 실행의 문제(옛 기록) */
  invalid?: string[];
}
export function reviewerState(round: ReviewRound, planned: readonly string[], now = Date.now()): ReviewerState {
  const runs = reviewersOf(round);
  const effective = effectiveReviewer(round, planned);
  const running = runs.find((run) => !run.ignored && !run.failure && !run.completedAt);
  const orphanable = !!running && now - Date.parse(running.startedAt) > TIMING.reviewerOrphanMs;
  const counted = runs.filter((run) => !run.ignored || run.ignored.reason === "orphaned").length;
  let invalid: string[] | undefined;
  let failures = 0, hookFailures = 0;
  for (const run of runs) {
    if (run.ignored) continue;
    if (run.failure) { failures++; if (run.failure.class === "hook-failure") hookFailures++; continue; }
    if (run.completedAt && run.result !== undefined) {
      const problems = reviewResultProblems(run.result, planned, REVIEWER_ID);
      if (problems.length) { failures++; invalid = problems; }
    }
  }
  return { ...(effective ? { effective } : {}), ...(running ? { running } : {}), orphanable, failures, hookFailures, runs: counted, ...(invalid ? { invalid } : {}) };
}
export function reviewerRunLabel(run: ReviewerRun): string {
  if (run.ignored) {
    return { "completed-round": "완료 뒤 재호출 무시", "run-limit": "호출 한도 초과 무시", concurrent: "동시 호출 무시", orphaned: "고아로 처리(결과 무시)" }[run.ignored.reason];
  }
  if (run.failure) return run.failure.class === "hook-failure" ? "hook 판정 실패" : "형식 오류";
  return run.completedAt ? "완료" : "실행 중";
}

// ---- 교차 시도 ----

/** 교차 실행의 제한 시간 — CODE_AGENT_CROSS_TIMEOUT_MIN(양수, 소수 허용) 또는 TIMING.crossTimeoutMin */
export function crossTimeoutMin(): number {
  const minutes = Number(process.env.CODE_AGENT_CROSS_TIMEOUT_MIN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : TIMING.crossTimeoutMin;
}
export function crossTimeoutMs(): number { return crossTimeoutMin() * 60_000; }
/** 끝 기록이 없는 시도를 고아로 보는 기한 — 제한 시간 + 5분 */
export const CROSS_ORPHAN_GRACE_MS = 300_000;

const LEGACY_SHAPE_ERROR = "결과가 지적 표 또는 '- 없음' 이 아닙니다";
type LegacyReviewCross = NonNullable<ReviewRound["cross"]>;
const hostOf = (host: string): HostName => host === "codex" ? "codex" : "claude";
/**
 * 옛 `cross` 필드에서 만든 시도 하나. planned 를 주면 완료 결과를 표 규칙으로 다시 보고, 걸리면 형식 오류로 본다 — 옛 결과 원문을
 * `result` 에 남겨, 배열을 처음 저장하는 교차 명령이 handoff 로 옮기고(rawPath) 판단은 그대로 둔 채 형식만 교정한다.
 * planned 가 없으면(연속 중지 집계처럼 계획을 모르는 곳) 내용은 보지 않는다.
 */
export function legacyReviewAttempts(cross: LegacyReviewCross | undefined, planned?: readonly string[]): CrossAttempt[] {
  if (!cross) return [];
  const base: CrossAttempt = { n: 1, host: hostOf(cross.host), mode: "review", startedAt: cross.startedAt, endedAt: cross.completedAt ?? cross.startedAt,
    ...(cross.model ? { model: cross.model } : {}) };
  if (cross.completedAt && cross.result !== undefined) {
    const problems = planned ? reviewResultProblems(cross.result, planned, CROSS_ID) : [];
    return [problems.length ? { ...base, class: "cross-result-invalid", kind: "content", detail: problems.join(" · ").slice(0, 600), result: cross.result }
      : { ...base, class: "completed", result: cross.result }];
  }
  if (cross.unavailable) return [{ ...base, class: "cross-unavailable", detail: cross.unavailable }];
  if (cross.error) {
    return [cross.error === LEGACY_SHAPE_ERROR ? { ...base, class: "cross-result-invalid", kind: "format", detail: cross.error }
      : { ...base, class: "cross-config-error", kind: "unclassified", detail: cross.error }];
  }
  return [{ ...base, class: "cross-timeout", kind: "interrupted", detail: "기록 없이 끝난 실행" }];
}
export function crossAttemptsOf(round: ReviewRound, planned?: readonly string[]): CrossAttempt[] {
  return round.crossAttempts ?? legacyReviewAttempts(round.cross, planned);
}
/**
 * 지점에 고정된 호스트 — 다른 호스트를 실제로 띄운 첫 시도(review·correct)의 호스트. 띄우기 전에 멈춘 사전 판정(preflight)과
 * 사람 중지(human)는 고정하지 않는다(Codex 샌드박스에서 멈춘 `--by claude` 뒤 Claude Code 로 옮겨 `--by codex` 를 쓸 수 있게).
 */
export function pointHost(attempts: readonly { mode: string; host: string }[]): HostName | undefined {
  const first = attempts.find((attempt) => attempt.mode === "review" || attempt.mode === "correct");
  return first ? hostOf(first.host) : undefined;
}

type LegacyPlanningCross = NonNullable<PlanningState["cross"]>;
/** 옛 `cross` 필드에서 만든 계획 교차 시도. criticDispatchId 를 주면 그 지점의 것만 */
export function legacyPlanningAttempts(cross: LegacyPlanningCross | undefined, criticDispatchId?: string): PlanningCrossAttempt[] {
  if (!cross || (criticDispatchId !== undefined && cross.criticDispatchId !== criticDispatchId)) return [];
  const base: PlanningCrossAttempt = { n: 1, host: hostOf(cross.host), mode: "review", startedAt: cross.at, endedAt: cross.at,
    criticDispatchId: cross.criticDispatchId, ...(cross.model ? { model: cross.model } : {}) };
  if (cross.status === "unavailable") return [{ ...base, class: "cross-unavailable", detail: cross.summary }];
  return [{ ...base, class: "completed", outcome: { status: cross.status, summary: cross.summary, findings: cross.findings, questions: cross.questions } }];
}
export function planningCrossAttemptsOf(state: PlanningState, criticDispatchId: string): PlanningCrossAttempt[] {
  return state.crossAttempts
    ? state.crossAttempts.filter((attempt) => attempt.criticDispatchId === criticDispatchId)
    : legacyPlanningAttempts(state.cross, criticDispatchId);
}
export interface QuestionView { id: string; title: string; answered: boolean }
/**
 * 계획 지점의 판정용 보기. completed 인데 needs-input 인 시도는 그 질문(기록이 없으면 머리 `· 교차 계획 검토(` 인 질문 전부)이
 * 하나라도 답이 없으면 질문 대기(그대로 completed), 모두 답했거나 질문이 없으면 끝난 실행 한 번(`answered-input`)이다 —
 * 지점이 열려 같은 지점에서 한 번 더 실행할 수 있다(지점 한도 안).
 */
export function planningCrossView(attempts: readonly PlanningCrossAttempt[], questions: readonly QuestionView[]): { view: PlanningCrossView[]; awaiting?: string[] } {
  const awaiting: string[] = [];
  const view = attempts.map((attempt): PlanningCrossView => {
    if (attempt.class !== "completed" || attempt.outcome?.status !== "needs-input") return attempt;
    const ids = attempt.outcome.questionIds ?? questions.filter((question) => question.title.includes("· 교차 계획 검토(")).map((question) => question.id);
    const open = ids.filter((id) => questions.some((question) => question.id === id && !question.answered));
    if (open.length) { awaiting.push(...open); return attempt; }
    return { ...attempt, class: "answered-input" };
  });
  return { view, ...(awaiting.length ? { awaiting: [...new Set(awaiting)] } : {}) };
}

type Endable = { startedAt: string; endedAt?: string; pid?: number; machine?: string; class?: string; kind?: string; detail?: string };
/**
 * 게이트 쪽 고아 보기 — 끝 기록이 없는 시도 중 같은 machine 에서 pid 가 죽었거나 제한 + 5분이 지난 것을 끊긴 실행
 * (`cross-timeout`·`interrupted`)으로 바꾼 **새 배열**(저장하지 않는다). 교차 명령의 고아 정리는 이 결과를 저장한다.
 */
export function orphanView<T extends Endable>(attempts: readonly T[], now = Date.now()): T[] {
  const me = hostname(), limit = crossTimeoutMs() + CROSS_ORPHAN_GRACE_MS;
  return attempts.map((attempt) => {
    if (attempt.endedAt !== undefined) return attempt;
    const dead = attempt.machine === me && attempt.pid !== undefined && !pidAlive(attempt.pid);
    if (!dead && now - Date.parse(attempt.startedAt) <= limit) return attempt;
    return { ...attempt, endedAt: new Date(now).toISOString(), class: "cross-timeout", kind: "interrupted", detail: `기록 없이 끊긴 실행(pid ${attempt.pid ?? "모름"})` };
  });
}

// ---- 옛 필드(파생 사본) ----

/** 옛 필드(reviewer·cross)를 배열에서 다시 쓴다 — 배열이 저장된 회차만. 판정에는 쓰지 않는다 */
export function syncLegacyRound(round: ReviewRound): void {
  if (round.reviewers) {
    const runs = round.reviewers;
    const pick = runs.find((run) => !run.ignored && !run.failure && run.completedAt) ?? [...runs].reverse().find((run) => !run.ignored);
    if (pick) {
      round.reviewer = { sessionId: pick.sessionId, agentId: pick.agentId, startedAt: pick.startedAt,
        ...(pick.completedAt && !pick.failure ? { completedAt: pick.completedAt } : {}),
        ...(pick.result !== undefined && !pick.failure ? { result: pick.result } : {}) };
    } else delete round.reviewer;
  }
  if (round.crossAttempts) {
    const ended = round.crossAttempts.filter((attempt) => attempt.endedAt !== undefined);
    const point = crossPointState(ended);
    if (point.state === "completed") {
      const done = point.completed as CrossAttempt;
      round.cross = { host: done.host, model: done.model ?? "", startedAt: done.startedAt, completedAt: done.endedAt, result: done.result };
    } else if (point.state === "stopped") {
      const stop = point.stoppedBy as CrossAttempt;
      round.cross = { host: stop.host, model: "", startedAt: stop.startedAt, unavailable: (stop.detail ?? "").slice(0, 500) };
    } else if (point.lastFailure) {
      const last = point.lastFailure as CrossAttempt;
      round.cross = { host: last.host, model: last.model ?? "", startedAt: last.startedAt, error: (last.detail ?? "").slice(0, 300) };
    } else delete round.cross;
  }
}
/**
 * 계획 교차 지점의 옛 필드(cross) — 지점이 completed·stopped 일 때만 다시 쓴다. 게이트와 같은 보기(planningCrossView — 질문을 모두 답한
 * needs-input 은 answered-input)에서 첫 completed 를 고른다 — 옛 needs-input 을 이어 실행한 지점은 다시 실행한 결과가 사본이 된다
 * (동시에 늦게 끝난 completed 는 고르지 않는다).
 */
export function syncLegacyPlanning(state: PlanningState, criticDispatchId: string, questions: readonly QuestionView[]): void {
  const ended = planningCrossAttemptsOf(state, criticDispatchId).filter((attempt) => attempt.endedAt !== undefined);
  const point = crossPointState(planningCrossView(ended, questions).view);
  if (point.state === "completed") {
    const done = point.completed as PlanningCrossAttempt;
    const outcome = done.outcome ?? { status: "completed" as const, summary: "", findings: [], questions: 0 };
    state.cross = { host: done.host, model: done.model ?? "", at: done.endedAt!, criticDispatchId, status: outcome.status, summary: outcome.summary,
      findings: outcome.findings, questions: outcome.questions };
  } else if (point.state === "stopped") {
    const stop = point.stoppedBy as PlanningCrossAttempt;
    state.cross = { host: stop.host, model: "", at: stop.endedAt ?? stop.startedAt, criticDispatchId, status: "unavailable",
      summary: (stop.detail ?? "").slice(0, 500), findings: [], questions: 0 };
  }
}

// ---- 렌더 ----

const oneLine = (text: string | undefined, max: number): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
/** ⑨ `## 교차 지적`의 중지 줄 */
export function stopBody(attempt: { host: string; class?: string; detail?: string; consent?: string }): string {
  if (attempt.class === "cross-stop") return `- 교차 검증 중지 — 사람 판단(동의 ${(attempt.consent ?? "").slice(0, 8)}): ${oneLine(attempt.detail, 300)}`;
  if (attempt.class === "cross-timeout") return `- 교차 검증 중지 — ${attempt.host} 가 ${oneLine(attempt.detail, 300)}`;
  return `- 교차 검증 중지 — ${attempt.host} 를 실행할 수 없습니다: ${oneLine(attempt.detail, 300)}`;
}
/** 시도 하나의 렌더용 이름 */
export function attemptLabel(attempt: { class?: string; kind?: string; endedAt?: string; mode?: string }): string {
  if (attempt.endedAt === undefined) return "실행 중";
  switch (attempt.class) {
    case "completed": return attempt.mode === "correct" ? "completed(형식 교정)" : "completed";
    case "answered-input": return "질문 답함";
    case "cross-unavailable": return "중지(실행 불가)";
    case "cross-stop": return "중지(사람 판단)";
    case "cross-config-error": return "설정 오류";
    case "cross-result-invalid": return "형식 오류";
    case "host-sandbox-denied": return "샌드박스";
    case "cross-timeout": return attempt.kind === "interrupted" ? "끊긴 실행" : "시간 초과";
    default: return attempt.class ?? "기록 없음";
  }
}
/** 지점 하나의 렌더용 이름(보기 배열을 받는다 — 고아 보기·계획 보기를 거친 것) */
export function pointLabel(attempts: readonly (CrossAttemptView & { outcome?: { status: string } })[], awaiting?: readonly string[]): string {
  const point = crossPointState(attempts);
  switch (point.state) {
    case "none": return "없음";
    case "running": return "실행 중";
    case "completed":
      return (point.completed as { outcome?: { status: string } }).outcome?.status === "needs-input" && awaiting?.length ? "질문 대기" : "completed";
    case "stopped":
      return point.stoppedBy?.class === "cross-stop" ? "중지(사람 판단)" : point.stoppedBy?.class === "cross-timeout" ? "중지(시간 초과)" : "중지(실행 불가)";
    default: {
      const last = attempts.filter((attempt) => attempt.endedAt !== undefined).at(-1);
      if (last?.class === "answered-input") return "질문 답함(재검토 대기)";
      const failed = point.lastFailure;
      switch (failed?.class) {
        case "cross-config-error": return "막힘(설정 오류)";
        case "cross-result-invalid": return "막힘(형식 오류)";
        case "host-sandbox-denied": return "막힘(샌드박스)";
        case "cross-timeout": return failed.kind === "interrupted" ? "막힘(끊긴 실행)" : "막힘(시간 초과)";
        default: return "열림";
      }
    }
  }
}
/** 지점 시도의 class 별 개수 — 한도 문구의 `{counts}` */
export function attemptCounts(attempts: readonly { class?: string; kind?: string; mode?: string; endedAt?: string }[]): string {
  const counts = new Map<string, number>();
  for (const attempt of attempts.filter((item) => item.mode === "review" || item.mode === "correct")) {
    const label = attemptLabel(attempt);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join(" · ") || "없음";
}
/**
 * 교차 지점이 막혀 있을 때의 안내 — 지점 안내(crossPointHint)를 원인별 문구로(기록된 실패는 recordedVariant). 리뷰 게이트(reviewProblems)와
 * 계획 게이트(crossCriticProblems)가 같이 쓴다 — 남은 횟수와 다음 행동(설정 오류 1회·형식만 교정·지점 한도·끊긴 실행)을 같은 문구로 낸다.
 */
export function crossHintText(hint: FailureRecord, values: { host: string; point: string;
  attempts: readonly { class?: string; kind?: string; mode?: string; endedAt?: string; rawPath?: string; result?: string }[] }): string {
  const left = hint.counter ? Math.max(0, hint.counter.limit - hint.counter.used) : 0;
  if (hint.class === "limit-exceeded") {
    const key = hint.counter?.key;
    return key === "crossPoint"
      ? guidance("limit-exceeded", { limit: hint.counter!.limit, counts: attemptCounts(values.attempts) }, "cross-point")
      : guidance("limit-exceeded", { counterLabel: key ? COUNTER_LABEL[key] : "재시도", limit: hint.counter?.limit ?? 0, key: key ?? "" }, "cross-cause");
  }
  const invalid = [...values.attempts].reverse().find((attempt) => attempt.class === "cross-result-invalid");
  const raw = [...values.attempts].reverse().find((attempt) => attempt.rawPath)?.rawPath
    ?? (invalid?.result !== undefined ? "옛 기록의 교차 결과(같은 명령이 handoff 로 옮긴다)" : "(원문 없음 — 같은 명령은 처음부터 다시 실행합니다)");
  return guidance(hint.class, { host: values.host, detail: hint.detail, left, min: crossTimeoutMin(), point: values.point, raw },
    recordedVariant(hint, { attempts: values.attempts, left })).replace(/\n/g, " ");
}
/**
 * 교차 게이트 줄(리뷰·계획)의 '직전 실행' 꼬리 — 라벨, 사유, 원인별 안내(crossHintText). 안내 문구가 같은 사유를 이미 싣으면(대부분의 원인이
 * `{detail}`을 싣는다) 사유는 안내에만 두어 한 줄에 같은 사유가 두 번 나오지 않게 한다. 안내가 싣지 않으면 라벨 뒤에 120자까지 붙인다
 */
export function crossLastRun(label: string, detail: string | undefined, hint: string): string {
  const shown = oneLine(detail, 600);
  const repeated = !shown || hint.replace(/\s+/g, " ").includes(shown);
  return ` — 직전 실행: ${label}${repeated ? "" : `: ${shown.slice(0, 120)}`}. ${hint}`;
}
/**
 * 교차 게이트 줄(리뷰 reviewProblems·계획 crossCriticProblems)이 실행 명령을 앞세우지 않는 지점 — 한도로 거부될 지점(limit-exceeded)과
 * 네트워크 오류가 권한 상승 안내 뒤에 되풀이돼 사람에게 넘긴 지점(recordedVariant 의 network-exhausted)은 "limit" 이다: 명령을 싣지 않는다
 * (그 명령은 거부되고 남은 길은 사람 판단이다). 지점 시도가 남은 network-repeat 은 "network" 다: 사용자가 네트워크를 확인한 뒤에만 다시
 * 실행하므로(D2) 명령을 안내 뒤에 싣는다(crossRerunAfterUser). 그 밖은 undefined — 명령을 앞세운다.
 */
export function crossGateHandoff(hint: FailureRecord | undefined,
  attempts: readonly { kind?: string; endedAt?: string }[]): "limit" | "network" | undefined {
  if (!hint) return undefined;
  if (hint.class === "limit-exceeded") return "limit";
  const left = hint.counter ? Math.max(0, hint.counter.limit - hint.counter.used) : 0;
  const variant = recordedVariant(hint, { attempts, left });
  return variant === "network-exhausted" ? "limit" : variant === "network-repeat" ? "network" : undefined;
}
/** 사람에게 넘긴 네트워크 지점(crossGateHandoff "network")의 게이트 줄 꼬리 — 사용자가 네트워크를 확인한 뒤 다시 실행할 명령 */
export function crossRerunAfterUser(command: string): string {
  return ` (사용자가 네트워크를 확인한 뒤 다시 실행할 명령: ${command})`;
}

// ---- 연속 중지 ----

/**
 * 최근 기록(작업 폴더의 review.json·planning.json 중 최신 20개)에서 이어진 "사람이 아닌 중지" 지점 수 — status·doctor 경고.
 * 리뷰는 회차마다, 계획은 critic 배정마다 지점 하나다. 읽지 못한 파일은 건너뛴다.
 */
export function crossStopStreak(root: string): { count: number; last?: { host: string; detail: string } } {
  const base = join(root, ".code-agent", "work");
  let files: { path: string; mtime: number }[] = [];
  try {
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of readdirSync(join(base, dir.name))) {
        if (!name.endsWith(".review.json") && !name.endsWith(".planning.json")) continue;
        const path = join(base, dir.name, name);
        try { files.push({ path, mtime: statSync(path).mtimeMs }); } catch { /* 지워졌다 */ }
      }
    }
  } catch { return { count: 0 }; }
  files = files.sort((a, b) => b.mtime - a.mtime).slice(0, 20);
  type Point = { state: string; by?: string; at: string; host: string; detail: string };
  const points: Point[] = [];
  const add = (attempts: readonly CrossAttempt[]) => {
    if (!attempts.length) return;
    const point = crossPointState(attempts);
    const ended = attempts.filter((attempt) => attempt.endedAt !== undefined);
    const at = ended.at(-1)?.endedAt ?? attempts.at(-1)!.startedAt;
    points.push({ state: point.state, ...(point.stoppedBy?.class ? { by: point.stoppedBy.class } : {}), at, host: pointHost(attempts) ?? attempts[0].host, detail: point.stoppedBy?.detail ?? "" });
  };
  for (const file of files) {
    try {
      const value = JSON.parse(readFileSync(file.path, "utf8")) as Partial<ReviewLog & PlanningState>;
      if (file.path.endsWith(".review.json")) {
        for (const round of Array.isArray(value.rounds) ? value.rounds : []) add(crossAttemptsOf(round as ReviewRound));
      } else {
        const state = value as PlanningState;
        const all = Array.isArray(state.crossAttempts) ? state.crossAttempts : legacyPlanningAttempts(state.cross);
        for (const id of [...new Set(all.map((attempt) => attempt.criticDispatchId))]) add(all.filter((attempt) => attempt.criticDispatchId === id));
      }
    } catch { /* 깨진 기록 */ }
  }
  points.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const count = consecutiveCrossStops(points);
  const lastStop = points.find((point) => point.state === "stopped" && point.by !== "cross-stop");
  return { count, ...(count && lastStop ? { last: { host: lastStop.host, detail: lastStop.detail } } : {}) };
}
