import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { writeAtomic } from "../core/atomic";
import { requireTerminal } from "./tty";
import { selectedHosts, type Host } from "./hosts";
import { allCursors } from "./branchCursor";
import { loadRequestSession } from "./request";
import { guidance } from "./retryPolicy";
import { Stop } from "./stop";
import {
  AGENTS, type AgentName, CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES, CLAUDE_MODELS_FILE, type ClaudeEffort, ClaudeModelIdSchema, CODEX_MODELS_FILE,
  CodexModelSchema, REASONING_LEVELS, ROLE_POLICY, TIER_DEFAULTS, TIER_LABEL, claudeFrontmatter, claudeModelOf, claudeSupportsEffort, codexModelOf,
  codexModelText, defaultCodexModel, frontmatterModel, isClaudeOverride, isCodexOverride, modelDisplay, modelLabel, nextClaudeOverrides,
  readClaudeOverrides, readCodexOverrides,
} from "./modelPolicy";
export { AGENTS, type AgentName, codexModelOf, claudeModelOf } from "./modelPolicy";

/**
 * 서브에이전트별 모델·추론 강도.
 *
 * 역할 정책은 modelPolicy.ts ROLE_POLICY 다 — 판단 역할(analyst·critic·reviewer)과 실행 역할(그 밖)의 기본값이 다르다.
 * Claude 변경값은 `.code-agent/models.json` — 역할 키는 모델 문자열(이전 형식 그대로), 예약 키 effort 는 역할별 추론 강도다.
 * 사람이 `code-agent model <역할|all> <모델>` 로 바꾸면 그 파일에 남고, `.claude/agents/ca-*.md` 머리말의 `model:`·`effort:`
 * 줄을 코드가 다시 쓴다 — Claude Code 가 읽는 것은 그 줄이다. 정의 파일에 박아 두는 이유: 비워 두면 각자 PC 의 기본값으로 돈다.
 * 설정 파일을 `.code-agent/` 에 두는 이유: 도구로는 못 쓰는 자리라 모델이 자기 모델을 바꿀 수 없고,
 * code-agent.json 이 생기기 전(도입 중)에도 에이전트는 돈다.
 * Codex는 modelPolicy의 역할별 기본값과 codex-models.json을 사용하며 호스트 간 설정은 섞지 않는다.
 */

/** Claude 모델 별칭 — 전체 ID(`claude-…`)도 받는다 */
export const MODELS = CLAUDE_MODEL_ALIASES;
export const MODELS_FILE = CLAUDE_MODELS_FILE;

function agentFile(repoRoot: string, agent: AgentName): string {
  return join(repoRoot, ".claude", "agents", `ca-${agent}.md`);
}

/** 테스트·스크립트 호환용 — 역할의 Claude 모델 이름만 */
export function modelOf(repoRoot: string, agent: AgentName): string {
  return claudeModelOf(repoRoot, agent).model;
}

/** 설치된 Claude 정의 파일 머리말의 model·effort. 파일이 없으면 undefined */
export function installedClaudeModel(repoRoot: string, agent: AgentName): { model?: string; effort?: string } | undefined {
  const path = agentFile(repoRoot, agent);
  return existsSync(path) ? frontmatterModel(readFileSync(path, "utf-8")) : undefined;
}

/** 정의 파일의 머리말 `model:`·`effort:` 줄을 설정대로 맞춘다. 강도를 받지 않는 모델이면 `effort:` 줄을 지운다 */
export function applyModels(repoRoot: string, host: Host = "claude"): void {
  for (const agent of AGENTS) {
    const path = host === "codex" ? join(repoRoot, ".codex/agents", `ca-${agent}.toml`) : agentFile(repoRoot, agent);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");
    const next = host === "codex" ? codexModelText(text, codexModelOf(repoRoot, agent)) : claudeFrontmatter(text, claudeModelOf(repoRoot, agent));
    if (next !== text) writeAtomic(path, next);
  }
}

/** 한 줄 요약 — 판단·실행 기본값과 바꾼 역할. init·doctor 가 쓴다 */
export function policySummary(repoRoot: string, host: Host): string {
  const tier = (name: "judgment" | "execution") => {
    const agents = AGENTS.filter((agent) => ROLE_POLICY[agent].tier === name);
    return `${TIER_LABEL[name]}(${agents.join("·")}) ${modelLabel(host === "claude" ? TIER_DEFAULTS[name].claude : TIER_DEFAULTS[name].codex)}`;
  };
  const changed = AGENTS.filter((agent) => host === "claude" ? isClaudeOverride(repoRoot, agent) : isCodexOverride(repoRoot, agent));
  const shown = changed.map((agent) => `${agent} ${modelDisplay(host === "claude" ? claudeModelOf(repoRoot, agent) : codexModelOf(repoRoot, agent))}`);
  return `${tier("judgment")} · ${tier("execution")}${changed.length ? ` · 바꿈 ${changed.length}개: ${shown.join(" · ")}` : ""}`;
}

