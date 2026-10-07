import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { Stop } from "./stop";

/**
 * 역할별 모델·추론 강도 정책의 원천 — Claude·Codex 기본값, 템플릿 머리말, 교차 실행 인자, 문서 표가 모두 여기서 나오거나
 * 테스트가 여기와 대조한다. hook 이 hosts.ts 를 거쳐 읽으므로 fs·path·zod·./stop 말고는 import 하지 않는다.
 */
export const AGENTS = ["surveyor", "analyst", "explorer", "writer", "critic", "implementer", "tester", "reviewer"] as const;
export type AgentName = (typeof AGENTS)[number];

export type RoleTier = "judgment" | "execution";
export const TIER_LABEL: Readonly<Record<RoleTier, string>> = { judgment: "판단", execution: "실행" };
/**
 * 역할 → 등급·선택 이유. 모델은 역할의 위상이 아니라 업무 성격으로 고른다 — 판단 역할의 오판은 뒤 단계로 번지고,
 * 실행 역할의 결과는 게이트와 판단 역할이 검증한다. 이유 원문은 doc/codex.md 역할별 모델 표와 같다.
 */
export const ROLE_POLICY: Readonly<Record<AgentName, { tier: RoleTier; reason: string }>> = {
  surveyor: { tier: "execution", reason: "survey 표본을 읽고 근거 경로를 단 사실을 정리한다 — 확정은 사람이 한다" },
  analyst: { tier: "judgment", reason: "요구 구체화·설계 대안·계획을 판단한다 — 오판이 뒤 단계 전체로 번진다" },
  explorer: { tier: "execution", reason: "영역 코드에서 근거와 사실을 찾는다 — 해석은 판단 역할과 게이트가 검사한다" },
  writer: { tier: "execution", reason: "받은 재료를 뼈대 형식으로 옮긴다 — 새 판단을 만들지 않는다" },
  critic: { tier: "judgment", reason: "계획을 독립적으로 반박한다 — 여기서 놓친 결함은 그대로 승인된다" },
  implementer: { tier: "execution", reason: "승인된 계획·context대로 쓴다 — check·test·review 게이트가 결과를 검증한다" },
  tester: { tier: "execution", reason: "07의 TC를 그대로 구현한다 — check·test·review 게이트가 검증한다" },
  reviewer: { tier: "judgment", reason: "구현을 독립 반박 검토한다 — 반영 전 마지막 판단이다" },
};

// ---- Codex ----

export const CODEX_MODELS_FILE = ".code-agent/codex-models.json";
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
/** Claude 별칭·전체 ID 는 Codex 모델로 받지 않는다 — 호스트 간 설정을 섞지 않는다 */
export const CodexModelSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/)
    .refine(value => !["opus", "sonnet", "haiku", "fable", "default", "inherit"].includes(value) && !/^claude-/.test(value)),
  reasoning: z.enum(REASONING_LEVELS),
}).strict();
export type CodexModel = z.infer<typeof CodexModelSchema>;
const CodexOverridesSchema = z.partialRecord(z.enum(AGENTS), CodexModelSchema);

// ---- Claude ----

export const CLAUDE_MODELS_FILE = ".code-agent/models.json";
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;
/** Claude Code 머리말 `effort:`·`--effort` 가 받는 값과 같다 */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export const ClaudeModelIdSchema = z.string().max(64).refine(
  (value) => (CLAUDE_MODEL_ALIASES as readonly string[]).includes(value) || /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value),
  { message: "Claude 모델 식별자가 아닙니다" },
);
/**
 * 추론 강도(effort)를 받지 않는 모델 — 번들 claude-api 스킬 "Thinking & Effort" 표에서 Haiku 4.5·Sonnet 4.5 는 오류이고,
 * 4 세대에서 effort 는 Opus 4.5·Opus 4.6·Sonnet 4.6 부터다(같은 스킬의 model-migration). 그보다 앞선 전체 ID 를 사람이 고른 경우도 막는다:
 * Sonnet 4.5 이하 4 세대(`claude-sonnet-4`·`-4-0`·`-4-20250514`), Opus 4·4.1, 이전 명명 체계 `claude-<버전>-…`(3·3.5·3.7·2.x — haiku 포함).
 * 허용 목록이 아니라 막는 목록인 이유: 앞으로 나올 모델 ID 를 미리 알 수 없고, 새 모델은 강도를 받아 왔다.
 * Claude Code 가 걸러 주는지에 기대지 않고, 정의 파일에 effort 줄을 쓰지 않고 교차 실행에 --effort 를 넘기지 않는다.
 * 목록을 바꾸면 `modelPolicyFingerprint` 가 달라져 준비해 둔 model 동의는 다시 준비 대상이 된다.
 */
