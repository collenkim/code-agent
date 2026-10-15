/**
 * master 연동 통신 계약(`code-agent.master` v1) — 순수 모듈(fs·child_process 없음). 명령·응답·이벤트의 꼴과 오류 코드, 위임할 수 있는
 * 동작과 사람만 하는 동작, 시간 정책의 기본값을 한곳에 둔다. 문서는 doc/master-control.md 다.
 *
 * - 전송은 로컬 CLI 다: `code-agent master call` 이 stdin 의 요청 한 건을 읽어 응답 한 건을 stdout 에 쓴다(서버·포트 없음).
 * - 연결(토큰)은 권한이 아니다: 승인·답 위임은 사람이 TTY 에서 따로 준 권한(grant) 범위에서만 받는다.
 */
import { createHash } from "crypto";

export const PROTOCOL = "code-agent.master";
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS = [1] as const;

/** 인증 없이 받는 요청 — 기능 협상 */
export const OPEN_TYPES = ["hello"] as const;
/** 읽기 전용 요청 — commandId 가 없어도 되고 기록하지 않는다 */
export const READ_TYPES = ["snapshot", "events", "heartbeat", "command", "questions", "consents", "result", "grants"] as const;
/** 상태를 바꾸는 요청 — commandId 가 필요하고 같은 ID 의 재전송은 기록된 응답을 그대로 돌려준다 */
export const MUTATING_TYPES = ["submit", "pause", "cancel", "resume", "decide", "answer", "handover", "reconcile", "policy", "revoke"] as const;
export const COMMAND_TYPES = [...OPEN_TYPES, ...READ_TYPES, ...MUTATING_TYPES] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];
export type MutatingType = (typeof MUTATING_TYPES)[number];

/** 이 버전이 지원하지 않는다고 명시하는 기능 — hello 가 그대로 돌려준다 */
export const UNSUPPORTED = [
  { feature: "host:codex", reason: "master 실행 러너는 Claude Code 비대화형 실행(claude -p)만 지원한다 — Codex 세션은 기존 독립 실행으로만 쓴다" },
  { feature: "transport:network", reason: "통신은 같은 PC 의 CLI 호출뿐이다(원격 서버·포트 없음)" },
  { feature: "delegate:human-only-actions", reason: "setup·docs·baseline·model·plugin·update·knowledge-prune·abort·repro-log·judgment 동의는 위임하지 않는다" },
  { feature: "events:push", reason: "이벤트는 순번 기반 조회(events after)다 — 연결을 유지하는 밀어넣기는 없다" },
] as const;

export const ERROR_CODES = [
  "invalid-request", "unsupported-protocol", "unsupported", "not-enabled", "unauthorized", "fenced", "handover-in-progress", "handover-unaccepted",
  "conflict", "stale-state", "busy", "not-found", "invalid-state", "human-required", "grant-missing", "grant-expired", "grant-revoked",
  "grant-exhausted", "scope-exceeded", "duplicate-decision", "policy-forbids", "host-unavailable", "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class ControlError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly detail?: unknown) { super(message); }
}

/** 위임할 수 있는 동작 — 동의 동작 셋과 업무 질문 답 */
export const DELEGABLE_ACTIONS = ["request", "plan", "deliver", "answer"] as const;
export type DelegableAction = (typeof DELEGABLE_ACTIONS)[number];
/** 사람만 하는 동의 — 권한 문서에 넣어도 받지 않는다(설치·기준·모델·플러그인·업데이트·지식 삭제·종료·로그 근거·사람 판단) */
export const HUMAN_ONLY_ACTIONS = ["setup", "docs", "baseline", "model", "plugin-add", "plugin-remove", "update", "knowledge-prune", "abort", "repro-log", "judgment"] as const;

/**
 * 판단 분류 — master 가 판단마다 붙인다. routine 만 위임으로 승인·답할 수 있다. ambiguous 는 재검토(수정 요청·보류)만, critical 은
 * 받지 않고 human-required 로 돌려보낸다(사람에게 넘기라는 뜻).
 */
