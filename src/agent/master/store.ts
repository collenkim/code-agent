/**
 * master 연동 기록 — `.code-agent/master/`. 모두 code-agent 코드만 쓴다(hook 이 모델의 `.code-agent/` 쓰기를 막는다). 폴더 안의
 * `.gitignore`(`*`)가 전부를 무시하므로 반영 커밋·작업 트리 대조·동의 스냅샷에 들지 않는다.
 *
 * - binding.json: 사람이 TTY 에서 켠 연동(프로젝트 ID·제어자 토큰 해시·정책·호스트 설정). 없으면 연동하지 않은 프로젝트다.
 * - owner.json: 지금 제어자와 세대(generation), 인계 진행 상태. 세대가 낮은 요청은 거부한다(fencing).
 * - grants.jsonl·decisions.jsonl: 사람이 준 위임 권한·회수, master 의 판단과 그 적용 결과(append 만).
 * - commands/<ID>.json: 상태를 바꾸는 요청의 처리 결과 — 같은 commandId 재전송은 이 응답을 돌려준다.
 * - runs/<runId>.json(+ .out.jsonl·.err.log·.prompt.md): 실행 한 건의 상태·프로세스·정지 요청·결과.
 * - works/<workId>.json: master 실행이 시작한 작업과 master 의 작업·시도·계획 식별자 연결.
 * - events.jsonl·events-meta.json: 순번 이벤트 기록과 기록 ID(logId).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

import { STATE_DIR } from "../layout";
import { acquireLock } from "../lock";
import type { HostProfile, Policy, RunState } from "./protocol";
import { ControlError, EVENT_TYPES, sha256, type DecisionCategory, type EventType } from "./protocol";

export const MASTER_DIR = `${STATE_DIR}/master`;

export interface Binding {
  version: 1;
  projectId: string;
  enabledAt: string;
  enabledBy: { actor: string; channel: "tty" };
  controllers: Record<string, { tokenHash: string; label?: string; addedAt: string }>;
  policy: Policy;
  host: HostProfile;
  hostProfiles?: Partial<Record<"claude" | "codex", HostProfile>>;
  humanChannel?: import("../interactionHuman").HumanChannel;
}
export interface Handover {
  id: string; from: string; to: string; mode: "cooperative" | "forced"; by: "controller" | "human";
  state: "requested" | "stopping" | "stopped" | "transferred";
  requestedAt: string; commandId?: string; runs: string[]; stoppedAt?: string; transferredAt?: string; generation?: number; note?: string;
}
export interface Owner {
  controller: string; generation: number; since: string;
  lastSeenAt?: string; disconnectedAt?: string; acceptedAt?: string;
  handover?: Handover;
  history: { at: string; controller: string; generation: number; how: string }[];
}
export interface Grant {
  id: string; controller: string; works: string[]; missions: string[]; actions: string[]; paths: string[];
  expiresAt: string; maxUses: number; note?: string; createdAt: string; createdBy: { actor: string; channel: "tty" };
}
export type GrantRow =
  | { type: "grant"; at: string; grant: Grant }
  | { type: "revoke"; at: string; id: string; by: { kind: "human" | "controller"; name: string }; reason?: string };

export interface DecisionRow {
  type: "decision"; at: string; decisionId: string; controller: string; generation: number; commandId: string; grantId: string;
  action: string; actor: "ai" | "human"; category: DecisionCategory; verdict?: string; reason: string; evidence: string[];
  target: { consentId?: string; workId?: string; questions?: string[]; shownHash?: string; questionsHash?: string };
}
export interface DecisionResultRow { type: "decision-result"; at: string; decisionId: string; state: "applied" | "rejected" | "failed"; detail: string }

export interface CommandRecord {
  commandId: string; type: string; controller?: string; generation?: number; requestHash: string; receivedAt: string;
  /** received: 처리 전에 남긴 기록(처리 도중 끊기면 이 상태로 남는다) */
  status: "received" | "accepted" | "rejected"; response: unknown; runId?: string;
}
export interface Links { missionId?: string; taskId?: string; attemptId?: string; planVersion?: string; invocationId?: string }
export interface ProcessRef { pid: number; startedAt: string; marker: string; exitCode?: number | null; signal?: string | null; exitedAt?: string }
export interface StopRequest {
  mode: "pause" | "cancel"; requestedAt: string; reason: string; by: string; commandId?: string; graceMs: number;
  forcedAt?: string; forceRequested?: boolean;
}
export interface RunRecord {
  version: 1; runId: string; commandId: string; controller: string; generation: number; mode: "start" | "continue";
  links: Links; state: RunState; acceptedAt: string; updatedAt: string;
  sessionId: string; resumeOf?: string; promptHash: string; timeoutMs: number;
  /** Codex가 thread.started로 확정하기 전 접수 시 반환한 세션 별칭. */
  sessionAlias?: string;
  sessionConfirmed?: boolean;
  hostProfile?: HostProfile;
  handoffId?: string;
  recovery?: { at: string; actor: string; source: { file: string; hash: string; size: number; modifiedAt: string }; context: import("../interactions").InteractionContext; requestIds: string[] };
  workId: string | null; baseHead: string | null; baseStateVersion: string;
  supervisor?: ProcessRef & { heartbeatAt?: string };
  host?: ProcessRef;
  stop?: StopRequest;
  progress?: { at: string; stateVersion: string; phase?: string; resume?: string };
  finishedAt?: string;
  outcome?: { state: RunState; reason: string; cooperative?: boolean; forced?: boolean };
  result?: unknown;
  history: { at: string; state: RunState; note?: string }[];
}
export interface WorkBinding { workId: string; links: Links; boundAt: string; runId: string; controller: string; runs: string[] }

