/**
 * 실행 타임라인 — 요청·담당·동의·검증·다음 행동의 시작·종료·대기 사유를 `.code-agent/log/timeline.jsonl`에 한 줄씩 덧붙인다.
 *
 * **측정용이고 판정에 쓰지 않는다.** 권한·승인·재개 판정은 도메인 기록이 정한다. 줄마다 eventId(UUID)와 이 기록을 쓴 코드의 런타임
 * (릴리스 ID 또는 번들 버전)을 싣는다 — 같은 저장소에서 버전을 바꿔 가며 돈 실행을 섞지 않고 비교한다.
 *
 * 글은 식별자·상태·코드가 정한 짧은 사유만 남긴다. 프롬프트·응답·로그 본문과 사용자 원문은 싣지 않는다(사유는 한 줄 300자로 자른다).
 * 덮어쓰거나 밀어내지 않는다 — 이전 실행을 잃지 않는다. `.code-agent/`가 있는 저장소에서만 쓰고, 쓰기 실패는 삼킨다.
 *
 * hook 경로에서도 부르므로 fs·path·crypto와 layout·runtimeSelect만 읽는다.
 */
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

import { loadActive, logDir, REQUEST_SESSION_FILE, STATE_DIR } from "./layout";
import { ownRelease } from "./runtimeSelect";

export const TIMELINE_LOG = `${STATE_DIR}/log/timeline.jsonl`;

export type TimelineType =
  /** 요청 접수(접수 세션 열기)·초안 제출(지시서 렌더)·사람의 확정·반려·반려한 변경안 대신 직전 확정본으로 되돌림 */
  | "request.received" | "request.submitted" | "request.decided" | "request.restored"
  /** 담당 배정(계획 배정·교정 배정·구현 인계)·시작·완료(hook 이 받은 완료 — Claude 비동기 담당은 이 직후 메인에 완료 알림이 들어간다) */
  | "agent.assigned" | "agent.started" | "agent.finished"
  /** 흐름이 고른 다음 행동과 호스트가 실행한 명령 */
  | "next.selected" | "action.started" | "action.ended"
  /** 승인 요청(동의 준비)·응답 관찰·적용 */
  | "consent.requested" | "consent.answered" | "consent.applied"
  /** 검증 명령 한 실행 */
  | "verify.started" | "verify.ended"
  /** 무효화 원인과 재시도 사용 사유 */
  | "invalidated" | "retry.used"
  /** 호스트 턴 종료(Stop hook)·세션 시작(SessionStart hook)·사람 입력 시각(Codex UserPromptSubmit — 본문 없이) */
  | "host.stopped" | "host.session" | "human.input";

export interface TimelineEvent {
  v: 1;
  eventId: string;
  at: string;
  type: TimelineType;
  /** 이 줄을 쓴 코드 — 릴리스 ID, 릴리스 밖 번들이면 `bundle@<버전>` */
  runtime: string;
  workId?: string;
  target?: string;
  phase?: string;
  /** 계획 작업 ID 또는 구현 Task */
  taskId?: string;
  dispatchId?: string;
  host?: "claude" | "codex";
  session?: string;
  /** hook 이 넘긴 담당 agent_id */
  agent?: string;
  /** 시작·종료·대기·무효화·재시도의 사유 — 코드가 정한 짧은 문구 */
  reason?: string;
  /** 상태·종류·소요(ms)처럼 작은 값만 */
  detail?: Record<string, string | number | boolean>;
}

export type TimelineInput = Omit<TimelineEvent, "v" | "eventId" | "at" | "runtime"> & { at?: string };

const REASON_LIMIT = 300;
let runtimeCache: string | undefined;

/** 이 프로세스에서 실제로 도는 코드 — runtime.json 의 기록(applied·adopted)이 아니라 읽힌 파일의 릴리스다 */
export function runtimeLabel(): string {
  if (runtimeCache) return runtimeCache;
  const release = ownRelease()?.id;
  if (release) return (runtimeCache = release);
  let version = "unknown";
  try { version = (JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { version?: string }).version ?? version; } catch { /* 번들 밖 */ }
  return (runtimeCache = `bundle@${version}`);
}

export function shortReason(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > REASON_LIMIT ? `${line.slice(0, REASON_LIMIT - 1)}…` : line;
}

/** 지금 자리의 작업 — 커서가 있으면 그 작업, 없으면 접수 중인 ID */
function placeOf(root: string): Pick<TimelineEvent, "workId" | "target" | "phase"> {
  try {
    const active = loadActive(root);
    if (active) return { workId: active.id, target: active.target, phase: active.phase };
  } catch { /* 깨진 커서는 상태 조회가 알린다 */ }
  try {
    const session = JSON.parse(readFileSync(join(root, REQUEST_SESSION_FILE), "utf8")) as { id?: unknown };
    if (typeof session.id === "string") return { workId: session.id, phase: "request" };
  } catch { /* 접수 중이 아니다 */ }
  return {};
}