export const DECISION_CATEGORIES = ["routine", "ambiguous", "critical"] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];
export const VERDICTS = ["approve", "request-changes", "defer"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** 실행 상태 — 위에서 아래로만 간다. terminal 이 아니면 같은 프로젝트에 새 실행을 받지 않는다 */
export const RUN_STATES = ["accepted", "starting", "running", "stopping", "completed", "blocked", "failed", "cancelled", "paused", "abandoned", "orphaned", "unknown"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const TERMINAL_RUN_STATES: readonly RunState[] = ["completed", "blocked", "failed", "cancelled", "paused", "abandoned", "unknown"];
/** 실행 중으로 보는 상태 — orphaned 는 감독 프로세스가 사라졌지만 호스트가 살아 있는 것이라 끝나지 않았다 */
export const ACTIVE_RUN_STATES: readonly RunState[] = ["accepted", "starting", "running", "stopping", "orphaned"];

export interface Policy {
  /** 감독 프로세스가 실행 기록의 heartbeat 를 고치는 주기 */
  heartbeatMs: number;
  /** 감독 프로세스가 code-agent 상태를 다시 보고 바뀐 것을 이벤트로 남기는 주기 */
  progressMs: number;
  /** master 의 마지막 요청 뒤 이만큼 지나면 연결 끊김으로 본다 — 실패·재배정 근거가 아니다 */
  masterTimeoutMs: number;
  /** 연결이 끊겼을 때 실행 중인 일 — continue(그대로 둔다) | pause(협력 정지) */
  onMasterDisconnect: "continue" | "pause";
  /** 협력 정지 요청 뒤 강제 종료까지 기다리는 시간 */
  stopGraceMs: number;
  /** 한 실행(호스트 한 턴)의 상한 — 넘으면 협력 정지 뒤 강제 종료하고 failed(timeout) */
  runTimeoutMs: number;
  /** 접수 뒤 감독 프로세스가 이만큼 안에 시작하지 않으면 abandoned */
  startTimeoutMs: number;
  /** events 한 번에 돌려주는 최대 수 */
  eventPageLimit: number;
}
export const DEFAULT_POLICY: Policy = {
  heartbeatMs: 10_000, progressMs: 15_000, masterTimeoutMs: 120_000, onMasterDisconnect: "continue",
  stopGraceMs: 120_000, runTimeoutMs: 3_600_000, startTimeoutMs: 60_000, eventPageLimit: 200,
};
const POLICY_RANGES: Record<Exclude<keyof Policy, "onMasterDisconnect">, [number, number]> = {
  heartbeatMs: [200, 600_000], progressMs: [200, 3_600_000], masterTimeoutMs: [1_000, 86_400_000], stopGraceMs: [0, 3_600_000],
  runTimeoutMs: [1_000, 86_400_000], startTimeoutMs: [1_000, 3_600_000], eventPageLimit: [1, 5_000],
};

/** 정책 일부를 검사해 기존 값 위에 덮는다 — 모르는 키·범위 밖 값은 invalid-request */
export function mergePolicy(base: Policy, patch: unknown): Policy {
  if (!plain(patch)) throw new ControlError("invalid-request", "policy 는 객체여야 합니다");
  const next: Policy = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "onMasterDisconnect") {
      if (value !== "continue" && value !== "pause") throw new ControlError("invalid-request", "onMasterDisconnect 는 continue 또는 pause 입니다");
      next.onMasterDisconnect = value;
      continue;
    }
    const range = (POLICY_RANGES as Record<string, [number, number] | undefined>)[key];
    if (!range) throw new ControlError("invalid-request", `모르는 정책 키: ${key}`);
    if (typeof value !== "number" || !Number.isInteger(value) || value < range[0] || value > range[1]) {
      throw new ControlError("invalid-request", `${key} 는 ${range[0]}~${range[1]} 정수입니다`);
    }
    (next as unknown as Record<string, number>)[key] = value;
  }
  return next;
}

