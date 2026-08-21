/**
 * 입력 규격 — 1차 게이트.
 *
 * "무엇이 정의되어야 하는가"를 문서가 아니라 **코드가 들고 대조한다.** 이것이 없으면 스펙의
 * 빈칸을 알아채는 주체가 모델뿐이고, 모델이 관행으로 채워 버리면 아무도 막지 못한다.
 *
 * 모델의 역할을 **판단에서 추출로** 낮추는 것이 핵심이다. 모델은 값을 정하지 않고 문서에서
 * 옮겨 오기만 하며, 옮겨 온 자리(원문 인용)를 함께 낸다. 인용을 붙이지 못한 값은 코드가
 * 미충족으로 처리하므로, 지어낸 값이 통과할 자리가 없다.
 *
 * 슬롯 결과는 파일로 남지만 **캐시가 아니라 파생물이다.** 스펙 해시에 묶여 있어 문서가
 * 바뀌면 그 순간 무효가 되고 다시 뽑는다. 정본은 언제나 문서다.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { z } from "zod";

import type { PendingQuestion } from "./session";
import type { WorkKind } from "./workOrder";
import { KINDS } from "./workOrder";

export const SPEC_SCHEMA_FILE = "spec-schema.json";
export const SPEC_SLOTS_FILE = ".spec-slots.json";

/** 질문이 어느 슬롯에서 나왔는지 표시하는 접두사. 사람이 답하면 그 슬롯이 채워진 것으로 본다. */
const QUESTION_TARGET = "intake";

const SlotSchema = z.object({
  key: z.string().describe("슬롯 식별자. 질문 라벨과 파생물 파일에 쓰인다"),
  title: z.string().describe("사람이 읽는 항목 이름"),
  requiredFor: z
    .array(z.enum(KINDS))
    .default([])
    .describe("이 항목이 필수인 작업 종류. 비면 참고 항목이고 진행을 막지 않는다"),
  question: z.string().describe("비었을 때 사람에게 물을 문장"),
  hint: z.string().optional().describe("어디를 보면 되는지 같은 보조 설명"),
});

const SpecSchemaSchema = z.object({
  slots: z.array(SlotSchema).min(1),
});

export type SlotDef = z.infer<typeof SlotSchema>;
export type SpecSchema = z.infer<typeof SpecSchemaSchema>;

/**
 * 입력 규격을 읽는다. **선언하지 않은 프로젝트에서는 이 층이 돌지 않는다** —
 * 매니페스트와 같은 원칙이다. 슬롯 목록은 회사·프로젝트마다 다르므로 에이전트가 들고 있지 않다.
 */
export function loadSpecSchema(templatesDir: string): SpecSchema | undefined {
  const path = join(templatesDir, SPEC_SCHEMA_FILE);
  if (!existsSync(path)) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${SPEC_SCHEMA_FILE} 파싱 실패: ${err instanceof Error ? err.message : err}`);
  }

  const parsed = SpecSchemaSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${SPEC_SCHEMA_FILE} 형식 오류:\n${issues}`);
  }
  return parsed.data;
}

// ---- 파생물 ----

export interface FilledSlot {
  key: string;
  /** 스펙에서 읽힌 내용. 읽히지 않았으면 빈 문자열 */
  value: string;
  /** 근거가 된 원문 그대로. 이것이 없는 값은 채워진 것으로 보지 않는다 */
  evidence: string;
}

export interface SpecSlots {
  /** 이 파생물이 어느 스펙에서 나왔는지. 달라지면 파생물은 무효다 */
  specHash: string;
  slots: FilledSlot[];
}

export const IntakeSchema = z.object({
  slots: z.array(
    z.object({
      key: z.string(),
      value: z.string().describe("스펙에서 읽히는 내용. 읽히지 않으면 빈 문자열"),
      evidence: z
        .string()
        .describe("근거가 된 원문을 그대로 옮긴 것. 옮길 문장이 없으면 빈 문자열"),
    }),
  ),
});

export const INTAKE_SHAPE = `{
  "slots": [
    {
      "key": "항목 키",
      "value": "스펙에서 읽히는 내용 (읽히지 않으면 \\"\\")",
      "evidence": "근거가 된 원문 그대로 (없으면 \\"\\")"
    }
  ]
}`;

export function hashSpec(specText: string): string {
  return `sha256:${createHash("sha256").update(specText, "utf-8").digest("hex").slice(0, 16)}`;
}

export function slotsPath(outDir: string): string {
  return join(outDir, SPEC_SLOTS_FILE);
}

export function saveSlots(outDir: string, slots: SpecSlots): string {
  const path = slotsPath(outDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(slots, null, 2), "utf-8");
  return path;
}

export function loadSlots(outDir: string): SpecSlots | undefined {
  const path = slotsPath(outDir);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as SpecSlots;
}