export const CLAUDE_NO_EFFORT: readonly RegExp[] = [
  /^haiku$/, /^claude-haiku-/,
  /^claude-sonnet-4(?:-[0-5])?(?:-\d{8})?$/,
  /^claude-opus-4(?:-[01])?(?:-\d{8})?$/,
  /^claude-\d/,
];
export function claudeSupportsEffort(model: string): boolean {
  return !CLAUDE_NO_EFFORT.some((pattern) => pattern.test(model));
}
/** 해석된 역할 설정. effort 는 모델이 강도를 받을 때만 있다 */
export interface ClaudeModel { model: string; effort?: ClaudeEffort }
/**
 * `.code-agent/models.json` — 역할 키의 값은 모델 문자열(이전 형식 그대로), 예약 키 `effort` 는 역할별 강도다.
 * 역할 값에 객체를 쓰지 않는다 — 팀이 커밋으로 공유하는 파일이라 이전 code-agent 가 역할 값을 그대로 `model:` 줄에 쓴다.
 */
export const ClaudeOverridesSchema = z.strictObject({
  ...(Object.fromEntries(AGENTS.map((agent) => [agent, ClaudeModelIdSchema.optional()])) as Record<AgentName, z.ZodOptional<typeof ClaudeModelIdSchema>>),
  effort: z.partialRecord(z.enum(AGENTS), z.enum(CLAUDE_EFFORTS)).optional(),
});
export type ClaudeOverrides = z.infer<typeof ClaudeOverridesSchema>;

/** 등급 → 호스트별 제품 기본값. 계정의 전역 기본값과 무관하고, 사용 권한은 호스트가 판정한다 */
export const TIER_DEFAULTS = {
  judgment: { claude: { model: "opus", effort: "high" }, codex: { model: "gpt-6.1-sol", reasoning: "high" } },
  execution: { claude: { model: "sonnet", effort: "medium" }, codex: { model: "gpt-6.1-sol", reasoning: "medium" } },
} as const satisfies Record<RoleTier, { claude: Required<ClaudeModel>; codex: CodexModel }>;

export function defaultClaudeModel(agent: AgentName): Required<ClaudeModel> {
  return { ...TIER_DEFAULTS[ROLE_POLICY[agent].tier].claude };
}
export function defaultCodexModel(agent: AgentName): CodexModel {
  return { ...TIER_DEFAULTS[ROLE_POLICY[agent].tier].codex };
}

// ---- 설정 파일 ----

const CLAUDE_FORMAT = '역할 값은 "<모델>"이고, 추론 강도는 "effort": {"<역할>": "<강도>"}에 둡니다. 파일을 고치거나 지운 뒤(지우면 모든 역할이 기본값) 다시 실행하세요.';
const CODEX_FORMAT = '값은 역할마다 {"model":"<모델>","reasoning":"<강도>"}입니다. 파일을 고치거나 지운 뒤(지우면 모든 역할이 기본값) 다시 실행하세요.';
/** 없으면 undefined. JSON 아님·형식 위반은 고치는 법과 함께 Stop 으로 멈춘다 */
function readSettings<T>(root: string | undefined, file: string, schema: z.ZodType<T>, format: string): T | undefined {
  const path = root && join(root, file);
  if (!path || !existsSync(path)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Stop(`\`${file}\`을 JSON으로 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}. ${format}`); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Stop(`\`${file}\` 형식이 잘못되었습니다 — ${issue.path.map(String).join(".") || "(최상위)"}: ${issue.message}. ${format}`);
  }
  return parsed.data;
}

export function readCodexOverrides(root?: string): Partial<Record<AgentName, CodexModel>> {
  return readSettings(root, CODEX_MODELS_FILE, CodexOverridesSchema, CODEX_FORMAT) ?? {};
}
export function codexModelOf(root: string | undefined, agent: AgentName): CodexModel {
  return readCodexOverrides(root)[agent] ?? defaultCodexModel(agent);
}
export function isCodexOverride(root: string | undefined, agent: AgentName): boolean {
  const config = codexModelOf(root, agent), base = defaultCodexModel(agent);
  return config.model !== base.model || config.reasoning !== base.reasoning;
}

export function readClaudeOverrides(root?: string): ClaudeOverrides {
  return readSettings(root, CLAUDE_MODELS_FILE, ClaudeOverridesSchema, CLAUDE_FORMAT) ?? {};
}
/** 모델 = 변경값 ?? 역할 기본 모델. 강도는 모델이 받을 때만 — 변경값 ?? 역할 기본 강도. 받지 않으면 변경값이 있어도 무시한다 */
export function claudeModelOf(root: string | undefined, agent: AgentName): ClaudeModel {
  const file = readClaudeOverrides(root), base = defaultClaudeModel(agent);
  const model = file[agent] ?? base.model;
  return claudeSupportsEffort(model) ? { model, effort: file.effort?.[agent] ?? base.effort } : { model };
}
/** 파일에 키가 있는지가 아니라 해석값이 역할 기본값과 다른지로 본다 */
export function isClaudeOverride(root: string | undefined, agent: AgentName): boolean {
  const config = claudeModelOf(root, agent), base = defaultClaudeModel(agent);
  return config.model !== base.model || config.effort !== base.effort;
}
/**
 * 저장 규칙 — 대상 역할의 항목만 바꾼 새 객체를 돌려준다(입력은 바꾸지 않는다). 역할 키의 값은 언제나 문자열이다.
 * 대상이 아닌 역할의 값은 기본값과 같아도 지우지 않는다 — 버전이 섞인 팀에서 이전 버전이 그 값을 계속 읽는다.
 * `default` 는 모델·강도를 함께 지운다. 강도를 주지 않으면 그 역할의 강도 항목은 그대로 둔다(모델만 바꾸면 강도 유지).
 */
