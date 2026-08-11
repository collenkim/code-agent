import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { listReferenceTree } from "./exemplar";
import type { Manifest, StageDef } from "./manifest";
import { withPolicy } from "./policy";
import type { BuildPlan, PromptPreview, ResolvedBuildContext } from "./types";

const PlanSchema = z.object({
  domainName: z.string().describe("프로젝트의 명명 규칙을 따른 도메인 이름"),
  domainLabel: z.string().describe("사람이 읽는 이름"),
  domainRoot: z
    .string()
    .describe("아래 '도메인 분류' 중 하나를 그대로. 분류가 제시되지 않았으면 빈 문자열"),
  domainDirName: z
    .string()
    .describe("실제로 만들 디렉토리 이름 — 참조 표준 도메인의 디렉토리 표기 규칙을 그대로 따른다"),
  files: z
    .array(
      z.object({
        stage: z.string().describe("이 파일을 만들 단계 키"),
        path: z.string().describe("저장소 루트 기준 상대경로"),
        purpose: z.string().describe("이 파일이 담당하는 것 한 줄"),
      }),
    )
    .describe("생성할 파일 목록 — 참조 표준 도메인의 파일 구조를 그대로 따른다"),
  conventions: z
    .array(
      z.object({
        rule: z.string().describe("이번 생성에 적용할 규칙"),
        source: z.string().describe("근거 — 컨벤션 문서의 위치 또는 참조 표준 파일 경로"),
      }),
    )
    .describe("스펙에 비추어 실제로 걸리는 규칙만. 일반론 나열 금지"),
  conflicts: z
    .array(
      z.object({
        topic: z.string(),
        docSays: z.string().describe("컨벤션 문서가 말하는 것"),
        codeSays: z.string().describe("참조 표준 코드가 실제로 하는 것"),
        decision: z.string().describe("어느 쪽을 따를지와 그 이유"),
      }),
    )
    .describe("컨벤션 문서와 참조 표준 코드가 어긋나는 지점. 없으면 빈 배열"),
  openQuestions: z
    .array(z.string())
    .describe("스펙만으로 정할 수 없어 사람이 답해야 하는 것. 없으면 빈 배열"),
  reasoning: z.string().describe("도메인 위치·파일 구성을 그렇게 정한 이유를 한국어로 간단히"),
});

const SYSTEM_PROMPT =
  "너는 코드 생성 파이프라인의 플래너다. 스펙을 읽고 '무엇을 어떤 컨벤션으로 만들지'를 정리한 작업 명세서만 만든다. " +
  "코드는 만들지 않는다.\n" +
  "가장 중요한 규칙: **참조 표준 도메인의 파일 구조가 정본이다.** 만들 파일 목록은 참조 표준 도메인의 " +
  "디렉토리 구성과 파일 이름 규칙을 그대로 따르고, 참조 표준에 없는 파일을 새로 발명하지 않는다.\n" +
  "언어·프레임워크·계층 구조를 네가 알고 있는 관행으로 가정하지 않는다. 아래 주어진 참조 표준 코드와 " +
  "컨벤션 문서에서 읽히는 것만 근거로 삼는다.\n" +
  "컨벤션 문서가 참조 표준 코드와 다르게 말하면, 조용히 한쪽을 고르지 말고 conflicts에 남긴다. " +
  "문서는 코드보다 뒤처질 수 있으므로 기본 판단은 '참조 표준 코드를 따른다'이며, 그 판단도 decision에 적는다.\n" +
  "스펙에 없는 필드·API·정책을 지어내지 않는다. 정할 수 없는 것은 openQuestions에 적는다.";

function buildUserPrompt(
  context: ResolvedBuildContext,
  manifest: Manifest,
  stages: StageDef[],
  referenceTree: string[],
): string {
  const roots = manifest.domainRoots.filter(Boolean);

  return withPolicy(
    `# 스펙 (요구사항·정책·기능·입출력)\n${context.specText}\n\n` +
      `# 코드 컨벤션 문서\n${context.conventionsText}\n\n` +
      `# 프로젝트 구조\n` +
      `- 도메인 디렉토리 위치: ${manifest.domainBase}\n` +
      `- 도메인 분류: ${roots.length > 0 ? roots.join(", ") : "(없음 — domainRoot는 빈 문자열)"}\n` +
      (manifest.language ? `- 주 언어: ${manifest.language}\n` : "") +
      `\n# 참조 표준 도메인 '${context.referenceDomain}'의 파일 구조\n${referenceTree.join("\n")}\n\n` +
      `# 실행할 단계\n${stages.map((stage) => `- ${stage.key}: ${stage.title}`).join("\n")}\n\n` +
      "files의 stage는 위 단계 키 중 하나여야 한다. 실행하지 않는 단계의 파일은 목록에 넣지 않는다.",
    context.policyText,
  );
}

export function previewPlanPrompt(
  context: ResolvedBuildContext,
  manifest: Manifest,
  stages: StageDef[],
  referenceTree: string[],
): PromptPreview {
  return {
    stage: "plan",
    reproducible: true,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(context, manifest, stages, referenceTree),
  };
}

const client = new Anthropic();

export async function planBuild(
  context: ResolvedBuildContext,
  manifest: Manifest,
  stages: StageDef[],
): Promise<BuildPlan> {
  const referenceTree = listReferenceTree(
    context.repoRoot,
    manifest,
    context.referenceDomain,
    stages,
  );

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: buildUserPrompt(context, manifest, stages, referenceTree) },
    ],
    output_config: { format: zodOutputFormat(PlanSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    // 계획이 없으면 이후 단계가 만들 파일을 특정할 수 없다 — 추측으로 진행하지 않는다.
    throw new Error("계획 응답을 파싱하지 못했습니다. 스펙을 줄이거나 다시 실행하세요.");
  }
  return parsed;
}

/** 계획을 사람이 읽을 형태로 출력한다. */
export function formatPlan(plan: BuildPlan): string {
  const location = [plan.domainRoot, plan.domainDirName].filter(Boolean).join("/");
  const lines = [
    `## 작업 명세서`,
    `도메인: ${plan.domainName} (${plan.domainLabel}) · 위치: ${location}`,
    "",
    `### 생성할 파일 (${plan.files.length}개)`,
    ...plan.files.map((file) => `- [${file.stage}] ${file.path} — ${file.purpose}`),
    "",
    `### 적용 규칙`,
    ...plan.conventions.map((rule) => `- ${rule.rule} (${rule.source})`),
  ];

  if (plan.conflicts.length > 0) {
    lines.push("", `### 문서 vs 참조 표준 코드 충돌 (${plan.conflicts.length}건)`);
    for (const conflict of plan.conflicts) {
      lines.push(
        `- ${conflict.topic}`,
        `  - 문서: ${conflict.docSays}`,
        `  - 코드: ${conflict.codeSays}`,
        `  - 판단: ${conflict.decision}`,
      );
    }
  }

  if (plan.openQuestions.length > 0) {
    lines.push("", `### 미결 질문 (${plan.openQuestions.length}건)`);
    lines.push(...plan.openQuestions.map((question) => `- ${question}`));
  }

  lines.push("", `### 판단 근거`, plan.reasoning);
  return lines.join("\n");
}
