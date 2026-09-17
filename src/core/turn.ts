/**
 * 한 턴 = 프롬프트 하나를 내주고, 그 응답을 받아 실행하는 것.
 *
 * 사람이 클립보드로 나르든 나중에 서버가 API로 나르든 이 파일이 하는 일은 같다.
 * 전송을 바꿀 때 다시 쓰지 않아도 되는 것을 전부 여기 둔다.
 *
 * 응답 형식이 두 가지인 이유: 파일 내용이 오가는 단계만 코드블록(액션)을 쓴다. 계획·검수는
 * 파일 내용이 없는 작은 구조체라 JSON이 깨질 위험이 낮고, 이미 검증된 경로가 있다.
 */
import { existsSync } from "fs";
import { join } from "path";

import { ACTION_FORMAT } from "./action";
import {
  checkApproval,
  formatDiff,
  hashPlan,
  recordDecision,
  recordStageDecision,
  UNATTENDED,
} from "./approval";
import type {
  ApprovalRecord,
  Decision,
  PendingApproval,
  PendingStage,
  Presence,
} from "./approval";
import { executeActions } from "./execute";
import type { ExecuteOutcome } from "./execute";
import { parseActions } from "./fence";
import { buildStagePrompt } from "./generate";
import { buildGatePrompt, GateSchema, missingPlannedFiles } from "./gate";
import { GATE_SHAPE, parseResponse, withOutputFormat } from "./manual";
import { formatPlan, missingPreserve, planFormatFor, previewPlanPrompt } from "./plan";
import { withResolvedInputs } from "./run";
import type { StageDef } from "./manifest";
import type { Lane, LaneState } from "./targets";
import { describeLanes, rememberIssuedToken, takeIssuedToken, withRememberedSpec } from "./targets";
import {
  answeredSlotKeys,
  buildIntakePrompt,
  findGaps,
  hashSpec,
  INTAKE_SHAPE,
  IntakeSchema,
  questionTargetFor,
  saveSlots,
} from "./specSchema";
import { describeWorkOrder } from "./workOrder";
import { appendQuestions, describeTarget, loadSession, readQuestions, saveSession } from "./session";
import type { Session, Target } from "./session";
import { listReferenceTree } from "./exemplar";
import { loadPlan, loadPreviousResults, loadStageFiles, PLAN_FILE, savePlan } from "./state";
import type { BuildContext, BuildPlan, GateViolation } from "./types";

/** 게이트를 몇 번까지 다시 돌릴지. 넘으면 사람에게 넘긴다 — 무한 반복이 더 나쁘다. */
const MAX_GATE_ATTEMPTS = 2;

function joinForChat(system: string, user: string, format: string): string {
  return `# 역할·규칙\n${system}\n\n---\n\n${user}\n\n${format}`;
}

function observationSection(session: Session): string {
  if (session.lastObservations.length === 0) {
    return "";
  }
  return (
    "\n\n# 앞 턴에서 요청한 것의 결과\n" +
    session.lastObservations
      .map((observation) => `## ${observation.label}\n${observation.body}`)
      .join("\n\n")
  );
}

function answerSection(outDir: string): string {
  const answered = readQuestions(outDir).filter((question) => question.answer !== "");
  if (answered.length === 0) {
    return "";
  }
  return (
    "\n\n# 사람이 답한 것 — 이 답을 따른다. 다시 묻지 않는다\n" +
    answered
      .map((question) => `- ${question.question}\n  → ${question.answer}`)
      .join("\n")
  );
}

/**
 * 지금 도는 대상의 레인 상태.
 *
 * 무엇을 할 차례인지는 레인 계산이 이미 정해 두었다. 여기서 다시 계산하면 고른 레인과
 * 실제로 도는 단계가 어긋날 수 있어, 고른 쪽의 답을 그대로 쓴다.
 */
function stepOf(lanes: LaneState[], target: string): Target {
  return lanes.find((state) => state.lane.target === target)!.step;
}

/** 대상이 여럿일 때만 대상 이름을 붙인다. 하나뿐이면 군더더기다. */
function labelFor(step: Target, target: string, lanes: LaneState[]): string {
  return lanes.length > 1 ? `${target}:${describeTarget(step)}` : describeTarget(step);
}

/** 다른 대상이 어떤 상태인지 — 한 대상에서 막혔을 때 전경을 잃지 않게 */
function laneSection(lanes: LaneState[]): string {
  return lanes.length > 1 ? `\n\n대상별 상태:\n${describeLanes(lanes)}` : "";
}

const HOW_TO_DECIDE = [
  '승인:  code-agent approve --approver <이름> [--target <대상>] [--comment "…"] --repo … --templates …',
  '반려:  code-agent reject  --approver <이름> [--target <대상>] --comment "사유"  --repo … --templates …',
  "  --target 은 판정을 기다리는 대상이 둘 이상일 때 필요합니다.",
].join("\n");

/**
 * 4차 게이트 화면에 올릴 말.
 *
 * 무엇을 확정하는지는 **파일 목록**이다. 그것 없이 "확정하시겠습니까"만 물으면 판정이 형식이 되고,
 * 형식이 된 판정은 통제가 아니다.
 */
