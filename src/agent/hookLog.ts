/**
 * hook 이 모델에게 낸 글의 기록 — PreToolUse 거부, Stop 차단, 담당 되돌림(SubagentStop exit 2), 세션 시작 주입, 쉬는 메인 깨우기.
 *
 * `usage` 가 이벤트별 횟수와 글자 수를 센다(측정용). 판정에 쓰는 곳은 하나다 — Stop 은 같은 세션에서 같은 사유로 이미
 * 막았으면 다시 막지 않고(`blockedBefore`), 완료 뒤 이어가기는 Stop 차단과 깨우기를 합쳐 한 번만 한다(`nudgedBefore`).
 * 글 자체는 남기지 않고 길이와 해시 앞 12자만 남긴다.
 *
 * `.code-agent/` 가 있는 저장소에서만 쓰고(설치되지 않은 저장소에 폴더를 만들지 않는다), 쓰기 실패는 삼킨다 — 집계용 기록이
 * hook 을 세우면 안 된다. 2MB 를 넘으면 `.old` 로 한 번 밀어낸다.
 */
import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { join } from "path";

import { findRepoRoot, STATE_DIR } from "./layout";

export const HOOK_LOG = `${STATE_DIR}/log/hooks.jsonl`;
const ROTATE_BYTES = 2_000_000;

/** deny: PreToolUse 거부 · block: Stop 차단·질문 도구 막음(exit 2) · return: 같은 담당에게 되돌림 · context: 세션 시작 주입 · wake: 쉬는 메인 깨우기(asyncRewake exit 2) */
export type HookOutputKind = "deny" | "block" | "return" | "context" | "wake";
export interface HookOutput {
  at: string;
  host: "claude" | "codex";
  event: string;
  kind: HookOutputKind;
  /** PreToolUse 의 도구 · SubagentStop 의 담당 · SessionStart 의 source */
  tool?: string;
  chars: number;
  /** 글의 sha256 앞 12자 — 같은 글을 묶는다 */
  key: string;
  session?: string;
  /** 하위 에이전트 안의 호출이면 그 agent_id */
  agent?: string;
}

export function reasonKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function noteHookOutput(root: string, entry: Omit<HookOutput, "at" | "chars" | "key"> & { text: string }): void {
  try {
    if (!entry.text || !existsSync(join(root, STATE_DIR))) return;
    const path = join(root, HOOK_LOG);
    mkdirSync(join(root, STATE_DIR, "log"), { recursive: true });
    try { if (statSync(path).size > ROTATE_BYTES) renameSync(path, `${path}.old`); } catch { /* 처음 쓰는 기록 */ }
    const { text, ...rest } = entry;
    const row: HookOutput = { at: new Date().toISOString(), ...rest, chars: text.length, key: reasonKey(text) };
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch {
    // 집계용 기록이 hook 을 세우면 안 된다
  }
}

/** 같은 담당에게 되돌린 사유(Claude SubagentStop exit 2 — stderr 가 담당에게 간다) */
export function noteSubagentReturn(input: { cwd?: string; hook_event_name?: string; agent_type?: string; session_id?: string; agent_id?: string } | undefined, text: string): void {
  try {
    const dir = process.env.CLAUDE_PROJECT_DIR ?? input?.cwd;
    if (!dir || input?.hook_event_name !== "SubagentStop") return;
    noteHookOutput(findRepoRoot(dir), { host: "claude", event: "SubagentStop", kind: "return", text, ...(input.agent_type ? { tool: input.agent_type } : {}),
      ...(input.session_id ? { session: input.session_id } : {}), ...(input.agent_id ? { agent: input.agent_id } : {}) });
  } catch { /* 측정용 기록이다 */ }
}

/** 시각 순. 깨진 줄은 그 줄만 버린다 — 쓰는 중일 수 있다 */
export function readHookOutputs(root: string): HookOutput[] {
  let text: string;
  try { text = readFileSync(join(root, HOOK_LOG), "utf8"); } catch { return []; }
  const rows: HookOutput[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<HookOutput>;
      if (typeof row.at === "string" && typeof row.event === "string" && typeof row.kind === "string" && typeof row.chars === "number" && typeof row.key === "string") rows.push(row as HookOutput);
    } catch { /* 반쯤 쓰인 줄 */ }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/** 같은 세션에서 같은 사유로 이미 막았는가 — 세션이 없으면 언제나 아니다 */
export function blockedBefore(root: string, session: string | undefined, event: string, key: string): boolean {
  if (!session) return false;
  return readHookOutputs(root).some((row) => row.session === session && row.event === event && row.kind === "block" && row.key === key);
}

/** 같은 세션에서 같은 사유로 이미 상기했는가 — Stop 차단과 쉬는 메인 깨우기를 함께 본다. 세션이 없으면 언제나 아니다 */
export function nudgedBefore(root: string, session: string | undefined, key: string): boolean {
  if (!session) return false;
  return readHookOutputs(root).some((row) => row.session === session && row.key === key && (row.kind === "wake" || (row.event === "Stop" && row.kind === "block")));
}
