/** 질문 원장의 공용 읽기. hook 요약은 쓰기·명령 모듈 없이 같은 구조를 검사한다. */
import { existsSync } from "fs";
import { join } from "path";
import type { InteractionRecord } from "./interactions";
import { INTERACTIONS_DIR } from "./interactionPaths";
import { readJson } from "./stateJson";
import { Stop } from "./stop";

export interface InteractionLedger {
  version: 1; instanceId: string; seq: number; requests: Record<string, InteractionRecord>;
  commands: Record<string, { hash: string; requestId: string; response: unknown }>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function readInteractions(root: string): InteractionLedger | undefined {
  const path = join(root, INTERACTIONS_DIR, "state.json");
  if (!existsSync(path)) return undefined;
  return readJson(path, { parse(raw) {
    const value = raw as InteractionLedger | null;
    if (!value || value.version !== 1 || typeof value.instanceId !== "string" || !value.instanceId ||
        !Number.isSafeInteger(value.seq) || value.seq < 0 || !object(value.requests) || !object(value.commands) ||
        Object.values(value.requests).some(r => !object(r) || !object(r.context) || typeof r.context.sessionId !== "string" || !Array.isArray(r.questions))) throw new Stop("질문 원장 형식을 확인할 수 없습니다");
    return value;
  } });
}
