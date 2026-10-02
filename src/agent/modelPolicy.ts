import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

export const AGENTS = ["surveyor", "analyst", "explorer", "writer", "critic", "implementer", "tester", "reviewer"] as const;
export type AgentName = (typeof AGENTS)[number];
export const CODEX_MODELS_FILE = ".code-agent/codex-models.json";
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const CodexModelSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/).refine(value => !["opus", "sonnet", "haiku", "default"].includes(value)),
  reasoning: z.enum(REASONING_LEVELS),
}).strict();
export type CodexModel = z.infer<typeof CodexModelSchema>;
const OverridesSchema = z.partialRecord(z.enum(AGENTS), CodexModelSchema);
/** 계정의 전역 기본값과 무관한 제품 기본값. 사용 권한은 호스트가 판정한다. */
export function defaultCodexModel(agent: AgentName): CodexModel {
  return { model: "gpt-6.1-sol", reasoning: ["analyst", "critic", "reviewer"].includes(agent) ? "high" : "medium" };
}
export function readCodexOverrides(root?: string): Partial<Record<AgentName, CodexModel>> {
  const file = root && join(root, CODEX_MODELS_FILE);
  return file && existsSync(file) ? OverridesSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : {};
}
export function codexModelOf(root: string | undefined, agent: AgentName): CodexModel {
  return readCodexOverrides(root)[agent] ?? defaultCodexModel(agent);
}
export function codexModelText(text: string, config: CodexModel): string {
  return text.replace(/^model = .*\r?\n/gm, "").replace(/^model_reasoning_effort = .*\r?\n/gm, "") +
    `model = ${JSON.stringify(config.model)}\nmodel_reasoning_effort = ${JSON.stringify(config.reasoning)}\n`;
}
