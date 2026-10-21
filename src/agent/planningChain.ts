/**
 * `planning advance` 의 다음 행동 한 줄(`next`)과 연쇄 모드(`--chain`).
 *
 * action 별로 메인이 할 일의 원천은 이 표다 — 계획 스킬(ca-analyze·ca-impact·ca-design·ca-plan)은 "출력의 `next` 줄을 따른다"만 적고
 * 불변 규칙만 둔다. 실패 원인이 있는 줄은 재시도 규약의 `guidance()` 문구를 쓴다. 문구는 호스트 중립이다(스킬·도구 이름 없음).
 *
 * 연쇄(`--chain`)는 결과가 모두 준비돼 `ready-for-gate` 인 analysis·impact·design 에서만 같은 호출로 program 게이트(`next()`)를
 * **한 번** 지난다. 다음 단계 배정은 하지 않는다(다음 절차가 자기 1항에서 연다 — 배정 전 선택이 살고, 시작이 관찰되지 않은 배정이
 * 연쇄 때문에 생기지 않는다). 사람 확인(계획 제출·승인)은 잇지 않고, 실패(`blocked`·`rewind-required`·`stale`·대기)나 게이트 거부에서는
 * 자동으로 다시 시도하지 않는다.
 */
import { advancePlanning } from "./planning";
import { handoffPlanning } from "./handoff";
import { OpenQuestionsStop } from "./commands";
import { loadActive, workDocsDir } from "./layout";
import { FAILURE_CLASSES, guidance, recordedVariant, type FailureClass } from "./retryPolicy";
import { Stop } from "./stop";

/** next 가 program 게이트인 계획 단계 — plan 의 게이트는 제출과 사람 승인이라 잇지 않는다 */
const GATE_PHASES = ["analysis", "impact", "design"];
/** 단계 → 그 단계 절차 이름(호스트 중립 — `/`·`$` 접두어 없이) */
const STAGE_SKILL: Record<string, string> = { analysis: "ca-analyze", impact: "ca-impact", design: "ca-design", plan: "ca-plan" };

export interface GateStep { from: string; gate: "passed" | "rejected"; to?: string; reason?: string; questions?: number }
interface Rewind { phase: string; command: string; auto: boolean; reason: string; notice?: string; tasks?: { id: string; staleBecause?: string[] }[] }
interface Blocked { id: string; reasons: string[]; class?: string; counter?: { key?: string; used?: number; limit?: number } }
/** advance 출력(handoff 뒤)의 읽는 부분 — C2 계약 */
export interface AdvanceView {
  phase: string;
  action: string;
  assignments?: { taskId?: string; mode?: string; assignmentFile?: string }[];
  waiting?: string[];
  blocked?: Blocked[];
  stale?: { id: string; reason: string; returnPending?: boolean }[];
  cancel?: string[];
  rewind?: Rewind;
  feedback?: unknown[];
  problems?: string[];
}

const PLACEHOLDER = /\{[A-Za-z]\w*\}/;

/** `--chain` 으로 부른 호출의 안내는 연쇄를 유지한다 — guidance 문구(재시도 규약 원천)를 고치지 않고 advance 명령에 깃발을 붙인다 */
function keepChain(text: string, chained: boolean): string {
  return chained ? text.replace(/(?:code-agent )?planning advance(?! --chain)/g, "code-agent planning advance --chain") : text;
}

function orphanValues(view: AdvanceView): { id: string; detail: string } {
  const stale = view.stale ?? [];
  if (stale.length === 1) return { id: stale[0].id, detail: stale[0].reason };
  return { id: (view.cancel ?? stale.map((item) => item.id)).join(", "), detail: stale.map((item) => `${item.id} ${item.reason}`).join("; ") };
}

/**
 * 원인별 안내. advance 가 원인과 행동을 함께 적은 항목(reasons 둘 — 같은 입력 실패의 명시 재배정·한도 문구, 출처 확인 실패의
 * 명시 재배정)은 그 두 줄이 원천이다. 사유 하나뿐이면 원인의 guidance(기록 변형)다. 자리표시가 남으면(값을 줄 수 없는 원인) undefined
 */
function blockedGuide(item: Blocked): string | undefined {
  if (!item.class || item.class === "precondition" || !(FAILURE_CLASSES as readonly string[]).includes(item.class)) return undefined;
  if (item.reasons.length > 1) return item.reasons.join(" — ");
  const cls = item.class as FailureClass;
  const values: Record<string, string | number> = { id: item.id, detail: item.reasons[0] ?? "" };
  for (const [key, value] of Object.entries(item.counter ?? {})) if (typeof value === "string" || typeof value === "number") values[key] = value;
  let text: string;
  try { text = guidance(cls, values, recordedVariant({ class: cls })); } catch { return undefined; }
  return PLACEHOLDER.test(text) ? undefined : text;
}

