/**
 * 작업 임대(FLOW-16) — 같은 작업의 상태를 두 세션(호스트)이 모르는 사이 동시에 바꾸는 사고를 막는다.
 *
 * `.code-agent/lease.json` 에 이 작업을 진행 중인 호스트·세션과 마지막 활동 시각을 둔다. PreToolUse hook(hook.ts decideTool —
 * 작업 모드에서 기존 판정이 허용일 때만, 동의 티켓 발급 전)이 상태를 바꾸는 호출(진행 명령·쓰기)마다 대조한다:
 * - 다른 세션이 쥔 신선한 임대면 거부한다(분류 precondition — 재시도 금지, 사용자 확인 뒤 `code-agent takeover`).
 * - 같은 주인은 호스트와 세션이 모두 같은 호출이다. 두 호스트 모두 한 대화의 hook 이 같은 session_id 를 싣는다 — 하위 에이전트도 부모의
 *   session_id 를 싣고, 재개(Claude `--resume`·`--continue`·압축, Codex `resume`)도 같은 id 다(claude 2.1.293·codex-cli 0.161.0 실측). 그래서 두
 *   터미널이 같은 세션을 이어 열면 임대는 둘을 한 주인으로 본다.
 * - SessionStart(Claude session-event·Codex codex-event)는 압축(`source` compact — 세션 ID 가 그대로인 같은 대화)을 빼고 같은 호스트 임대를 이 세션으로
 *   넘겨받는다 — 재시작·`/clear`·update 뒤 다시 열기가 막히지 않고, 아직 살아 있는 이전 세션은 다음 진행 명령이 거부되어 드러난다.
 * - 다른 호스트가 쥔 신선한 임대는 `takeover`(사용자 확인 뒤 — 스킬 규칙)나 30분 무활동으로만 넘어간다.
 * - 교차 실행 자식(CODE_AGENT_CROSS)은 임대를 읽지도 쓰지도 않고 진행 명령·쓰기를 거부한다.
 *
 * 임대는 사고 방지 장치이지 권한 경계가 아니다 — `takeover` 는 모델이 부를 수 있는 명령이고, 넘겨받기 전 사용자 확인은
 * 스킬 규칙(ca-next 재개표)이다. 기록(잠금·쓰기) 실패는 삼키고 처음 읽은 값으로 판정한다 — 임대 기록 때문에 도구가 막히지 않는다.
 * 동의 스냅샷은 lease.json·lease.json.lock 을 뺀다(consent.ts SNAPSHOT_EXCLUDED) — 응답을 기다리는 동안의 touch 가 동의를 깨지 않게.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeAtomic } from "../core/atomic";
import { CROSS_CHILD_DENY, crossChild, type HostName } from "./crossEnv";
import { hostLabel } from "./hostText";
import { STATE_DIR } from "./layout";
import { acquireLock } from "./lock";
import { TIMING } from "./retryPolicy";
import type { Work } from "./work";
import { currentLeaseFile, currentCursor } from "./branchCursor";

export const LEASE_FILE = `${STATE_DIR}/lease.json`;
/** 마지막 활동 뒤 이만큼 지나면 다른 세션이 이어받는다 */
export const LEASE_IDLE_MS = 30 * 60_000;
/** 같은 세션의 seenAt 갱신 간격 — hook 마다 쓰지 않는다 */
export const LEASE_TOUCH_MS = 60_000;

export interface Lease {
  version: 1; id: string; target: string; host: HostName; session: string;
  claimedAt: string; seenAt: string;
  previous?: { host: HostName; session: string; seenAt: string; why: "takeover" | "idle" | "session-start" };
  /** code-agent takeover 가 남긴다 — 이 임대는 비어 있다. 다음 claim 이 previous(why "takeover")로 옮긴다 */
  released?: { at: string };
}
export type LeaseVerdict =
  | { action: "skip" } | { action: "keep" } | { action: "touch" }
  | { action: "claim"; why: "none" | "other-work" | "released" | "idle" | "session-start" }
  | { action: "deny"; holder: Lease; idleMs: number };

