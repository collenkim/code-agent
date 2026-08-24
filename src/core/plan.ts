import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { listPaths, listReferenceTree } from "./exemplar";
import type { Manifest, StageDef } from "./manifest";
import { withPolicy } from "./policy";
import { describeWorkOrder } from "./workOrder";
import type { WorkKind, WorkOrder } from "./workOrder";
import type { BuildPlan, PromptPreview, ResolvedBuildContext } from "./types";

/** 종류가 무엇이든 계획에 들어가는 것 */
const COMMON_PLAN_FIELDS = {
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
  reasoning: z.string().describe("그렇게 정한 이유를 한국어로 간단히"),
};

export const PlanSchema = z.object({
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
  ...COMMON_PLAN_FIELDS,
});

/**
 * 고칠 파일과 보존 조건 — refactor 의 계획.
 *
 * feature 의 계획은 *만들 파일 목록*이지만 refactor 에는 만들 도메인이 없다.
 * 여기서 요구하는 것은 **무엇을 고치는가**와 **무엇을 지키는가** 둘이고,
 * 뒤쪽이 이 작업의 본체다.
 */
export const RefactorPlanSchema = z.object({
  files: z
    .array(
      z.object({
        stage: z.string().describe("이 파일을 만들거나 고칠 단계 키"),
        path: z.string().describe("저장소 루트 기준 상대경로"),
        purpose: z.string().describe("무엇을 어떻게 하는지 한 줄"),
      }),
    )
    .describe("고칠 파일 목록. 재현 테스트를 빼면 새 파일을 발명하지 않는다"),
  preserve: z
    .array(
      z.object({
        item: z
          .string()
          .describe("작업 지시서의 preserve 문장을 **그대로** 옮긴 것"),
        how: z.string().describe("이번 변경에서 그것이 어떻게 지켜지는지"),
      }),
    )
    .describe("지시서의 보존 조건마다 하나씩. 하나도 빠뜨리지 않는다"),
  ...COMMON_PLAN_FIELDS,
});

const SYSTEM_PROMPT_BASE =
  "너는 코드 생성 파이프라인의 플래너다. 스펙을 읽고 '무엇을 어떤 규칙으로 만들지'를 정리한 작업 명세서만 만든다. " +
  "코드는 만들지 않는다.\n" +
  "언어·프레임워크·계층 구조를 네가 알고 있는 관행으로 가정하지 않는다. 아래 주어진 것에서 읽히는 것만 근거로 삼는다.\n" +
  "스펙에 없는 필드·API·정책을 지어내지 않는다. 정할 수 없는 것은 openQuestions에 적는다.";

/** 복제할 코드가 있을 때만 붙는 규칙 — 없는 실행(신규 프로젝트 구성)에 붙이면 거짓말이 된다. */
const SYSTEM_PROMPT_WITH_REFERENCE =
  "\n가장 중요한 규칙: **참조 표준 도메인의 파일 구조가 정본이다.** 만들 파일 목록은 참조 표준 도메인의 " +
  "디렉토리 구성과 파일 이름 규칙을 그대로 따르고, 참조 표준에 없는 파일을 새로 발명하지 않는다.\n" +
  "컨벤션 문서가 참조 표준 코드와 다르게 말하면, 조용히 한쪽을 고르지 말고 conflicts에 남긴다. " +
  "문서는 코드보다 뒤처질 수 있으므로 기본 판단은 '참조 표준 코드를 따른다'이며, 그 판단도 decision에 적는다.";

/** 복제할 코드가 없을 때 — 근거가 얇다는 사실 자체를 알려 준다. */
const SYSTEM_PROMPT_WITHOUT_REFERENCE =
  "\n이 실행에는 **복제할 참조 코드가 없다.** 기존 관행으로 빈칸을 메우지 말고, " +
  "스펙과 결정 문서에 적힌 것만 계획에 넣는다. 근거가 없는 항목은 openQuestions로 돌린다.";