/** 호스트 실행 설정 — 사람이 enable 때 정한다(허용 도구는 권한에 닿으므로 master 가 바꾸지 못한다) */
export interface HostProfile {
  kind: "claude";
  /** 실행 파일과 앞 인자. 기본 ["claude"] */
  command: string[];
  permissionMode: "acceptEdits" | "dontAsk" | "manual" | "auto";
  allowedTools: string[];
  disallowedTools: string[];
  model?: string;
}
export const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Grep", "Glob", "Write", "Edit", "MultiEdit", "TodoWrite", "Task",
  "Bash(code-agent *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
  "PowerShell(code-agent *)", "PowerShell(git status*)", "PowerShell(git diff*)", "PowerShell(git log*)",
];
export const DEFAULT_HOST_PROFILE: HostProfile = {
  kind: "claude", command: ["claude"], permissionMode: "acceptEdits", allowedTools: DEFAULT_ALLOWED_TOOLS,
  // 질문 도구는 사람이 없는 실행에서 답을 받을 수 없다 — 동의·질문은 master 의 위임 또는 사람의 응답으로 받는다
  disallowedTools: ["AskUserQuestion"],
};

export function hostProfileOf(raw: unknown): HostProfile {
  if (raw === undefined) return { ...DEFAULT_HOST_PROFILE };
  if (!plain(raw)) throw new ControlError("invalid-request", "host 설정은 객체여야 합니다");
  const allowedKeys = ["kind", "command", "permissionMode", "allowedTools", "disallowedTools", "model"];
  const extra = Object.keys(raw).filter((key) => !allowedKeys.includes(key));
  if (extra.length) throw new ControlError("invalid-request", `모르는 host 설정 키: ${extra.join(", ")}`);
  const strings = (value: unknown, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new ControlError("invalid-request", `${name} 는 문자열 배열입니다`);
    return value as string[];
  };
  if (raw.kind !== undefined && raw.kind !== "claude") throw new ControlError("unsupported", "host.kind 는 claude 만 지원합니다");
  const mode = raw.permissionMode ?? DEFAULT_HOST_PROFILE.permissionMode;
  if (!["acceptEdits", "dontAsk", "manual", "auto"].includes(String(mode))) {
    throw new ControlError("policy-forbids", "permissionMode 는 acceptEdits·dontAsk·manual·auto 중 하나입니다(bypassPermissions·plan 은 받지 않는다)");
  }
  const command = strings(raw.command, "host.command") ?? DEFAULT_HOST_PROFILE.command;
  if (!command.length) throw new ControlError("invalid-request", "host.command 가 비었습니다");
  const allowed = strings(raw.allowedTools, "host.allowedTools") ?? DEFAULT_HOST_PROFILE.allowedTools;
  if (allowed.some((tool) => /^(?:Bash|PowerShell)(?:\(\*\))?$/.test(tool))) throw new ControlError("policy-forbids", "셸 전체 허용(Bash·PowerShell·Bash(*))은 받지 않습니다 — 명령 접두어로 좁혀 주세요");
  const disallowed = [...new Set([...(strings(raw.disallowedTools, "host.disallowedTools") ?? []), "AskUserQuestion"])];
  return { kind: "claude", command, permissionMode: mode as HostProfile["permissionMode"], allowedTools: allowed, disallowedTools: disallowed,
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}) };
}

export interface RequestEnvelope {
  protocol: typeof PROTOCOL;
  version: number;
  type: CommandType;
  controller?: string;
  generation?: number;
  token?: string;
  commandId?: string;
  expect?: { stateVersion?: string; work?: string | null; attempt?: string | null };
  payload?: Record<string, unknown>;
}

export interface ResponseEnvelope {
  protocol: typeof PROTOCOL;
  version: number;
  ok: boolean;
  type: string;
  commandId?: string;
  /** 같은 commandId 의 재전송에 기록된 응답을 돌려줬다 */
  replayed?: boolean;
  result?: unknown;
  error?: { code: ErrorCode; message: string; detail?: unknown };
  events?: { logId: string; latestSeq: number };
  ownership?: { controller: string; generation: number; handover?: string };
  at: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }

