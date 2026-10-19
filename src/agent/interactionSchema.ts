/** 대시보드 요청 계약. 추천은 발행자의 근거이며 기본값은 응답이 아니다. */
import { z } from "zod";
import { ControlError } from "./master/protocol";

export const INTERACTION_SCHEMA = 1;
export const INTERACTION_STAGES = ["setup", "document", "request", "planning", "implementation", "verification", "review", "delivery", "recovery", "maintenance"] as const;
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const Input = z.object({ required: z.boolean(), minLength: z.number().int().min(0).max(8000), maxLength: z.number().int().min(1).max(8000), description: z.string().max(2000) }).strict()
  .refine(v => v.minLength <= v.maxLength, "입력 길이 범위가 잘못됐습니다");
export const InteractionQuestion = z.object({
  questionId: Id, title: z.string().min(1).max(8000), background: z.string().max(12000).default(""),
  mode: z.enum(["single", "multiple", "text"]), required: z.boolean().default(true),
  options: z.array(z.object({ optionId: Id, label: z.string().min(1).max(1000), description: z.string().max(2000), consequence: z.string().max(2000), input: Input.optional() }).strict()).max(16).default([]),
  minSelections: z.number().int().min(0).max(16).default(0), maxSelections: z.number().int().min(0).max(16).default(1),
  input: Input.optional(),
  recommendedOptionIds: z.array(Id).max(16).default([]), defaultOptionIds: z.array(Id).max(16).default([]),
  recommendationReason: z.string().min(1).max(4000), evidence: z.array(z.object({ path: z.string().max(2000).optional(), summary: z.string().min(1).max(4000) }).strict()).max(32).default([]),
}).strict().superRefine((q, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  const ids = q.options.map(o => o.optionId);
  if (new Set(ids).size !== ids.length) bad("선택지 ID가 중복됐습니다");
  for (const selected of [q.recommendedOptionIds, q.defaultOptionIds]) if (new Set(selected).size !== selected.length || selected.some(id => !ids.includes(id))) bad("추천·기본 선택 ID가 선택지와 다릅니다");
  if (q.mode === "text" && (!q.input || ids.length || q.recommendedOptionIds.length || q.defaultOptionIds.length)) bad("직접 입력 질문은 입력 조건만 지정합니다");
  if (q.mode !== "text" && (!ids.length || q.minSelections > q.maxSelections || q.maxSelections > ids.length || (q.mode === "single" && q.maxSelections !== 1))) bad("선택 개수 조건이 잘못됐습니다");
  if (q.mode === "single" && (q.recommendedOptionIds.length > 1 || q.defaultOptionIds.length > 1)) bad("단일 선택의 추천·기본값은 하나입니다");
  if (q.mode === "multiple" && q.defaultOptionIds.length && (q.defaultOptionIds.length < q.minSelections || q.defaultOptionIds.length > q.maxSelections)) bad("기본 선택 개수가 범위 밖입니다");
  if (q.recommendedOptionIds.length && !q.evidence.length) bad("추천에는 근거가 필요합니다");
});
export type InteractionQuestion = z.infer<typeof InteractionQuestion>;
export const PublishInteraction = z.object({
  key: Id, stage: z.enum(INTERACTION_STAGES), kind: z.enum(["question", "recovery-decision"]).default("question"),
  title: z.string().min(1).max(1000), questions: z.array(InteractionQuestion).min(1).max(16),
  source: z.enum(["host", "questions"]).default("host"),
  expiresInMs: z.number().int().min(1000).max(7 * 86400000).default(86400000),
}).strict().refine(v => new Set(v.questions.map(q => q.questionId)).size === v.questions.length, "질문 ID가 중복됐습니다");
export type PublishInteraction = z.infer<typeof PublishInteraction>;
export const InteractionAnswer = z.object({ questionId: Id, optionIds: z.array(Id).max(16).default([]), text: z.string().max(8000).optional(), optionInputs: z.record(z.string(), z.string().max(8000)).default({}) }).strict();
export const InteractionSubmission = z.object({
  intent: z.enum(["submit", "defer", "cancel", "reopen"]), explicit: z.literal(true),
  answers: z.array(InteractionAnswer).max(16).optional(),
  verdict: z.enum(["approve", "request-changes"]).optional(), shownHash: z.string().optional(),
  choices: z.record(z.string(), z.enum(["적용", "유지"])).optional(),
}).strict();
export type InteractionSubmission = z.infer<typeof InteractionSubmission>;
export function validateInteractionAnswers(questions: InteractionQuestion[], submission: InteractionSubmission): void {
  if (submission.intent !== "submit") {
    if (submission.answers || submission.verdict || submission.choices) throw new ControlError("invalid-request", "보류·취소·다시 열기는 답이나 승인을 포함하지 않습니다");
    return;
  }
  if (submission.verdict || submission.shownHash || submission.choices) throw new ControlError("invalid-request", "일반 답은 동의 응답이 아닙니다");
  const answers = submission.answers ?? [];
  if (new Set(answers.map(a => a.questionId)).size !== answers.length || answers.some(a => !questions.some(q => q.questionId === a.questionId))) throw new ControlError("invalid-request", "질문 ID가 중복되거나 요청에 없습니다");
  for (const q of questions) {
    const a = answers.find(a => a.questionId === q.questionId);
    if (!a) { if (q.required) throw new ControlError("invalid-request", `${q.questionId}: 필수 답이 없습니다`); continue; }
    const checkInput = (rule: z.infer<typeof Input> | undefined, text: string | undefined) => {
      if (!rule) { if (text !== undefined) throw new ControlError("invalid-request", "허용하지 않은 직접 입력입니다"); return; }
      const n = (text ?? "").trim().length;
      if ((rule.required || n > 0) && (n < Math.max(rule.required ? 1 : 0, rule.minLength) || n > rule.maxLength)) throw new ControlError("invalid-request", "직접 입력 길이가 조건과 다릅니다");
    };
    const ids = a.optionIds;
    if (new Set(ids).size !== ids.length || ids.some(id => !q.options.some(o => o.optionId === id))) throw new ControlError("invalid-request", "표시하지 않은 선택지 또는 중복 선택입니다");
    if (q.mode === "text" ? ids.length > 0 : ids.length < Math.max(q.required && !q.input ? 1 : 0, q.minSelections) || ids.length > q.maxSelections) throw new ControlError("invalid-request", "선택 개수가 조건과 다릅니다");
    checkInput(q.input, a.text);
    if (q.required && !ids.length && !a.text?.trim()) throw new ControlError("invalid-request", "명시적인 답이 없습니다");
    if (Object.keys(a.optionInputs).some(id => !ids.includes(id))) throw new ControlError("invalid-request", "선택하지 않은 항목의 입력입니다");
    for (const id of ids) checkInput(q.options.find(o => o.optionId === id)!.input, a.optionInputs[id]);
  }
}
