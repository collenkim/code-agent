/**
 * 사람 허용(judgment retry-grant) — 소진된 카운터에 관찰된 사람 판단으로 한도를 GRANT_STEP 만큼 더한다.
 *
 * 카운터 키마다 기록 파일·소유 함수·범위(scope)·잠금·소진 재확인이 고정돼 있다(아래 grantTarget 이 유일한 구현).
 * 범위는 코드가 현재 단계·회차·테스트 트리·critic 지점에서 구한다 — 모델이 주는 값은 계획 배정 한도(taskTotal·sameInput)의
 * 계획 작업 ID 하나다. 같은 키가 두 파일에 있으면(crossPoint 등) 현재 단계가 파일을 정한다.
 * 소진되지 않은 카운터에는 허용을 기록하지 않는다 — 한도를 미리 늘려 두는 길을 닫는다.
 *
 * 동의 미리보기·적용에서만 쓴다(hook 은 이 모듈을 읽지 않는다).
 */
import { existsSync, readFileSync } from "fs";
import { relative } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import { crossAttemptsOf, orphanView } from "./crossRecord";
import { planningCrossBudgets } from "./crossCheck";
import { boundEvidence, planPaths, reviewOpened, reviewRoundBudget, testTreeHashNow, verifyView, type Evidence } from "./evidence";
import { reviewFile, verifyFile } from "./layout";
import { skill } from "./hostText";
import { mutatePlanning, planningBudget, grantPlanningRetry } from "./planning";
import { criticCrossPoint, loadPlanning, planningFile, withPlanningCache } from "./planningState";
import {
  budgetOf, COUNTER_LABEL, GRANT_STEP, grantFor, grantScope, LIMITS, NO_REVIEW_CHOICES, verifyRetryOf,
  type Budget, type CounterKey, type RetryGrant,
} from "./retryPolicy";
import { loadReview, mutateReview, reviewBudgets } from "./review";
import { Stop } from "./stop";
import { patchEvidence } from "./validate";
import { verificationFlowFile } from "./verificationFlow";
import { loadWork, type Work } from "./work";

type GrantKey = keyof typeof GRANT_STEP;
interface GrantTarget {
  key: GrantKey; label: string;
  /** 기록 위치(저장소 상대 경로 · 필드) */
  file: string;
  /** 사람용 지점 이름 */
  point: string;
  scope: string;
  used: number; limit: number; exhausted: boolean; lastFailure?: string;
  /** 잠금을 쥔 채 소진·묶임을 다시 보고 append 한 뒤 기록을 확인한다 */
  record(consentId: string, reason: string): void;
  /** 이 동의의 허용이 이미 기록돼 있는가(멱등) */
  granted(consentId: string): RetryGrant | undefined;
  /** 다시 이어갈 명령 */
  resume: string;
}

const VERIFY_KEYS = ["fix", "rerun", "integrateRerun", "reproRerun", "reproAttempt"] as const;
const REVIEW_KEYS = ["reviewRounds", "reviewerRuns"] as const;
const CROSS_KEYS = ["crossPoint", "crossError", "crossFormat"] as const;
const PLANNING_KEYS = ["taskTotal", "sameInput"] as const;
const PLANNING_PHASES = ["analysis", "impact", "design", "plan"];
const VERIFY_PHASES = ["check", "test", "review", "integrate"];
const REPRO_PHASES = ["implement", "check", "test", "review", "integrate"];

const rel = (work: Work, path: string): string => relative(work.repoRoot, path).replace(/\\/g, "/");
const firstLine = (text: string | undefined): string | undefined => text?.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 200);
const includes = (list: readonly string[], key: string): boolean => list.includes(key);