function confirmMessage(
  state: PendingStage,
  stage: StageDef,
  outDir: string,
  target: string,
): string {
  const files = loadStageFiles(outDir, loadPlan(outDir), stage.key);
  const listed =
    files.length > 0
      ? files
          .map((file) => `  - ${join(outDir, file.path)} (${file.content.split("\n").length}줄)`)
          .join("\n")
      : "  (이 단계는 파일을 만들지 않았습니다 — 그대로 확정할지도 사람이 정합니다)";

  const lines = [
    `## 단계 산출물을 확정해야 넘어갑니다 (4차 게이트) — 대상: ${target} · 단계: ${stage.key}`,
    stage.title,
    "",
    listed,
    "",
  ];

  if (state.status === "rejected") {
    lines.push(
      `직전 판정: 반려 — ${state.record.approver} · ${state.record.at}`,
      ...(state.record.comment ? [`  사유: ${state.record.comment}`] : []),
      "그 사유는 다음 프롬프트에 실렸습니다. 다시 만든 것을 보고 판정하세요.",
      "",
    );
  } else if (state.status === "stale-files") {
    lines.push(
      `이미 확정된 적이 있지만 그 뒤 산출물이 바뀌었습니다 — ${state.record.approver} · ${state.record.at}`,
      "확정은 그때의 파일들에 대한 것이라 지금 파일들을 말하지 않습니다. 다시 판정하세요.",
      "",
    );
  }

  lines.push("확정 전에는 다음 단계로 넘어가지 않습니다.", "", HOW_TO_DECIDE);
  return lines.join("\n");
}

/**
 * 승인 화면에 올릴 말.
 *
 * 처음 승인이면 계획 전문을, 재승인이면 **달라진 것만** 보여 준다. 계획 전체를 다시 읽히면
 * 승인이 형식이 되고, 형식이 된 승인은 통제가 아니다.
 */
function approvalMessage(
  state: PendingApproval,
  plan: BuildPlan,
  outDir: string,
  target: string,
): string {
  const planPath = join(outDir, PLAN_FILE);
  const head = `## 계획 승인이 필요합니다 (2차 게이트) — 대상: ${target}`;

  if (state.status === "none") {
    // 승인하는 사람은 이 계획이 **어떤 답 위에** 세워졌는지도 봐야 한다.
    return [head, "", formatPlan(plan) + answerSection(outDir), "", HOW_TO_DECIDE].join(
      "\n",
    );
  }

  if (state.status === "rejected") {
    return [
      `## 이 계획은 반려되었습니다 (대상: ${target}) — ${state.record.approver} · ${state.record.at}`,
      ...(state.record.comment ? [`사유: ${state.record.comment}`] : []),
      "",
      "계획이 그대로인 채로는 진행되지 않습니다. 스펙이나 지시서를 고친 뒤 " +
        `${planPath} 를 지우면 계획부터 다시 돕니다.`,
    ].join("\n");
  }

  if (state.status === "unverified") {
    return [
      `## 승인은 있으나 사람 존재가 관측되지 않았습니다 — 대상: ${target}`,
      `직전 판정: ${state.record.approver} · ${state.record.at}` +
        ` (통로 ${state.record.presence?.channel ?? "기록 없음"})`,
      ...(state.record.presence?.detail ? [`근거: ${state.record.presence.detail}`] : []),
      "",
      "이 프로젝트는 `requireVerifiedApproval` 을 켜 두었습니다 — 사람이 그 자리에 있었다는 것이" +
        " 관측된 판정만 게이트를 엽니다.",
      "터미널에서 `code-agent approve` 를 다시 부르세요. 그 자리에서 확인 문구를 입력하면" +
        " 통로가 tty 로 기록됩니다.",
      "",
      HOW_TO_DECIDE,
    ].join("\n");
  }

  if (state.status === "stale-order") {
    return [
      `## 작업 지시서가 바뀌어 승인이 무효가 됐습니다 (0차부터 다시) — 대상: ${target}`,
      `직전 판정: ${state.record.approver} · ${state.record.at} (지시서 ${state.record.orderHash})`,
      "",
      "지시서가 바뀌면 슬롯 충족 여부도 경계도 다시 봐야 합니다. 계획도 지금 지시서로 " +
        `다시 세우는 것이 맞습니다 — ${planPath} 를 지우면 계획부터 다시 돕니다.`,
      "",
      HOW_TO_DECIDE,
    ].join("\n");
  }

  const decided = state.record.decision === "approved" ? "승인됨" : "반려됨";
  return [
    `${head} — 계획이 바뀌어 직전 판정이 무효가 됐습니다`,
    `[${decided}] planHash: ${state.record.planHash} (${state.record.approver} · ${state.record.at})`,
    `[변경됨] planHash: ${hashPlan(plan)}`,
    "─".repeat(60),
    formatDiff(state.diff),
    "",
    `계획 전문: ${planPath}`,
    "",
    HOW_TO_DECIDE,
  ].join("\n");
}