/**
 * 항목을 다시 뽑아야 하는가.
 *
 * 스펙이 바뀌었으면 앞서 뽑은 것은 그 순간 무효다 — 그것을 그대로 쓰면 문서를 고쳐
 * 게이트를 우회할 수 있게 된다. 파생물을 캐시로 쓰지 않는다는 것이 이 함수의 전부다.
 */
export function needsIntake(outDir: string, specText: string): boolean {
  const existing = loadSlots(outDir);
  return existing === undefined || existing.specHash !== hashSpec(specText);
}

// ---- 1차 게이트 ----

export interface SlotGap {
  key: string;
  title: string;
  question: string;
}

function isFilled(slot: FilledSlot | undefined): boolean {
  // 인용 없는 값은 채워진 것으로 보지 않는다. 관행으로 채우면 옮겨 올 문장이 없기 때문이다.
  return slot !== undefined && slot.value.trim() !== "" && slot.evidence.trim() !== "";
}

/** 사람이 이미 답해 준 슬롯. 답이 있으면 다시 묻지 않는다. */
export function answeredSlotKeys(questions: PendingQuestion[]): Set<string> {
  return new Set(
    questions
      .filter((question) => question.answer !== "" && question.target.startsWith(`${QUESTION_TARGET}:`))
      .map((question) => question.target.slice(QUESTION_TARGET.length + 1)),
  );
}

export function questionTargetFor(key: string): string {
  return `${QUESTION_TARGET}:${key}`;
}

/**
 * 채워지지 않은 필수 항목을 찾는다. **모델이 질문을 떠올렸는지와 무관하게 코드가 판정한다.**
 */
export function findGaps(
  schema: SpecSchema,
  slots: FilledSlot[],
  kind: WorkKind,
  answered: Set<string>,
): SlotGap[] {
  const filled = new Map(slots.map((slot) => [slot.key, slot]));

  return schema.slots
    .filter((slot) => slot.requiredFor.includes(kind))
    .filter((slot) => !isFilled(filled.get(slot.key)) && !answered.has(slot.key))
    .map((slot) => ({ key: slot.key, title: slot.title, question: slot.question }));
}

// ---- 프롬프트 ----

const INTAKE_SYSTEM =
  "너는 문서에서 항목을 뽑아내는 추출기다. **판단하거나 채우지 않는다.**\n" +
  "각 항목에 대해, 아래 스펙 문서에서 그 항목을 말하고 있는 부분을 찾아 옮겨 온다.\n" +
  "- 문서에 없으면 value 와 evidence 를 모두 빈 문자열로 둔다. 그것이 정답이다.\n" +
  "- evidence 는 **문서에 실제로 있는 문장을 그대로** 옮긴 것이어야 한다. 요약하거나 다시 쓰지 않는다.\n" +
  "- 일반적인 관행이나 네가 아는 사례로 빈칸을 메우지 않는다. 빈칸은 사람이 답할 자리다.\n" +
  "- 주어진 항목 키만 쓴다. 새 항목을 만들지 않는다.";

export function buildIntakePrompt(
  schema: SpecSchema,
  kind: WorkKind,
  workOrderText: string,
  specText: string,
): { system: string; user: string } {
  const items = schema.slots
    .map((slot) => {
      const required = slot.requiredFor.includes(kind) ? "필수" : "참고";
      return `- ${slot.key} — ${slot.title} (${required})${slot.hint ? `\n    ${slot.hint}` : ""}`;
    })
    .join("\n");

  return {
    system: INTAKE_SYSTEM,
    user:
      `${workOrderText}\n\n` +
      `# 뽑아낼 항목\n${items}\n\n` +
      `# 스펙 문서 (여기서만 옮겨 온다)\n${specText}`,
  };
}

/**
 * 확정된 항목을 프롬프트에 실을 형태로 줄인다.
 *
 * 스펙 전문을 매번 다시 싣는 대신, **읽힌 것만 근거와 함께** 싣는다. 축약이 원문을 대체하는
 * 것이 아니라, 원문은 그대로 두고 이 요약이 앞에 놓인다 — 근거가 남아 있어야 나중에 누구도
 * "그 규칙이 어디서 왔나"를 확인할 수 있다.
 */
export function describeSlots(schema: SpecSchema, slots: FilledSlot[]): string {
  const filled = new Map(slots.map((slot) => [slot.key, slot]));
  const lines = schema.slots
    .filter((slot) => isFilled(filled.get(slot.key)))
    .map((slot) => {
      const found = filled.get(slot.key)!;
      return `## ${slot.title}\n${found.value}\n> 근거: ${found.evidence}`;
    });

  if (lines.length === 0) {
    return "";
  }
  return `# 스펙에서 확정된 항목 — 근거와 함께\n\n${lines.join("\n\n")}`;
}