function row(agent: AgentName, value: string, override: boolean): string {
  return `  ${agent.padEnd(12)} ${value.padEnd(20)} ${TIER_LABEL[ROLE_POLICY[agent].tier]}  ${override ? "(바꿈)" : "(기본)"}`;
}

/**
 * 표의 변경 줄 — 진행 중인 작업이 있으면 변경이 거부된다는 문장(model-in-work, D1)을 먼저 싣고 작업이 끝난 뒤의 방법을 붙인다.
 * 상태를 읽지 못하면 평소 줄이다(조회는 막지 않는다 — 변경은 requireNoWorkInProgress 가 막는다)
 */
function changeLine(repoRoot: string, manual: string): string {
  let work: ReturnType<typeof workInProgress>;
  try { work = workInProgress(repoRoot); } catch { work = undefined; }
  return work
    ? `변경: ${guidance("precondition", { id: work.id, phase: work.phase }, "model-in-work")} 작업이 끝난 뒤: 현재 세션에서 변경을 요청하거나 수동 TTY: ${manual}`
    : `변경: 현재 세션에서 역할·모델·추론 강도 변경을 요청하세요. 수동 TTY: ${manual}`;
}

export function modelsTable(repoRoot: string, host?: Host): string {
  const hosts = selectedHosts(repoRoot);
  if (host && !hosts.includes(host)) throw new Error(`${host}를 먼저 설치하세요.`);
  return (host ? [host] : hosts).map(selected => {
  if (selected === "codex") {
    return ["Codex 에이전트별 모델·추론 강도 (제품 기본값):", ...AGENTS.map(agent => {
      const config = codexModelOf(repoRoot, agent);
      return row(agent, `${config.model} / ${config.reasoning}`, isCodexOverride(repoRoot, agent));
    }), "", changeLine(repoRoot, "code-agent model <역할|all> <모델|default> --host codex [--reasoning <강도>]"),
    "설정한 모델의 계정 사용 권한과 추론 강도 지원은 Codex가 판정합니다. 적용 후 호스트를 재시작하세요."].join("\n");
  }
  const defaults = (name: "judgment" | "execution") => `${TIER_DEFAULTS[name].claude.model} / ${TIER_DEFAULTS[name].claude.effort}`;
  return [
    `Claude 에이전트별 모델·추론 강도 (제품 기본값: 판단 ${defaults("judgment")} · 실행 ${defaults("execution")}):`,
    ...AGENTS.map((agent) => {
      const config = claudeModelOf(repoRoot, agent);
      return row(agent, `${config.model} / ${config.effort ?? "(지원 안 함)"}`, isClaudeOverride(repoRoot, agent));
    }),
    "",
    changeLine(repoRoot, "code-agent model <역할|all> <모델|default> --host claude [--effort <강도>]"),
    `모델: ${CLAUDE_MODEL_ALIASES.join("·")} 또는 claude-로 시작하는 전체 ID. 추론 강도: ${CLAUDE_EFFORTS.join("·")}(haiku, Sonnet 4.5·Opus 4.1 이하, claude-3 이전 전체 ID는 강도를 받지 않습니다). ` +
      "모델만 바꾸면 그 역할의 추론 강도는 유지합니다. 적용 후 Claude Code를 다시 시작하세요.",
  ].join("\n");
  }).join("\n\n");
}

/**
 * 진행 중인 작업 — 작업 커서(start 뒤)나 접수 세션(접수 뒤 start 전). 반영(deliver)·종료(abort)가 둘 다 지운다.
 * 역할 모델 변경을 막는 범위는 사용자 결정(2026-10-08 D1 '작업 중에는 바꿀 수 없다 — 반영·종료 뒤')대로 접수부터다 — 접수 중에 바꾼
 * 정의 파일은 커밋되지 않은 변경이라 그 접수의 start 가 거부한다(startBlockers, FLOW-07). 상태 파일을 읽지 못하면 던진다(변경을 막는 쪽).
 */
export function workInProgress(repoRoot: string): { id: string; phase: string } | undefined {
  const active = allCursors(repoRoot)[0];
  if (active) return { id: active.id, phase: active.phase };
  const intake = loadRequestSession(repoRoot);
  return intake ? { id: intake.id, phase: "접수" } : undefined;
}
/**
 * 작업 중에는 역할 모델·추론 강도를 바꾸지 않는다(D1) — 정의 파일(.claude/agents/ca-*.md·.codex/agents/ca-*.toml)과 변경값 파일은
 * 커밋되는 설치 파일이라 바꾸면 그 작업의 계획 밖 변경이 되어 검증·반영이 막힌다. 동의 준비(validateModelChange — 질문을 내기 전)·
 * 동의 적용(consent.ts applyLocked 의 재확인과 setModel)·사람의 `code-agent model <역할> <모델>`(setModel)이 이 한 검사를 쓴다.
 * 조회(`code-agent model`, modelsTable)는 막지 않는다.
 */