/**
 * 이 프롬프트가 **어느 자리에서 나왔는지**. 응답이 돌아왔을 때 그 자리가 그대로인지 대조한다.
 *
 * 이것이 없으면 `applyResponse` 는 붙여넣은 것이 어느 단계를 위해 만들어졌는지 모른 채
 * 지금 차례에 밀어넣는다. 혼자 쓸 때는 드러나지 않지만 화면이 둘이거나 사람이 둘이면,
 * 한쪽이 먼저 반영해 상태를 움직인 뒤 다른 쪽이 붙여넣게 되고 그 응답은 **엉뚱한 레인의
 * 엉뚱한 단계**로 들어간다. 계획 하나가 남의 대상에 저장되는 사고가 여기서 난다.
 *
 * 해시가 아니라 읽을 수 있는 문자열인 것은 의도다 — 막으려는 것이 위조가 아니라 착오이고
 * (위조는 인증이 막는다), 어긋났을 때 무엇과 무엇이 어긋났는지 사람이 바로 읽어야 한다.
 * 뒤에서부터 잘라 읽으므로 대상 이름에 `@`·`#` 이 들어 있어도 갈리지 않는다.
 */
export function turnTokenOf(lane: string, step: Target, turn: number): string {
  return `${lane}@${describeTarget(step)}#${turn}`;
}

export function parseTurnToken(
  token: string,
): { lane: string; step: string; turn: number } | undefined {
  const hash = token.lastIndexOf("#");
  if (hash < 0) {
    return undefined;
  }
  const turn = Number(token.slice(hash + 1));
  if (!Number.isInteger(turn) || turn < 0) {
    return undefined;
  }
  const head = token.slice(0, hash);
  const at = head.lastIndexOf("@");
  // at === 0 이면 대상 이름이 비어 있다 — 그런 레인은 없다.
  if (at <= 0) {
    return undefined;
  }
  return { lane: head.slice(0, at), step: head.slice(at + 1), turn };
}

/**
 * 응답이 만들어진 자리와 지금 자리가 다르다. **아무것도 반영하지 않는다.**
 *
 * 형식 오류(`parseErrors`)와 구분하는 이유는 고치는 방법이 다르기 때문이다. 형식 오류는
 * 같은 프롬프트로 다시 받으면 되지만, 이것은 프롬프트 자체를 다시 받아야 한다.
 */
export class TurnMismatchError extends Error {
  constructor(
    readonly issued: string,
    readonly now: string,
  ) {
    super(
      `붙여넣은 응답은 \`${issued}\` 자리의 것인데 지금 차례는 \`${now}\` 입니다 — ` +
        "아무것도 반영하지 않았습니다.\n" +
        "  그 사이에 이 작업이 진행됐습니다 (다른 화면 · 다른 사람 · 앞선 요청).\n" +
        "  프롬프트를 다시 받아 그 응답을 붙여넣으세요.",
    );
    this.name = "TurnMismatchError";
  }
}

export interface NextPrompt {
  target: Target;
  label: string;
  prompt?: string;
  /** 이 프롬프트가 나온 자리. 응답을 되돌려 줄 때 그대로 실어 보낸다 */
  token: string;
  /** blocked·done·approval 이면 프롬프트 대신 사람에게 할 말 */
  message?: string;
  /** 이 프롬프트가 어느 대상의 것인지 */
  lane: string;
  /** 작업 지시서의 id — 프롬프트를 내준 자리를 적을 때 쓴다 */
  orderId: string;
  /** 그 대상의 계획·질문·생성물이 있는 곳 */
  outDir: string;
  /** 지시서의 대상 전부와 각자의 상태 */
  lanes: LaneState[];
  /**
   * 프롬프트는 나왔지만 사람이 알아야 하는 것. 지금은 참조 표준 일부 누락이 여기 온다.
   *
   * 위반과 다르다 — 진행을 막지 않는다. 다만 **버리지는 않는다**: 참조 표준이 빠진 사실을
   * 아무도 모르면 이 도구의 설계 축이 조용히 무너진다.
   */
  warnings?: string[];
}

/**
 * **CLI 전용** — next 가 내준 자리를 적어 두어 apply 가 대조할 수 있게 한다.
 *
 * 두 명령이 다른 프로세스라 토큰을 들고 있을 곳이 파일밖에 없다. 서버는 이것을 부르지
 * 않는다 — 클라이언트가 토큰을 직접 들고 오므로 조회가 부작용을 갖지 않아도 되고,
 * 파일 슬롯 하나를 여럿이 나눠 쓰면 그게 곧 덮어쓰기 사고가 된다.
 */
export function rememberIssued(input: BuildContext, next: NextPrompt): void {
  if (!next.prompt) {
    return;
  }
  rememberIssuedToken(input.outDir, next.orderId, next.token);
}

/**
 * 지금 붙여넣을 프롬프트 하나를 만든다. 진행 상태를 바꾸지 않으므로 몇 번 실행해도 같다.
 * 스펙 경로만은 받은 자리에서 기억해 둔다 — 사람이 매번 --spec 을 다시 쓰지 않게 하려는 것이다.
 */
