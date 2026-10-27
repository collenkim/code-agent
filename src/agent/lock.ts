/**
 * 공통 파일 잠금 — 계획 기록·리뷰 기록·작업 임대·동의 적용이 같이 쓴다.
 *
 * 잠금 파일을 `wx` 로 만들고 주인 `{pid, host, at, started?, nonce}` 을 적는다. 이미 있으면 retryPolicy.lockDecision 으로 판정한다:
 * 같은 PC 의 죽은 주인은 같은 호출 안에서 회수하고(stderr 한 줄), 살아 있는 주인은 waitMs 까지 기다린 뒤 멈추며,
 * 다른 PC·주인 기록 없음은 사람에게 넘긴다(나이 회수를 허용한 잠금만 TIMING.lockStaleMs 뒤 회수한다).
 * CLI 는 스스로 다시 실행하지 않는다 — 기다림이 끝나면 Stop 의 안내대로 메인이 같은 명령을 한 번 다시 부른다.
 *
 * 회수는 `<잠금>.reclaim` 가드를 `wx` 로 잡은 프로세스 하나만 한다(다시 읽기 → 다시 판정 → 지우기). 가드 없이 둘이 같은
 * 죽은 잠금을 회수하면, 한쪽이 지우고 새로 잡은 잠금을 다른 쪽이 지워 둘 다 잠금을 얻는다. 해제는 파일 내용이 자기
 * 기록과 같을 때만 지운다 — 잘못 회수된 잠금의 해제가 남의 잠금을 지우는 연쇄를 막는다.
 */
import { randomUUID } from "crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "fs";
import { hostname } from "os";
import { lockDecision, TIMING, type LockOwner } from "./retryPolicy";
import { Stop } from "./stop";
import { ownProcessIdentity, processIdentity } from "./processIdentity";

/** Stop 문구에 넘기는 값 */
export interface LockView { label: string; display: string; pid?: number; host?: string; at?: string; ageSec: number; ageReclaim: boolean }
export interface LockMessages {
  /** 같은 PC 의 살아 있는 주인 */
  busy?: (lock: LockView) => string;
  /** 다른 PC 의 주인 */
  foreign?: (lock: LockView) => string;
  /** 주인 기록 없음(옛 빈 잠금·손상·읽을 수 없음) */
  unknown?: (lock: LockView) => string;
  /** 다른 프로세스가 같은 잠금을 회수하는 중이라 기한 안에 끝나지 않았다 */
  reclaiming?: (lock: LockView) => string;
}
export interface LockOptions {
  waitMs: number; ageReclaim: boolean; label: string;
  /** 사용자에게 보일 잠금 경로. 없으면 path 그대로 */
  display?: string;
  /** 호출자별 Stop 문구. 없는 항목은 기본 문구 */
  messages?: LockMessages;
  /** 같은 PC의 살아 있는 PID에 대해 호출자가 아는 실행 표지까지 대조한다. 확인 실패는 undefined. */
  identity?: (owner: LockOwner) => boolean | undefined;
}

/** 대기 간격 */
const POLL_MS = 20;
/** 주인을 쓰기 직전(열기와 쓰기 사이)이거나 막 풀리는 잠금을 넘기는 유예 */
const OWNER_WRITE_GRACE_MS = 200;
/** 한 호출이 회수하는 잠금 수 상한 — 회수와 재생성이 엇갈리는 경합에서 끝없이 돌지 않게 */
const MAX_RECLAIM = 3;
/** 회수 가드가 이만큼 오래됐으면(또는 같은 PC 의 주인이 죽었으면) 끊긴 회수로 보고 치운다 — 가드는 몇 ms 만 쥔다 */
const RECLAIM_GUARD_STALE_MS = 30_000;

/** 잠금을 쥔 프로세스가 아직 있는가. 권한이 없어 못 보는 프로세스는 있는 것으로 본다 */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
/** Windows 에서 지워지는 중인 파일을 열거나 읽으면 EPERM·EACCES 가 잠깐 난다 — 기한까지 다시 본다 */
const transient = (error: unknown): boolean => process.platform === "win32" && (code(error) === "EPERM" || code(error) === "EACCES");

