import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { writeAtomic } from "../core/atomic";
import { STATE_DIR } from "./layout";
import { requireTerminal } from "./tty";

/**
 * 서브에이전트별 모델.
 *
 * 기본은 전부 opus 다. 사람이 `code-agent model <에이전트|all> <모델>` 로 바꾸면 `.code-agent/models.json` 에
 * 남고, `.claude/agents/ca-*.md` 의 `model:` 줄을 코드가 다시 쓴다 — Claude Code 가 읽는 것은 그 줄이다.
 * 정의 파일에 박아 두는 이유: 비워 두면 각자 PC 의 기본 모델로 돈다.
 * 설정 파일을 `.code-agent/` 에 두는 이유: 도구로는 못 쓰는 자리라 모델이 자기 모델을 바꿀 수 없고,
 * code-agent.json 이 생기기 전(도입 중)에도 에이전트는 돈다.
 */
export const AGENTS = ["surveyor", "analyst", "explorer", "writer", "critic", "implementer", "tester", "reviewer"] as const;
export type AgentName = (typeof AGENTS)[number];

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
export function applyModels(repoRoot: string): void {
  for (const agent of AGENTS) {
    const path = agentFile(repoRoot, agent);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");
    const line = `model: ${modelOf(repoRoot, agent)}`;
    const next = /^model:.*$/m.test(text)
      ? text.replace(/^model:.*$/m, line)
      : text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, head: string) => `---\n${head}\n${line}\n---`);
    if (next !== text) writeAtomic(path, next);
  }
}

export function modelsTable(repoRoot: string): string {
  const overrides = readOverrides(repoRoot);
  return [
    "에이전트별 모델 (기본 opus):",
    ...AGENTS.map((agent) => `  ${agent.padEnd(12)} ${modelOf(repoRoot, agent)}${overrides[agent] ? "  (바꿈)" : ""}`),
    "",
    `바꾸기: 현재 세션에서 모델 변경을 요청하세요. 수동 TTY 대체 명령: code-agent model <${AGENTS.join("|")}|all> <${MODELS.join("|")}>`,
  ].join("\n");
}

export function setModel(repoRoot: string, who: string | undefined, model: string | undefined): string {
  const name = who?.replace(/^ca-/, "");
  if (!name || (name !== "all" && !AGENTS.includes(name as AgentName))) {
    throw new Error(`에이전트는 ${AGENTS.join(", ")} 또는 all 입니다: ${who ?? "(없음)"}`);
  }
  if (!model || !MODELS.includes(model as ModelName)) {
    throw new Error(`모델은 ${MODELS.join(", ")} 중 하나입니다: ${model ?? "(없음)"}`);
  }
  requireTerminal("에이전트 모델");

  const overrides = readOverrides(repoRoot);
  for (const agent of name === "all" ? AGENTS : [name as AgentName]) {
    if (model === DEFAULT_MODEL) delete overrides[agent];
    else overrides[agent] = model as ModelName;
  }
  writeAtomic(join(repoRoot, MODELS_FILE), `${JSON.stringify(overrides, null, 2)}\n`);
  applyModels(repoRoot);
  return modelsTable(repoRoot);
}
