import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { writeAtomic } from "../core/atomic";
import { STATE_DIR } from "./layout";
import { requireTerminal } from "./tty";
import { selectedHosts, type Host } from "./hosts";
import { AGENTS, type AgentName, CODEX_MODELS_FILE, CodexModelSchema, REASONING_LEVELS, codexModelOf, codexModelText, defaultCodexModel, readCodexOverrides } from "./modelPolicy";
export { AGENTS, type AgentName, codexModelOf } from "./modelPolicy";

/**
 * 서브에이전트별 모델.
 *
 * Claude 기본은 전부 opus 다. 사람이 `code-agent model <에이전트|all> <모델>` 로 바꾸면 `.code-agent/models.json` 에
 * 남고, `.claude/agents/ca-*.md` 의 `model:` 줄을 코드가 다시 쓴다 — Claude Code 가 읽는 것은 그 줄이다.
 * 정의 파일에 박아 두는 이유: 비워 두면 각자 PC 의 기본 모델로 돈다.
 * 설정 파일을 `.code-agent/` 에 두는 이유: 도구로는 못 쓰는 자리라 모델이 자기 모델을 바꿀 수 없고,
 * code-agent.json 이 생기기 전(도입 중)에도 에이전트는 돈다.
 * Codex는 modelPolicy의 역할별 기본값과 codex-models.json을 사용하며 호스트 간 설정은 섞지 않는다.
 */

export const MODELS = ["opus", "sonnet", "haiku"] as const;
export type ModelName = (typeof MODELS)[number];

export const DEFAULT_MODEL: ModelName = "opus";
export const MODELS_FILE = `${STATE_DIR}/models.json`;

function agentFile(repoRoot: string, agent: AgentName): string {
  return join(repoRoot, ".claude", "agents", `ca-${agent}.md`);
}

/** 바꾼 것만 들어 있다. 없는 에이전트는 기본값 */
function readOverrides(repoRoot: string): Partial<Record<AgentName, ModelName>> {
  const path = join(repoRoot, MODELS_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Partial<Record<AgentName, ModelName>>) : {};
}

export function modelOf(repoRoot: string, agent: AgentName): ModelName {
  return readOverrides(repoRoot)[agent] ?? DEFAULT_MODEL;
}

/** 정의 파일의 `model:` 줄을 설정대로 맞춘다. 줄이 없으면 프런트매터 끝에 넣는다 */
export function applyModels(repoRoot: string, host: Host = "claude"): void {
  for (const agent of AGENTS) {
    const path = host === "codex" ? join(repoRoot, ".codex/agents", `ca-${agent}.toml`) : agentFile(repoRoot, agent);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");
    if (host === "codex") {
      const next = codexModelText(text, codexModelOf(repoRoot, agent));
      if (next !== text) writeAtomic(path, next);
      continue;
    }
    const line = `model: ${modelOf(repoRoot, agent)}`;
    const next = /^model:.*$/m.test(text)
      ? text.replace(/^model:.*$/m, line)
      : text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, head: string) => `---\n${head}\n${line}\n---`);
    if (next !== text) writeAtomic(path, next);
  }
}

export function modelsTable(repoRoot: string, host?: Host): string {
  const hosts = selectedHosts(repoRoot);
  if (host && !hosts.includes(host)) throw new Error(`${host}를 먼저 설치하세요.`);
  return (host ? [host] : hosts).map(selected => {
  if (selected === "codex") {
    const overrides = readCodexOverrides(repoRoot);
    return ["Codex 에이전트별 모델·추론 강도 (제품 기본값):", ...AGENTS.map(agent => {
      const config = codexModelOf(repoRoot, agent);
      return `  ${agent.padEnd(12)} ${config.model} / ${config.reasoning}${overrides[agent] ? "  (바꿈)" : "  (기본)"}`;
    }), "", "변경: 현재 세션에서 역할·모델·추론 강도 변경을 요청하세요. 수동 TTY: code-agent model <역할|all> <모델|default> --host codex [--reasoning <강도>]",
    "설정한 모델의 계정 사용 권한과 추론 강도 지원은 Codex가 판정합니다. 적용 후 호스트를 재시작하세요."].join("\n");
  }
  const overrides = readOverrides(repoRoot);
  return [
    "Claude 에이전트별 모델 (기본 opus):",
    ...AGENTS.map((agent) => `  ${agent.padEnd(12)} ${modelOf(repoRoot, agent)}${overrides[agent] ? "  (바꿈)" : ""}`),
    "",
    `바꾸기: 현재 세션에서 모델 변경을 요청하세요. 수동 TTY 대체 명령: code-agent model <${AGENTS.join("|")}|all> <${MODELS.join("|")}|default> --host claude`,
  ].join("\n");
  }).join("\n\n");
}

export interface ModelOptions { host?: Host; reasoning?: string }
export function validateModelChange(repoRoot: string, who: string | undefined, model: string | undefined, options: ModelOptions = {}) {
  const hosts = selectedHosts(repoRoot), host = options.host ?? (hosts.length === 1 ? hosts[0] : undefined);
  if (!host) throw new Error("두 호스트가 설치되어 있습니다. --host claude 또는 --host codex를 지정하세요.");
  if (!hosts.includes(host)) throw new Error(`${host}를 먼저 설치하세요.`);
  const name = who?.replace(/^ca[-_]/, "");
  if (!name || (name !== "all" && !AGENTS.includes(name as AgentName))) {
    throw new Error(`에이전트는 ${AGENTS.join(", ")} 또는 all 입니다: ${who ?? "(없음)"}`);
  }
  if (host === "claude" && options.reasoning !== undefined) throw new Error("--reasoning은 Codex 전용입니다.");
  if (model === "default" && options.reasoning !== undefined) throw new Error("기본값 복원에는 추론 강도를 함께 지정하지 않습니다.");
  if (host === "claude" && model !== "default" && (!model || !MODELS.includes(model as ModelName))) {
    throw new Error(`모델은 ${MODELS.join(", ")} 중 하나입니다: ${model ?? "(없음)"}`);
  }
  if (host === "codex" && model !== "default" && !CodexModelSchema.safeParse({model,reasoning:options.reasoning ?? "medium"}).success) throw new Error(`Codex 모델 식별자와 추론 강도를 확인하세요: ${REASONING_LEVELS.join(", ")}`);
  return {host, name: name as AgentName | "all", model: model!};
}
export function setModel(repoRoot: string, who: string | undefined, model: string | undefined, options: ModelOptions = {}): string {
  const change = validateModelChange(repoRoot, who, model, options), name = change.name;
  requireTerminal("에이전트 모델");
  if (change.host === "codex") {
    const overrides = readCodexOverrides(repoRoot);
    for (const agent of name === "all" ? AGENTS : [name]) {
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
  const overrides = readOverrides(repoRoot);
  for (const agent of name === "all" ? AGENTS : [name as AgentName]) {
    if (model === DEFAULT_MODEL || model === "default") delete overrides[agent];
    else overrides[agent] = model as ModelName;
  }
  writeAtomic(join(repoRoot, MODELS_FILE), `${JSON.stringify(overrides, null, 2)}\n`);
  applyModels(repoRoot);
  return modelsTable(repoRoot, "claude");
}