export const DEFAULT_LOCK_MESSAGES: Required<LockMessages> = {
  busy: (lock) => `${lock.label} 잠금을 다른 code-agent 프로세스가 쥐고 있습니다 (pid ${lock.pid}, ${lock.at ?? "시각 모름"} 시작). ` +
    `잠시 뒤 같은 명령을 한 번만 다시 실행하세요. 계속 막히면 그 프로세스가 멈췄는지 확인하세요 — 잠금: ${lock.display}`,
  foreign: (lock) => `${lock.label} 잠금을 다른 PC(${lock.host}, pid ${lock.pid})가 쥐고 있습니다. ` +
    `그 PC의 code-agent가 끝났으면 사람이 별도 터미널에서 ${lock.display} 을 지운 뒤 다시 실행하세요.`,
  unknown: (lock) => lock.ageReclaim
    ? `${lock.label} 잠금의 주인을 확인할 수 없습니다(${lock.ageSec}초 전 생성). ${Math.round(TIMING.lockStaleMs / 60_000)}분이 지나면 다음 실행이 자동으로 회수합니다. ` +
      `실행 중인 code-agent가 없으면 사람이 별도 터미널에서 ${lock.display} 을 지운 뒤 다시 실행해도 됩니다.`
    : `${lock.label} 잠금의 주인을 확인할 수 없습니다. 실행 중인 code-agent가 없으면 사람이 별도 터미널에서 ${lock.display} 을 지운 뒤 다시 실행하세요.`,
  reclaiming: (lock) => `${lock.label} 잠금을 다른 프로세스가 회수하는 중입니다. 잠시 뒤 같은 명령을 한 번만 다시 실행하세요. ` +
    `계속 막히면 실행 중인 code-agent가 없는지 확인한 뒤 사람이 별도 터미널에서 ${lock.display}.reclaim 을 지운 뒤 다시 실행하세요.`,
};

/** 잠금 파일 한 번 보기. gone: 그 사이 풀렸다. text 는 읽지 못하면 ""(주인 불명), mtimeMs 는 stat 하지 못하면 지금(나이 0) */
type Seen = { gone: true } | { gone: false; text: string; mtimeMs: number; busy: boolean };
function observe(path: string, now: number): Seen {
  let text = "", mtimeMs = now, busy = false;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if (code(error) === "ENOENT") return { gone: true }; busy ||= transient(error); }
  try { mtimeMs = statSync(path).mtimeMs; }
  catch (error) { if (code(error) === "ENOENT") return { gone: true }; busy ||= transient(error); }
  return { gone: false, text, mtimeMs, busy };
}
function ownerOf(text: string): LockOwner | undefined {
  try { const value: unknown = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as LockOwner : undefined; }
  catch { return undefined; }
}

/** 파일을 wx 로 만들고 기록을 쓴다. 이미 있으면 undefined. 쓰기에 실패하면 치우고 원래 오류를 던진다 */
function create(path: string, record: string): number | undefined {
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) { if (code(error) === "EEXIST") return undefined; throw error; }
  try { writeSync(fd, record); }
  catch (error) { try { closeSync(fd); } catch { /* 이미 닫혔다 */ } try { unlinkSync(path); } catch { /* 이미 치워졌다 */ } throw error; }
  return fd;
}
/** 내용이 기록과 같을 때만 지운다 */
function removeIfMine(path: string, record: string): void {
  try { if (readFileSync(path, "utf8") === record) unlinkSync(path); } catch { /* 이미 치워졌다 */ }
}
/** 끊긴 회수 가드(주인이 죽었거나 오래됨)면 치우고 true */
function clearStaleGuard(guard: string, me: string): boolean {
  try {
    const text = readFileSync(guard, "utf8");
    const owner = ownerOf(text);
    const dead = owner?.host === me && typeof owner.pid === "number" && !pidAlive(owner.pid);
    if (!dead && Date.now() - statSync(guard).mtimeMs <= RECLAIM_GUARD_STALE_MS) return false;
    // 같은 끊긴 가드를 둘이 동시에 치우는 경우(가드 주인이 회수 도중 죽은 뒤에만 생긴다)는 막지 못한다
    if (readFileSync(guard, "utf8") !== text) return false;
    unlinkSync(guard);
    return true;
  } catch { return false; }
}
/** 회수 가드를 잡는다. 다른 프로세스가 쥐고 있으면 undefined */
function claimGuard(guard: string, me: string): (() => void) | undefined {
  const record = JSON.stringify({ pid: process.pid, host: me, at: new Date().toISOString(), nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try { fd = create(guard, record); }
    catch (error) { if (!transient(error)) throw error; }
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 이미 닫혔다 */ }
      return () => removeIfMine(guard, record);
    }
    if (attempt === 0 && !clearStaleGuard(guard, me)) return undefined;
  }
  return undefined;
}

