/** 접수 상태 읽기. hook·질문 관찰도 명령 모듈을 불러오지 않고 같은 구조를 검사한다. */
import { existsSync } from "fs";
import { join } from "path";
import type { WorkKind } from "../core/workOrder";
import { REQUEST_SESSION_FILE } from "./layout";
import { readJson } from "./stateJson";
import { Stop } from "./stop";

export interface RequestSession {
  id: string; kind: WorkKind; startedAt: string;
  /** 접수 때 받은 기준 브랜치와 대상을 확정 뒤 시작 명령으로 잇는다. */
  base?: string; target?: string;
}
export function loadRequestSession(root: string): RequestSession | undefined {
  const path = join(root, REQUEST_SESSION_FILE);
  if (!existsSync(path)) return undefined;
  return readJson(path, { parse(raw) {
    const value = raw as RequestSession | null;
    if (!value || Array.isArray(value) || typeof value.id !== "string" || !value.id ||
        (value.kind !== undefined && !["feature", "fix", "refactor"].includes(value.kind)) ||
        [value.startedAt, value.base, value.target].some(v => v !== undefined && typeof v !== "string")) throw new Stop("접수 세션 형식이 올바르지 않습니다");
    return value;
  } }, REQUEST_SESSION_FILE);
}