/** 한 줄을 덧붙인다. 자리(workId·target·phase)를 주지 않으면 지금 커서에서 채운다 */
export function recordEvent(root: string, input: TimelineInput): void {
  try {
    if (!existsSync(join(root, STATE_DIR))) return;
    const { at, reason, ...rest } = input;
    const place = input.workId === undefined ? placeOf(root) : {};
    const event: TimelineEvent = { v: 1, eventId: randomUUID(), at: at ?? new Date().toISOString(), runtime: runtimeLabel(), ...place, ...rest,
      ...(reason ? { reason: shortReason(reason) } : {}) };
    mkdirSync(logDir(root), { recursive: true });
    appendFileSync(join(root, TIMELINE_LOG), `${JSON.stringify(event)}\n`);
  } catch {
    // 측정 기록이 작업을 세우면 안 된다
  }
}

/** 기록 순서 그대로(같은 시각은 쓴 순서). 깨진 줄은 그 줄만 버린다 — 쓰는 중일 수 있다 */
export function readTimeline(root: string): TimelineEvent[] {
  let text: string;
  try { text = readFileSync(join(root, TIMELINE_LOG), "utf8"); } catch { return []; }
  const rows: TimelineEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<TimelineEvent>;
      if (row.v === 1 && typeof row.at === "string" && typeof row.type === "string" && typeof row.eventId === "string") rows.push(row as TimelineEvent);
    } catch { /* 반쯤 쓰인 줄 */ }
  }
  return rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.at.localeCompare(b.row.at) || a.index - b.index).map(({ row }) => row);
}

// ---- 구간 요약 ----

export type SpanCategory = "agent" | "build-test" | "human" | "external" | "host-resume";
export const CATEGORY_LABEL: Record<SpanCategory, string> = {
  agent: "담당 실행", "build-test": "빌드·테스트", human: "사람 응답 대기", external: "외부 의존 대기", "host-resume": "호스트 재개 대기",
};
/** 겹친 시간을 하나에만 넣는 순서 — 실행 중인 일이 있으면 그 시간은 대기가 아니다 */
const PRIORITY: readonly SpanCategory[] = ["build-test", "agent", "human", "external", "host-resume"];
const WAITS: readonly SpanCategory[] = ["human", "external", "host-resume"];

/** 호스트 기록(Claude 메인 대화)에서 읽은 표지 — 완료 알림·사람 입력·도구 호출의 시각만 */
export interface HostMark { at: string; type: "host.notified" | "human.input" | "host.tool"; status?: string }

export interface SpanView {
  category: SpanCategory;
  reason: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** 요약 끝까지 닫히지 않았다 */
  open: boolean;
  workId?: string; phase?: string; taskId?: string; dispatchId?: string;
  /** 호스트 재개 대기 중 호스트 턴이 끝났다(Stop hook) */
  stopped?: boolean;
  /** 대기 중 사람 입력이 있었다(호스트 기록) — 사람이 재개시킨 대기 */
  human?: boolean;
  /** 닫은 사건 */
  closedBy?: string;
}

export interface RunView {
  run: string; phase?: string; kind?: string; round?: number; outcome?: string; logFile?: string;
  startedAt: string; endedAt?: string; durationMs?: number;
}

/** 무효화 원인·재시도 사용 사유 */
export interface CauseView { type: "invalidated" | "retry.used"; at: string; reason: string; workId?: string; phase?: string; taskId?: string; dispatchId?: string }

export interface TimelineSummary {
  workId?: string;
  from?: string;
  to?: string;
  /** 처음~마지막 사건의 경과 — 구간을 더한 값이 아니다 */
  wallMs: number;
  /** ms: 그 분류 구간의 합집합, exclusiveMs: 겹친 시간을 우선순위 하나에만 넣은 값(분류 합 + otherMs = wallMs) */
  categories: Record<SpanCategory, { ms: number; exclusiveMs: number; count: number; open: number }>;
  /** 어느 구간에도 들지 않은 시간 — 호스트가 직접 처리한 시간 */
  otherMs: number;
  waits: SpanView[];
  runs: RunView[];
  causes: CauseView[];
  counts: Record<string, number>;
  runtimes: string[];
}

interface Open { category: SpanCategory; reason: string; start: string; ref: Partial<TimelineEvent>; stopped?: boolean; human?: boolean }