/** advance 출력의 다음 행동 한 줄 — 위에서부터 처음 맞는 행 하나(명세 C7 §3.4.1 표) */
export function planningNextLine(view: AdvanceView, options: { chained: boolean; gate?: GateStep; workDir: string }): string {
  const { chained, gate } = options;
  const adv = chained ? "code-agent planning advance --chain" : "code-agent planning advance";
  const feedback = view.feedback?.length ?? 0;
  const FEEDBACK = "계약의 수정 피드백으로 고칠 작업을 다시 배정한다(feedback[].citedTask 는 근거 문서를 낸 작업일 뿐이고 고칠 곳은 지적 내용으로 정한다. 앞 단계를 고쳐야 하면 원인과 다시 도는 작업을 사용자에게 보고하고 지시를 받는다)";
  const keep = (text: string) => keepChain(text, chained);
  const line = ((): string => {
    if (gate?.gate === "passed") {
      const to = gate.to ?? "";
      return `게이트 통과(${gate.from}→${to}) — 스테이지는 ${to}다. ${STAGE_SKILL[to] ?? to} 절차를 읽고 그 1항부터 잇는다(자리 확인 status 는 하지 않는다). 사용자가 ${gate.from} 단계만 요청했으면 결과를 보고하고 마친다`;
    }
    if (gate?.gate === "rejected" && (gate.questions ?? 0) > 0) {
      return `답이 없거나 출처를 확인할 수 없는 질문 ${gate.questions}개 때문에 게이트(${gate.from})를 지나지 못했다 — ca-answer 절차로 실제 답을 받아 기록한 뒤 ${adv}`;
    }
    if (gate?.gate === "rejected") return `게이트 거부(${gate.from}) — chain.reason 을 그대로 전하고 멈춘다`;
    switch (view.action) {
      case "rewind-required": {
        const rewind = view.rewind;
        if (rewind?.auto) {
          return `${rewind.notice ? `먼저 이 한 줄을 사용자에게 알린다(답을 기다리지 않는다): ${rewind.notice} — 그다음 ` : ""}앞 단계(${rewind.phase}) 계획 작업이 지금 입력과 맞지 않는다 — ${rewind.command} 를 실행하고(같은 사유의 첫 자동 되감기라 사용자 지시 없이 한다) ${STAGE_SKILL[rewind.phase] ?? rewind.phase} 절차로 잇는다`;
        }
        return `앞 단계(${rewind?.phase ?? "?"}) 계획 작업이 같은 사유로 다시 낡았다 — 자동으로 되감지 않는다. rewind.reason 과 rewind.tasks[].staleBecause 를 사용자에게 보고하고 지시를 받는다`;
      }
      case "dispatch": {
        const assignments = view.assignments ?? [];
        const cancel = view.cancel?.length ? `먼저 cancel 목록 — ${view.stale?.some(item => item.returnPending) ? keep(view.stale.map(item => `${item.id}: ${item.reason}`).join(" · ")) : keep(guidance("dispatch-orphan", orphanValues(view)))} 그다음 ` : "";
        const together = assignments.length > 1 ? " — 한 메시지에서 함께 호출한다" : "";
        const correction = assignments.some((item) => item.mode === "correction") ? " (mode:correction 배정은 형식만 고친다)" : "";
        return `${cancel}배정 ${assignments.length}개를 담당에게 맡긴다${together}${correction}. 프롬프트에는 assignmentFile 경로만 넘기고, 완료 알림을 받으면 ${adv}`;
      }
      case "stale":
        if (view.stale?.some(item => item.returnPending)) return keep(view.stale.map(item => `${item.id}: ${item.reason}`).join(" · "));
        return keep(guidance("dispatch-orphan", orphanValues(view)));
      case "wait":
        return `실행 중: ${(view.waiting ?? []).join(", ")} — 완료 알림을 기다린다. 상태를 반복 조회하지 않는다. 그 담당 호출이 이미 끝났는데도 wait 이면 결과가 기록되지 않은 것이다 — code-agent planning cancel <ID> 뒤 ${adv}`;
      case "blocked": {
        const blocked = view.blocked ?? [];
        const guide = blocked[0] ? blockedGuide(blocked[0]) : undefined;
        if (guide) {
          const kept = keep(guide);
          const hint = chained && /planning advance/.test(guide) === false && /advance/.test(kept) ? " — 다음 advance 는 code-agent planning advance --chain" : "";
          return `${blocked[0].id}: ${kept}${hint}${blocked.length > 1 ? ` (외 ${blocked.length - 1}건 — blocked 참고)` : ""}`;
        }
        // 배정이 막힌 작업은 없고 교차 계획 검토(crossCriticProblems)가 남았다 — 그 줄이 할 일(명령·사람 판단)을 적는다
        const cross = blocked.length === 0 ? (view.problems ?? []).find((problem) => /^교차 검토/.test(problem)) : undefined;
        if (cross) return `${keep(cross)} — 그다음 ${adv}`;
        // 남은 것이 차단 지적뿐이면 그것이 할 일이다 — 교차 계획 검토는 고친 계획의 critic 결과로 돈다(critic 이 막은 지점은 요구하지 않는다)
        if (blocked.length === 0 && feedback) return "";
        return `막힘 — blocked·problems 사유를 해결한 뒤 ${adv} (미결 질문은 ca-answer 절차로 실제 답을 받는다. 보류·상태 메모는 답이 아니다). 해결할 수 없는 사유면 그대로 전하고 멈춘다`;
      }
      case "ready-for-gate":
        if (view.phase === "plan") return `계획 제출 — code-agent plan submit ${options.workDir}/plan.json (ca-plan 끝 절차)`;
        return `게이트 — code-agent next. 통과하면 다음 스테이지 절차로 잇는다. 답이 없거나 출처를 확인할 수 없는 질문으로 거부되면 ca-answer 절차로 실제 답을 받은 뒤 ${adv}, 그 밖의 거부는 사유를 그대로 전하고 멈춘다`;
      default:
        return `알 수 없는 action(${view.action}) — 출력을 그대로 전하고 멈춘다`;
    }
  })();
  if (!feedback) return line;
  return line ? `${line} — 차단 지적 ${feedback}건: ${FEEDBACK}` : `차단 지적 ${feedback}건 — ${FEEDBACK}. 고친 뒤 ${adv}`;
}

