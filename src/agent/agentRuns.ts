/**
 * 담당 실행 장부 — 메인이 부른 담당(계획·리뷰·구현·테스트)의 실행 중·마지막 완료를 작업별로 둔다. Stop hook 이 "담당이 끝났는데
 * 메인이 다음 행동 없이 턴을 끝내는" 자리를 이 장부로 가른다(stopHook.ts continuation).
 *
 * - 쓰는 쪽: 담당 hook(planningHook·reviewHook·agentHook)이 판정·기록을 마친 **뒤** 시작·되돌림·완료를 적는다. 완료는 다음 행동이 있는
 *   결과(처리한 결과·기록한 실패·hook 판정 실패)만 남긴다 — 중복 완료 알림·취소된 배정의 늦은 결과·이미 기록한 결과·게이트에 쓰지 않는
 *   실행은 실행 중 표시만 지운다(advance:false). 같은 담당에게 되돌린 실행(되돌림 대기)은 실행 중으로 둔다 — 담당이 이어서 끝낸다.
 * - 지우는 쪽: 메인의 진행 명령(cliMain.runCommand — 읽기 전용이 아닌 명령)과 새 담당 시작. 둘 다 메인이 완료를 받아 다음 행동을 했다는 뜻이다.
 * - 완료마다 eventId 를 붙인다. Stop 차단 사유에 그 값이 들어가므로 같은 완료로는 한 세션에서 한 번만 막는다(hookLog blockedBefore).
 * - 쓰기는 잠금 안에서 다시 읽고 고친다. 기록 실패는 삼킨다 — 장부는 진행을 잇는 보조이고, 게이트·배정 판정은 각 상태 파일이 한다.
 */
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeAtomic } from "../core/atomic";
import { currentCursor } from "./branchCursor";
import { STATE_DIR } from "./layout";
import { acquireLock } from "./lock";
import { TIMING } from "./retryPolicy";

export const AGENT_RUNS_FILE = `${STATE_DIR}/agent-runs.json`;
export type RunSource = "planning" | "review" | "implement";
type Host = "claude" | "codex";
export interface AgentRun { source: RunSource; type: string; phase: string; startedAt: string; session?: string; host?: Host; returnedAt?: string }
export interface Completion { eventId: string; agent: string; source: RunSource; type: string; status: string; phase: string; at: string; session?: string; host?: Host; wokenAt?: string }
interface WorkRuns { running: Record<string, AgentRun>; completed?: Completion }
interface Ledger { version: 1; works: Record<string, WorkRuns> }

function readLedger(root: string): Ledger {
  try {
    const value = JSON.parse(readFileSync(join(root, AGENT_RUNS_FILE), "utf8")) as Ledger;
    if (value?.version === 1 && value.works && typeof value.works === "object" && !Array.isArray(value.works)) return value;
  } catch { /* 없거나 깨진 장부는 빈 장부다 — 다음 쓰기가 덮는다 */ }
  return { version: 1, works: {} };
}