export function nextPrompt(input: BuildContext): NextPrompt {
  const { context, manifest, lanes } = withResolvedInputs(withRememberedSpec(input));
  const session = loadSession(context.outDir);
  const lane = context.target;
  const target = stepOf(lanes, lane);
  const head = {
    target,
    label: labelFor(target, lane, lanes),
    token: turnTokenOf(lane, target, session.turn),
    lane,
    orderId: context.workOrder.id,
    lanes,
    outDir: context.outDir,
  };

  if (target.kind === "approval") {
    // 프롬프트를 내주지 않는다. 승인은 사람이 하는 일이라 모델에 보낼 것이 없다.
    return {
      ...head,
      message:
        approvalMessage(target.state, loadPlan(context.outDir), context.outDir, lane) +
        laneSection(lanes),
    };
  }

  if (target.kind === "confirm") {
    // 프롬프트를 내주지 않는다. 확정은 사람이 하는 일이라 모델에 보낼 것이 없다.
    return {
      ...head,
      message:
        confirmMessage(target.state, target.stage, context.outDir, lane) + laneSection(lanes),
    };
  }

  if (target.kind === "blocked") {
    return { ...head, message: target.reason + laneSection(lanes) };
  }
  if (target.kind === "done") {
    const all = lanes.every((state) => state.step.kind === "done");
    return {
      ...head,
      message: all
        ? `모든 대상이 끝났습니다. 결과: ${input.outDir}\n` +
          "내용을 확인한 뒤 저장소에 복사하면 반영됩니다."
        : `${lane} 은 끝났습니다.` + laneSection(lanes),
    };
  }

  if (target.kind === "intake") {
    // specSchema 가 없으면 intake 가 대상이 될 수 없다 — decideTarget 이 그렇게 정한다.
    const { system, user } = buildIntakePrompt(
      context.specSchema!,
      context.workOrder.kind,
      describeWorkOrder(context.workOrder, context.target),
      context.specText,
    );
    return {
      ...head,
      prompt: withOutputFormat(joinForChat(system, user, "").trimEnd(), INTAKE_SHAPE),
    };
  }

  if (target.kind === "plan") {
    const referenceTree = listReferenceTree(
      context.repoRoot,
      manifest,
      context.referenceDomain,
      manifest.stages,
    );
    const preview = previewPlanPrompt(context, manifest, manifest.stages, referenceTree);
    return {
      ...head,
      prompt: withOutputFormat(
        // 사람이 답한 것은 계획에도 실려야 한다 — 1차 게이트의 질문이 계획 이전에 걸리므로,
        // 여기서 빠지면 사람이 답한 내용을 계획이 모르는 채로 세워진다.
        joinForChat(preview.system, preview.user + answerSection(context.outDir), "").trimEnd(),
        planFormatFor(context.workOrder.kind).shape,
      ),
    };
  }

  const plan = loadPlan(context.outDir);

  if (target.kind === "gate") {
    const files = loadStageFiles(context.outDir, plan, target.stage.key);
    if (files.length === 0) {
      // 아무것도 안 만든 단계는 검수할 것이 없다.
      return { ...head, message: `${target.stage.key} 단계의 산출물이 없어 검수를 건너뜁니다.` };
    }
    const { system, user } = buildGatePrompt(context, manifest, target.stage, files);
    return { ...head, prompt: withOutputFormat(joinForChat(system, user, "").trimEnd(), GATE_SHAPE) };
  }

  const previous = loadPreviousResults(context.outDir, plan, manifest.stages, target.stage.key);
  const { system, user, missingExemplars, exemplarsUsed } = buildStagePrompt(
    context,
    manifest,
    plan,
    target.stage,
    previous,
    session.lastViolations,
  );

  // 이 도구의 1번 축은 "참조할 파일은 모델이 아니라 코드가 결정론적으로 고른다"다.
  // 단계가 참조 표준을 선언했는데 하나도 실리지 않았다면, 이 프롬프트는 모델에게
  // **지어내라고 하는 것**이 된다. 조용히 내보내면 축이 무너진 사실을 아무도 모른다.
  if (target.stage.exemplars.length > 0 && exemplarsUsed === 0) {
    throw new Error(
      `참조 표준을 하나도 찾지 못해 ${target.stage.key} 단계의 프롬프트를 만들지 않았습니다.\n` +
        `  선언: ${target.stage.exemplars.join(", ")}\n` +
        `  찾은 곳: ${missingExemplars.join("\n           ") || "(경로 계산 실패)"}\n` +
        `  참조 도메인: ${context.referenceDomain || "(없음)"}\n\n` +
        "이 상태로 만들면 참조 표준 없이 지어낸 코드가 나옵니다. 흔한 원인은 둘입니다 —\n" +
        "  · code-agent.json 의 exemplars 경로가 실제 저장소와 다르다\n" +
        "  · {Ref} 치환이 실제 클래스명과 어긋난다 (여러 낱말로 된 도메인 이름)",
    );
  }

  return {
    ...head,
    warnings:
      missingExemplars.length > 0
        ? [
            `참조 표준 ${missingExemplars.length}건을 찾지 못했습니다 — ` +
              `${missingExemplars.join(", ")} (나머지 ${exemplarsUsed}건으로 진행합니다)`,
          ]
        : undefined,
    prompt: joinForChat(
      system,
      user + observationSection(session) + answerSection(context.outDir),
      ACTION_FORMAT,
    ),
  };
}