/**
 * 잠금을 얻고 해제 함수를 돌려준다. 잠금 폴더는 호출자가 만든다. 해제는 여러 번 불러도 한 번만, 자기 기록일 때만 지운다.
 * 얻지 못하면 Stop(사유·경로·다시 실행 안내)을 던진다.
 */
export function acquireLock(path: string, options: LockOptions): () => void {
  const display = options.display ?? path;
  const messages = { ...DEFAULT_LOCK_MESSAGES, ...options.messages };
  const deadline = Date.now() + options.waitMs;
  const me = hostname();
  const started = ownProcessIdentity();
  const identity = (owner: LockOwner): boolean | undefined => {
    if (options.identity?.(owner) === false) return false;
    if (typeof owner.started !== "string") return undefined;
    const actual = owner.pid === process.pid ? started : processIdentity(owner.pid!);
    return actual === undefined ? undefined : actual === owner.started;
  };
  const unseen = (): LockView => ({ label: options.label, display, ageSec: 0, ageReclaim: options.ageReclaim });
  let reclaimed = 0;
  let stopSince: number | undefined;
  for (;;) {
    const record = JSON.stringify({ pid: process.pid, host: me, at: new Date().toISOString(), ...(started ? { started } : {}), nonce: randomUUID() });
    let fd: number | undefined;
    try { fd = create(path, record); }
    catch (error) {
      if (!transient(error)) throw error;
      if (Date.now() < deadline) { sleep(POLL_MS); continue; }
      throw new Stop(messages.unknown(unseen()));
    }
    if (fd !== undefined) {
      const handle = fd;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { closeSync(handle); } catch { /* 이미 닫혔다 */ }
        removeIfMine(path, record);
      };
    }
    const now = Date.now();
    const seen = observe(path, now);
    if (seen.gone) continue;   // 그 사이 풀렸다
    if (seen.busy && now < deadline) { sleep(POLL_MS); continue; }
    const { text, mtimeMs } = seen;
    const owner = ownerOf(text);
    const known = typeof owner?.pid === "number" && typeof owner.host === "string";
    const sameHost = known && owner!.host === me;
    const ageMs = Math.max(0, now - mtimeMs);
    const alive = sameHost ? pidAlive(owner!.pid!) : undefined;
    const decision = lockDecision({ owner, sameHost, alive, identity: sameHost && alive ? identity(owner!) : undefined, ageMs, ageReclaim: options.ageReclaim });
    const view: LockView = { label: options.label, display, ...(known ? { pid: owner!.pid, host: owner!.host } : {}),
      ...(typeof owner?.at === "string" ? { at: owner.at } : {}), ageSec: Math.round(ageMs / 1000), ageReclaim: options.ageReclaim };
    if (decision === "reclaim" && reclaimed < MAX_RECLAIM) {
      const releaseGuard = claimGuard(`${path}.reclaim`, me);
      if (!releaseGuard) {
        // 다른 프로세스가 회수 중이다 — 끝나면 그 결과(빈 자리 또는 새 주인)를 다시 본다
        if (now < deadline) { sleep(POLL_MS); continue; }
        throw new Stop(messages.reclaiming(view));
      }
      try {
        // 가드 안에서 다시 보고 다시 판정한다 — 그 사이 다른 프로세스가 회수하고 새로 잡았으면 건드리지 않는다
        const again = observe(path, Date.now());
        const still = !again.gone && !again.busy && again.text === text && lockDecision({ owner, sameHost,
          alive: sameHost ? pidAlive(owner!.pid!) : undefined, identity: sameHost ? identity(owner!) : undefined,
          ageMs: Math.max(0, Date.now() - again.mtimeMs), ageReclaim: options.ageReclaim }) === "reclaim";
        if (still) {
          unlinkSync(path);
          reclaimed++;
          const why = known ? `pid ${owner!.pid} 종료 또는 재사용` : `주인 기록 없음, ${Math.floor(ageMs / 60_000)}분 경과`;
          process.stderr.write(`code-agent: ${options.label} 잠금을 회수했습니다 — ${why}\n`);
        }
      } catch { /* 이미 치워졌다 */ }
      finally { releaseGuard(); }
      continue;
    }
    if (decision === "wait" && now < deadline) { sleep(POLL_MS); continue; }
    if (decision === "wait") throw new Stop(messages.busy(view));
    stopSince ??= now;
    if (now - stopSince < OWNER_WRITE_GRACE_MS) { sleep(POLL_MS); continue; }
    throw new Stop(known && !sameHost ? messages.foreign(view) : messages.unknown(view));
  }
}
