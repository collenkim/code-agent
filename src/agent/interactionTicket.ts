/** hook이 발행한 세션 결속. 질문 입력으로 세션·재개 명령을 지정하지 못하게 한다. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { writeAtomic } from "../core/atomic";
import { Stop } from "./stop";
import { INTERACTIONS_DIR } from "./interactionPaths";

export interface InteractionTicket { sessionId: string; host: "claude" | "codex"; command: string; at: number; runId?: string }
const path = (root: string, command: string) => join(root, INTERACTIONS_DIR, "tickets", `${createHash("sha256").update(command).digest("hex")}.json`);
export function issueInteractionTicket(root: string, ticket: Omit<InteractionTicket, "at">): void {
  const file = path(root, ticket.command); mkdirSync(join(file, ".."), { recursive: true });
  writeAtomic(file, JSON.stringify({ ...ticket, at: Date.now() }));
}
export function takeInteractionTicket(root: string, command: string): InteractionTicket {
  const file = path(root, command), taken = `${file}.${process.pid}.taking`;
  if (!existsSync(file)) throw new Stop("현재 메인 세션의 hook이 질문 명령을 관찰해야 합니다.");
  renameSync(file, taken);
  try {
    const value = JSON.parse(readFileSync(taken, "utf8")) as InteractionTicket;
    if (!value.sessionId || !["claude", "codex"].includes(value.host) || !Number.isFinite(value.at) || value.command !== command || Date.now() - value.at > 900000 || value.at > Date.now() + 60000) throw new Stop("질문 세션 티켓이 만료되거나 다릅니다");
    return value;
  } finally { rmSync(taken, { force: true }); }
}