const ms = (from: string, to: string): number => Math.max(0, Date.parse(to) - Date.parse(from));
/** 시각 비교를 글자 순서로 하므로 한 꼴(toISOString)로 맞춘다. 읽을 수 없는 시각은 버린다 */
const iso = (at: string): string | undefined => { const time = Date.parse(at); return Number.isFinite(time) ? new Date(time).toISOString() : undefined; };
const refOf = (event: Partial<TimelineEvent>) => ({
  ...(event.workId ? { workId: event.workId } : {}), ...(event.phase ? { phase: event.phase } : {}),
  ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.dispatchId ? { dispatchId: event.dispatchId } : {}),
});

/** 작업별 요약(처음 사건 순) — 호스트 표지는 그 작업의 처음~마지막 사건 사이의 것만 쓴다. 작업 ID 없는 사건(준비·문서)은 한 묶음이다 */
export function summarizeByWork(events: readonly TimelineEvent[], marks: readonly HostMark[] = []): TimelineSummary[] {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) groups.set(event.workId ?? "", [...(groups.get(event.workId ?? "") ?? []), event]);
  return [...groups.values()].map((list) => {
    const times = list.map((event) => Date.parse(event.at)).filter(Number.isFinite);
    const [from, to] = [Math.min(...times), Math.max(...times)];
    return summarizeTimeline(list, marks.filter((mark) => Date.parse(mark.at) >= from && Date.parse(mark.at) <= to));
  }).sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));
}

/**
 * 사건 목록 → 분류별 구간. 담당 실행은 시작~완료, 빌드·테스트는 검증 실행, 사람 응답 대기는 동의 준비~응답과 흐름의 사람 판단,
 * 외부 의존 대기는 흐름의 wait, 호스트 재개 대기는 담당 완료·완료 알림·호스트 턴 종료부터 호스트의 다음 행동까지다.
 * 겹친 시간은 분류별 합집합(ms)과 우선순위 귀속(exclusiveMs)으로 따로 센다 — 전체 소요에 두 번 들어가지 않는다.
 */
