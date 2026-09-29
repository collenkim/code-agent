/**
 * 계획의 규격 — 스키마·형식·제출 검사.
 *
 * 계획은 Claude Code 안의 모델이 plan.json 으로 써 온다. 여기 남는 것은 그 초안을
 * **검사하고 사람이 읽을 형태로 내는** 쪽이다. 계획을 API 로 받아 오던 쪽은 없어졌다.
 */
import { z } from "zod";

import type { WorkKind, WorkOrder } from "./workOrder";
import type { BuildPlan } from "./types";

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
        requirements: z
          .array(z.string())
          .optional()
          .describe("이 파일이 담당하는 요구 항목 번호 (analysis.md 의 R1, R2 …)"),
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
        requirements: z
          .array(z.string())
          .optional()
          .describe("이 파일이 담당하는 요구 항목 번호 (analysis.md 의 R1, R2 …)"),
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

/** 계획 단계가 돌려줘야 하는 형태 — 종류마다 다르다 */
const PLAN_SHAPE = `{
  "domainName": "도메인 이름",
  "domainLabel": "사람이 읽는 이름",
  "domainRoot": "도메인 분류 (없으면 \\"\\")",
  "domainDirName": "실제 디렉토리 이름",
  "files": [{ "stage": "단계 키", "path": "상대경로", "purpose": "한 줄 설명", "requirements": ["R1"] }],
  "conventions": [{ "rule": "적용할 규칙", "source": "근거 위치" }],
  "conflicts": [{ "topic": "", "docSays": "", "codeSays": "", "decision": "" }],
  "openQuestions": ["사람이 답해야 하는 것"],
  "reasoning": "판단 근거"
}`;

const REFACTOR_PLAN_SHAPE = `{
  "files": [{ "stage": "단계 키", "path": "고칠 파일의 상대경로", "purpose": "무엇을 어떻게 고치는지", "requirements": ["R1"] }],
  "preserve": [{ "item": "지시서의 문장 그대로", "how": "이번 변경에서 어떻게 지켜지는지" }],
  "conventions": [{ "rule": "적용할 규칙", "source": "근거 위치" }],
  "conflicts": [{ "topic": "", "docSays": "", "codeSays": "", "decision": "" }],
  "openQuestions": ["사람이 답해야 하는 것"],
  "reasoning": "판단 근거"
}`;

/**
 * 종류에 맞는 계획 형식 한 벌.
 *
 * 스키마와 context 가 내보내는 형태와 해석을 한자리에 둔다 — 셋이 흩어지면 한쪽만 갈라져
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
    // 승인 화면까지 오려면 전부 답이 채워져 있어야 한다 — 여기서 '미결'이라 부르면
    // 승인하는 사람이 아직 남은 것이 있다고 읽는다.
    lines.push("", `### 계획이 남긴 질문 (${plan.openQuestions.length}건)`);
    lines.push(...plan.openQuestions.map((question) => `- ${question}`));
  }

  lines.push("", `### 판단 근거`, plan.reasoning);
  return lines.join("\n");
}