export interface EventRow { seq: number; logId: string; at: string; type: EventType; runId?: string; commandId?: string; stateVersion?: string; data?: unknown }

const path = (root: string, ...parts: string[]): string => join(root, MASTER_DIR, ...parts);
export const masterPath = path;

/** 폴더와 자기 무시 `.gitignore` — 연동 기록이 커밋·작업 트리 대조에 들지 않게 */
export function ensureMasterDir(root: string): void {
  const dir = path(root);
  mkdirSync(join(dir, "commands"), { recursive: true });
  mkdirSync(join(dir, "runs"), { recursive: true });
  mkdirSync(join(dir, "works"), { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# code-agent master 연동 기록 — 커밋하지 않는다\n*\n");
}

/** 원자적 쓰기 — Windows 에서 읽는 쪽이 파일을 잡고 있으면 rename 이 잠깐 실패한다(EPERM·EACCES·EBUSY) */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try { renameSync(temp, file); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 50 && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) { sleep(20); continue; }
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
export function readJson<T>(file: string): T | undefined {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 50 && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) { sleep(20); continue; }
      if (error instanceof SyntaxError) throw new ControlError("internal", `${file.replace(/\\/g, "/")} 를 읽을 수 없습니다(손상)`);
      throw error;
    }
  }
}
export function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { /* 반쯤 쓰인 끝줄 */ }
  }
  return rows;
}

/** 잠금 — 공통 acquireLock(같은 PC 의 죽은 주인은 회수, 살아 있는 주인은 기다린 뒤 busy) */
export function withLock<T>(root: string, name: string, run: () => T, waitMs = 10_000): T {
  ensureMasterDir(root);
  let release: () => void;
  try {
    release = acquireLock(path(root, name), { waitMs, ageReclaim: false, label: `master ${name}`, display: `${MASTER_DIR}/${name}` });
  } catch (error) {
    throw new ControlError("busy", error instanceof Error ? error.message : String(error));
  }
  try { return run(); } finally { release(); }
}
export const CONTROL_LOCK = "control.lock";

// ---- 연동·소유 ----