export function nextClaudeOverrides(current: ClaudeOverrides, agent: AgentName, model: string, effort?: ClaudeEffort): ClaudeOverrides {
  const next: ClaudeOverrides = { ...current };
  const efforts: Partial<Record<AgentName, ClaudeEffort>> = { ...(current.effort ?? {}) };
  const base = defaultClaudeModel(agent);
  if (model === "default") {
    delete next[agent];
    delete efforts[agent];
  } else {
    if (model === base.model) delete next[agent];
    else next[agent] = model;
    if (effort !== undefined) {
      if (effort === base.effort) delete efforts[agent];
      else efforts[agent] = effort;
    }
  }
  if (Object.keys(efforts).length > 0) next.effort = efforts;
  else delete next.effort;
  return next;
}

// ---- 정의 파일 머리말 ----

const FRONTMATTER = /^---(\r?\n)([\s\S]*?)\r?\n---/;
/**
 * 머리말(첫 --- 블록) 안의 model·effort 줄만 다시 쓴다. effort 가 없으면 effort 줄을 지운다. effort 줄이 없으면 model 줄
 * 바로 다음에 넣는다. 줄바꿈(CRLF)을 유지하고 본문은 건드리지 않는다. 같은 값이면 같은 바이트를 돌려준다.
 */
export function claudeFrontmatter(text: string, config: ClaudeModel): string {
  const match = FRONTMATTER.exec(text);
  if (!match) return text;
  const eol = match[1];
  const lines = match[2].split(/\r?\n/);
  const modelLine = `model: ${config.model}`;
  let at = lines.findIndex((line) => /^model:/.test(line));
  if (at >= 0) lines[at] = modelLine;
  else at = lines.push(modelLine) - 1;
  const effortAt = lines.findIndex((line) => /^effort:/.test(line));
  if (config.effort) {
    if (effortAt >= 0) lines[effortAt] = `effort: ${config.effort}`;
    else lines.splice(at + 1, 0, `effort: ${config.effort}`);
  } else if (effortAt >= 0) lines.splice(effortAt, 1);
  return `---${eol}${lines.join(eol)}${eol}---${text.slice(match[0].length)}`;
}
/** 설치된 정의 파일의 머리말에서 model·effort 를 읽는다(없는 줄은 키가 없다) */
export function frontmatterModel(text: string): { model?: string; effort?: string } {
  const head = FRONTMATTER.exec(text)?.[2];
  if (head === undefined) return {};
  const value = (key: string) => new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, "m").exec(head)?.[1] || undefined;
  const model = value("model"), effort = value("effort");
  return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

// ---- 표시·실행 인자 ----

/** 교차 실행 claude 인자 — 강도를 받지 않는 모델에는 --effort 를 넣지 않는다 */
export function claudeModelArgs(config: ClaudeModel): string[] {
  return ["--model", config.model, ...(config.effort ? ["--effort", config.effort] : [])];
}
/** 교차 실행 codex exec 인자 */
export function codexModelArgs(config: CodexModel): string[] {
  return ["-m", config.model, "-c", `model_reasoning_effort="${config.reasoning}"`];
}
/** 결과 줄·update·doctor 대조용: "opus/high" · "haiku"(강도 없음) · "gpt-6.1-sol/high" */
export function modelLabel(config: ClaudeModel | CodexModel): string {
  const strength = "reasoning" in config ? config.reasoning : config.effort;
  return strength ? `${config.model}/${strength}` : config.model;
}
/** 사람에게 보이는 표·요약용: 강도가 없으면 "haiku/(지원 안 함)" */
export function modelDisplay(config: ClaudeModel | CodexModel): string {
  const strength = "reasoning" in config ? config.reasoning : config.effort;
  return `${config.model}/${strength ?? "(지원 안 함)"}`;
}

/**
 * model 동의 스냅샷의 정책 상태 — 역할 등급·TIER_DEFAULTS·CLAUDE_NO_EFFORT. 이유 문장은 넣지 않는다(문구만 고쳐도
 * 준비한 동의가 깨지지 않게). CLI 만 바뀌고 설치본이 그대로일 때, 이전 정책 아래 준비한 동의가 새 의미로 적용되지 않게 한다.
 */
export function modelPolicyFingerprint(): string {
  return JSON.stringify({
    tiers: AGENTS.map((agent) => [agent, ROLE_POLICY[agent].tier]),
    defaults: TIER_DEFAULTS,
    noEffort: CLAUDE_NO_EFFORT.map((pattern) => pattern.source),
  });
}

export function codexModelText(text: string, config: CodexModel): string {
  return text.replace(/^model = .*\r?\n/gm, "").replace(/^model_reasoning_effort = .*\r?\n/gm, "") +
    `model = ${JSON.stringify(config.model)}\nmodel_reasoning_effort = ${JSON.stringify(config.reasoning)}\n`;
}
