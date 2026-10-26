/** hook이 발행한 세션 결속. MCP 입력의 세션은 hook이 실제 호출 세션과 먼저 대조한다. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { writeAtomic } from "../core/atomic";
import { Stop } from "./stop";
import { INTERACTIONS_DIR } from "./interactionPaths";

export interface InteractionTicket { sessionId: string; host: "claude" | "codex"; command: string; at: number; runId?: string }
const path = (root: string, command: string, sessionId?: string) => join(root, INTERACTIONS_DIR, "tickets", `${createHash("sha256").update(command === "mcp-ask" ? JSON.stringify([command, sessionId]) : command).digest("hex")}.json`);
export function issueInteractionTicket(root: string, ticket: Omit<InteractionTicket, "at">): void {
  const file = path(root, ticket.command, ticket.sessionId); mkdirSync(join(file, ".."), { recursive: true });
  writeAtomic(file, JSON.stringify({ ...ticket, at: Date.now() }));
}
export function takeInteractionTicket(root: string, command: string, sessionId?: string): InteractionTicket {
  if (command === "mcp-ask" && !sessionId) throw new Stop("질문 입력에 현재 hook이 안내한 sessionId를 넣으세요. 선택 도구에 이 인자가 없으면 Codex 세션을 다시 여세요.");
  const file = path(root, command, sessionId), taken = `${file}.${process.pid}.taking`;
  if (!existsSync(file)) throw new Stop("현재 메인 세션의 hook이 질문 명령을 관찰해야 합니다.");
  renameSync(file, taken);
  try {
    const value = JSON.parse(readFileSync(taken, "utf8")) as InteractionTicket;
    if (!value.sessionId || sessionId && value.sessionId !== sessionId || !["claude", "codex"].includes(value.host) || !Number.isFinite(value.at) || value.command !== command || Date.now() - value.at > 900000 || value.at > Date.now() + 60000) throw new Stop("질문 세션 티켓이 만료되거나 다릅니다");
    return value;
  } finally { rmSync(taken, { force: true }); }
}