function requireWorkAt(root: string): Work {
  const work = loadWork(root);
  if (!work) throw new Stop("진행 중인 작업이 없습니다.");
  return work;
}
function requirePhase(work: Work, key: string, phases: readonly string[]): void {
  if (!phases.includes(work.active.phase)) throw new Stop(`${key} 는 ${phases.join("·")} 단계에서 허용합니다(지금: ${work.active.phase}).`);
}
function requireBound(work: Work): Evidence {
  const evidence = boundEvidence(work);
  if (!evidence) throw new Stop("지금 계획·기준에 묶인 검증 기록이 없습니다 — 늘릴 한도가 없습니다.");
  return evidence;
}
const bound = (work: Work, disk: Evidence): boolean => !!work.plan && disk.baseCommit === work.active.baseCommit
  && disk.planHash === hashPlan(work.plan) && disk.manifestHash === hashManifest(work.manifest);

/** 검증 흐름 기록의 마지막 실패 사유 — 없으면 undefined */
function lastVerifyFailure(work: Work): string | undefined {
  try {
    const path = verificationFlowFile(work);
    if (!existsSync(path)) return undefined;
    const history = JSON.parse(readFileSync(path, "utf8")) as { attempts?: { result?: { failure?: { detail?: string } } }[] };
    return firstLine(history.attempts?.at(-1)?.result?.failure?.detail);
  } catch { return undefined; }
}

function verifyTarget(work: Work, key: (typeof VERIFY_KEYS)[number]): GrantTarget {
  const repro = key === "reproRerun" || key === "reproAttempt";
  requirePhase(work, key, repro ? REPRO_PHASES : VERIFY_PHASES);
  if (repro && work.order.kind !== "fix") throw new Stop(`${key} 는 fix 작업의 재현 카운터입니다(지금: ${work.order.kind}).`);
  const evidence = requireBound(work);
  const round = evidence.rounds;
  const tree = repro ? testTreeHashNow(work) : "";
  const scope = key === "fix" || key === "reproAttempt" ? grantScope({ file: "verify", key })
    : key === "reproRerun" ? grantScope({ file: "verify", key, tree })
    : grantScope({ file: "verify", key, round });
  const budgetFrom = (disk: Evidence): Budget => {
    if (key === "fix" || key === "rerun" || key === "integrateRerun") return verifyView(work, disk).budget[key];
    const retry = verifyRetryOf(disk);
    if (key === "reproRerun") return budgetOf("reproRerun", retry.repro.reruns[tree] ?? 0, LIMITS.reproRerun, retry.grants, scope);
    return budgetOf("reproAttempt", retry.repro.trees.length, LIMITS.reproAttempt, retry.grants, scope);
  };
  const budget = budgetFrom(evidence);
  const file = verifyFile(work.repoRoot, work.active.id, work.active.target);
  const grantedIn = (disk: Evidence | undefined, consentId: string) => disk ? verifyRetryOf(disk).grants.find((grant) => grant.consent === consentId) : undefined;
  const point = key === "fix" || key === "reproAttempt" ? `검증 ${round}회차` : key === "reproRerun" ? `재현 테스트 트리 ${tree.slice(-12)}` : `검증 ${round}회차`;
  return {
    key, label: COUNTER_LABEL[key], file: `${rel(work, file)} (retry.grants)`, point, scope, ...pick(budget),
    lastFailure: lastVerifyFailure(work),
    resume: key === "fix" ? "code-agent verify" : key === "rerun" ? "code-agent verify --retry" : key === "integrateRerun" ? "code-agent integrate" : "code-agent repro",
    granted: (consentId) => grantedIn(boundEvidence(work), consentId),
    record(consentId, reason) {
      let refused: Stop | undefined;
      patchEvidence(work, (disk) => {
        // 콜백 안에서 디스크 값으로 다시 판정한다 — 묶임(기준·계획·매니페스트)·회차·트리·소진
        if (!bound(work, disk) || (!repro && key !== "fix" && disk.rounds !== round) || (repro && testTreeHashNow(work) !== tree)) {
          refused = new Stop("준비한 뒤 검증 기록의 회차·묶임이 바뀌었습니다 — 새로 준비하세요."); return;
        }
        const retry = verifyRetryOf(disk);
        retry.grants.push(grantFor({ key, scope, budget: budgetFrom(disk), consent: consentId, reason }));
        disk.retry = retry;
      });
      if (refused) throw refused;
      // 검증 기록에는 파일 잠금이 없다 — 같은 순간의 다른 check 가 덮었으면 기록이 남지 않는다
      if (!grantedIn(boundEvidence(work), consentId)) {
        throw new Stop("검증 기록에 허용이 남지 않았습니다 — 동시에 실행된 검증이 기록을 덮었습니다. code-agent status 로 확인한 뒤 새로 준비하세요.");
      }
    },
  };
}

