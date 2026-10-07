/**
 * 공통 파일 잠금 — 계획 기록·리뷰 기록·작업 임대·동의 적용이 같이 쓴다.
 *
 * 잠금 파일을 `wx` 로 만들고 주인 `{pid, host, at}` 을 적는다. 이미 있으면 retryPolicy.lockDecision 으로 판정한다:
 * 같은 PC 의 죽은 주인은 같은 호출 안에서 회수하고(stderr 한 줄), 살아 있는 주인은 waitMs 까지 기다린 뒤 멈추며,
 * 다른 PC·주인 기록 없음은 사람에게 넘긴다(나이 회수를 허용한 잠금만 주인 없는 잠금을 10분 뒤 회수한다).
 * CLI 는 스스로 다시 실행하지 않는다 — 기다림이 끝나면 Stop 의 안내대로 메인이 같은 명령을 한 번 다시 부른다.
 */
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { lockDecision, TIMING, type LockOwner } from "./retryPolicy";
import { Stop } from "./stop";

/** Stop 문구에 넘기는 값 */
export interface LockView { label: string; display: string; pid?: number; host?: string; at?: string; ageSec: number; ageReclaim: boolean }
export interface LockMessages {
  /** 같은 PC 의 살아 있는 주인 */
  busy?: (lock: LockView) => string;
  /** 다른 PC 의 주인 */
  foreign?: (lock: LockView) => string;
  /** 주인 기록 없음(옛 빈 잠금·손상) */
  unknown?: (lock: LockView) => string;
}
export interface LockOptions {
  waitMs: number; ageReclaim: boolean; label: string;
  /** 사용자에게 보일 잠금 경로. 없으면 path 그대로 */
  display?: string;
  /** 호출자별 Stop 문구. 없는 항목은 기본 문구 */
  messages?: LockMessages;
}

/** 대기 간격 */
const POLL_MS = 20;
/** 주인을 쓰기 직전(열기와 쓰기 사이)이거나 막 풀리는 잠금을 넘기는 유예 */
const OWNER_WRITE_GRACE_MS = 200;
/** 한 호출이 회수하는 잠금 수 상한 — 회수와 재생성이 엇갈리는 경합에서 끝없이 돌지 않게 */
const MAX_RECLAIM = 3;

/** 잠금을 쥔 프로세스가 아직 있는가. 권한이 없어 못 보는 프로세스는 있는 것으로 본다 */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

export const DEFAULT_LOCK_MESSAGES: Required<LockMessages> = {
  busy: (lock) => `${lock.label} 잠금을 다른 code-agent 프로세스가 쥐고 있습니다 (pid ${lock.pid}, ${lock.at ?? "시각 모름"} 시작). ` +
    `잠시 뒤 같은 명령을 한 번만 다시 실행하세요. 계속 막히면 그 프로세스가 멈췄는지 확인하세요 — 잠금: ${lock.display}`,
  foreign: (lock) => `${lock.label} 잠금을 다른 PC(${lock.host}, pid ${lock.pid})가 쥐고 있습니다. ` +
    `그 PC의 code-agent가 끝났으면 사람이 별도 터미널에서 ${lock.display} 을 지운 뒤 다시 실행하세요.`,
  unknown: (lock) => lock.ageReclaim
    ? `${lock.label} 잠금의 주인을 확인할 수 없습니다(${lock.ageSec}초 전 생성). ${Math.round(TIMING.lockStaleMs / 60_000)}분이 지나면 다음 실행이 자동으로 회수합니다. ` +
      `실행 중인 code-agent가 없으면 사람이 별도 터미널에서 ${lock.display} 을 지운 뒤 다시 실행해도 됩니다.`
    : `${lock.label} 잠금의 주인을 확인할 수 없습니다. 실행 중인 code-agent가 없으면 사람이 별도 터미널에서 ${lock.display} 을 지운 뒤 다시 실행하세요.`,
};

/**
 * 잠금을 얻고 해제 함수를 돌려준다. 잠금 폴더는 호출자가 만든다. 해제는 여러 번 불러도 한 번만 지운다.
 * 얻지 못하면 Stop(사유·경로·다시 실행 안내)을 던진다.
 */
export function acquireLock(path: string, options: LockOptions): () => void {
  const display = options.display ?? path;
  const messages = { ...DEFAULT_LOCK_MESSAGES, ...options.messages };
  const deadline = Date.now() + options.waitMs;
  const me = hostname();
  let reclaimed = 0;
  let stopSince: number | undefined;
  for (;;) {
    let fd: number | undefined;
    try { fd = openSync(path, "wx", 0o600); }
    catch (error) { if (code(error) !== "EEXIST") throw error; }
    if (fd !== undefined) {
      const handle = fd;
      try { writeSync(handle, JSON.stringify({ pid: process.pid, host: me, at: new Date().toISOString() })); }
      catch (error) { try { closeSync(handle); } catch { /* 이미 닫혔다 */ } try { unlinkSync(path); } catch { /* 이미 치워졌다 */ } throw error; }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { closeSync(handle); } catch { /* 이미 닫혔다 */ }
        try { unlinkSync(path); } catch { /* 이미 치워졌다 */ }
      };
    }
    let text: string, mtimeMs: number;
    try { text = readFileSync(path, "utf8"); mtimeMs = statSync(path).mtimeMs; }
    catch (error) { if (code(error) === "ENOENT") continue; throw error; }   // 그 사이 풀렸다
    const now = Date.now();
    let owner: LockOwner | undefined;
    try { const value: unknown = JSON.parse(text); owner = value && typeof value === "object" ? value as LockOwner : undefined; } catch { owner = undefined; }
    const known = typeof owner?.pid === "number" && typeof owner.host === "string";
    const sameHost = known && owner!.host === me;
    const ageMs = Math.max(0, now - mtimeMs);
    const decision = lockDecision({ owner, sameHost, alive: sameHost ? pidAlive(owner!.pid!) : undefined, ageMs, ageReclaim: options.ageReclaim });
    const view: LockView = { label: options.label, display, ...(known ? { pid: owner!.pid, host: owner!.host } : {}),
      ...(typeof owner?.at === "string" ? { at: owner.at } : {}), ageSec: Math.round(ageMs / 1000), ageReclaim: options.ageReclaim };
    if (decision === "reclaim" && reclaimed < MAX_RECLAIM) {
      try {
        // 그 사이 다른 프로세스가 되찾아 새로 잡았으면 건드리지 않는다
        if (readFileSync(path, "utf8") === text) {
          unlinkSync(path);
          reclaimed++;
          const why = known ? `pid ${owner!.pid} 종료` : `주인 기록 없음, ${Math.floor(ageMs / 60_000)}분 경과`;
          process.stderr.write(`code-agent: ${options.label} 잠금을 회수했습니다 — ${why}\n`);
        }
      } catch { /* 이미 치워졌다 */ }
      continue;
    }
    if (decision === "wait" && now < deadline) { sleep(POLL_MS); continue; }
    if (decision === "wait") throw new Stop(messages.busy(view));
    stopSince ??= now;
    if (now - stopSince < OWNER_WRITE_GRACE_MS && now < deadline) { sleep(POLL_MS); continue; }
    throw new Stop(known && !sameHost ? messages.foreign(view) : messages.unknown(view));
  }
}
