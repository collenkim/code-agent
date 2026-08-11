import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { collectExemplars, formatExemplars, listReferenceTree } from "./exemplar";
import type { Manifest, StageDef } from "./manifest";
import { withPolicy } from "./policy";
import type {
  ResolvedBuildContext,
  BuildPlan,
  GateViolation,
  GeneratedFile,
  PromptPreview,
  StageResult,
} from "./types";

/** 앞 단계 산출물을 프롬프트에 다시 넣을 때의 파일당 상한 */
const MAX_PREVIOUS_LINES = 300;

export const FilesSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("저장소 루트 기준 상대경로"),
      content: z.string().describe("파일 전체 내용 (부분 발췌·생략 표시 금지)"),
      note: z
        .string()
        .optional()
        .describe("참조 표준에 없어 판단이 필요했던 지점. 없으면 생략"),
    }),
  ),
});

function buildSystemPrompt(manifest: Manifest, stage: StageDef): string {
  const language = manifest.language ? `${manifest.language} ` : "";

  return (
    `너는 ${language}코드 생성기다. 이번 실행에서 만들 것은 **${stage.title}** 뿐이다.\n` +
    "규칙:\n" +
    "1. 참조 표준 코드와 동일한 구조·네이밍·주석 밀도로 쓴다. " +
    "참조 표준에 없는 패턴(새 라이브러리·새 계층·새 유틸)을 발명하지 않는다.\n" +
    "2. 이 언어·프레임워크의 일반적인 관행을 네가 알고 있다는 이유로 적용하지 않는다. " +
    "주어진 참조 표준 코드와 컨벤션 문서에서 읽히는 것만 따른다.\n" +
    "3. 컨벤션 문서와 참조 표준 코드가 충돌하면 **참조 표준 코드를 따르고** note에 그 사실을 적는다. " +
    "문서는 코드보다 뒤처져 있을 수 있다.\n" +
    "4. 이 단계의 산출물 외 다른 계층 파일은 만들지 않는다. 필요해 보여도 만들지 않고 note에만 적는다.\n" +
    "5. 계획에 적힌 파일만 만든다. 파일을 추가하거나 빠뜨리지 않는다.\n" +
    "6. 스펙에 없는 필드·API·정책을 지어내지 않는다. 모르는 값은 note에 적는다.\n" +
    "7. content는 그대로 저장해 빌드할 파일 전체다. `...` 같은 생략 표시를 쓰지 않는다."
  );
}

function readTemplate(templatesDir: string, stage: StageDef): string {
  const path = join(templatesDir, stage.template);
  if (!existsSync(path)) {
    return `(템플릿 파일 없음: ${stage.template} — 참조 표준 코드와 컨벤션 문서만으로 생성)`;
  }
  return readFileSync(path, "utf-8");
}

function formatPrevious(previous: StageResult[]): string {
  const files = previous.flatMap((result) => result.files);
  if (files.length === 0) {
    return "(없음 — 이 단계가 첫 단계)";
  }

  return files
    .map((file) => {
      const lines = file.content.split("\n");
      const capped = lines.length > MAX_PREVIOUS_LINES;
      const body = capped ? lines.slice(0, MAX_PREVIOUS_LINES).join("\n") : file.content;
      const header = capped
        ? `## ${file.path} (총 ${lines.length}줄 중 앞 ${MAX_PREVIOUS_LINES}줄)`
        : `## ${file.path}`;
      return `${header}\n\`\`\`\n${body}\n\`\`\``;
    })
    .join("\n\n");
}

function formatViolations(violations: GateViolation[]): string {
  if (violations.length === 0) {
    return "";
  }
  return (
    "\n\n# 직전 생성물의 자가검증 위반 — 이번에는 반드시 고친다\n" +
    violations
      .map((violation) => `- [${violation.item}] ${violation.file}: ${violation.detail}`)
      .join("\n")
  );
}

export function buildStagePrompt(
  context: ResolvedBuildContext,
  manifest: Manifest,
  plan: BuildPlan,
  stage: StageDef,
  previous: StageResult[],
  violations: GateViolation[] = [],
): { system: string; user: string; missingExemplars: string[] } {
  const { files: exemplars, missing } = collectExemplars(
    context.repoRoot,
    manifest,
    context.referenceDomain,
    stage,
  );
  const plannedFiles = plan.files.filter((file) => file.stage === stage.key);

  // 참조 도메인의 파일 목록(경로만)은 어느 단계에나 쓸모가 있다 — 무엇이 이미 있는지 알아야
  // 없는 것을 지어내지 않는다. 레거시 도입의 구조 조사 단계는 이것만으로 돌아간다.
  const referenceTree = listReferenceTree(
    context.repoRoot,
    manifest,
    context.referenceDomain,
    manifest.stages,
  );
  const treeSection =
    referenceTree.length > 0
      ? `# 참조 도메인 '${context.referenceDomain}'의 전체 파일 목록\n${referenceTree.join("\n")}\n\n`
      : "";

  const user = withPolicy(
    `# 이번 단계에서 만들 파일 (계획 확정분)\n` +
      (plannedFiles.length > 0
        ? plannedFiles.map((file) => `- ${file.path} — ${file.purpose}`).join("\n")
        : "(계획에 이 단계 파일이 없음 — 아무것도 만들지 말고 빈 배열을 반환한다)") +
      `\n\n# 단계 템플릿 (${stage.template})\n${readTemplate(context.templatesDir, stage)}\n\n` +
      treeSection +
      (exemplars.length > 0
        ? `# 참조 표준 코드 — 도메인 '${context.referenceDomain}'\n` +
          `${formatExemplars(exemplars, manifest.language)}\n\n`
        : "") +
      `# 스펙\n${context.specText}\n\n` +
      `# 코드 컨벤션 문서\n${context.conventionsText}\n\n` +
      `# 앞 단계에서 이미 만든 파일\n${formatPrevious(previous)}` +
      formatViolations(violations),
    context.policyText,
  );

  return { system: buildSystemPrompt(manifest, stage), user, missingExemplars: missing };
}

export function previewStagePrompt(
  context: ResolvedBuildContext,
  manifest: Manifest,
  plan: BuildPlan,
  stage: StageDef,
  previous: StageResult[],
): PromptPreview {
  const { system, user, missingExemplars } = buildStagePrompt(
    context,
    manifest,
    plan,
    stage,
    previous,
  );
  const isFirst = previous.length === 0;

  return {
    stage: stage.key,
    reproducible: isFirst,
    note: [
      isFirst ? undefined : "앞 단계 산출물이 아직 없어 그 자리는 비어 있음 — 실제 실행과 다름",
      missingExemplars.length > 0
        ? `참조 표준 파일 없음: ${missingExemplars.join(", ")}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" / "),
    system,
    user,
  };
}

const client = new Anthropic();

export async function generateStage(
  context: ResolvedBuildContext,
  manifest: Manifest,
  plan: BuildPlan,
  stage: StageDef,
  previous: StageResult[],
  violations: GateViolation[] = [],
): Promise<GeneratedFile[]> {
  const { system, user } = buildStagePrompt(context, manifest, plan, stage, previous, violations);

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 32000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(FilesSchema) },
  });

  return response.parsed_output?.files ?? [];
}