const pick = (budget: Budget) => ({ used: budget.used, limit: budget.limit, exhausted: budget.exhausted });

function reviewTarget(work: Work, key: (typeof REVIEW_KEYS)[number] | (typeof CROSS_KEYS)[number]): GrantTarget {
  // 리뷰 회차 한도 거부는 검증 쪽(check() 의 통과 뒤 변경)에서 나고 그때 커서는 check 로 되감겨 있다 — 검증 단계 어디서든 받는다.
  // 리뷰어 호출·교차 지점은 회차가 열린 review 단계만이다
  requirePhase(work, key, key === "reviewRounds" ? VERIFY_PHASES : ["review"]);
  const rowOf = (): ReturnType<typeof reviewBudgets>[number] | undefined => reviewBudgets(work).find((row) => row.key === key);
  const row = rowOf();
  if (!row) {
    throw new Stop(includes(CROSS_KEYS, key) ? "이 리뷰 회차에는 교차 지점이 없습니다(두 호스트 설치에서 회차가 열려 있어야 합니다)."
      : "지금 계획·기준에 묶인 리뷰 회차가 없습니다 — 늘릴 한도가 없습니다.");
  }
  const log = loadReview(work.repoRoot, work.active.id, work.active.target);
  // 판정은 한도 안내(check() 거부의 kind no-review·hook·다음:)와 같은 reviewOpened 하나다 — 선택지도 같은 NO_REVIEW_CHOICES 다
  if (key === "reviewRounds" && !reviewOpened(work)) {
    throw new Stop("리뷰 회차를 연 기록이 없습니다 — 리뷰 없이 통과 뒤 변경을 되풀이해 리뷰 회차 한도를 썼습니다. 허용은 리뷰 기록(review.json)에 남기므로 받지 않습니다 — " +
      `사람이 고릅니다: ${NO_REVIEW_CHOICES}.`);
  }
  const lastRound = log?.rounds.at(-1);
  const roundNumber = lastRound?.round;
  const lastCross = lastRound && includes(CROSS_KEYS, key)
    ? orphanView(crossAttemptsOf(lastRound, planPaths(work))).filter((attempt) => attempt.endedAt !== undefined).at(-1) : undefined;
  const file = reviewFile(work.repoRoot, work.active.id, work.active.target);
  return {
    key, label: COUNTER_LABEL[key], file: `${rel(work, file)} (grants)`, point: row.point, scope: row.scope, ...pick(row),
    lastFailure: lastCross ? firstLine(`${lastCross.class ?? "기록 없음"}: ${lastCross.detail ?? ""}`) : undefined,
    resume: key === "reviewRounds" ? "계획 안 지적을 고친 뒤 code-agent verify — 통과하면 code-agent review 로 새 회차를 엽니다"
      : key === "reviewerRuns" ? `${skill("ca-review")} 절차대로 리뷰어를 다시 부릅니다`
      : "code-agent review cross --by <지점 호스트> 로 같은 지점을 다시 실행합니다",
    granted: (consentId) => loadReview(work.repoRoot, work.active.id, work.active.target)?.grants?.find((grant) => grant.consent === consentId),
    record(consentId, reason) {
      mutateReview(work.repoRoot, work.active.id, work.active.target, (current) => {
        if (!current) throw new Stop("리뷰 기록이 없습니다 — 새로 준비하세요.");
        if (key !== "reviewRounds" && current.rounds.at(-1)?.round !== roundNumber) throw new Stop("준비한 뒤 리뷰 회차가 바뀌었습니다 — 새로 준비하세요.");
        // 잠금 안에서 다시 읽은 기록으로 다시 계산한다(reviewBudgets 는 같은 디스크 기록을 읽는다)
        const again = key === "reviewRounds" ? (() => {
          const usage = reviewRoundBudget(work);
          if (usage.stale) throw new Stop("준비한 뒤 리뷰 묶임이 바뀌었습니다 — 새로 준비하세요.");
          return { key: "reviewRounds" as const, used: usage.used, limit: usage.limit, left: Math.max(0, usage.limit - usage.used), exhausted: usage.used >= usage.limit };
        })() : rowOf();
        if (!again) throw new Stop("준비한 뒤 리뷰 지점이 바뀌었습니다 — 새로 준비하세요.");
        current.grants = [...(current.grants ?? []), grantFor({ key, scope: row.scope, budget: again, consent: consentId, reason })];
        return { log: current, value: undefined };
      });
    },
  };
}