/**
 * 계획 CLI 출력 — 최상위 키마다 한 줄(값은 들여쓰지 않은 JSON)이고 빈 배열은 뺀다. `problems` 는 비어도 남긴다(advance 의 기존 키).
 * 함수(`advancePlanning` 등)의 JSON 은 그대로다 — 메인 대화로 가는 CLI 출력에서만 줄인다
 */
export function planningJson(value: Record<string, unknown>): string {
  const entries = Object.entries(value).filter(([key, item]) => item !== undefined && !(Array.isArray(item) && item.length === 0 && key !== "problems"));
  return `{\n${entries.map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`).join(",\n")}\n}`;
}

/**
 * CLI `planning advance [--chain]`. 출력은 advance JSON(기존 키·problems 그대로)에 `next`(와 연쇄면 `chain`)를 더한 것이다.
 * 게이트 거부면 exit 1 이다(`code-agent next` 의 Stop 과 같다) — JSON 은 그대로 낸다.
 */
export async function planningAdvanceCli(root: string, options: { chain: boolean }): Promise<{ text: string; exit: 0 | 1 }> {
  const view = JSON.parse(handoffPlanning(root, await advancePlanning(root))) as AdvanceView & Record<string, unknown>;
  const active = loadActive(root);
  let gate: GateStep | undefined;
  if (options.chain && view.action === "ready-for-gate" && GATE_PHASES.includes(view.phase)) {
    try {
      await (require("./graph/transition") as typeof import("./graph/transition")).advancePhase(root);
      gate = { from: view.phase, gate: "passed", to: loadActive(root)?.phase };
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      gate = { from: view.phase, gate: "rejected", reason: error.message };
      // 질문 수는 답 없는·출처 미확인 질문 때문에 거부됐을 때만 싣는다 — AI-DLC·문서·요구 확정 거부는 질문이 열려 있어도 그 사유다
      if (error instanceof OpenQuestionsStop && error.count > 0) gate.questions = error.count;
    }
  }
  const workDir = active ? workDocsDir(active.id) : "doc/work/<ID>";
  const text = planningJson({ ...view, ...(gate ? { chain: gate } : {}), next: planningNextLine(view, { chained: options.chain, gate, workDir }) });
  return { text, exit: gate?.gate === "rejected" ? 1 : 0 };
}

/** CLI `planning dispatch|repair <ID>` — 단건 배정. 연쇄 여부를 모르므로 일반 advance 를 안내한다 */
export function planningAssignmentCli(json: string): string {
  const value = JSON.parse(json) as { cached?: boolean; mode?: string } & Record<string, unknown>;
  const next = value.cached
    ? "현재 입력의 결과가 이미 있다 — code-agent planning advance"
    : `이 배정을 담당에게 맡긴다${value.mode === "correction" ? " (형식만 고친다)" : ""} — 프롬프트에는 assignmentFile 경로만 넘기고, 완료 알림을 받으면 code-agent planning advance`;
  return planningJson({ ...value, next });
}