const host = (value: unknown): value is HostName => value === "claude" || value === "codex";
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** 없거나 형식이 틀리면 undefined — 틀린 파일은 다음 claim 이 덮는다 */
export function readLease(root: string): Lease | undefined {
  try {
    const path = join(root, currentLeaseFile(root));
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Lease>;
    if (!value || value.version !== 1 || !text(value.id) || typeof value.target !== "string" || !host(value.host) || !text(value.session) ||
      !text(value.claimedAt) || !text(value.seenAt) || Number.isNaN(Date.parse(value.seenAt))) return undefined;
    return value as Lease;
  } catch {
    return undefined;
  }
}

/** 임대 판정(순수 함수) — 위가 먼저다 */
export function leaseDecision(input: { lease?: Lease; id: string; target: string; host: HostName; session?: string; now: number; sessionStart?: boolean }): LeaseVerdict {
  const { lease, now } = input;
  // 누구인지 모르는 호출은 막지 않는다(세션 없는 이벤트·테스트의 직접 호출)
  if (!input.session) return { action: "skip" };
  if (!lease) return { action: "claim", why: "none" };
  if (lease.id !== input.id || lease.target !== input.target) return { action: "claim", why: "other-work" };
  if (lease.released) return { action: "claim", why: "released" };
  const idleMs = Math.max(0, now - Date.parse(lease.seenAt));
  // 같은 주인 — 호스트와 세션이 모두 같다(하위 에이전트는 부모 session_id 를 싣는다)
  if (lease.host === input.host && lease.session === input.session) {
    return idleMs >= LEASE_TOUCH_MS ? { action: "touch" } : { action: "keep" };
  }
  // 같은 호스트의 새 세션 시작(재시작·재개·비우기 — 압축은 sessionStartLease 가 sessionStart 없이 판정한다) — 새로 연 세션이 이긴다
  if (input.sessionStart && lease.host === input.host) return { action: "claim", why: "session-start" };
  if (idleMs >= LEASE_IDLE_MS) return { action: "claim", why: "idle" };
  return { action: "deny", holder: lease, idleMs };
}

const minutes = (ms: number): number => Math.floor(Math.max(0, ms) / 60_000);
const who = (lease: Lease): string => `${hostLabel(lease.host)} 세션 ${lease.session.slice(0, 8)}`;

function denyText(holder: Lease, idleMs: number): string {
  return [
    `다른 세션이 이 작업을 진행 중입니다: ${who(holder)} · 마지막 활동 ${minutes(idleMs)}분 전.`,
    "두 세션(호스트)이 같은 작업의 상태를 동시에 바꾸면 계획 기록과 검증 회차가 엇갈립니다. 같은 명령을 다시 실행해도 결과는 같습니다.",
    "저쪽 세션을 끝냈거나 멈췄는지 사용자에게 확인한 뒤 code-agent takeover 로 이 세션이 넘겨받습니다. 저쪽에서 계속하려면 이 세션은 멈춥니다.",
    `${LEASE_IDLE_MS / 60_000}분 동안 저쪽 활동이 없으면 자동으로 넘겨받습니다.`,
  ].join("\n");
}

/** claim·touch 가 쓸 임대 — claim 은 같은 작업의 이전 주인을 previous 로 남긴다 */
function nextLease(verdict: LeaseVerdict, lease: Lease | undefined, me: { id: string; target: string; host: HostName; session: string }, now: number): Lease | undefined {
  const at = new Date(now).toISOString();
  if (verdict.action === "touch" && lease) return { ...lease, seenAt: at };
  if (verdict.action !== "claim") return undefined;
  const same = lease && verdict.why !== "none" && verdict.why !== "other-work";
  return {
    version: 1, id: me.id, target: me.target, host: me.host, session: me.session, claimedAt: at, seenAt: at,
    ...(same ? { previous: { host: lease!.host, session: lease!.session, seenAt: lease!.seenAt, why: verdict.why === "released" ? "takeover" as const : verdict.why as "idle" | "session-start" } } : {}),
  };
}

