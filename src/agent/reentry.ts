/**
 * 승인 무효의 재진입 안내 — status·next 의 `다음:`, hook 쓰기 거부, 검증·재현 거부가 같은 문장을 쓴다.
 *
 * 되감기는 둘일 때만이다: 관찰 흐름에서 낡은 계획 작업이 있을 때(그 작업을 다시 배정하려면 커서가 그 단계에 있어야 한다 —
 * planning.ts requireRolePhase), 옛 흐름에서 계획을 바꿔야 할 때(plan submit 은 plan 스테이지에서만 받는다).
 * 계획이 그대로면 지금 자리에서 plan 동의로 다시 승인한다 — 승인(decide)은 스테이지를 요구하지 않고, 검증 증거의 묶임
 * (bindingProblems)은 기준 커밋·트리·매니페스트·계획 해시만 보고 문서 해시는 보지 않으므로 게이트가 같다.
 * 이 되감기는 사용자 지시 없이 하는 예외다(단계 스킬의 되감기 문장). 분류는 precondition 이고 카운터와 무관하다.
 *
 * hook 이 읽으므로 commands.ts 를 import 하지 않는다(commands → request·review … 순환과 hook 기동 비용).
 */
import type { ApprovalState } from "../core/approval";
import { skill, type SkillName } from "./hostText";
import { PHASES, workDocsDir, type Phase } from "./layout";
import { PLANNING_PHASES, planningProblems } from "./planningState";
import { approvalOf, type Work } from "./work";

/** 스테이지마다 그 스테이지 하나만 도는 스킬 — `다음:` 의 머리(commands.ts stageCommand)와 재진입 안내가 쓴다 */
export const PHASE_SKILL: Record<Exclude<Phase, "deliver">, SkillName> = {
  analysis: "ca-analyze",
  impact: "ca-impact",
  design: "ca-design",
  plan: "ca-plan",
  implement: "ca-implement",
  check: "ca-check",
  test: "ca-test",
  review: "ca-review",
  integrate: "ca-integrate",
};

export const APPROVAL_LABEL: Record<Exclude<ApprovalState["status"], "approved">, string> = {
  none: "승인 기록이 없습니다",
  rejected: "계획이 반려됐습니다",
  "stale-plan": "제출된 계획이 승인 뒤 바뀌었습니다",
  "stale-order": "요구사항(지시서)이 승인 뒤 바뀌었습니다",
  "stale-manifest": "code-agent.json 의 경계·검증 선언이 승인 뒤 바뀌었습니다",
  "stale-docs": "근거 문서(공통 POLICY·01~04·07·계획 작업 기록)가 승인 뒤 바뀌었습니다",
  unverified: "승인에 사람이 관측되지 않았습니다",
};

const PLAN_CONSENT = "현재 호스트 세션에서 ca-answer의 plan 동의 절차로 다시 승인받습니다";
const IN_PLACE = `지금 자리에서 ${PLAN_CONSENT}`;
const NO_ORDER = "(승인 무효의 재진입이라 사용자 지시 없이 되감습니다)";

/**
 * 관찰 흐름에서 계획 작업이 현재 입력에 맞지 않는 가장 앞 단계 — 없으면 undefined. 옛 흐름이거나 계획 기록을 읽지 못하면 undefined다
 * (안내 하나로 status 를 세우지 않는다 — 게이트는 next·plan submit 이 그대로 본다).
 */
export function staleEarliest(work: Work): (typeof PLANNING_PHASES)[number] | undefined {
  if (!work.active.planningVersion) return undefined;
  try {
    return PLANNING_PHASES.find((phase) => planningProblems(work, phase).length > 0);
  } catch {
    return undefined;
  }
}

const after = (phase: Phase, than: Phase): boolean => PHASES.indexOf(phase) > PHASES.indexOf(than);

/** 승인이 무효일 때의 재진입 순서 한 줄 — 승인됐으면 undefined */
export function reentryHint(work: Work, approval: ApprovalState = approvalOf(work)): string | undefined {
  if (approval.status === "approved") return undefined;
  const { active } = work;
  const head = `승인 무효(${approval.status}: ${APPROVAL_LABEL[approval.status]})`;
  const draft = `${workDocsDir(active.id)}/plan.json`;
  if (approval.status === "rejected") {
    const reason = approval.record.comment ? ` — 사유: ${approval.record.comment.replace(/\s+/g, " ").slice(0, 120)}` : "";
    return `${head}${reason} — ${after(active.phase, "plan") ? "code-agent back plan 으로 되감고 " : ""}${skill("ca-plan")} 의 반려 절차로 사유가 가리키는 문서부터 다시 봅니다`;
  }
  if (active.planningVersion) {
    const earliest = staleEarliest(work);
    if (!earliest) return `${head} — ${IN_PLACE}`;
    const steps = [
      ...(after(active.phase, earliest) ? [`code-agent back ${earliest} ${NO_ORDER}`] : []),
      `${skill(PHASE_SKILL[earliest])} 부터 계획 작업을 다시 돌려(code-agent planning advance) 단계마다 code-agent next`,
      `code-agent plan submit ${draft}`,
      PLAN_CONSENT,
    ];
    return `${head} — ${steps.join(" → ")}`;
  }
  if (approval.status === "stale-docs" || approval.status === "stale-order") {
    const rewind = after(active.phase, "plan") ? "code-agent back plan(승인 무효의 재진입이라 사용자 지시 없이) → " : "";
    return `${head} — 계획을 바꿔야 하면: ${rewind}${skill("ca-plan")} 로 계획을 다시 확인해 code-agent plan submit ${draft} → ${PLAN_CONSENT}. ` +
      `계획이 그대로면: ${IN_PLACE}(검증 증거는 계획·트리·매니페스트에 묶여 있어 그대로 씁니다)`;
  }
  return `${head} — ${IN_PLACE}`;
}
