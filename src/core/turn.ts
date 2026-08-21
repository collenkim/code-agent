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
import { executeActions } from "./execute";
import type { ExecuteOutcome } from "./execute";
import { parseActions } from "./fence";
import { buildStagePrompt } from "./generate";
import { buildGatePrompt, GateSchema } from "./gate";
import { GATE_SHAPE, parseResponse, PLAN_SHAPE, withOutputFormat } from "./manual";
import { PlanSchema, previewPlanPrompt } from "./plan";
import { withResolvedInputs } from "./run";
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
import {
  appendQuestions,
  decideTarget,
  describeTarget,
  loadSession,
  readQuestions,
  saveSession,
} from "./session";
import type { Session, Target } from "./session";
import { listReferenceTree } from "./exemplar";
import { loadPlan, loadPreviousResults, loadStageFiles, PLAN_FILE, savePlan } from "./state";
import type { BuildContext, GateViolation } from "./types";

/** 게이트를 몇 번까지 다시 돌릴지. 넘으면 사람에게 넘긴다 — 무한 반복이 더 나쁘다. */
const MAX_GATE_ATTEMPTS = 2;

/**
 * 최초 한 번 준 스펙을 세션이 기억한다.
 * 새 프로젝트를 시작할 때만 필요하고, 이후 단계에서는 다시 주지 않아도 된다.
 */
export function withSessionSpec(input: BuildContext, session: Session): BuildContext {
  if (input.specPaths.length > 0) {
    return input;
  }
  return { ...input, specPaths: session.specPaths };
}

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

export interface NextPrompt {
  target: Target;
  label: string;
  prompt?: string;
  /** blocked·done 이면 프롬프트 대신 사람에게 할 말 */
  message?: string;
}

/**
 * 지금 붙여넣을 프롬프트 하나를 만든다. 진행 상태를 바꾸지 않으므로 몇 번 실행해도 같다.
 * 스펙 경로만은 받은 자리에서 기억해 둔다 — 사람이 매번 --spec 을 다시 쓰지 않게 하려는 것이다.
 */
export function nextPrompt(input: BuildContext): NextPrompt {
  const session = loadSession(input.outDir);

  if (input.specPaths.length > 0 && input.specPaths.join("\n") !== session.specPaths.join("\n")) {
    saveSession(input.outDir, { ...session, specPaths: input.specPaths });
    session.specPaths = input.specPaths;
  }

  const { context, manifest } = withResolvedInputs(withSessionSpec(input, session));
  const target = decideTarget(context.outDir, manifest, session, {
    gate: context.gate !== false,
    intakeNeeded: context.intakeNeeded,
  });
  const label = describeTarget(target);

  if (target.kind === "blocked") {
    return { target, label, message: target.reason };
  }
  if (target.kind === "done") {
    return {
      target,
      label,
      message:
        `모든 단계가 끝났습니다. 결과: ${context.outDir}\n` +
        "내용을 확인한 뒤 저장소에 복사하면 반영됩니다.",
    };
  }

  if (target.kind === "intake") {
    // specSchema 가 없으면 intake 가 대상이 될 수 없다 — decideTarget 이 그렇게 정한다.
    const { system, user } = buildIntakePrompt(
      context.specSchema!,
      context.workOrder.kind,
      describeWorkOrder(context.workOrder),
      context.specText,
    );
    return {
      target,
      label,
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
      target,
      label,
      prompt: withOutputFormat(
        // 사람이 답한 것은 계획에도 실려야 한다 — 1차 게이트의 질문이 계획 이전에 걸리므로,
        // 여기서 빠지면 사람이 답한 내용을 계획이 모르는 채로 세워진다.
        joinForChat(preview.system, preview.user + answerSection(context.outDir), "").trimEnd(),
        PLAN_SHAPE,
      ),
    };
  }

  const plan = loadPlan(context.outDir);

  if (target.kind === "gate") {
    const files = loadStageFiles(context.outDir, plan, target.stage.key);
    if (files.length === 0) {
      // 아무것도 안 만든 단계는 검수할 것이 없다.
      return { target, label, message: `${target.stage.key} 단계의 산출물이 없어 검수를 건너뜁니다.` };
    }
    const { system, user } = buildGatePrompt(context, manifest, target.stage, files);
    return { target, label, prompt: withOutputFormat(joinForChat(system, user, "").trimEnd(), GATE_SHAPE) };
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
    target,
    label,
    prompt: joinForChat(
      system,
      user + observationSection(session) + answerSection(context.outDir),
      ACTION_FORMAT,
    ),
  };
}

export interface ApplyOutcome {
  label: string;
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
  const session = loadSession(input.outDir);
  const { context, manifest } = withResolvedInputs(withSessionSpec(input, session));

  if (input.specPaths.length > 0) {
    session.specPaths = input.specPaths;
  }

  const target = decideTarget(context.outDir, manifest, session, {
    gate: context.gate !== false,
    intakeNeeded: context.intakeNeeded,
  });
  const label = describeTarget(target);
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

  const finish = (outcome: ApplyOutcome): ApplyOutcome => {
    record.violations = outcome.violations.length;
    record.parseErrors = outcome.parseErrors.length;
    session.log.push(record);
    saveSession(context.outDir, session);
    return outcome;
  };

  if (target.kind === "blocked" || target.kind === "done") {
    session.turn -= 1;
    return {
      label,
      violations: [],
      parseErrors: [],
      questionsAdded: 0,
      advanced: false,
      message: target.kind === "blocked" ? target.reason : "이미 모든 단계가 끝났습니다.",
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
    const plan = parseResponse(responseText, PlanSchema);
    const planPath = savePlan(context.outDir, plan);
    const questions = appendQuestions(context.outDir, "plan", plan.openQuestions);
    session.lastObservations = [];
    session.lastViolations = [];

    return finish({
      label,
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

  const questions = appendQuestions(context.outDir, target.stage.key, execution.questions);

  // 관찰 요청이 남아 있거나 위반이 있으면 아직 끝난 것이 아니다.
  const blockedByFollowUp = execution.observations.length > 0 || execution.violations.length > 0;
  const advanced = execution.done && !blockedByFollowUp;

  if (advanced) {
    session.completedStages = [...session.completedStages, target.stage.key];
  }

  return finish({
    label,
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

/**
 * 계획 파일이 있는지.
 * 스펙은 계획을 세울 때만 있으면 되므로, 이후 실행에서 --spec 을 요구할지 판단하는 데 쓴다.
 */
export function hasPlan(outDir: string): boolean {
  return existsSync(join(outDir, PLAN_FILE));
}
