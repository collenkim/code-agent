/** 설치와 별개인 실행 정책. hook에서도 읽으므로 명령 모듈을 import하지 않는다. */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Stop } from "./stop";
export type ExecutionMode = "auto" | "claude" | "codex" | "both";
export const EXECUTION_FILE = ".code-agent/execution.json";
export function executionMode(root: string): ExecutionMode | undefined {
  return executionPolicy(root)?.mode;
}
export function executionPolicy(root: string): { version: 1; mode: ExecutionMode; main?: "claude" | "codex" } | undefined {
  const file = join(root, EXECUTION_FILE);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value?.version !== 1 || !["auto", "claude", "codex", "both"].includes(value.mode)) throw new Stop("실행 방식 기록이 잘못됐습니다: .code-agent/execution.json");
  if (value.main !== undefined && (value.mode !== "both" || !["claude", "codex"].includes(value.main))) throw new Stop("교차 실행의 main은 claude·codex만 지정합니다");
  return value;
}