export function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 요청 꼴 검사 — 내용 판단(권한·상태)은 하지 않는다 */
export function parseRequest(text: string): RequestEnvelope {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ControlError("invalid-request", "요청이 JSON 이 아닙니다"); }
  if (!plain(raw)) throw new ControlError("invalid-request", "요청은 객체여야 합니다");
  if (raw.protocol !== PROTOCOL) throw new ControlError("unsupported-protocol", `protocol 은 ${PROTOCOL} 입니다`, { supported: SUPPORTED_VERSIONS });
  if (typeof raw.version !== "number" || !(SUPPORTED_VERSIONS as readonly number[]).includes(raw.version)) {
    throw new ControlError("unsupported-protocol", `지원하지 않는 프로토콜 버전: ${String(raw.version)}`, { supported: SUPPORTED_VERSIONS });
  }
  if (typeof raw.type !== "string" || !(COMMAND_TYPES as readonly string[]).includes(raw.type)) {
    throw new ControlError("unsupported", `지원하지 않는 명령: ${String(raw.type)}`, { supported: COMMAND_TYPES });
  }
  const allowed = ["protocol", "version", "type", "controller", "generation", "token", "commandId", "expect", "payload"];
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ControlError("invalid-request", `모르는 필드: ${extra.join(", ")}`);
  if (raw.controller !== undefined && !validId(raw.controller)) throw new ControlError("invalid-request", "controller 형식이 올바르지 않습니다");
  if (raw.generation !== undefined && (typeof raw.generation !== "number" || !Number.isInteger(raw.generation) || raw.generation < 1)) {
    throw new ControlError("invalid-request", "generation 은 1 이상의 정수입니다");
  }
  if (raw.token !== undefined && typeof raw.token !== "string") throw new ControlError("invalid-request", "token 은 문자열입니다");
  if (raw.commandId !== undefined && !validId(raw.commandId)) throw new ControlError("invalid-request", "commandId 는 영문·숫자·._:- 128자 이하입니다");
  if (raw.expect !== undefined && !plain(raw.expect)) throw new ControlError("invalid-request", "expect 는 객체입니다");
  if (raw.payload !== undefined && !plain(raw.payload)) throw new ControlError("invalid-request", "payload 는 객체입니다");
  if ((MUTATING_TYPES as readonly string[]).includes(raw.type) && raw.commandId === undefined) {
    throw new ControlError("invalid-request", `${raw.type} 에는 commandId 가 필요합니다(같은 ID 의 재전송은 한 번만 실행된다)`);
  }
  return raw as unknown as RequestEnvelope;
}

/** 키 순서를 고정한 JSON — 요청 해시·판단 해시 입력 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** 같은 commandId 의 재전송인지 가르는 해시 — 토큰·세대는 넣지 않는다(내용이 같으면 같은 명령) */
export function requestHash(request: RequestEnvelope): string {
  return `sha256:${sha256(canonicalJson({ type: request.type, controller: request.controller ?? null, expect: request.expect ?? null, payload: request.payload ?? null }))}`;
}

/** 이벤트 종류 — events 응답의 type */
export const EVENT_TYPES = [
  "binding.enabled", "binding.disabled", "controller.added", "grant.added", "grant.revoked", "policy.changed",
  "command.accepted", "command.rejected",
  "run.accepted", "run.starting", "run.started", "run.stop-requested", "run.finished", "run.abandoned", "run.orphaned", "run.unknown",
  "master.disconnected", "master.reconnected",
  "work.bound", "phase.changed", "attempt.changed", "resume.changed", "question.opened", "question.answered", "consent.opened", "consent.updated", "consent.closed",
  "verification.recorded", "decision.recorded", "decision.applied", "decision.rejected", "answer.recorded",
  "handover.requested", "handover.stopping", "handover.stopped", "handover.transferred", "handover.accepted", "handover.aborted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
