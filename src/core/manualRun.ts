import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { listReferenceTree } from "./exemplar";
import { buildStagePrompt, FilesSchema } from "./generate";
import { buildGatePrompt, GateSchema, runCodeChecks } from "./gate";
import { selectStages } from "./manifest";
import {
  FILES_SHAPE,
  GATE_SHAPE,
  parseResponse,
  PLAN_SHAPE,
  withOutputFormat,
} from "./manual";
import { PlanSchema, previewPlanPrompt } from "./plan";
import { withResolvedInputs } from "./run";
import { loadSession, saveSession } from "./session";
import { loadPlan, loadPreviousResults, loadStageFiles, savePlan } from "./state";
import type { BuildContext, GateViolation, GeneratedFile } from "./types";

/** 수동 모드에서 뽑을 수 있는 프롬프트 종류 */
export type PromptTarget = { kind: "plan" } | { kind: "stage"; key: string } | { kind: "gate"; key: string };

export function parsePromptTarget(value: string): PromptTarget {
  if (value === "plan") {
    return { kind: "plan" };
  }
  if (value.startsWith("gate:")) {
    return { kind: "gate", key: value.slice("gate:".length) };
  }
  return { kind: "stage", key: value };
}

/**
 * 붙여넣기용 프롬프트 한 덩어리를 만든다.
 *
 * API는 system을 별도 필드로 보내지만 채팅창에는 그런 필드가 없어 한 덩어리로 합친다.
 * 지시 준수 강도가 미묘하게 달라질 수 있으니, system 부분임을 표시해 둔다.
 */
function joinForChat(system: string, user: string, shape: string): string {
  return withOutputFormat(`# 역할·규칙\n${system}\n\n---\n\n${user}`, shape);
}

/**
 * 스펙 경로를 세션이 기억하게 한다.
 *
 * 작업 지시서는 스펙 문서의 머리말에 있으므로, 0차 게이트가 생긴 뒤로는 명령마다 그 경로가
 * 필요해졌다. 상태가 이끄는 모드는 이미 세션이 기억해 주는데 이 경로만 아니어서, 예전 방식만
 * 매번 --spec 을 다시 쓰게 되는 차이가 생겼다.
 *
 * **기억하는 것은 경로뿐이다.** 지시서를 요구하는 것도, 그 내용을 매번 다시 읽어 검사하는 것도
 * 그대로다 — 게이트를 무르게 하지 않으면서 없앨 수 있는 차이만 없앤다.
 */
function withRememberedSpec(input: BuildContext): BuildContext {
  const session = loadSession(input.outDir);

  if (input.specPaths.length === 0) {
    return { ...input, specPaths: session.specPaths };
  }
  if (input.specPaths.join("\n") !== session.specPaths.join("\n")) {
    saveSession(input.outDir, { ...session, specPaths: input.specPaths });
  }
  return input;
}

export function emitPrompt(input: BuildContext, target: PromptTarget): string {
  const { context, manifest } = withResolvedInputs(withRememberedSpec(input));
  const stages = selectStages(manifest);

  if (target.kind === "plan") {
    const referenceTree = listReferenceTree(
      context.repoRoot,
      manifest,
      context.referenceDomain,
      stages,
    );
    const preview = previewPlanPrompt(context, manifest, stages, referenceTree);
    return joinForChat(preview.system, preview.user, PLAN_SHAPE);
  }

  const stage = stages.find((candidate) => candidate.key === target.key);
  if (!stage) {
    throw new Error(
      `알 수 없는 단계: ${target.key} (선언된 단계: ${stages.map((s) => s.key).join(", ")})`,
    );
  }

  const plan = loadPlan(context.outDir);

  if (target.kind === "gate") {
    // 검수 대상은 '앞 단계'가 아니라 그 단계 자신의 산출물이다.
    const files = loadStageFiles(context.outDir, plan, stage.key);
    if (files.length === 0) {
      throw new Error(
        `${stage.key} 단계의 산출물이 ${context.outDir} 에 없습니다. 먼저 생성을 반영하세요.`,
      );
    }
    const { system, user } = buildGatePrompt(context, manifest, stage, files);
    return joinForChat(system, user, GATE_SHAPE);
  }

  const previous = loadPreviousResults(context.outDir, plan, stages, stage.key);
  const { system, user } = buildStagePrompt(context, manifest, plan, stage, previous);
  return joinForChat(system, user, FILES_SHAPE);
}

export interface IngestResult {
  target: PromptTarget;
  writtenFiles: string[];
  violations: GateViolation[];
  planPath?: string;
}

/** 채팅 응답을 받아 계획을 저장하거나 파일을 만든다. */
export function ingestResponse(
  input: BuildContext,
  target: PromptTarget,
  responsePath: string,
): IngestResult {
  const { context, manifest } = withResolvedInputs(withRememberedSpec(input));
  const stages = selectStages(manifest);
  const text = readFileSync(responsePath, "utf-8");

  if (target.kind === "plan") {
    const plan = parseResponse(text, PlanSchema);
    return { target, writtenFiles: [], violations: [], planPath: savePlan(context.outDir, plan) };
  }

  const stage = stages.find((candidate) => candidate.key === target.key);
  if (!stage) {
    throw new Error(
      `알 수 없는 단계: ${target.key} (선언된 단계: ${stages.map((s) => s.key).join(", ")})`,
    );
  }

  const plan = loadPlan(context.outDir);

  if (target.kind === "gate") {
    // 검수 응답은 파일을 만들지 않는다 — 위반 목록만 돌려준다.
    const parsed = parseResponse(text, GateSchema);
    return { target, writtenFiles: [], violations: parsed.violations };
  }

  const parsed = parseResponse(text, FilesSchema);
  const files: GeneratedFile[] = parsed.files;

  // 코드로 할 수 있는 검사는 파일을 쓰기 전에 돌린다 — 경계를 벗어난 파일은 애초에 만들지 않는다.
  const violations = runCodeChecks(manifest, plan, stage, files);
  const blocking = violations.filter((violation) => violation.item !== "계획 준수");
  if (blocking.length > 0) {
    throw new Error(
      "경로 규칙을 어긴 파일이 있어 반영하지 않았습니다:\n" +
        blocking.map((v) => `  - [${v.item}] ${v.file}: ${v.detail}`).join("\n"),
    );
  }

  const writtenFiles = files.map((file) => {
    const targetPath = join(context.outDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, file.content, "utf-8");
    return targetPath;
  });

  return { target, writtenFiles, violations };
}
