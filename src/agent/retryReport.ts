/**
 * 재시도·재배정 측정 — `usage` 가 작업 기록을 **읽기만** 한다.
 *
 * 카운터는 `retryPolicy.retrySummary()` 를 그대로 쓰고(이 모듈은 세지 않는다), 실패 원인은 정해진 경로의 `class` 만 모은다.
 * 결과는 출력에만 쓴다 — 어떤 파일에도 쓰지 않고 배정 입력·스킬로 돌려보내지 않는다(자가 학습이 아니다).
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import { crossAttemptsOf, legacyPlanningAttempts, type CrossAttempt } from "./crossRecord";
import type { PlanningState } from "./planningState";
import type { ReviewRound } from "./review";
import { CONSENT_DIR } from "./consentState";
import { STATE_DIR } from "./layout";
import { COUNTER_KEYS, COUNTER_LABEL, isFailureClass, retrySummary, type CounterKey, type FailureClass } from "./retryPolicy";

export interface CrossTotals { attempts: number; durationMs: number; costUsd: number; inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }
const emptyCross = (): CrossTotals => ({ attempts: 0, durationMs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
export interface RetryReport {
  id: string;
  target: string;
  /** retrySummary() 결과에서 0 이 아닌 것만 */
  counters: Partial<Record<CounterKey, number>>;
  /** planning.json tasks[].attempts 총수(전 기간) */
  dispatches: number;
  /** Σ max(0, attempts.length − 1) */
  reassignments: number;
  failures: Partial<Record<FailureClass | "(기타)", number>>;
  /** 교차 시도의 usage 합 — usage 가 기록된 시도만 */
  cross: CrossTotals;
  /** 읽지 못한 파일(JSON 오류) — 버리지 않고 알린다 */
  unreadable: string[];
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
/** 실패가 아닌 교차 결과 — 원인 집계에서 뺀다 */
const NOT_FAILURE = new Set(["completed", "cross-stop"]);
const KINDS = ["verify", "planning", "review", "verification-flow"] as const;

function readJson(path: string, unreadable: string[], shown: string): unknown {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { unreadable.push(shown); return undefined; }
}
function countFailure(failures: RetryReport["failures"], cls: unknown): void {
  if (typeof cls !== "string" || NOT_FAILURE.has(cls)) return;
  const key: FailureClass | "(기타)" = isFailureClass(cls) ? cls : "(기타)";
  failures[key] = (failures[key] ?? 0) + 1;
}
function addCross(totals: CrossTotals, attempts: unknown[]): void {
  for (const attempt of attempts.map(record)) {
    const usage = record((attempt as Partial<CrossAttempt> | undefined)?.usage);
    if (!usage) continue;
    totals.attempts += 1;
    totals.durationMs += num(usage.durationMs);
    totals.costUsd += num(usage.costUsd);
    totals.inputTokens += num(usage.inputTokens);
    totals.outputTokens += num(usage.outputTokens);
    totals.cacheCreationInputTokens += num(usage.cacheCreationInputTokens);
    totals.cacheReadInputTokens += num(usage.cacheReadInputTokens);
  }
}

/**
 * 교차 시도 — 배열이 없는 옛 기록은 옛 `cross` 필드에서 만든 시도(crossRecord 의 접근 함수)로 본다. retrySummary 의 카운터가 옛 기록도
 * 세므로 실패 원인도 같은 범위를 센다. 옛 시도에는 usage 가 없어 교차 실행 합계는 달라지지 않는다
 */
function reviewCrossAttempts(round: Json): unknown[] {
  if (Array.isArray(round.crossAttempts)) return round.crossAttempts;
  return crossAttemptsOf({ cross: record(round.cross) } as unknown as ReviewRound);
}
function planningCrossAttempts(plan: Json): unknown[] {
  if (Array.isArray(plan.crossAttempts)) return plan.crossAttempts;
  return legacyPlanningAttempts(record(plan.cross) as PlanningState["cross"]);
}
/** 리뷰어 실행 — 옛 기록의 단수 `reviewer` 도 하나로 본다(crossRecord.reviewersOf·retrySummary 와 같다) */
function reviewerRuns(round: Json): unknown[] {
  if (Array.isArray(round.reviewers)) return round.reviewers;
  return record(round.reviewer) ? [round.reviewer] : [];
}