/**
 * 어느 대상에 판정할 것인가.
 *
 * 대상 여럿이 동시에 승인을 기다릴 수 있다(A 가 대기하는 동안 B 를 돌렸으니 흔한 일이다).
 * 그때 코드가 하나를 고르면 사람이 읽은 계획과 판정한 계획이 달라질 수 있어, 고르지 않고 묻는다.
 */
function laneToDecide(lanes: LaneState[], target?: string): Lane {
  if (target) {
    const named = lanes.find((state) => state.lane.target === target);
    if (!named) {
      throw new Error(
        `작업 지시서에 없는 대상입니다: ${target} \n` +
          `  대상: ${lanes.map((state) => state.lane.target).join(", ")}`,
      );
    }
    return named.lane;
  }

  const waiting = lanes.filter(
    (state) => state.step.kind === "approval" || state.step.kind === "confirm",
  );
  if (waiting.length === 0) {
    throw new Error(
      "판정을 기다리는 대상이 없습니다. 계획 승인(2차)이나 단계 확정(4차)이 걸린 뒤에 판정할 수 있습니다.",
    );
  }
  if (waiting.length > 1) {
    throw new Error(
      `판정을 기다리는 대상이 ${waiting.length} 개입니다. --target 으로 고르세요: ` +
        waiting.map((state) => state.lane.target).join(", "),
    );
  }
  return waiting[0].lane;
}

export interface ApprovalOutcome {
  /** 이미 같은 판정이 있어 원장에 아무것도 남기지 않았는지 */
  unchanged: boolean;
  record: ApprovalRecord;
}

/**
 * 2차 게이트에 사람이 판정을 내린다. CLI 든 서버든 이 함수를 지난다 —
 * 판정을 남기는 자리가 둘이면 한쪽에만 검사가 빠지는 일이 생긴다.
 */
export function decideApproval(
  input: BuildContext,
  decision: Decision,
  given: {
    approver?: string;
    comment?: string;
    target?: string;
    /**
     * 전송이 관측한 사람 존재. **생략하면 관측하지 못한 것으로 남는다** —
     * 넘기지 않은 호출자에게 조용히 권한을 주지 않기 위해 기본값이 그쪽으로 기운다.
     */
    presence?: Presence;
  },
): ApprovalOutcome {
  const { context, manifest, lanes } = withResolvedInputs(withRememberedSpec(input));
  const lane = laneToDecide(lanes, given.target);
  const plan = loadPlan(lane.outDir);
  const step = stepOf(lanes, lane.target);
  // 정책을 함께 넘긴다. 빼면 아래 멱등 단축로가 관측되지 않은 승인을 "이미 승인됨"으로 읽어,
  // 같은 계획에 관측된 승인을 얹으려는 사람을 조용히 되돌려 보낸다.
  const state = checkApproval(context.repoRoot, context.workOrder, plan, lane.target, {
    requireVerifiedApproval: manifest.workOrder.requireVerifiedApproval,
  });

  // 게이트가 **한 번도 제시된 적 없는** 자리에는 판정을 남기지 않는다.
  //
  // 이 검사가 없으면 질문에 막힌 대상의 계획을 미리 승인해 원장에 박아 둘 수 있다. 그러면
  // 나중에 계획이 세워질 때 이미 승인이 있는 상태가 되고, 사람은 그 계획을 본 적이 없다.
  //
  // 이미 판정이 있는 자리(`status !== "none"`)는 통과시킨다 — 같은 승인을 다시 부르는 것과
  // 승인을 되돌리는 것은 게이트를 지난 뒤의 일이라 여기서 막을 것이 아니다.
  if (step.kind !== "approval" && step.kind !== "confirm" && state.status === "none") {
    throw new Error(
      `${lane.target} 은 판정을 기다리지 않습니다 (지금: ${describeTarget(step)}).\n` +
        "판정은 게이트가 걸린 자리에만 남깁니다 — 아직 제시되지 않은 것을 미리 승인할 수는 없습니다.",
    );
  }

  if (decision === "approved" && step.kind !== "confirm" && state.status === "approved") {
    // 같은 계획에 같은 판정을 두 번 남기지 않는다. 원장이 사건 기록이라 중복은 잡음이다.
    return { unchanged: true, record: state.record };
  }
  if (decision === "rejected" && !given.comment) {
    throw new Error(
      "반려에는 사유가 필요합니다. 반려는 지워야 할 실패가 아니라 가장 값진 기록입니다 — " +
        "사유 없는 반려는 그 값을 잃습니다.",
    );
  }

  const approver = given.approver ?? context.workOrder.approver;
  if (!approver) {
    throw new Error(
      "누가 판정했는지 알 수 없습니다 (--approver). " +
        "작업 지시서에 approver 를 적어 두면 그 값이 기본이 됩니다.",
    );
  }

  // 4차 게이트 — 지금 기다리는 것이 단계 확정이면 그것에 판정한다.
  // 사람은 "승인·반려"만 하고, 무엇에 대한 판정인지는 상태가 정한다.
  const presence = given.presence ?? UNATTENDED;

  if (step.kind === "confirm") {
    const files = loadStageFiles(lane.outDir, plan, step.stage.key);
    const record = recordStageDecision(context.repoRoot, {
      order: context.workOrder,
      target: lane.target,
      plan,
      stage: step.stage.key,
      files,
      decision,
      approver,
      comment: given.comment,
      presence,
    });

    if (decision === "rejected") {
      reopenStage(lane.outDir, step.stage.key, given.comment!);
    }
    return { unchanged: false, record };
  }

  return {
    unchanged: false,
    record: recordDecision(context.repoRoot, {
      order: context.workOrder,
      target: lane.target,
      plan,
      decision,
      approver,
      comment: given.comment,
      presence,
    }),
  };
}