/** 잠금 안에서 다시 읽고 고친다. change 가 false 면 쓰지 않는다. 상태 폴더가 없으면(설치 전) 아무것도 하지 않는다 */
function mutate(root: string, change: (ledger: Ledger) => boolean, waitMs: number = TIMING.hookLockWaitMs): void {
  if (!existsSync(join(root, STATE_DIR))) return;
  try {
    const release = acquireLock(join(root, `${AGENT_RUNS_FILE}.lock`), { waitMs, ageReclaim: true, label: "담당 실행 장부", display: `${AGENT_RUNS_FILE}.lock` });
    try {
      const ledger = readLedger(root);
      if (!change(ledger)) return;
      for (const [id, entry] of Object.entries(ledger.works)) if (!entry.completed && !Object.keys(entry.running).length) delete ledger.works[id];
      writeAtomic(join(root, AGENT_RUNS_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
    } finally {
      release();
    }
  } catch { /* 장부 기록 실패가 hook·명령을 세우지 않는다 */ }
}

/** 담당 시작 — 메인이 새 담당을 불렀으면 앞 완료는 처리된 것이다 */
export function noteAgentStarted(root: string, workId: string, agent: string, run: Omit<AgentRun, "startedAt">): void {
  mutate(root, (ledger) => {
    const entry = ledger.works[workId] ??= { running: {} };
    entry.running[agent] = { ...run, startedAt: new Date().toISOString() };
    delete entry.completed;
    return true;
  });
}

/** 같은 담당에게 되돌렸다 — 담당이 이어서 끝내므로 실행 중으로 둔다 */
export function noteAgentReturned(root: string, workId: string, agent: string): void {
  mutate(root, (ledger) => {
    const run = ledger.works[workId]?.running[agent];
    if (!run) return false;
    run.returnedAt = new Date().toISOString();
    return true;
  });
}

/** 담당 종료 — advance 면 메인이 다음 행동을 할 완료로 남긴다 */
export function noteAgentFinished(root: string, workId: string, agent: string, done: Omit<Completion, "eventId" | "agent" | "at"> & { advance: boolean }): void {
  const { advance, ...rest } = done;
  mutate(root, (ledger) => {
    const had = !!ledger.works[workId]?.running[agent];
    if (had) delete ledger.works[workId].running[agent];
    if (!advance) return had;
    (ledger.works[workId] ??= { running: {} }).completed = { eventId: randomUUID(), agent, ...rest, at: new Date().toISOString() };
    return true;
  });
}

/**
 * 담당 hook 의 판정이 기록 전에 실패했는데 담당은 끝났다(종료 코드 0 — 기록한 실패이거나 이미 한 번 되돌린 뒤) — 실행 중 표시를 완료로 바꾼다.
 * 메인의 다음 진행 명령(planning advance·리뷰 게이트)이 그 실행의 상태를 보고 복구 행동을 낸다. 앞에서 이미 종료를 적었으면 아무것도 하지 않는다.
 */
export function settleAgent(root: string, agent: string, status: string): void {
  mutate(root, (ledger) => {
    const found = Object.entries(ledger.works).find(([, entry]) => entry.running[agent]);
    if (!found) return false;
    const [, entry] = found, run = entry.running[agent];
    delete entry.running[agent];
    entry.completed = { eventId: randomUUID(), agent, source: run.source, type: run.type, status, phase: run.phase, at: new Date().toISOString(),
      ...(run.session ? { session: run.session } : {}), ...(run.host ? { host: run.host } : {}) };
    return true;
  });
}

/** 회수한 배정의 담당 — 끝을 관찰하지 못해도(되돌림 뒤 종료·중단) 실행 중으로 세지 않는다(planning cancel). 나중에 오는 늦은 결과는 완료로 남지 않는다 */
export function forgetAgents(root: string, workId: string, agents: readonly string[]): void {
  if (!agents.length || !existsSync(join(root, AGENT_RUNS_FILE))) return;
  mutate(root, (ledger) => {
    const entry = ledger.works[workId];
    const known = agents.filter((agent) => entry?.running[agent]);
    for (const agent of known) delete entry!.running[agent];
    return known.length > 0;
  }, TIMING.lockWaitMs);
}

/** 이 완료로 쉬는 메인을 깨울 차례를 잡는다 — 같은 완료(eventId)는 한 번만 잡힌다(동시에 끝난 깨우기 hook 둘 중 하나). 잡았으면 true */
export function claimWake(root: string, workId: string, eventId: string): boolean {
  let claimed = false;
  mutate(root, (ledger) => {
    const completed = ledger.works[workId]?.completed;
    if (completed?.eventId !== eventId || completed.wokenAt) return false;
    completed.wokenAt = new Date().toISOString();
    return claimed = true;
  });
  return claimed;
}

/** 메인이 진행 명령을 실행했다 — 지금 작업의 완료를 처리된 것으로 본다(cliMain.runCommand) */
export function consumeCompletion(root: string): void {
  if (!existsSync(join(root, AGENT_RUNS_FILE))) return;
  let workId: string | undefined;
  try { workId = currentCursor(root)?.active.id; } catch { return; }
  if (!workId || !readLedger(root).works[workId]?.completed) return;
  mutate(root, (ledger) => {
    const entry = ledger.works[workId!];
    if (!entry?.completed) return false;
    delete entry.completed;
    return true;
  }, TIMING.lockWaitMs);
}

/**
 * 메인이 아직 처리하지 않은 완료와 그 작업에서 실행 중인 담당 수. 시작 뒤 TIMING.orphanRunMs 가 지난 실행 중 표시는 세지 않는다 —
 * 끝을 관찰하지 못한 담당(호스트 종료·hook 누락)이 완료 뒤 진행을 영영 막지 않게.
 */
export function pendingCompletion(root: string, workId: string, now: number = Date.now()): { completion: Completion; running: number } | undefined {
  const entry = readLedger(root).works[workId];
  if (!entry?.completed) return undefined;
  const running = Object.values(entry.running).filter((run) => now - Date.parse(run.startedAt) < TIMING.orphanRunMs).length;
  return { completion: entry.completed, running };
}