/** 작업 하나·대상 하나의 기록 */
function reportOf(dir: string, id: string, target: string): RetryReport {
  const unreadable: string[] = [];
  const shown = (kind: string) => `${STATE_DIR}/work/${id}/${target}.${kind}.json`;
  const [evidence, planning, review, flow] = KINDS.map((kind) => readJson(join(dir, `${target}.${kind}.json`), unreadable, shown(kind)));
  const totals = retrySummary({ evidence, planning, review });
  const counters = Object.fromEntries(COUNTER_KEYS.filter((key) => totals[key] > 0).map((key) => [key, totals[key]])) as RetryReport["counters"];
  const failures: RetryReport["failures"] = {};
  const cross = emptyCross();
  let dispatches = 0, reassignments = 0;
  const plan = record(planning);
  if (plan) {
    for (const task of list(plan.tasks).map(record)) {
      const attempts = list(task?.attempts).map(record);
      dispatches += attempts.length;
      reassignments += Math.max(0, attempts.length - 1);
      for (const attempt of attempts) countFailure(failures, record(attempt?.failure)?.class);
    }
    for (const agent of list(plan.agents).map(record)) countFailure(failures, record(agent?.failure)?.class);
    const attempts = planningCrossAttempts(plan);
    for (const attempt of attempts.map(record)) countFailure(failures, attempt?.class);
    addCross(cross, attempts);
  }
  const log = record(review);
  if (log) {
    for (const round of list(log.rounds).map(record)) {
      if (!round) continue;
      const attempts = reviewCrossAttempts(round);
      for (const attempt of attempts.map(record)) countFailure(failures, attempt?.class);
      for (const reviewer of reviewerRuns(round).map(record)) countFailure(failures, record(reviewer?.failure)?.class);
      addCross(cross, attempts);
    }
  }
  for (const attempt of list(record(flow)?.attempts).map(record)) countFailure(failures, record(record(attempt?.result)?.failure)?.class);
  return { id, target, counters, dispatches, reassignments, failures, cross, unreadable };
}

/** 대상 이름 — `<대상>.<종류>.json` 의 앞부분 */
function targetsIn(dir: string): string[] {
  const names = new Set<string>();
  for (const name of readdirSync(dir)) {
    for (const kind of KINDS) if (name.endsWith(`.${kind}.json`)) names.add(name.slice(0, -`.${kind}.json`.length));
  }
  return [...names].sort();
}

/**
 * `.code-agent/work/<ID>/` 기록의 재시도·재배정·실패 원인·교차 실행 합계. `work` 가 없으면 모든 작업과, 동의 기록의 실패 원인
 * (`(동의)` 행 하나)를 더한다. 기록이 하나도 없으면 빈 배열이다.
 */
export function retryReports(repoRoot: string, work?: string): RetryReport[] {
  const base = join(repoRoot, STATE_DIR, "work");
  const reports: RetryReport[] = [];
  const ids = work !== undefined ? [work] : existsSync(base) ? readdirSync(base).sort() : [];
  for (const id of ids) {
    const dir = join(base, id);
    let targets: string[];
    try { targets = targetsIn(dir); } catch { continue; }
    for (const target of targets) reports.push(reportOf(dir, id, target));
  }
  if (work === undefined) {
    const dir = join(repoRoot, CONSENT_DIR);
    const failures: RetryReport["failures"] = {};
    const unreadable: string[] = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
        countFailure(failures, record(record(readJson(join(dir, name), unreadable, `${CONSENT_DIR}/${name}`))?.failure)?.class);
      }
    }
    if (Object.keys(failures).length || unreadable.length) {
      reports.push({ id: "(동의)", target: "", counters: {}, dispatches: 0, reassignments: 0, failures, cross: emptyCross(), unreadable });
    }
  }
  return reports;
}

/** 출력 한 줄 — 값이 0 인 항목은 쓰지 않는다. 비용에는 `$` 를 쓰지 않는다(usage 표 파서가 `$숫자` 줄을 표 행으로 읽는다) */
export function retryLine(report: RetryReport): string {
  const parts: string[] = [];
  if (report.dispatches) parts.push(`배정 ${report.dispatches}회(재배정 ${report.reassignments})`);
  for (const key of COUNTER_KEYS) {
    const value = report.counters[key];
    if (!value || key === "taskTotal") continue;
    parts.push(`${COUNTER_LABEL[key]} ${value}`);
  }
  const failures = Object.entries(report.failures).sort(([a], [b]) => a.localeCompare(b));
  if (failures.length) parts.push(`실패 원인 ${failures.map(([cls, count]) => `${cls} ${count}`).join(" · ")}`);
  if (report.cross.attempts) {
    const seconds = Math.round(report.cross.durationMs / 1000);
    parts.push(`교차 실행 ${report.cross.attempts}회 ${seconds}초${report.cross.costUsd > 0 ? ` 비용 ${report.cross.costUsd.toFixed(2)} USD` : ""}`);
  }
  if (report.unreadable.length) parts.push(`읽지 못한 기록 ${report.unreadable.join(", ")}`);
  const name = report.target ? `${report.id}/${report.target}` : report.id;
  return `  ${name}: ${parts.length ? parts.join(" · ") : "재시도·실패 기록 없음"}`;
}
