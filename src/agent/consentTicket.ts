/**
 * 동의 준비·적용 티켓 — "이 세션의 hook 이 동의 준비·적용 명령을 방금 허용했다"는 표지(CON-1·CON-2).
 *
 * 준비 티켓은 **인자 글자와 무관하다** — 저장소당 하나(`prepare.json`)이고 가장 최근 것만 남는다. 그래서 hook 과 CLI 가 인자를
 * 같은 방법으로 해석할 필요가 없다(셸·작업 경로·따옴표 차이, 이후 `--action` 같은 형식). 적용 티켓의 키는 동의 UUID 하나다.
 * CLI 는 티켓을 rename 으로 가로채 읽고 지운다 — 두 프로세스가 같은 티켓을 얻지 못한다.
 *
 * hook 이 모든 셸 호출에서 읽으므로 consent.ts·zod·commands 를 import 하지 않는다. 위치가 consents/ 아래라 동의 스냅샷에서 빠진다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "fs";
import { join } from "path";

import { writeAtomic } from "../core/atomic";
import { hostMarked } from "./crossEnv";
import { TIMING } from "./retryPolicy";

export type TicketKind = "prepare" | "apply";
export interface ConsentTicket {
  kind: TicketKind;
  /** apply: 동의 UUID */
  id?: string;
  sessionId: string;
  host: "claude" | "codex";
  cwd: string;
  command: string;
  at: string;
}
const DIR = ".code-agent/consents/tickets";
const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const PREPARE = /^code-agent consent prepare\s+\S/;
const APPLY = new RegExp(`^code-agent consent (?:apply|finish) (${UUID})$`);

export const PREPARE_UNOBSERVED =
  "이 준비 명령을 호스트 hook 이 관찰하지 못했습니다 — 동의는 메인 세션의 셸에서 `code-agent consent prepare …` 를 이 꼴 그대로(셸 연결자·리디렉션·다른 명령을 붙이지 않고) 실행해 준비합니다. " +
  "다른 실행 경로·래퍼·15분 넘게 기다린 명령, 다른 세션이 같은 때 준비해 티켓이 바뀐 경우는 세션을 확인할 수 없습니다 — 다시 실행하세요. " +
  "hook 이 동작하는지는 사람이 code-agent doctor 로 확인합니다. 사람이 터미널에서 직접 확인하려면 confirm · approve · deliver 같은 직접 명령을 씁니다.";
export const APPLY_UNOBSERVED =
  "이 적용 명령을 호스트 hook 이 관찰하지 못했습니다 — 응답을 받은 세션의 셸에서 `code-agent consent finish <ID>`(또는 apply) 를 이 꼴 그대로 실행하세요. 다른 실행 경로로는 적용하지 않습니다.";

/**
 * hook 이 본 셸 명령이 동의 준비·적용인가. 정확한 꼴만 인정한다 — prepare 는 인자 내용을 보지 않는다(CLI 가 해석한다).
 * 셸 연결자·치환이 든 명령은 hook.ts 가 이 함수를 부르기 전에 거른다.
 */
export function consentCommandOf(command: string): { kind: "prepare" } | { kind: "apply"; id: string } | undefined {
  const text = command.trim();
  if (PREPARE.test(text)) return { kind: "prepare" };
  const match = APPLY.exec(text);
  return match ? { kind: "apply", id: match[1] } : undefined;
}

function fileOf(kind: TicketKind, id?: string): string {
  return kind === "prepare" ? "prepare.json" : `apply-${id}.json`;
}
function expired(ticket: Pick<ConsentTicket, "at">, now: number): boolean {
  const at = Date.parse(ticket.at);
  return !Number.isFinite(at) || now - at > TIMING.consentTicketTtlMs || at - now > 60_000;
}

/** 같은 폴더의 만료 티켓과 끊긴 가로채기 파일을 지운다 */
function sweep(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (name.endsWith(".taking")) { rmSync(path, { force: true }); continue; }
      if (!name.endsWith(".json")) continue;
      if (expired(JSON.parse(readFileSync(path, "utf8")) as ConsentTicket, now)) rmSync(path, { force: true });
    } catch { /* 다른 프로세스가 가져갔다 */ }
  }
}

/** prepare → `prepare.json`(덮어쓴다), apply → `apply-<UUID>.json` */
export function issueTicket(root: string, ticket: Omit<ConsentTicket, "at">, now = Date.now()): void {
  if (ticket.kind === "apply" && !(ticket.id && new RegExp(`^${UUID}$`).test(ticket.id))) throw new Error("적용 티켓에는 동의 ID 가 필요합니다.");
  const dir = join(root, DIR);
  mkdirSync(dir, { recursive: true });
  try { sweep(dir, now); } catch { /* 정리는 덤이다 */ }
  writeAtomic(join(dir, fileOf(ticket.kind, ticket.id)), `${JSON.stringify({ ...ticket, at: new Date(now).toISOString() })}\n`);
}

/** 티켓을 가로채 읽고 지운다. 없거나 만료면 undefined(만료 파일은 지운다) */
export function takeTicket(root: string, kind: TicketKind, id?: string, now = Date.now()): ConsentTicket | undefined {
  if (kind === "apply" && !(id && new RegExp(`^${UUID}$`).test(id))) return undefined;
  const path = join(root, DIR, fileOf(kind, id));
  if (!existsSync(path)) return undefined;
  const taking = `${path}.${process.pid}.taking`;
  try { renameSync(path, taking); } catch { return undefined; }   // 다른 프로세스가 먼저 가져갔다
  try {
    const ticket = JSON.parse(readFileSync(taking, "utf8")) as ConsentTicket;
    if (ticket.kind !== kind || (kind === "apply" && ticket.id !== id) || typeof ticket.sessionId !== "string" || !ticket.sessionId
        || (ticket.host !== "claude" && ticket.host !== "codex") || expired(ticket, now)) return undefined;
    return ticket;
  } catch { return undefined; }
  finally { rmSync(taking, { force: true }); }
}

/** CLI 적용 경로의 호출자 — TTY 이고 호스트 표지가 없을 때만 사람의 터미널로 본다 */
export function terminalCaller(isTTY: boolean | undefined, env: NodeJS.ProcessEnv): { tty: true } | undefined {
  return isTTY && !hostMarked(env) ? { tty: true } : undefined;
}