/**
 * 고치는 작업의 계획자 — 만드는 작업과 규칙이 다르다.
 *
 * 참조 표준을 복제하는 것이 아니라 **이미 있는 코드를 보존 조건 아래에서 고치는** 일이라,
 * "정본은 참조 도메인" 규칙을 그대로 붙이면 없는 파일을 만들라는 말이 된다.
 */
const REFACTOR_SYSTEM_PROMPT =
  "너는 리팩토링 계획자다. **동작을 바꾸지 않는다.** 코드는 만들지 않고, 무엇을 고칠지와 " +
  "무엇이 지켜져야 하는지를 정리한 작업 명세서만 만든다.\n" +
  "가장 중요한 규칙: **작업 지시서의 '바뀌면 안 되는 것'을 하나도 빠뜨리지 않는다.** " +
  "항목 문장을 그대로 옮기고, 이번 변경에서 그것이 어떻게 지켜지는지를 각각 적는다.\n" +
  "- 새 파일을 발명하지 않는다. files 에는 아래 '대상의 현재 파일' 에 있는 경로만 넣는다.\n" +
  "- 건드려도 되는 곳 밖의 파일은 목록에 넣지 않는다.\n" +
  "- 기능을 더하거나 빼지 않는다. 스펙에 없는 구조 변경을 지어내지 않는다.\n" +
  "- 정할 수 없는 것은 openQuestions 에 적는다.";

/**
 * 결함 수정의 계획자 — **재현이 먼저다.**
 *
 * 고치고 나서 테스트를 쓰면 그 테스트가 결함을 잡는지 알 수 없다. 지금 코드에서
 * 실패하는 것을 먼저 보여야 그 뒤의 통과가 뜻을 갖는다.
 */
const FIX_SYSTEM_PROMPT =
  "너는 결함 수정 계획자다. 코드는 만들지 않고, 무엇을 재현하고 무엇을 고칠지를 정리한 " +
  "작업 명세서만 만든다.\n" +
  "가장 중요한 규칙: **재현 테스트가 먼저다.** 재현 조건에서 실패하는 테스트를 먼저 만들고, " +
  "그 다음에 고친다. 그 테스트는 **지금 코드에서 실패해야 한다** — 통과한다면 결함을 재현하지 " +
  "못한 것이다.\n" +
  "- files 에는 새로 만들 재현 테스트와 고칠 파일을 함께 적는다. 각각 어느 단계의 것인지 밝힌다.\n" +
  "- 고치는 범위를 넘지 않는다. 같은 원인이 다른 곳에도 있으면 openQuestions 에 남기고 " +
  "이번에 같이 고치지 않는다.\n" +
  "- 작업 지시서의 바뀌면 안 되는 것을 하나도 빠뜨리지 않는다. 문장을 그대로 옮긴다.";

function systemPromptFor(kind: WorkKind, hasReference: boolean): string {
  if (kind === "refactor") {
    return REFACTOR_SYSTEM_PROMPT;
  }
  if (kind === "fix") {
    return FIX_SYSTEM_PROMPT;
  }
  return (
    SYSTEM_PROMPT_BASE +
    (hasReference ? SYSTEM_PROMPT_WITH_REFERENCE : SYSTEM_PROMPT_WITHOUT_REFERENCE)
  );
}