export function requireNoWorkInProgress(repoRoot: string): void {
  const work = workInProgress(repoRoot);
  if (work) throw new Stop(guidance("precondition", { id: work.id, phase: work.phase }, "model-in-work"));
}

/** 강도는 두 호스트 모두 reasoning 하나로 받는다 — CLI 의 --reasoning·--effort 를 합친 값이다 */
export interface ModelOptions { host?: Host; reasoning?: string }
export function validateModelChange(repoRoot: string, who: string | undefined, model: string | undefined, options: ModelOptions = {}) {
  requireNoWorkInProgress(repoRoot);
  const hosts = selectedHosts(repoRoot), host = options.host ?? (hosts.length === 1 ? hosts[0] : undefined);
  if (!host) throw new Error("두 호스트가 설치되어 있습니다. --host claude 또는 --host codex를 지정하세요.");
  if (!hosts.includes(host)) throw new Error(`${host}를 먼저 설치하세요.`);
  const name = who?.replace(/^ca[-_]/, "");
  if (!name || (name !== "all" && !AGENTS.includes(name as AgentName))) {
    throw new Error(`에이전트는 ${AGENTS.join(", ")} 또는 all 입니다: ${who ?? "(없음)"}`);
  }
  const reasoning = options.reasoning;
  if (host === "claude") {
    if (model === "inherit") {
      throw new Error(`Claude 모델 inherit는 쓰지 않습니다 — 메인 세션 모델을 따라가 역할별 정책이 사라집니다. ${CLAUDE_MODEL_ALIASES.join(", ")} 또는 claude- 전체 ID를 지정하세요.`);
    }
    if (model !== "default" && (!model || !ClaudeModelIdSchema.safeParse(model).success)) {
      throw new Error(`Claude 모델은 ${CLAUDE_MODEL_ALIASES.join(", ")} 또는 claude-로 시작하는 전체 ID입니다: ${model ?? "(없음)"}`);
    }
    if (model === "default" && reasoning !== undefined) throw new Error("기본값 복원에는 추론 강도를 함께 지정하지 않습니다.");
    if (reasoning !== undefined && !(CLAUDE_EFFORTS as readonly string[]).includes(reasoning)) {
      throw new Error(`Claude 추론 강도(effort)는 ${CLAUDE_EFFORTS.join(", ")} 중 하나입니다: ${reasoning}`);
    }
    if (reasoning !== undefined && !claudeSupportsEffort(model!)) throw new Error(`Claude ${model}는 추론 강도(effort)를 받지 않습니다 — 강도 없이 모델만 지정하세요.`);
  } else {
    if (model === "default" && reasoning !== undefined) throw new Error("기본값 복원에는 추론 강도를 함께 지정하지 않습니다.");
    if (model !== "default" && !CodexModelSchema.safeParse({model,reasoning:reasoning ?? "medium"}).success) throw new Error(`Codex 모델 식별자와 추론 강도를 확인하세요: ${REASONING_LEVELS.join(", ")}`);
  }
  return {host, name: name as AgentName | "all", model: model!, reasoning};
}
/** 역할 모델 변경 — 작업 중이면 TTY 를 묻기 전에 거부한다(validateModelChange 의 requireNoWorkInProgress) */
export function setModel(repoRoot: string, who: string | undefined, model: string | undefined, options: ModelOptions = {}): string {
  const change = validateModelChange(repoRoot, who, model, options), name = change.name;
  requireTerminal("에이전트 모델");
  const targets = name === "all" ? AGENTS : [name];
  if (change.host === "codex") {
    const overrides = readCodexOverrides(repoRoot);
    for (const agent of targets) {
      if (model === "default") { delete overrides[agent]; continue; }
      const value = {model: change.model, reasoning: options.reasoning ?? codexModelOf(repoRoot, agent).reasoning};
      const config = CodexModelSchema.parse(value), defaults = defaultCodexModel(agent);
      if (config.model === defaults.model && config.reasoning === defaults.reasoning) delete overrides[agent];
      else overrides[agent] = config;
    }
    writeAtomic(join(repoRoot, CODEX_MODELS_FILE), `${JSON.stringify(overrides, null, 2)}\n`);
    applyModels(repoRoot, "codex");
    return modelsTable(repoRoot, "codex");
  }
  // 대상 역할의 항목만 바꾼다 — 대상이 아닌 역할의 값은 기본값과 같아도 그대로 둔다(이전 버전이 계속 읽는다)
  let next = readClaudeOverrides(repoRoot);
  for (const agent of targets) next = nextClaudeOverrides(next, agent, change.model, change.reasoning as ClaudeEffort | undefined);
  writeAtomic(join(repoRoot, MODELS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  applyModels(repoRoot, "claude");
  return modelsTable(repoRoot, "claude");
}