function planningCrossTarget(work: Work, key: (typeof CROSS_KEYS)[number]): GrantTarget {
  requirePhase(work, key, PLANNING_PHASES);
  const rowOf = () => planningCrossBudgets(work).find((row) => row.key === key);
  const row = rowOf();
  if (!row) throw new Stop("현재 critic 결과의 교차 검토 지점이 없습니다 — 늘릴 한도가 없습니다.");
  const dispatchId = withPlanningCache(() => criticCrossPoint(work, loadPlanning(work))?.dispatchId);
  const file = planningFile(work);
  return {
    key, label: COUNTER_LABEL[key], file: `${rel(work, file)} (retry.grants)`, point: row.point, scope: row.scope, ...pick(row),
    resume: "code-agent planning cross --by <지점 호스트> 로 같은 지점을 다시 실행합니다",
    granted: (consentId) => withPlanningCache(() => loadPlanning(work).retry?.grants.find((grant) => grant.consent === consentId)),
    record(consentId, reason) {
      withPlanningCache(() => mutatePlanning(work, (state) => {
        const current = criticCrossPoint(work, state);
        if (!current || current.dispatchId !== dispatchId) throw new Stop("준비한 뒤 critic 지점이 바뀌었습니다 — 새로 준비하세요.");
        const again = rowOf();
        if (!again) throw new Stop("준비한 뒤 critic 지점이 바뀌었습니다 — 새로 준비하세요.");
        state.retry!.grants.push(grantFor({ key, scope: row.scope, budget: again, consent: consentId, reason }));
      }));
    },
  };
}

function planningTaskTarget(work: Work, key: (typeof PLANNING_KEYS)[number], taskId: string): GrantTarget {
  requirePhase(work, key, PLANNING_PHASES);
  const budgets = planningBudget(work.repoRoot, taskId);
  const budget = key === "taskTotal" ? budgets.taskTotal : budgets.sameInput;
  const scope = key === "taskTotal" ? grantScope({ file: "planning", key, taskId }) : grantScope({ file: "planning", key, taskId, inputHash: budgets.sameInput.inputHash });
  const record = withPlanningCache(() => loadPlanning(work).tasks.find((item) => item.task.id === taskId));
  const file = planningFile(work);
  return {
    key, label: COUNTER_LABEL[key], file: `${rel(work, file)} (retry.grants)`, point: `계획 작업 ${taskId}`, scope, ...pick(budget),
    lastFailure: firstLine(record?.attempts.at(-1)?.failure?.detail),
    resume: key === "taskTotal" ? "code-agent planning advance" : `입력을 보완했으면 code-agent planning dispatch ${taskId}`,
    granted: (consentId) => withPlanningCache(() => loadPlanning(work).retry?.grants.find((grant) => grant.consent === consentId)),
    // C2 함수가 계획 기록 잠금 안에서 다시 읽고 소진을 다시 확인한 뒤 append 한다(sameInput 은 현재 입력의 inputHash 범위)
    record(consentId, reason) { grantPlanningRetry(work.repoRoot, key, taskId, consentId, reason); },
  };
}