/**
 * 반려된 단계를 다시 돌게 한다.
 *
 * 검수 시도 횟수까지 되돌리는 것은, 사람이 반려한 것과 모델이 스스로 걸린 것을 같은 예산으로
 * 세면 두 번째 판정에서는 검수가 아예 돌지 않기 때문이다. 반려 사유는 **위반으로** 실어
 * 다음 프롬프트에 그대로 올린다 — 사유가 안 실리면 같은 것을 다시 만들어 온다.
 */
function reopenStage(outDir: string, stageKey: string, comment: string): void {
  const session = loadSession(outDir);
  const { [stageKey]: dropped, ...attempts } = session.gateAttempts;

  saveSession(outDir, {
    ...session,
    completedStages: session.completedStages.filter((key) => key !== stageKey),
    gatedStages: session.gatedStages.filter((key) => key !== stageKey),
    gateAttempts: attempts,
    lastViolations: [
      { item: "사람이 반려함", file: stageKey, detail: comment },
    ],
  });
}

export interface ApplyOutcome {
  label: string;
  /** 어느 대상에 반영했는지 */
  lane: string;
  /** 그 대상의 레인 디렉토리 */
  outDir: string;
  planSaved?: string;
  execution?: ExecuteOutcome;
  violations: GateViolation[];
  parseErrors: string[];
  questionsAdded: number;
  /** 이 단계가 끝나 다음으로 넘어가는지 */
  advanced: boolean;
  message?: string;
}

/**
 * 채팅 응답을 읽어 실제로 반영한다.
 *
 * `issuedToken` 은 이 응답이 만들어진 자리다. 서버는 클라이언트가 보낸 것을 그대로 넘기고,
 * CLI 는 생략해 next 가 적어 둔 것을 읽게 한다. 어느 쪽이든 **지금 자리와 다르면 던진다** —
 * 그 자리에 밀어넣으면 남의 대상에 남의 계획이 저장된다.
 */