/** 고치는 작업의 계획 프롬프트. 근거는 참조 도메인이 아니라 **대상의 현재 코드**다. */
function buildChangeUserPrompt(
  context: ResolvedBuildContext,
  manifest: Manifest,
  stages: StageDef[],
): string {
  const order = context.workOrder;
  const current = listPaths(context.repoRoot, manifest, [context.target, ...order.scope]);

  return withPolicy(
    `${describeWorkOrder(order, context.target)}\n\n` +
      (context.slotsText ? `${context.slotsText}\n\n` : "") +
      `# 스펙 (무엇을 왜 고치는가)\n${context.specText}\n\n` +
      `# 코드 컨벤션 문서\n${context.conventionsText}\n\n` +
      `# 대상의 현재 파일\n` +
      (current.length > 0 ? current.join("\n") : "(비어 있음 — 지시서의 대상·scope 를 확인하세요)") +
      "\n\n" +
      `# 실행할 단계\n${stages.map((stage) => `- ${stage.key}: ${stage.title}`).join("\n")}\n\n` +
      "files 의 stage 는 위 단계 키 중 하나여야 하고, path 는 위 '대상의 현재 파일' 에 있는 것이어야 한다.\n" +
      (order.kind === "fix"
        ? "path 의 예외는 새로 만들 재현 테스트 하나다 — 그것만은 아직 없는 경로여도 된다.\n"
        : "") +
      (order.preserve.length > 0
        ? `preserve 는 ${order.preserve.length} 건이다. 그 문장을 그대로 옮겨 하나씩 채운다.`
        : "지시서에 보존 조건이 없다. 그래도 동작은 바뀌지 않아야 한다."),
    context.policyText,
  );
}

