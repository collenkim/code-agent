import { loadEvidence } from "./evidence";
import { PLANNING_PHASES, ROLE_PHASE } from "./planningState";
import type { PlanningState } from "./planningState";
import { loadReview } from "./review";
import type { Work } from "./work";

/**
 * 지금 자리의 시도 식별자 — 상태 조회(`status --json`)의 `attempt` 와 발견 보고의 원래 시도가 같은 값을 쓴다.
 * 계획 단계는 그 단계 작업의 마지막 배정(dispatchId), 검증은 회차·실행 수, 리뷰는 회차, 구현은 Task 다.
 * 진행이 한 걸음 나가면 값이 바뀌므로 오래된 재개 요청을 가리는 데 쓴다. 판정·권한에는 쓰지 않는다.
 */
export interface AttemptRef { id: string; kind: "planning" | "implement" | "verify" | "review" | "deliver" }

export function currentAttempt(work: Work, planning?: PlanningState): AttemptRef {
  const { active } = work;
  const phase = active.phase;
  if ((PLANNING_PHASES as readonly string[]).includes(phase)) {
    const latest = (planning?.tasks ?? []).filter((record) => ROLE_PHASE[record.task.role] === phase)
      .flatMap((record) => record.attempts.map((attempt) => ({ task: record.task.id, attempt })))
      .reduce<{ task: string; attempt: { dispatchId: string; at: string } } | undefined>((best, item) =>
        !best || Date.parse(item.attempt.at) >= Date.parse(best.attempt.at) ? item : best, undefined);
    return { id: latest ? `${phase}:${latest.task}:${latest.attempt.dispatchId}` : `${phase}:none`, kind: "planning" };
  }
  if (phase === "implement") return { id: `implement:${active.task ?? active.stage ?? "none"}`, kind: "implement" };
  if (phase === "check" || phase === "test" || phase === "integrate") {
    const evidence = loadEvidence(work.repoRoot, active.id, active.target);
    return { id: `verify:r${evidence?.rounds ?? 0}:${evidence?.runs.length ?? 0}`, kind: "verify" };
  }
  if (phase === "review") return { id: `review:r${loadReview(work.repoRoot, active.id, active.target)?.rounds.length ?? 0}`, kind: "review" };
  return { id: "deliver", kind: "deliver" };
}