/**
 * 잠금 안에서 다시 읽고 다시 판정한 뒤 쓴다. 쓴 임대(또는 그 사이 다른 세션이 claim 해 생긴 거부)를 돌려준다.
 * 잠금 획득 실패(Stop)·쓰기 예외는 삼키고 undefined — 처음 판정을 쓴다.
 */
function record(work: Work, me: { host: HostName; session: string; sessionStart?: boolean }, now: number, waitMs: number):
  { written?: Lease; before?: Lease; denied?: { holder: Lease; idleMs: number } } | undefined {
  const root = work.repoRoot, ids = { id: work.active.id, target: work.active.target };
  try {
    const file = currentLeaseFile(root);
    const release = acquireLock(join(root, `${file}.lock`), { waitMs, ageReclaim: true, label: "작업 임대", display: `${file}.lock` });
    try {
      const before = readLease(root);
      const again = leaseDecision({ lease: before, ...ids, ...me, now });
      if (again.action === "deny") return { denied: { holder: again.holder, idleMs: again.idleMs } };
      const written = nextLease(again, before, { ...ids, ...me }, now);
      if (written) writeAtomic(join(root, file), `${JSON.stringify(written, null, 2)}\n`);
      return { written, before };
    } finally {
      release();
    }
  } catch {
    return undefined;
  }
}

/**
 * 진행 명령·쓰기의 임대 판정 — 거부 사유 또는 undefined. hook 이 기존 판정이 허용일 때만 부른다(읽기 도구·읽기 명령·선언된
 * build·test·읽기용 git 은 오지 않는다). 예외를 밖으로 내지 않는다(Claude runHook 은 예외를 exit 2 로 바꿔 도구를 막는다).
 */
export function leaseGuard(work: Work, hostName: HostName, session: string | undefined, now: number = Date.now(), waitMs: number = TIMING.hookLockWaitMs): string | undefined {
  // 교차 실행 자식은 메인 세션이 부른 CLI 의 자식이라 진행 세션이 아니다 — 임대를 읽지도 쓰지도 않는다
  if (crossChild()) return CROSS_CHILD_DENY;
  let verdict: LeaseVerdict;
  try {
    verdict = leaseDecision({ lease: readLease(work.repoRoot), id: work.active.id, target: work.active.target, host: hostName, session, now });
  } catch {
    return undefined;
  }
  if (verdict.action === "skip" || verdict.action === "keep") return undefined;
  if (verdict.action === "deny") return denyText(verdict.holder, verdict.idleMs);
  const result = record(work, { host: hostName, session: session! }, now, waitMs);
  return result?.denied ? denyText(result.denied.holder, result.denied.idleMs) : undefined;
}

/**
 * SessionStart(Claude session-event·Codex codex-event, sessionHook.sessionAnchor) — 같은 호스트 임대를 이 세션으로 넘겨받고, 이전 세션이
 * 있었으면 요약에 붙일 줄을 돌려준다. 다른 호스트가 쥔 신선한 임대면 넘겨받지 않고 경고 줄.
 * `source` 가 `compact`(자동·수동 압축)면 넘겨받지 않는다 — 압축은 세션 ID 를 바꾸지 않는 같은 대화의 이어짐이고 사용자의 행동이
 * 아니다. 넘겨받으면 새로 연 세션에 넘어간 임대를 아직 열린 이전 세션이 압축만으로 되찾는다. 같은 세션이면 갱신만 하고, 다른 세션이
 * 쥔 신선한 임대면 쓰지 않고 이 세션의 진행 명령이 거부된다는 줄을 낸다.
 */