/** 표의 유일한 구현. 키·id 검증 Stop 도 여기 한 곳이다 */
function grantTarget(root: string, key: string, taskId?: string): GrantTarget {
  const allowed = Object.keys(GRANT_STEP);
  if (!allowed.includes(key)) {
    throw new Stop(`이 카운터는 사람 허용으로 늘리지 않습니다: ${key || "(없음)"} — 재계획·재승인이나 작업 종료(abort)를 고르게 하세요. 허용할 수 있는 카운터: ${allowed.join(", ")}`);
  }
  const planningKey = includes(PLANNING_KEYS, key);
  if (planningKey && !taskId) throw new Stop(`${key} 에는 계획 작업 ID(id)가 필요합니다 — code-agent planning status 의 작업 ID 를 넣으세요.`);
  if (!planningKey && taskId !== undefined) throw new Stop("이 카운터의 범위는 코드가 현재 단계·회차·지점에서 정합니다 — id 를 빼고 준비하세요.");
  const work = requireWorkAt(root);
  if (includes(VERIFY_KEYS, key)) return verifyTarget(work, key as (typeof VERIFY_KEYS)[number]);
  if (includes(REVIEW_KEYS, key)) return reviewTarget(work, key as (typeof REVIEW_KEYS)[number]);
  if (includes(CROSS_KEYS, key)) {
    // 같은 키가 리뷰 기록과 계획 기록에 있다 — 현재 단계가 파일을 정한다
    if (work.active.phase === "review") return reviewTarget(work, key as (typeof CROSS_KEYS)[number]);
    if (PLANNING_PHASES.includes(work.active.phase)) return planningCrossTarget(work, key as (typeof CROSS_KEYS)[number]);
    throw new Stop(`${key} 는 review 단계(리뷰 교차 지점) 또는 analysis·impact·design·plan 단계(계획 교차 지점)에서 허용합니다(지금: ${work.active.phase}).`);
  }
  return planningTaskTarget(work, key as (typeof PLANNING_KEYS)[number], taskId!);
}

function exhaustedOrStop(target: GrantTarget): void {
  if (!target.exhausted) {
    throw new Stop(`${target.label} 한도가 남아 있어(사용 ${target.used} / 한도 ${target.limit}) 허용을 기록하지 않습니다 — 한도를 미리 늘리지 않습니다.`);
  }
}

/** 동의 요약에 싣는 카운터 보고 — 소진되지 않았으면 Stop */
export function budgetReport(root: string, key: string, taskId?: string): string {
  const target = grantTarget(root, key, taskId);
  exhaustedOrStop(target);
  const step = GRANT_STEP[target.key];
  return [
    `카운터: ${target.label}(${target.key}) · 지점: ${target.point}`,
    `사용 ${target.used} / 한도 ${target.limit} — 소진`,
    `허용하면: 한도 ${target.limit} → ${target.limit + step} (+${step}, 사람 판단)`,
    ...(target.lastFailure ? [`마지막 실패: ${target.lastFailure}`] : []),
    `기록 위치: ${target.file}`,
  ].join("\n");
}

/** 관찰된 사람 판단을 적용한다 — 대상을 다시 구해 소진을 확인한 뒤 소유 기록의 잠금 안에서 append 한다. 같은 동의는 한 번만 */
export function grantRetry(root: string, key: string, consentId: string, reason: string, taskId?: string): string {
  const target = grantTarget(root, key, taskId);
  const step = GRANT_STEP[target.key];
  const done = (from: number) => `${target.label} 한도를 ${from}→${from + step}회로 늘렸습니다(사람 판단, 동의 ${consentId.slice(0, 8)}) — ${target.resume}`;
  if (target.granted(consentId)) return done(target.limit - step);
  exhaustedOrStop(target);
  target.record(consentId, reason);
  return done(target.limit);
}

/** 테스트·문서가 대조하는 허용 가능 키 */
export const GRANTABLE_KEYS: readonly CounterKey[] = Object.keys(GRANT_STEP) as CounterKey[];