export async function applyResponse(
  input: BuildContext,
  responseText: string,
  issuedToken?: string,
): Promise<ApplyOutcome> {
  const remembered = withRememberedSpec(input);
  const issued = issuedToken ?? takeIssuedToken(remembered.outDir);
  const parsedToken = issued === undefined ? undefined : parseTurnToken(issued);
  if (issued !== undefined && parsedToken === undefined) {
    throw new Error(
      `자리 토큰의 형식이 어긋납니다: ${JSON.stringify(issued)}\n` +
        "  형식은 `대상@단계#턴` 입니다. 프롬프트를 받은 자리에서 준 값을 그대로 보내세요.",
    );
  }

  // 토큰이 가리키는 레인으로 간다. 없는 대상이면 지시서의 대상 목록과 함께 거부된다.
  const { context, manifest, lanes } = withResolvedInputs(remembered, parsedToken?.lane);
  const session = loadSession(context.outDir);
  const lane = context.target;
  const target = stepOf(lanes, lane);

  // 대조는 레인을 고른 **뒤에** 한다 — 단계와 턴까지 봐야 "그 사이 진행됐다"를 잡는다.
  const now = turnTokenOf(lane, target, session.turn);
  if (issued !== undefined && issued !== now) {
    throw new TurnMismatchError(issued, now);
  }

  const label = labelFor(target, lane, lanes);
  session.turn += 1;

  const record = {
    turn: session.turn,
    at: new Date().toISOString(),
    target: label,
    counts: {} as ExecuteOutcome["counts"],
    written: 0,
    observations: 0,
    violations: 0,
    parseErrors: 0,
  };

  const laneInfo = { lane, outDir: context.outDir };

  const finish = (outcome: ApplyOutcome): ApplyOutcome => {
    record.violations = outcome.violations.length;
    record.parseErrors = outcome.parseErrors.length;
    session.log.push(record);
    saveSession(context.outDir, session);
    return outcome;
  };

  /**
   * JSON 단계(intake·plan·gate)의 형식 오류도 **턴으로 센다.**
   *
   * 액션 단계는 이미 그렇게 하는데 이쪽만 예외로 throw 하고 있었다 — 그러면 `log` 의 형식오류
   * 수치가 절반의 단계에서 빠져, "자동으로 맡겨도 되나"를 판단할 근거가 체계적으로 과소집계된다.
   */
  const malformed = (error: unknown): ApplyOutcome =>
    finish({
      label,
      ...laneInfo,
      violations: [],
      parseErrors: [error instanceof Error ? error.message : String(error)],
      questionsAdded: 0,
      advanced: false,
      message: "응답 형식이 어긋나 아무것도 반영하지 않았습니다.",
    });

  if (
    target.kind === "blocked" ||
    target.kind === "done" ||
    target.kind === "approval" ||
    target.kind === "confirm"
  ) {
    // 응답을 소비하지 않는다. 붙여넣은 것이 있어도 지금 반영할 자리가 없다.
    session.turn -= 1;
    return {
      label,
      ...laneInfo,
      violations: [],
      parseErrors: [],
      questionsAdded: 0,
      advanced: false,
      message:
        target.kind === "blocked"
          ? target.reason
          : target.kind === "done"
            ? "이미 모든 단계가 끝났습니다."
            : target.kind === "confirm"
              ? confirmMessage(target.state, target.stage, context.outDir, lane)
              : approvalMessage(target.state, loadPlan(context.outDir), context.outDir, lane),
    };
  }

  // ---- 항목 추출 (1차 게이트) ----
  if (target.kind === "intake") {
    const schema = context.specSchema!;
    let parsed: ReturnType<typeof IntakeSchema.parse>;
    try {
      parsed = parseResponse(responseText, IntakeSchema);
    } catch (error) {
      return malformed(error);
    }
    saveSlots(context.outDir, {
      specHash: hashSpec(context.specText),
      slots: parsed.slots,
    });

    // 무엇이 비었는지는 **코드가** 판정한다. 모델이 질문을 떠올렸는지와 무관하다.
    const answered = answeredSlotKeys(readQuestions(context.outDir));
    const gaps = findGaps(schema, parsed.slots, context.workOrder.kind, answered);
    for (const gap of gaps) {
      appendQuestions(context.outDir, questionTargetFor(gap.key), [gap.question]);
    }

    session.lastObservations = [];
    session.lastViolations = [];

    return finish({
      label,
      ...laneInfo,
      violations: [],
      parseErrors: [],
      questionsAdded: gaps.length,
      advanced: gaps.length === 0,
      message:
        gaps.length > 0
          ? `스펙에서 근거를 찾지 못한 필수 항목 ${gaps.length}건을 질문으로 남겼습니다 ` +
            `(${gaps.map((gap) => gap.title).join(", ")}). 답을 채워야 계획으로 넘어갑니다.`
          : undefined,
    });
  }

  // ---- 계획 ----
  if (target.kind === "plan") {
    const format = planFormatFor(context.workOrder.kind);
    let plan: BuildPlan;
    try {
      plan = format.toPlan(parseResponse(responseText, format.schema));
    } catch (error) {
      return malformed(error);
    }

    // 보존 조건이 빠진 계획을 승인받는 것이 이 종류에서 가장 위험한 실패다. 저장하지 않는다 —
    // 저장하면 그대로 2차 게이트에 올라가고, 사람은 빠진 줄이 있다는 것을 알 길이 없다.
    const missing = format.requiresPreserve ? missingPreserve(context.workOrder, plan) : [];
    if (missing.length > 0) {
      session.lastObservations = [];
      return finish({
        label,
        ...laneInfo,
        violations: missing.map((item) => ({
          item: "보존 조건 누락",
          file: "(계획)",
          detail: `작업 지시서의 이 항목을 계획이 다루지 않았습니다: ${item}`,
        })),
        parseErrors: [],
        questionsAdded: 0,
        advanced: false,
        message:
          `보존 조건 ${missing.length}건이 계획에 없어 저장하지 않았습니다. ` +
          "같은 프롬프트로 계획을 다시 받으세요 — 문장을 그대로 옮겨야 합니다.",
      });
    }

    const planPath = savePlan(context.outDir, plan);
    const questions = appendQuestions(context.outDir, "plan", plan.openQuestions);
    session.lastObservations = [];
    session.lastViolations = [];

    return finish({
      label,
      ...laneInfo,
      planSaved: planPath,
      violations: [],
      parseErrors: [],
      questionsAdded: plan.openQuestions.length,
      advanced: true,
      message:
        questions.length > 0
          ? `미결 질문 ${plan.openQuestions.length}건을 남겼습니다. 답을 채워야 다음으로 넘어갑니다.`
          : undefined,
    });
  }

  // ---- 검수 ----
  if (target.kind === "gate") {
    let parsed: ReturnType<typeof GateSchema.parse>;
    try {
      parsed = parseResponse(responseText, GateSchema);
    } catch (error) {
      return malformed(error);
    }
    const attempts = (session.gateAttempts?.[target.stage.key] ?? 0) + 1;
    session.gateAttempts = { ...session.gateAttempts, [target.stage.key]: attempts };
    session.lastObservations = [];

    if (parsed.violations.length === 0) {
      session.gatedStages = [...session.gatedStages, target.stage.key];
      session.lastViolations = [];
      return finish({
        label,
        ...laneInfo,
        violations: [],
        parseErrors: [],
        questionsAdded: 0,
        advanced: true,
      });
    }

    session.lastViolations = parsed.violations;

    if (attempts >= MAX_GATE_ATTEMPTS) {
      // 여기서 더 돌려도 같은 곳에서 막히는 경우가 많다. 덮지 말고 사람에게 넘긴다.
      session.gatedStages = [...session.gatedStages, target.stage.key];
      return finish({
        label,
        ...laneInfo,
        violations: parsed.violations,
        parseErrors: [],
        questionsAdded: 0,
        advanced: true,
        message:
          `${MAX_GATE_ATTEMPTS}회 시도했는데 위반이 남았습니다. 자동으로 덮지 않고 넘어갑니다 — ` +
          "위 목록을 보고 직접 판단하세요.",
      });
    }

    // 위반을 안고 그 단계를 다시 돈다 — 다음 프롬프트에 위반 목록이 실린다.
    session.completedStages = session.completedStages.filter((key) => key !== target.stage.key);
    return finish({
      label,
      ...laneInfo,
      violations: parsed.violations,
      parseErrors: [],
      questionsAdded: 0,
      advanced: false,
      message: `위반 ${parsed.violations.length}건 — ${target.stage.key} 단계를 다시 돕니다.`,
    });
  }

  // ---- 생성 (액션) ----
  const parsed = parseActions(responseText);
  if (parsed.errors.length > 0) {
    // 형식이 깨진 응답도 턴으로 센다 — 사람이 실제로 한 번 왕복한 비용이고,
    // 그 빈도야말로 "자동으로 맡겨도 되나"의 답이 된다.
    return finish({
      label,
      ...laneInfo,
      violations: [],
      parseErrors: parsed.errors,
      questionsAdded: 0,
      advanced: false,
      message: "응답 형식이 어긋나 아무것도 반영하지 않았습니다.",
    });
  }

  const plan = loadPlan(context.outDir);
  const execution = await executeActions({
    repoRoot: context.repoRoot,
    outDir: context.outDir,
    order: context.workOrder,
    // 앞 턴들에서 확인해 둔 결과. 그 뒤로 파일이 바뀌었으면 이미 지워져 있다.
    verified: session.verified[target.stage.key],
    manifest,
    plan,
    stage: target.stage,
    actions: parsed.actions,
  });

  record.counts = execution.counts;
  record.written = execution.writtenFiles.length;
  record.observations = execution.observations.length;

  // 사람이 승인한 계획이 만들라고 한 것이 다 있는가. **끝났다고 할 때만 본다** —
  // 한 단계가 여러 턴에 걸쳐 도므로 중간 턴에 보면 매 턴 거짓 위반이 뜬다.
  //
  // 계획 밖 파일은 여기서 보지 않는다. 그쪽은 쓰기 전에 거부되므로(execute 의 경계 검사)
  // out/ 에 남지 않는다 — 남은 뒤에 알리면 모델이 되돌릴 수단이 없어 경고만 반복된다.
  const missing = execution.done
    ? missingPlannedFiles(
        plan,
        target.stage,
        loadStageFiles(context.outDir, plan, target.stage.key).map((file) => file.path),
      )
    : [];
  const violations = [...execution.violations, ...missing];

  session.lastObservations = execution.observations;
  session.lastViolations = violations;

  // 검증 결과는 그때의 파일들에 대한 것이다. 이 턴에서 확인한 것이 있으면 그것으로 갈고,
  // 확인 없이 파일만 바꿨으면 앞서 본 것을 버린다.
  if (
    execution.verified === "pass" ||
    execution.verified === "fail" ||
    execution.verified === "error"
  ) {
    session.verified = { ...session.verified, [target.stage.key]: execution.verified };
  } else if (execution.writtenFiles.length > 0) {
    const { [target.stage.key]: dropped, ...rest } = session.verified;
    session.verified = rest;
  }

  const questions = appendQuestions(context.outDir, target.stage.key, execution.questions);

  // 관찰 요청이 남아 있거나 위반이 있으면 아직 끝난 것이 아니다.
  const blockedByFollowUp = execution.observations.length > 0 || violations.length > 0;
  const advanced = execution.done && !blockedByFollowUp;

  if (advanced) {
    session.completedStages = [...session.completedStages, target.stage.key];
  }

  return finish({
    label,
    ...laneInfo,
    execution,
    violations,
    parseErrors: [],
    questionsAdded: execution.questions.length,
    advanced,
    message: advanced
      ? undefined
      : violations.length > 0
        ? "위반이 있어 이 단계를 이어서 돕니다."
        : execution.observations.length > 0
          ? "요청한 내용을 다음 프롬프트에 실어 이어서 돕니다."
          : questions.length > 0 && execution.questions.length > 0
            ? "질문이 남아 답을 기다립니다."
            : "아직 ### done 이 없어 이 단계를 이어서 돕니다.",
  });
}

/** 그 대상의 계획 파일이 있는지. 인자는 레인 디렉토리다 — 뿌리가 아니다. */
export function hasPlan(outDir: string): boolean {
  return existsSync(join(outDir, PLAN_FILE));
}