export function sessionStartLease(work: Work, session: string, source?: string, now: number = Date.now(), waitMs: number = TIMING.hookLockWaitMs,
  hostName: HostName = "claude"): string | undefined {
  if (crossChild()) return undefined;
  const sessionStart = source !== "compact";
  const verdict = leaseDecision({ lease: readLease(work.repoRoot), id: work.active.id, target: work.active.target, host: hostName, session, now, sessionStart });
  if (verdict.action === "skip" || verdict.action === "keep") return undefined;
  const held = (holder: Lease, idleMs: number) => holder.host === hostName
    ? `- 이 작업의 진행 기록은 다른 세션(${who(holder)})이 ${minutes(idleMs)}분 전까지 쥐고 있습니다 — 대화 압축은 진행 기록을 넘겨받지 않으므로 이 세션의 진행 명령은 거부됩니다. ` +
      "이어서 하려면 저쪽 세션을 끝냈거나 멈췄는지 사용자에게 확인한 뒤 code-agent takeover"
    : `- 다른 호스트 세션(${hostLabel(holder.host)} ${holder.session.slice(0, 8)})이 ${minutes(idleMs)}분 전까지 이 작업을 진행했습니다. 동시에 진행하지 않습니다 — 이어서 하려면 저쪽을 멈췄는지 사용자에게 확인한 뒤 code-agent takeover`;
  if (verdict.action === "deny") return held(verdict.holder, verdict.idleMs);
  const result = record(work, { host: hostName, session, sessionStart }, now, waitMs);
  if (result?.denied) return held(result.denied.holder, result.denied.idleMs);
  // 넘겨받은 그 순간만 알린다 — 이미 이 세션이 쥔 임대를 압축·재개 뒤에 갱신(touch)하면 남아 있는 previous 를 다시 알리지 않는다
  const previous = result?.written?.previous, before = result?.before;
  if (!previous || previous.session === session || (before?.host === hostName && before.session === session && !before.released)) return undefined;
  return `- 이 세션이 작업 진행 기록을 넘겨받았습니다(이전: ${hostLabel(previous.host)} 세션 ${previous.session.slice(0, 8)}, 마지막 활동 ${minutes(now - Date.parse(previous.seenAt))}분 전). ` +
    "이전 세션이 아직 열려 있으면 그쪽에서는 진행하지 않습니다 — 그쪽의 다음 진행 명령은 거부됩니다.";
}

/**
 * `code-agent takeover` — 임대에 released 를 남긴다(파일은 지우지 않는다 — 누가 언제 풀었는지는 다음 claim 의 previous 가 남긴다).
 * 잠금·쓰기 실패는 CLI 라 그대로 Stop 이다.
 */
export function releaseLease(root: string, now: number = Date.now()): string {
  if (!existsSync(join(root, STATE_DIR))) return "진행 세션 기록이 없습니다 — 다음 진행 명령을 실행하는 세션이 이어받습니다.";
  if (!currentCursor(root)) return "현재 브랜치에 진행 중인 작업이 없습니다 — 다른 브랜치의 임대는 유지합니다.";
  const file = currentLeaseFile(root);
  const release = acquireLock(join(root, `${file}.lock`), { waitMs: TIMING.lockWaitMs, ageReclaim: true, label: "작업 임대", display: `${file}.lock` });
  try {
    const lease = readLease(root);
    if (!lease || lease.released) return "진행 세션 기록이 없습니다 — 다음 진행 명령을 실행하는 세션이 이어받습니다.";
    writeAtomic(join(root, file), `${JSON.stringify({ ...lease, released: { at: new Date(now).toISOString() } }, null, 2)}\n`);
    return `진행 세션 기록을 풀었습니다: ${who(lease)} (마지막 활동 ${minutes(now - Date.parse(lease.seenAt))}분 전). ` +
      "다음 진행 명령을 실행하는 세션이 이어받습니다. 저쪽 세션이 아직 진행 중이면 그쪽 명령이 거부됩니다 — 같은 작업을 두 세션에서 동시에 진행하지 않습니다.";
  } finally {
    release();
  }
}

/** status 한 줄 — 임대가 지금 작업 것이 아니면 undefined */
export function leaseLine(work: Work, now: number = Date.now()): string | undefined {
  const lease = readLease(work.repoRoot);
  if (!lease || lease.id !== work.active.id || lease.target !== work.active.target) return undefined;
  if (lease.released) {
    return `진행 세션: 없음 — ${who(lease)} 의 기록을 ${minutes(now - Date.parse(lease.released.at))}분 전에 풀었습니다(다음 진행 명령의 세션이 이어받음)`;
  }
  return `진행 세션: ${who(lease)} · 마지막 활동 ${minutes(now - Date.parse(lease.seenAt))}분 전`;
}
