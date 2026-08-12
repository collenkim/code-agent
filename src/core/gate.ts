import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { collectExemplars, domainDirOf, formatExemplars } from "./exemplar";
import type { Manifest, StageDef } from "./manifest";
import type {
  BuildPlan,
  GateResult,
  GateViolation,
  GeneratedFile,
  ResolvedBuildContext,
} from "./types";

export const GateSchema = z.object({
  violations: z.array(
    z.object({
      item: z.string().describe("위반한 체크리스트 항목 또는 컨벤션 규칙"),
      file: z.string().describe("해당 파일 경로"),
      detail: z.string().describe("무엇이 어떻게 어긋났는지 한국어로"),
    }),
  ),
});

const SYSTEM_PROMPT =
  "너는 생성된 코드의 검수자다. 아래 체크리스트와 참조 표준 코드를 기준으로 위반만 찾는다.\n" +
  "- 참조 표준 코드가 실제로 하고 있는 방식은 위반이 아니다. 문서와 달라도 마찬가지다.\n" +
  "- 취향·개선 제안은 위반이 아니다. 체크리스트 항목이나 명시된 컨벤션을 어긴 것만 적는다.\n" +
  "- 근거를 파일 내용에서 짚을 수 없으면 적지 않는다. 위반이 없으면 빈 배열을 반환한다.";

/**
 * 경로 규칙 검사 — 판단이 아니라 규칙 대조라서 모델에 맡기지 않는다.
 * 다른 계층 파일을 만들지 않는다는 do-not-touch 경계가 여기서 강제된다.
 */
export function checkPaths(
  manifest: Manifest,
  plan: BuildPlan,
  stage: StageDef,
  files: GeneratedFile[],
): GateViolation[] {
  const violations: GateViolation[] = [];
  const domainDir = domainDirOf(manifest, plan.domainRoot, plan.domainDirName, stage.base);

  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");

    if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("..")) {
      violations.push({ item: "경로 규칙", file: path, detail: "절대경로 또는 상위 경로 참조" });
      continue;
    }
    // outputDirs가 비면 위치를 제한하지 않는다 (문서 산출물 등).
    if (stage.outputDirs.length === 0) {
      continue;
    }
    // 프로젝트 범위 단계는 도메인 디렉토리가 아니라 저장소 루트를 기준으로 본다.
    if (stage.scope === "project") {
      const allowed = stage.outputDirs.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      if (!allowed) {
        violations.push({
          item: "do-not-touch 경계",
          file: path,
          detail: `${stage.key} 단계가 만들 수 있는 위치가 아님 (허용: ${stage.outputDirs.join(", ")})`,
        });
      }
      continue;
    }
    if (!path.startsWith(`${domainDir}/`)) {
      violations.push({
        item: "do-not-touch 경계",
        file: path,
        detail: `이번 도메인 디렉토리(${domainDir}) 밖의 파일`,
      });
      continue;
    }
    // 도메인 디렉토리 바로 아래 파일은 하위 디렉토리가 없어 "." 으로 본다
    const rest = path.slice(domainDir.length + 1);
    const layer = rest.includes("/") ? rest.split("/")[0] : ".";
    if (!stage.outputDirs.includes(layer)) {
      violations.push({
        item: "do-not-touch 경계",
        file: path,
        detail: `${stage.key} 단계가 만들 수 있는 위치가 아님 (허용: ${stage.outputDirs.join(", ")})`,
      });
    }
  }

  return violations;
}

/** 계획에 적힌 파일과 실제 생성된 파일이 일치하는지 — 누락·추가 모두 잡는다. */
function checkPlanCoverage(
  plan: BuildPlan,
  stage: StageDef,
  files: GeneratedFile[],
): GateViolation[] {
  const planned = new Set(
    plan.files.filter((file) => file.stage === stage.key).map((file) => file.path),
  );
  const generated = new Set(files.map((file) => file.path.replace(/\\/g, "/")));

  const violations: GateViolation[] = [];
  for (const path of planned) {
    if (!generated.has(path)) {
      violations.push({ item: "계획 준수", file: path, detail: "계획에 있는데 생성되지 않음" });
    }
  }
  for (const path of generated) {
    if (!planned.has(path)) {
      violations.push({ item: "계획 준수", file: path, detail: "계획에 없는 파일이 생성됨" });
    }
  }
  return violations;
}

function readChecklist(templatesDir: string, stage: StageDef): string {
  const path = join(templatesDir, stage.template);
  if (!existsSync(path)) {
    return "(템플릿 없음 — 컨벤션 문서만 기준으로 검사)";
  }
  return readFileSync(path, "utf-8");
}

/**
 * 코드만으로 할 수 있는 검사. API가 없어도 돌아가므로 수동 모드에서도 그대로 쓴다.
 * 경로가 규칙에 맞는지, 계획대로 만들었는지는 전부 비교 연산이라 모델에 맡길 이유가 없다.
 */
export function runCodeChecks(
  manifest: Manifest,
  plan: BuildPlan,
  stage: StageDef,
  files: GeneratedFile[],
): GateViolation[] {
  return [...checkPaths(manifest, plan, stage, files), ...checkPlanCoverage(plan, stage, files)];
}

/** 검수 프롬프트 한 벌. 수동 모드에서 그대로 뽑아 쓸 수 있게 분리해 둔다. */
export function buildGatePrompt(
  context: ResolvedBuildContext,
  manifest: Manifest,
  stage: StageDef,
  files: GeneratedFile[],
): { system: string; user: string } {
  const { files: exemplars } = collectExemplars(
    context.repoRoot,
    manifest,
    context.referenceDomain,
    stage,
  );
  const generated = files
    .map((file) => `## ${file.path}\n\`\`\`${manifest.language ?? ""}\n${file.content}\n\`\`\``)
    .join("\n\n");

  return {
    system: SYSTEM_PROMPT,
    user:
      `# 단계 템플릿 (체크리스트 포함)\n${readChecklist(context.templatesDir, stage)}\n\n` +
      `# 코드 컨벤션 문서\n${context.conventionsText}\n\n` +
      `# 참조 표준 코드\n${formatExemplars(exemplars, manifest.language)}\n\n` +
      `# 검수 대상 — ${stage.title}\n${generated}`,
  };
}

const client = new Anthropic();

/**
 * 한 단계의 산출물을 검수한다.
 * 규칙 대조(경로·계획 준수)는 코드가, 문맥 판단(컨벤션 준수)은 모델이 맡는다.
 */
export async function runGate(
  context: ResolvedBuildContext,
  manifest: Manifest,
  plan: BuildPlan,
  stage: StageDef,
  files: GeneratedFile[],
): Promise<GateResult> {
  const deterministic = runCodeChecks(manifest, plan, stage, files);

  if (files.length === 0) {
    return { passed: deterministic.length === 0, violations: deterministic };
  }

  const { system, user } = buildGatePrompt(context, manifest, stage, files);

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(GateSchema) },
  });

  const violations = [...deterministic, ...(response.parsed_output?.violations ?? [])];
  return { passed: violations.length === 0, violations };
}