export function readBinding(root: string): Binding | undefined { return readJson<Binding>(path(root, "binding.json")); }
export function writeBinding(root: string, binding: Binding): void { ensureMasterDir(root); writeJson(path(root, "binding.json"), binding); }
export function readOwner(root: string): Owner | undefined { return readJson<Owner>(path(root, "owner.json")); }
export function writeOwner(root: string, owner: Owner): void { writeJson(path(root, "owner.json"), { ...owner, history: owner.history.slice(-50) }); }
export const tokenHash = (token: string): string => `sha256:${sha256(token)}`;

// ---- 권한·판단 ----

export function grantRows(root: string): GrantRow[] { return readLines<GrantRow>(path(root, "grants.jsonl")); }
export function appendGrantRow(root: string, row: GrantRow): void { ensureMasterDir(root); appendFileSync(path(root, "grants.jsonl"), `${JSON.stringify(row)}\n`); }
export function decisionRows(root: string): (DecisionRow | DecisionResultRow)[] { return readLines(path(root, "decisions.jsonl")); }
export function appendDecisionRow(root: string, row: DecisionRow | DecisionResultRow): void { ensureMasterDir(root); appendFileSync(path(root, "decisions.jsonl"), `${JSON.stringify(row)}\n`); }

export interface GrantView extends Grant { revoked?: { at: string; by: string; reason?: string }; used: number; expired: boolean; exhausted: boolean }
export function grantViews(root: string, now = Date.now()): GrantView[] {
  const rows = grantRows(root);
  const decisions = decisionRows(root);
  const results = new Map(decisions.filter((row): row is DecisionResultRow => row.type === "decision-result").map((row) => [row.decisionId, row.state]));
  return rows.filter((row): row is Extract<GrantRow, { type: "grant" }> => row.type === "grant").map(({ grant }) => {
    const revoke = rows.find((row): row is Extract<GrantRow, { type: "revoke" }> => row.type === "revoke" && row.id === grant.id);
    // 쓰인 횟수 — 적용됐거나 적용 결과가 아직 없는(적용 중에 끊긴) 판단. 거부·실패는 세지 않는다
    const used = decisions.filter((row): row is DecisionRow => row.type === "decision" && row.grantId === grant.id)
      .filter((row) => { const state = results.get(row.decisionId); return state === undefined || state === "applied"; }).length;
    return { ...grant, ...(revoke ? { revoked: { at: revoke.at, by: `${revoke.by.kind}:${revoke.by.name}`, ...(revoke.reason ? { reason: revoke.reason } : {}) } } : {}),
      used, expired: Date.parse(grant.expiresAt) <= now, exhausted: used >= grant.maxUses };
  });
}

// ---- 명령 ----

const commandFile = (root: string, id: string): string => path(root, "commands", `${id.replace(/:/g, "_")}.json`);
export function readCommand(root: string, id: string): CommandRecord | undefined { return readJson<CommandRecord>(commandFile(root, id)); }
export function writeCommand(root: string, record: CommandRecord): void { writeJson(commandFile(root, record.commandId), record); }

// ---- 실행 ----

export const runFile = (root: string, runId: string): string => path(root, "runs", `${runId}.json`);
export const runOutput = (root: string, runId: string): string => path(root, "runs", `${runId}.out.jsonl`);
export const runErrors = (root: string, runId: string): string => path(root, "runs", `${runId}.err.log`);
export const runPrompt = (root: string, runId: string): string => path(root, "runs", `${runId}.prompt.md`);
export const RUN_LOCK = (runId: string): string => `runs/${runId}.lock`;
export function readRun(root: string, runId: string): RunRecord | undefined { return readJson<RunRecord>(runFile(root, runId)); }
export function listRuns(root: string): RunRecord[] {
  const dir = path(root, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^run-[A-Za-z0-9-]+\.json$/.test(name))
    .map((name) => { try { return readJson<RunRecord>(join(dir, name)); } catch { return undefined; } })
    .filter((run): run is RunRecord => !!run).sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
}
/** 실행 기록 고치기 — 감독 프로세스(heartbeat·상태)와 제어 명령(정지 요청)이 같은 파일을 고치므로 짧은 잠금 안에서 읽고 쓴다 */
export function updateRun(root: string, runId: string, change: (run: RunRecord) => RunRecord | void): RunRecord {
  return withLock(root, `runs/${runId}.rec.lock`, () => {
    const run = readRun(root, runId);
    if (!run) throw new ControlError("not-found", `실행 ${runId} 가 없습니다`);
    const next = change(run) ?? run;
    next.updatedAt = new Date().toISOString();
    writeJson(runFile(root, runId), next);
    return next;
  });
}
export function writeRunRecord(root: string, run: RunRecord): void { writeJson(runFile(root, run.runId), run); }