function buildUserPrompt(
  context: ResolvedBuildContext,
  manifest: Manifest,
  stages: StageDef[],
  referenceTree: string[],
): string {
  const roots = manifest.domainRoots.filter(Boolean);

  return withPolicy(
    `${describeWorkOrder(context.workOrder, context.target)}\n\n` +
      (context.slotsText ? `${context.slotsText}\n\n` : "") +
      `# 스펙 (요구사항·정책·기능·입출력)\n${context.specText}\n\n` +
      `# 코드 컨벤션 문서\n${context.conventionsText}\n\n` +
      `# 프로젝트 구조\n` +
      `- 도메인 디렉토리 위치: ${manifest.domainBase}\n` +
      `- 도메인 분류: ${roots.length > 0 ? roots.join(", ") : "(없음 — domainRoot는 빈 문자열)"}\n` +
      (manifest.language ? `- 주 언어: ${manifest.language}\n` : "") +
      (referenceTree.length > 0
        ? `\n# 참조 표준 도메인 '${context.referenceDomain}'의 파일 구조\n${referenceTree.join("\n")}\n\n`
        : "\n# 참조 표준 코드\n(없음 — 복제할 기존 코드가 없는 실행이다)\n\n") +
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
  const kind = context.workOrder.kind;
  return {
    stage: "plan",
    reproducible: true,
    system: systemPromptFor(kind, referenceTree.length > 0),
    user:
      changesExistingCode(kind)
        ? buildChangeUserPrompt(context, manifest, stages)
        : buildUserPrompt(context, manifest, stages, referenceTree),
  };
}

/** 계획 단계가 돌려줘야 하는 형태 — 종류마다 다르다 */
const PLAN_SHAPE = `{
  "domainName": "도메인 이름",
  "domainLabel": "사람이 읽는 이름",
  "domainRoot": "도메인 분류 (없으면 \\"\\")",
  "domainDirName": "실제 디렉토리 이름",
  "files": [{ "stage": "단계 키", "path": "상대경로", "purpose": "한 줄 설명" }],
  "conventions": [{ "rule": "적용할 규칙", "source": "근거 위치" }],
  "conflicts": [{ "topic": "", "docSays": "", "codeSays": "", "decision": "" }],
  "openQuestions": ["사람이 답해야 하는 것"],
  "reasoning": "판단 근거"
}`;

const REFACTOR_PLAN_SHAPE = `{
  "files": [{ "stage": "단계 키", "path": "고칠 파일의 상대경로", "purpose": "무엇을 어떻게 고치는지" }],
  "preserve": [{ "item": "지시서의 문장 그대로", "how": "이번 변경에서 어떻게 지켜지는지" }],
  "conventions": [{ "rule": "적용할 규칙", "source": "근거 위치" }],
  "conflicts": [{ "topic": "", "docSays": "", "codeSays": "", "decision": "" }],
  "openQuestions": ["사람이 답해야 하는 것"],
  "reasoning": "판단 근거"
}`;

/**
 * 종류에 맞는 계획 형식 한 벌.
 *
 * 스키마와 붙여넣기용 형태와 해석을 한자리에 둔다 — 셋이 흩어지면 한쪽만 갈라져
 * "형식은 refactor 인데 스키마는 feature" 같은 상태가 생긴다.
 */
export interface PlanFormat {
  schema: z.ZodType<unknown>;
  shape: string;
  /** 계획에 보존 조건이 있어야 하는 종류인지 */
  requiresPreserve: boolean;
  toPlan(parsed: unknown): BuildPlan;
}

/**
 * 이미 있는 코드를 고치는 종류인가.
 *
 * 이 둘의 계획은 *만들 파일 목록*이 아니라 **고칠 파일 + 보존 조건**이다. 만들 도메인이
 * 없다는 점이 같아서, 계획의 모양도 같다.
 */
function changesExistingCode(kind: WorkKind): boolean {
  return kind === "refactor" || kind === "fix";
}

export function planFormatFor(kind: WorkKind): PlanFormat {
  if (!changesExistingCode(kind)) {
    return {
      schema: PlanSchema,
      shape: PLAN_SHAPE,
      requiresPreserve: false,
      toPlan: (parsed) => parsed as BuildPlan,
    };
  }

  return {
    schema: RefactorPlanSchema,
    shape: REFACTOR_PLAN_SHAPE,
    requiresPreserve: true,
    // 고치는 작업에는 만들 도메인이 없다. 도메인 자리를 비워 두면 경계 검사도
    // 도메인 디렉토리가 아니라 지시서의 scope 를 보게 된다.
    toPlan: (parsed) => ({
      domainName: "",
      domainLabel: "",
      domainRoot: "",
      domainDirName: "",
      ...(parsed as Omit<BuildPlan, "domainName" | "domainLabel" | "domainRoot" | "domainDirName">),
    }),
  };
}

/**
 * 지시서의 보존 조건 중 계획이 다루지 않은 것.
 *
 * 문장을 **그대로** 옮기게 해 두면 대조를 코드가 한다. 모델이 요약하거나 흘리면 여기서 걸리고,
 * 걸린 계획은 승인 화면에 올라가지 않는다 — 보존 조건이 빠진 계획을 승인받는 것이
 * 이 종류에서 가장 위험한 실패다.
 */
export function missingPreserve(order: WorkOrder, plan: BuildPlan): string[] {
  const covered = new Set((plan.preserve ?? []).map((entry) => entry.item.trim()));
  return order.preserve.filter((entry) => !covered.has(entry.trim()));
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

  const preview = previewPlanPrompt(context, manifest, stages, referenceTree);
  const format = planFormatFor(context.workOrder.kind);

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 8000,
    system: preview.system,
    messages: [{ role: "user", content: preview.user }],
    output_config: { format: zodOutputFormat(format.schema as z.ZodType<object>) },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    // 계획이 없으면 이후 단계가 만들 파일을 특정할 수 없다 — 추측으로 진행하지 않는다.
    throw new Error("계획 응답을 파싱하지 못했습니다. 스펙을 줄이거나 다시 실행하세요.");
  }
  return format.toPlan(parsed);
}

/** 계획을 사람이 읽을 형태로 출력한다. */
export function formatPlan(plan: BuildPlan): string {
  const location = [plan.domainRoot, plan.domainDirName].filter(Boolean).join("/");
  // 만들 도메인이 없는 계획(고치는 작업)은 도메인 줄 자리에 쓸 말이 없다.
  const heading = plan.domainName
    ? [`도메인: ${plan.domainName} (${plan.domainLabel}) · 위치: ${location}`, ""]
    : [];

  const lines = [
    `## 작업 명세서`,
    ...heading,
    `### ${plan.preserve ? "고칠" : "생성할"} 파일 (${plan.files.length}개)`,
    ...plan.files.map((file) => `- [${file.stage}] ${file.path} — ${file.purpose}`),
    "",
    ...(plan.preserve
      ? [
          `### 보존 조건 (${plan.preserve.length}건)`,
          ...plan.preserve.map((entry) => `- ${entry.item}
  → ${entry.how}`),
          "",
        ]
      : []),
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
