import { readFileSync } from "fs";

import { verifyByBuild } from "./build";
import { resolveAgainstRepo, resolveConventions } from "./conventions";
import { emitFiles } from "./emit";
import { generateStage } from "./generate";
import { runGate } from "./gate";
import { loadManifest, selectStages } from "./manifest";
import type { Manifest } from "./manifest";
import { planBuild } from "./plan";
import { describeSlots, hashSpec, loadSlots, loadSpecSchema } from "./specSchema";
import { loadWorkOrder } from "./workOrder";
import type {
  BuildContext,
  BuildOutcome,
  GateViolation,
  ResolvedBuildContext,
  StageResult,
} from "./types";

/** 여러 문서를 출처 주석과 함께 한 덩어리로 합친다. */
function concatDocuments(paths: string[], emptyLabel = "(없음)"): string {
  if (paths.length === 0) {
    return emptyLabel;
  }
  return paths.map((path) => `<!-- ${path} -->\n${readFileSync(path, "utf-8")}`).join("\n\n");
}

/**
 * 프로젝트 설정을 읽고, 파일에서 읽어야 하는 입력(스펙·컨벤션·정책)을 모두 채운다.
 * 프로젝트별 값(도메인 경로·계층·참조 도메인·검증 명령)은 전부 여기서 매니페스트를 통해 들어온다.
 */
export function withResolvedInputs(context: BuildContext): {
  context: ResolvedBuildContext;
  manifest: Manifest;
} {
  const templatesDir = resolveAgainstRepo(context.repoRoot, context.templatesDir);
  const manifest = loadManifest(templatesDir);

  const conventions = resolveConventions(
    context.repoRoot,
    manifest.conventions,
    context.conventionsPaths,
  );
  const policyPath = context.policyPath
    ? resolveAgainstRepo(context.repoRoot, context.policyPath)
    : undefined;

  // 0차 게이트. 이 줄보다 앞에서 프롬프트가 만들어지는 경로는 없다 —
  // 지시서가 규격에 맞지 않으면 모델에 한 글자도 가지 않는다.
  const workOrder = loadWorkOrder(context.repoRoot, context.specPaths, manifest.workOrder);

  // 1차 게이트가 쓸 것들. 파생물은 스펙 해시에 묶여 있어, 문서가 바뀌면 여기서 무효가 된다.
  const specText = concatDocuments(context.specPaths);
  const specSchema = loadSpecSchema(templatesDir);
  const slots = specSchema ? loadSlots(context.outDir) : undefined;
  const fresh = slots !== undefined && slots.specHash === hashSpec(specText);
  const slotsText = specSchema && slots && fresh ? describeSlots(specSchema, slots.slots) : "";

  // 참조 도메인은 복제할 코드가 있을 때만 필요하다. 신규 프로젝트 구성처럼 참조할 파일을
  // 선언하지 않은 단계만 있는 실행에서는 없어도 된다.
  const referenceDomain = context.referenceDomain ?? manifest.referenceDomain ?? "";
  const needsReference = manifest.stages.some((stage) => stage.exemplars.length > 0);
  if (needsReference && !referenceDomain) {
    throw new Error(
      "참조 표준 도메인이 없습니다. code-agent.json 의 referenceDomain 에 선언하거나 " +
        "--reference 로 지정하세요.",
    );
  }

  return {
    manifest,
    context: {
      ...context,
      templatesDir,
      policyPath,
      workOrder,
      specSchema,
      intakeNeeded: specSchema !== undefined && !fresh,
      slotsText,
      referenceDomain,
      specText,
      conventionsText: concatDocuments(
        conventions.paths,
        "(아직 없음 — 이 실행이 만들어 낼 대상이다. 기존 규칙이 있다고 가정하지 않는다.)",
      ),
      conventionsSource: conventions.source,
      policyText: policyPath ? readFileSync(policyPath, "utf-8") : undefined,
    },
  };
}

export async function runBuild(input: BuildContext): Promise<BuildOutcome> {
  const { context, manifest } = withResolvedInputs(input);
  const stages = selectStages(manifest, context.onlyStages);
  const conventionsSource = context.conventionsSource!;

  const plan = await planBuild(context, manifest, stages);

  if (context.planOnly) {
    return { plan, stages: [], conventionsSource };
  }

  // 미결 질문이 남아 있으면 생성하지 않는다 — 추측으로 채운 코드가 나오는 것보다 멈추는 게 낫다.
  // 우회 옵션은 두지 않는다. 예외를 하나 두면 그 자리가 통제의 우회로가 된다.
  if (plan.openQuestions.length > 0) {
    return { plan, stages: [], conventionsSource };
  }

  const results: StageResult[] = [];

  for (const stage of stages) {
    let violations: GateViolation[] = [];
    let result: StageResult | undefined;

    for (let attempt = 1; attempt <= context.maxRetries + 1; attempt += 1) {
      const files = await generateStage(context, manifest, plan, stage, results, violations);
      result = { stage: stage.key, files, attempts: attempt };

      if (context.gate === false) {
        break;
      }

      const gate = await runGate(context, manifest, plan, stage, files);
      result.gate = gate;
      if (gate.passed) {
        break;
      }
      // 다음 시도에 위반 내용을 그대로 넘겨 같은 실수를 반복하지 않게 한다.
      violations = gate.violations;
    }

    results.push(result!);
  }

  emitFiles(context.outDir, results);

  const build = context.build
    ? verifyByBuild(context.repoRoot, manifest, context.outDir, results, "build")
    : undefined;

  // 테스트 실패는 재생성으로 되돌리지 않는다. 통과시키려고 단언을 지우는 것이 전형적인 실패
  // 모드라, 테스트가 틀렸는지 코드가 틀렸는지의 판단은 사람에게 남긴다.
  const test = context.test
    ? verifyByBuild(context.repoRoot, manifest, context.outDir, results, "test")
    : undefined;

  return { plan, stages: results, build, test, conventionsSource };
}

export type { BuildContext, BuildOutcome, BuildPlan, StageResult } from "./types";