// ---- 작업 연결 ----

const workFile = (root: string, workId: string): string => path(root, "works", `${encodeURIComponent(workId)}.json`);
export function readWorkBinding(root: string, workId: string): WorkBinding | undefined { return readJson<WorkBinding>(workFile(root, workId)); }
export function writeWorkBinding(root: string, binding: WorkBinding): void { writeJson(workFile(root, binding.workId), binding); }

// ---- 이벤트 ----

interface EventMeta { logId: string; seq: number }
function eventMeta(root: string): EventMeta {
  const meta = readJson<EventMeta>(path(root, "events-meta.json"));
  if (meta) return meta;
  // 메타가 없는데 기록이 있으면(메타만 지워진 경우) 기록의 끝 순번을 잇는다 — 순번을 되돌리지 않는다
  const rows = readLines<EventRow>(path(root, "events.jsonl"));
  return { logId: rows.at(-1)?.logId ?? `log-${randomUUID()}`, seq: rows.at(-1)?.seq ?? 0 };
}
export function eventPosition(root: string): { logId: string; latestSeq: number } {
  if (!existsSync(path(root))) return { logId: "", latestSeq: 0 };
  const meta = eventMeta(root);
  return { logId: meta.logId, latestSeq: meta.seq };
}
/** 이벤트 한 건 — 순번은 기록 잠금 안에서 하나씩 올린다 */
export function emit(root: string, type: EventType, fields: Omit<EventRow, "seq" | "logId" | "at" | "type"> = {}): EventRow {
  if (!(EVENT_TYPES as readonly string[]).includes(type)) throw new Error(`모르는 이벤트: ${type}`);
  return withLock(root, "events.lock", () => {
    const meta = eventMeta(root);
    const row: EventRow = { seq: meta.seq + 1, logId: meta.logId, at: new Date().toISOString(), type, ...fields };
    appendFileSync(path(root, "events.jsonl"), `${JSON.stringify(row)}\n`);
    writeJson(path(root, "events-meta.json"), { logId: meta.logId, seq: row.seq });
    return row;
  });
}
/** after 다음 순번부터. 기록 ID 가 다르거나 순번이 앞서 있으면 gap — 받는 쪽은 스냅샷으로 다시 맞춘다 */
export function readEvents(root: string, after: number, logId: string | undefined, limit: number): { logId: string; firstSeq: number; latestSeq: number; events: EventRow[]; gap: boolean; reason?: string } {
  const position = eventPosition(root);
  const rows = readLines<EventRow>(path(root, "events.jsonl"));
  const firstSeq = rows[0]?.seq ?? position.latestSeq + 1;
  let gap = false, reason: string | undefined;
  if (logId && position.logId && logId !== position.logId) { gap = true; reason = "기록 ID 가 다릅니다 — 다른 기록(초기화·다른 프로젝트)입니다"; }
  else if (after > position.latestSeq) { gap = true; reason = `받은 순번(${after})이 기록의 끝(${position.latestSeq})보다 앞섭니다`; }
  else if (after + 1 < firstSeq) { gap = true; reason = `요청한 순번 ${after + 1} 이 기록에 없습니다(첫 순번 ${firstSeq})`; }
  const events = gap ? [] : rows.filter((row) => row.seq > after).slice(0, limit);
  return { logId: position.logId, firstSeq, latestSeq: position.latestSeq, events, gap, ...(reason ? { reason } : {}) };
}
