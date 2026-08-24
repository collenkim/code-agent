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
import { checkApproval, formatDiff, hashPlan, recordDecision } from "./approval";
import type { ApprovalRecord, Decision, PendingApproval } from "./approval";
import { executeActions } from "./execute";
import type { ExecuteOutcome } from "./execute";
import { parseActions } from "./fence";
import { buildStagePrompt } from "./generate";
import { buildGatePrompt, GateSchema } from "./gate";
import { GATE_SHAPE, parseResponse, withOutputFormat } from "./manual";
import { formatPlan, missingPreserve, planFormatFor, previewPlanPrompt } from "./plan";
import { withResolvedInputs } from "./run";
import type { Lane, LaneState } from "./targets";
import { describeLanes, rememberDispatch, takeDispatch, withRememberedSpec } from "./targets";
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
  "  --target 은 승인을 기다리는 대상이 둘 이상일 때 필요합니다.",
].join("\n");

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
    return [head, "", formatPlan(plan), "", HOW_TO_DECIDE].join("\n");
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

export interface NextPrompt {
  target: Target;
  label: string;
  prompt?: string;
  /** blocked·done·approval 이면 프롬프트 대신 사람에게 할 말 */
  message?: string;
  /** 이 프롬프트가 어느 대상의 것인지 */
  lane: string;
  /** 그 대상의 계획·질문·생성물이 있는 곳 */
  outDir: string;
  /** 지시서의 대상 전부와 각자의 상태 */
  lanes: LaneState[];
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
    lane,
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

  // 여기서부터는 프롬프트를 실제로 내준다. 어느 대상의 것이었는지 적어 둔다 —
  // 그 사이 다른 대상이 풀려도 붙여넣은 응답이 엉뚱한 레인에 반영되지 않게.
  rememberDispatch(input.outDir, context.workOrder.id, lane);

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
  const { system, user } = buildStagePrompt(
    context,
    manifest,
    plan,
    target.stage,
    previous,
    session.lastViolations,
  );

  return {
    ...head,
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

  const waiting = lanes.filter((state) => state.step.kind === "approval");
  if (waiting.length === 0) {
    throw new Error("승인을 기다리는 대상이 없습니다. 계획이 선 뒤에 판정할 수 있습니다.");
  }
  if (waiting.length > 1) {
    throw new Error(
      `승인을 기다리는 대상이 ${waiting.length} 개입니다. --target 으로 고르세요: ` +
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
  given: { approver?: string; comment?: string; target?: string },
): ApprovalOutcome {
  const { context, lanes } = withResolvedInputs(withRememberedSpec(input));
  const lane = laneToDecide(lanes, given.target);
  const plan = loadPlan(lane.outDir);
  const state = checkApproval(context.repoRoot, context.workOrder, plan, lane.target);

  if (decision === "approved" && state.status === "approved") {
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

  return {
    unchanged: false,
    record: recordDecision(context.repoRoot, {
      order: context.workOrder,
      target: lane.target,
      plan,
      decision,
      approver,
      comment: given.comment,
    }),
  };
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

/** 채팅 응답을 읽어 실제로 반영한다. */
export function applyResponse(input: BuildContext, responseText: string): ApplyOutcome {
  const remembered = withRememberedSpec(input);
  // 프롬프트를 내준 대상에 반영한다. 그 사이 사람이 다른 대상의 질문에 답했다면 선택이
  // 달라지는데, 그러면 붙여넣은 응답이 엉뚱한 레인으로 들어간다.
  const dispatched = takeDispatch(remembered.outDir);
  const { context, manifest, lanes } = withResolvedInputs(remembered, dispatched);
  const session = loadSession(context.outDir);
  const lane = context.target;
  const target = stepOf(lanes, lane);
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

  if (target.kind === "blocked" || target.kind === "done" || target.kind === "approval") {
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
            : approvalMessage(target.state, loadPlan(context.outDir), context.outDir, lane),
    };
  }

  // ---- 항목 추출 (1차 게이트) ----
  if (target.kind === "intake") {
    const schema = context.specSchema!;
    const parsed = parseResponse(responseText, IntakeSchema);
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
    const plan = format.toPlan(parseResponse(responseText, format.schema));

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
    const parsed = parseResponse(responseText, GateSchema);
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
  const execution = executeActions({
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

  session.lastObservations = execution.observations;
  session.lastViolations = execution.violations;

  // 검증 결과는 그때의 파일들에 대한 것이다. 이 턴에서 확인한 것이 있으면 그것으로 갈고,
  // 확인 없이 파일만 바꿨으면 앞서 본 것을 버린다.
  if (execution.verified === "pass" || execution.verified === "fail") {
    session.verified = { ...session.verified, [target.stage.key]: execution.verified };
  } else if (execution.writtenFiles.length > 0) {
    const { [target.stage.key]: dropped, ...rest } = session.verified;
    session.verified = rest;
  }

  const questions = appendQuestions(context.outDir, target.stage.key, execution.questions);

  // 관찰 요청이 남아 있거나 위반이 있으면 아직 끝난 것이 아니다.
  const blockedByFollowUp = execution.observations.length > 0 || execution.violations.length > 0;
  const advanced = execution.done && !blockedByFollowUp;

  if (advanced) {
    session.completedStages = [...session.completedStages, target.stage.key];
  }

  return finish({
    label,
    ...laneInfo,
    execution,
    violations: execution.violations,
    parseErrors: [],
    questionsAdded: execution.questions.length,
    advanced,
    message: advanced
      ? undefined
      : execution.violations.length > 0
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