export function summarizeTimeline(events: readonly TimelineEvent[], marks: readonly HostMark[] = []): TimelineSummary {
  type Row = { at: string; type: string; event?: TimelineEvent; mark?: HostMark };
  const rows: Row[] = [...events.map((event) => ({ at: iso(event.at), type: event.type as string, event })), ...marks.map((mark) => ({ at: iso(mark.at), type: mark.type as string, mark }))]
    .flatMap((row) => row.at === undefined ? [] : [{ ...row, at: row.at }])
    .map((row, index) => ({ row, index })).sort((a, b) => a.row.at.localeCompare(b.row.at) || a.index - b.index).map(({ row }) => row);
  const spans: SpanView[] = [];
  const open = new Map<string, Open>();
  const runs = new Map<string, RunView>();
  const causes: CauseView[] = [];
  const counts: Record<string, number> = {};
  const opened = (key: string, value: Open) => { if (!open.has(key)) open.set(key, value); };
  const close = (key: string, at: string, closedBy: string) => {
    const span = open.get(key);
    if (!span) return;
    open.delete(key);
    spans.push({ category: span.category, reason: span.reason, startedAt: span.start, endedAt: at, durationMs: ms(span.start, at), open: false, ...refOf(span.ref),
      ...(span.stopped ? { stopped: true } : {}), ...(span.human ? { human: true } : {}), closedBy });
  };
  const resume = (at: string, by: string) => { idle = false; close("host-resume", at, by); };
  const touched = () => { for (const span of open.values()) if (WAITS.includes(span.category)) span.human = true; };
  const running = () => [...open.keys()].some((key) => key.startsWith("agent:") || key.startsWith("verify:"));
  let lastKind: string | undefined;
  // 담당이 도는 동안 호스트 턴이 끝났다 — 그 시간은 담당 실행이고, 완료 뒤 대기가 턴 종료 상태에서 시작한다
  let idle = false;
  for (const { at, type, event, mark } of rows) {
    counts[type] = (counts[type] ?? 0) + 1;
    const detail = event?.detail ?? {};
    switch (type) {
      case "agent.started":
        resume(at, type);
        opened(`agent:${event!.session}:${event!.agent}`, { category: "agent", reason: `${detail.agentType ?? "담당"} 실행`, start: at, ref: event! });
        break;
      case "agent.finished":
        // 이미 처리한 완료(중복 알림)는 구간을 바꾸지 않는다
        if (detail.duplicate) break;
        close(`agent:${event!.session}:${event!.agent}`, at, type);
        opened("host-resume", { category: "host-resume", reason: `담당 완료(${detail.status ?? "기록"}) 뒤 다음 행동 대기`, start: at, ref: event!, ...(idle ? { stopped: true } : {}) });
        break;
      case "host.notified":
        opened("host-resume", { category: "host-resume", reason: `완료 알림(${mark!.status ?? "알림"}) 뒤 다음 행동 대기`, start: at, ref: {}, ...(idle ? { stopped: true } : {}) });
        break;
      case "host.stopped": {
        // 막은 종료는 턴이 이어진다 — 멈춘 것이 아니다
        if (detail.blocked) break;
        const current = open.get("host-resume");
        if (current) current.stopped = true;
        else if (running()) idle = true;
        else if (event!.workId && lastKind !== "done") opened("host-resume", { category: "host-resume", reason: "호스트 턴 종료 뒤 재개 대기", start: at, ref: event!, stopped: true });
        break;
      }
      case "human.input":
        touched();
        break;
      case "action.started":
        // 사람이 터미널에서 친 명령은 호스트의 재개가 아니라 사람의 개입이다
        if (detail.terminal) { touched(); break; }
        resume(at, type);
        break;
      case "host.tool":
        resume(at, type);
        break;
      case "next.selected":
        close("flow-human", at, type);
        close("flow-wait", at, type);
        lastKind = String(detail.kind ?? "");
        if (detail.kind === "human") opened("flow-human", { category: "human", reason: `사람 판단 대기: ${detail.action ?? ""}`.trim(), start: at, ref: event! });
        if (detail.kind === "wait") opened("flow-wait", { category: "external", reason: event!.reason ?? `외부 완료 대기: ${detail.action ?? ""}`, start: at, ref: event! });
        break;
      case "consent.requested":
        opened(`consent:${detail.consent}`, { category: "human", reason: `동의 응답 대기: ${detail.action ?? ""}`.trim(), start: at, ref: event! });
        break;
      case "consent.answered":
      case "consent.applied":
        close(`consent:${detail.consent}`, at, type);
        close("flow-human", at, type);
        break;
      case "request.decided":
        close("flow-human", at, type);
        break;
      case "invalidated":
      case "retry.used":
        causes.push({ type, at, reason: event!.reason ?? "", ...refOf(event!) });
        break;
      case "verify.started": {
        const run = String(detail.run ?? event!.eventId);
        runs.set(run, { run, ...(event!.phase ? { phase: event!.phase } : {}), ...(typeof detail.kind === "string" ? { kind: detail.kind } : {}),
          ...(typeof detail.round === "number" ? { round: detail.round } : {}), ...(typeof detail.logFile === "string" ? { logFile: detail.logFile } : {}), startedAt: at });
        opened(`verify:${run}`, { category: "build-test", reason: `${detail.kind ?? "검증"} 실행`, start: at, ref: event! });
        break;
      }
      case "verify.ended": {
        const run = String(detail.run ?? event!.eventId);
        const started = runs.get(run);
        runs.set(run, { ...(started ?? { run, startedAt: typeof detail.startedAt === "string" ? detail.startedAt : at }),
          ...(typeof detail.outcome === "string" ? { outcome: detail.outcome } : {}), ...(typeof detail.logFile === "string" ? { logFile: detail.logFile } : {}),
          endedAt: at, durationMs: typeof detail.durationMs === "number" ? detail.durationMs : ms(started?.startedAt ?? at, at) });
        close(`verify:${run}`, at, type);
        break;
      }
    }
  }
  const from = rows[0]?.at, to = rows.at(-1)?.at;
  for (const [, span] of open) {
    spans.push({ category: span.category, reason: span.reason, startedAt: span.start, endedAt: to!, durationMs: ms(span.start, to!), open: true, ...refOf(span.ref),
      ...(span.stopped ? { stopped: true } : {}), ...(span.human ? { human: true } : {}) });
  }
  const categories = Object.fromEntries(PRIORITY.map((category) => [category, { ms: 0, exclusiveMs: 0, count: 0, open: 0 }])) as TimelineSummary["categories"];
  for (const span of spans) { categories[span.category].count++; if (span.open) categories[span.category].open++; }
  // 경계 시각으로 나눈 조각마다 활성 분류를 본다 — 분류 안의 겹침은 한 번, 분류 사이의 겹침은 우선순위 하나에만 넣는다
  const points = [...new Set(spans.flatMap((span) => [span.startedAt, span.endedAt]))].sort();
  let covered = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]], length = ms(a, b);
    if (!length) continue;
    const active = new Set(spans.filter((span) => span.startedAt <= a && span.endedAt >= b).map((span) => span.category));
    if (!active.size) continue;
    for (const category of active) categories[category].ms += length;
    categories[PRIORITY.find((category) => active.has(category))!].exclusiveMs += length;
    covered += length;
  }
  const wallMs = from && to ? ms(from, to) : 0;
  return {
    ...(events[0]?.workId && events.every((event) => event.workId === events[0].workId) ? { workId: events[0].workId } : {}),
    ...(from ? { from, to } : {}), wallMs, categories, otherMs: Math.max(0, wallMs - covered),
    waits: spans.filter((span) => WAITS.includes(span.category)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    runs: [...runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    causes, counts, runtimes: [...new Set(events.map((event) => event.runtime))],
  };
}
