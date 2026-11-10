import { sha256, canonicalJson } from "../../core/serialize";
import type { KnowledgeHandoff, KnowledgeRef, KnowledgeRefV1, KnowledgeRefV2 } from "../plugins/protocol";
export { sha256, canonicalJson } from "../../core/serialize";
/**
 * master 연동 통신 계약(`code-agent.master` v1) — 순수 모듈(fs·child_process 없음). 명령·응답·이벤트의 꼴과 오류 코드, 위임할 수 있는
 * 동작과 사람만 하는 동작, 시간 정책의 기본값을 한곳에 둔다. 문서는 doc/master-control.md 다.
 *
 * - 전송은 로컬 CLI 다: `code-agent master call` 이 stdin 의 요청 한 건을 읽어 응답 한 건을 stdout 에 쓴다(서버·포트 없음).
 * - 연결(토큰)은 권한이 아니다: 승인·답 위임은 사람이 TTY 에서 따로 준 권한(grant) 범위에서만 받는다.
 */

export const PROTOCOL = "code-agent.master";
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS = [1] as const;

/** 토큰 없이 받는 요청 — 기능 협상과 대시보드 페어링(pair 는 PC 신뢰 키 서명으로 인증하고 commandId 가 필요하다) */
export const OPEN_TYPES = ["hello", "pair.challenge", "pair"] as const;
/** 읽기 전용 요청 — commandId 가 없어도 되고 기록하지 않는다 */
export const READ_TYPES = ["snapshot", "events", "heartbeat", "command", "questions", "consents", "result", "grants", "interactions", "interaction", "interaction.result"] as const;
/** 상태를 바꾸는 요청 — commandId 가 필요하고 같은 ID 의 재전송은 기록된 응답을 그대로 돌려준다 */
export const MUTATING_TYPES = ["submit", "pause", "cancel", "resume", "decide", "answer", "handover", "reconcile", "policy", "revoke", "interaction.respond", "knowledge"] as const;
export const COMMAND_TYPES = [...OPEN_TYPES, ...READ_TYPES, ...MUTATING_TYPES] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** 이 버전이 지원하지 않는다고 명시하는 기능 — hello 가 그대로 돌려준다 */
export const UNSUPPORTED = [
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
export interface ClaudeHostProfile {
  kind: "claude";
  /** 실행 파일과 앞 인자. 기본 ["claude"] */
  command: string[];
  permissionMode: "acceptEdits" | "dontAsk" | "manual" | "auto";
  allowedTools: string[];
  disallowedTools: string[];
  model?: string;
}
export interface CodexHostProfile {
  kind: "codex";
  command: string[];
  sandbox: "read-only" | "workspace-write";
  model?: string;
}
export type HostProfile = ClaudeHostProfile | CodexHostProfile;
/** master 가 새 실행(start)에 고른 실행 방식 — 단독이면 그 호스트, both 면 main 이 개발하고 상대 호스트가 계획·코드 리뷰를 교차 검증한다 */
export interface RunExecution { mode: "claude" | "codex" | "both"; main?: "claude" | "codex" }
export function runExecutionOf(raw: unknown): RunExecution | undefined {
  if (raw === undefined) return undefined;
  if (!plain(raw)) throw new ControlError("invalid-request", "execution 은 { mode, main } 객체입니다");
  const extra = Object.keys(raw).filter((key) => key !== "mode" && key !== "main");
  if (extra.length) throw new ControlError("invalid-request", `모르는 execution 키: ${extra.join(", ")}`);
  if (raw.mode === "claude" || raw.mode === "codex") {
    if (raw.main !== undefined && raw.main !== raw.mode) throw new ControlError("invalid-request", "단독 실행에는 다른 main 을 지정하지 않습니다");
    return { mode: raw.mode };
  }
  if (raw.mode !== "both") throw new ControlError("invalid-request", "execution.mode 는 claude·codex·both 입니다");
  if (raw.main !== "claude" && raw.main !== "codex") throw new ControlError("invalid-request", "execution both 에는 main(claude·codex)이 필요합니다");
  return { mode: "both", main: raw.main };
}
export const executionMain = (execution: RunExecution): "claude" | "codex" => execution.mode === "both" ? execution.main! : execution.mode;

/**
 * master 가 인계하는 지식 항목 참조(submit `knowledge`)의 형식 — 1은 첫 계약(`{version:1, refs:[{itemId, generation, commit, itemSha256,
 * required}]}`)이고 2는 생산자 V2 의 `items[].ref`(ItemRef) 필드 이름 그대로에 `required` 를 더한 확장이다. 두 형식 모두 엄격 검사한다 —
 * 형식 1에 형식 2의 필드를 섞으면 받지 않는다. 생산자 응답 형식(`responseVersion`)과는 다른 번호다.
 */
export const KNOWLEDGE_REFS_VERSION = 1;
export const KNOWLEDGE_HANDOFF_VERSIONS = [1, 2] as const;
export const MAX_KNOWLEDGE_REFS = 20;
/** 한 번에 받는 인계의 크기 상한(정규화 JSON UTF-8 바이트) — 큰 본문을 인계에 싣지 않게 */
export const MAX_KNOWLEDGE_BYTES = 32 * 1024;
const KNOWLEDGE_KEYS = ["version", "refs"];
const KNOWLEDGE_REF_KEYS = ["itemId", "generation", "commit", "itemSha256", "required"];
const KNOWLEDGE_REF_V2_REQUIRED = ["indexId", "indexGeneration", "itemId", "itemSha256", "commit", "sourceId", "path", "startLine", "endLine"];
const KNOWLEDGE_REF_V2_KEYS = [...KNOWLEDGE_REF_V2_REQUIRED, "segmentId", "segmentSha256", "segmentStartLine", "segmentEndLine", "handle", "projectId", "documentSha256", "blobSha", "required"];
const CONTROL_CHAR = /\p{Cc}/u;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const INDEX_ID = /^[0-9a-f]{32}$/;
const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HANDLE = /^[A-Za-z0-9_.:-]{1,64}$/;

const handoffError = (reason: string, message: string, at?: string): ControlError =>
  new ControlError("invalid-request", message, { reason, ...(at ? { at } : {}) });

/** 저장소 기준 상대 경로인가(knowledgeRefs.ts `safeDocPath` 와 같은 규칙) */
function safeRelative(path: string): boolean {
  if (path === "" || path.length > 512 || path.includes("\\") || CONTROL_CHAR.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function itemIdOf(value: unknown, at: string): string {
  // 항목 ID 는 `<원본>:<경로>#<위치>` 꼴이다 — 원본 이름으로 대응 프로젝트를 가르므로 구분자가 없으면 받지 않는다
  if (typeof value !== "string" || !value.length || value.length > 512 || !value.trim() || CONTROL_CHAR.test(value) || !value.includes(":") || !value.includes("#")) {
    throw handoffError("knowledge-format", `${at}.itemId 는 ':'·'#' 를 담은 512자 이하 문자열입니다(제어 문자 없음)`, at);
  }
  return value;
}
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

function refV1(item: Record<string, unknown>, at: string): KnowledgeRefV1 {
  const unknown = Object.keys(item).filter((key) => !KNOWLEDGE_REF_KEYS.includes(key));
  if (unknown.length) throw handoffError("knowledge-format", `모르는 ${at} 키: ${unknown.join(", ")} — 색인 식별·범위를 보내려면 형식 2를 씁니다`, at);
  const { generation, commit, itemSha256, required } = item;
  const itemId = itemIdOf(item.itemId, at);
  if (!positive(generation)) throw handoffError("knowledge-format", `${at}.generation 은 1 이상의 정수입니다`, at);
  if (typeof commit !== "string" || !HEX40.test(commit)) throw handoffError("knowledge-format", `${at}.commit 은 40자리 소문자 16진입니다`, at);
  if (typeof itemSha256 !== "string" || !HEX64.test(itemSha256)) throw handoffError("knowledge-format", `${at}.itemSha256 은 64자리 소문자 16진입니다`, at);
  if (required !== undefined && typeof required !== "boolean") throw handoffError("knowledge-format", `${at}.required 는 true·false 입니다`, at);
  return { itemId, generation, commit, itemSha256, required: required ?? true };
}

function refV2(item: Record<string, unknown>, at: string): KnowledgeRefV2 {
  const unknown = Object.keys(item).filter((key) => !KNOWLEDGE_REF_V2_KEYS.includes(key));
  if (unknown.length) throw handoffError("knowledge-format", `모르는 ${at} 키: ${unknown.join(", ")}`, at);
  const missing = KNOWLEDGE_REF_V2_REQUIRED.filter((key) => item[key] === undefined || item[key] === null);
  if (missing.length) throw handoffError("knowledge-format", `${at} 에 형식 2 필수 필드가 없습니다: ${missing.join(", ")}`, at);
  const fail = (field: string, rule: string): never => { throw handoffError("knowledge-format", `${at}.${field} 는 ${rule}`, at); };
  const itemId = itemIdOf(item.itemId, at);
  const { indexId, indexGeneration, itemSha256, commit, sourceId, path, startLine, endLine } = item;
  if (typeof indexId !== "string" || !INDEX_ID.test(indexId)) fail("indexId", "32자리 소문자 16진입니다");
  if (!positive(indexGeneration)) fail("indexGeneration", "1 이상의 정수입니다");
  if (typeof itemSha256 !== "string" || !HEX64.test(itemSha256)) fail("itemSha256", "64자리 소문자 16진입니다");
  if (typeof commit !== "string" || !GIT_SHA.test(commit)) fail("commit", "40·64자리 소문자 16진입니다");
  if (typeof sourceId !== "string" || !SOURCE_NAME.test(sourceId)) fail("sourceId", "생산자 원본 이름 꼴입니다");
  if (typeof path !== "string" || !safeRelative(path)) fail("path", "저장소 기준 상대 경로입니다");
  if (!itemId.startsWith(`${sourceId as string}:${path as string}#`)) fail("itemId", "`<sourceId>:<path>#` 로 시작합니다");
  if (!positive(startLine) || !positive(endLine) || (startLine as number) > (endLine as number)) fail("startLine", "endLine 이하의 1 이상 정수입니다");
  const out: KnowledgeRefV2 = {
    indexId: indexId as string, indexGeneration: indexGeneration as number, itemId, itemSha256: itemSha256 as string, commit: commit as string,
    sourceId: sourceId as string, path: path as string, startLine: startLine as number, endLine: endLine as number, required: true,
  };
  const { segmentId, segmentSha256, segmentStartLine, segmentEndLine } = item;
  if (segmentId === undefined || segmentId === null) {
    if ([segmentSha256, segmentStartLine, segmentEndLine].some((value) => value !== undefined && value !== null)) fail("segmentId", "분할 필드를 보낼 때 함께 보냅니다");
  } else {
    if (typeof segmentId !== "string" || segmentId.length > 600 || CONTROL_CHAR.test(segmentId) || !segmentId.startsWith(`${itemId}#`)) fail("segmentId", "`<itemId>#` 로 시작하는 600자 이하 문자열입니다");
    if (typeof segmentSha256 !== "string" || !HEX64.test(segmentSha256)) fail("segmentSha256", "64자리 소문자 16진입니다");
    if (!positive(segmentStartLine) || !positive(segmentEndLine) || (segmentStartLine as number) > (segmentEndLine as number) ||
      (segmentStartLine as number) < out.startLine || (segmentEndLine as number) > out.endLine) fail("segmentStartLine", "원본 범위 안의 분할 줄 범위입니다");
    Object.assign(out, { segmentId, segmentSha256, segmentStartLine, segmentEndLine });
  }
  if (item.handle !== undefined) { if (typeof item.handle !== "string" || !HANDLE.test(item.handle)) fail("handle", "64자 이하 핸들입니다"); out.handle = item.handle as string; }
  if (item.projectId !== undefined) { if (typeof item.projectId !== "string" || !SOURCE_NAME.test(item.projectId)) fail("projectId", "생산자 프로젝트 이름 꼴입니다"); out.projectId = item.projectId as string; }
  if (item.documentSha256 !== undefined) { if (typeof item.documentSha256 !== "string" || !HEX64.test(item.documentSha256)) fail("documentSha256", "64자리 소문자 16진입니다"); out.documentSha256 = item.documentSha256 as string; }
  if (item.blobSha !== undefined) { if (typeof item.blobSha !== "string" || !GIT_SHA.test(item.blobSha)) fail("blobSha", "40·64자리 소문자 16진입니다"); out.blobSha = item.blobSha as string; }
  if (item.required !== undefined && typeof item.required !== "boolean") fail("required", "true·false 입니다");
  out.required = (item.required as boolean | undefined) ?? true;
  return out;
}

/** 참조를 가르는 열쇠 — 항목 ID 와 (분할이면) 분할 ID */
export const knowledgeRefKey = (ref: { itemId: string; segmentId?: string | null }): string => `${ref.itemId}\u0000${ref.segmentId ?? ""}`;

/**
 * submit 의 `knowledge` 를 엄격히 검사한다 — 없으면 undefined. 모르는 키·형식 오류·상한 초과는 invalid-request 이고 `detail.reason` 으로
 * 가른다(knowledge-format·knowledge-version·knowledge-limit·knowledge-too-large·knowledge-duplicate). 조용히 버리면 master 는 근거가
 * 전달된 줄 안다. 참조의 꼴만 본다: 받는 프로젝트의 등록 문서 범위는 submit 이(control.ts), 항목·내용은 진행 게이트 전 검증이 대조한다.
 * `required` 는 생략하면 true 다(검증되지 않으면 이 작업을 멈추는 항목).
 */
export function knowledgeHandoffOf(raw: unknown): KnowledgeHandoff | undefined {
  if (raw === undefined) return undefined;
  if (!plain(raw)) throw handoffError("knowledge-format", "knowledge 는 { version, refs } 객체입니다");
  const extra = Object.keys(raw).filter((key) => !KNOWLEDGE_KEYS.includes(key));
  if (extra.length) throw handoffError("knowledge-format", `모르는 knowledge 키: ${extra.join(", ")}`);
  if (raw.version !== 1 && raw.version !== 2) throw handoffError("knowledge-version", `knowledge.version 은 ${KNOWLEDGE_HANDOFF_VERSIONS.join("·")} 입니다`);
  if (!Array.isArray(raw.refs) || raw.refs.length < 1 || raw.refs.length > MAX_KNOWLEDGE_REFS) {
    throw handoffError("knowledge-limit", `knowledge.refs 는 1~${MAX_KNOWLEDGE_REFS}개 배열입니다`);
  }
  if (Buffer.byteLength(canonicalJson(raw), "utf8") > MAX_KNOWLEDGE_BYTES) throw handoffError("knowledge-too-large", `knowledge 는 ${MAX_KNOWLEDGE_BYTES} 바이트 이하입니다`);
  const version = raw.version;
  const seen = new Set<string>();
  const refs = raw.refs.map((item: unknown, index: number) => {
    const at = `knowledge.refs[${index}]`;
    if (!plain(item)) throw handoffError("knowledge-format", `${at} 는 객체입니다`, at);
    const ref = version === 1 ? refV1(item, at) : refV2(item, at);
    const key = knowledgeRefKey(ref as { itemId: string; segmentId?: string | null });
    if (seen.has(key)) throw handoffError("knowledge-duplicate", `${at} 의 항목${version === 2 ? "·분할" : ""} ID 가 겹칩니다: ${ref.itemId}`, at);
    seen.add(key);
    return ref;
  });
  return version === 1 ? { version: 1, refs: refs as KnowledgeRefV1[] } : { version: 2, refs: refs as KnowledgeRefV2[] };
}

/**
 * 이 수신자가 지금 받는 인계 형식인가 — hello `knowledge.refs.versions` 로 알린 형식만 받는다. 꼴은 맞지만 지금 받지 않는 형식(형식 2를
 * 대조할 등록이 아님)은 invalid-request·`knowledge-version` 이다. 보내는 쪽은 hello 를 다시 읽고 공지된 형식으로 보낸다.
 */
export function requireHandoffVersion(handoff: KnowledgeHandoff, versions: readonly number[]): void {
  if (!versions.includes(handoff.version)) {
    throw handoffError("knowledge-version", `지금 이 프로젝트는 인계 형식 ${versions.join("·")} 만 받습니다(형식 ${handoff.version}) — hello 의 knowledge.refs.versions 를 다시 읽고 보냅니다`);
  }
}

/** 인계 참조를 어댑터 입력·게이트가 쓰는 꼴로 — 형식 2는 `indexGeneration` 을 `generation` 으로 */
export function normalizedKnowledgeRefs(handoff: KnowledgeHandoff): KnowledgeRef[] {
  if (handoff.version === 1) return handoff.refs.map(({ itemId, generation, commit, itemSha256, required }) => ({ itemId, generation, commit, itemSha256, required }));
  return handoff.refs.map((ref) => ({
    itemId: ref.itemId, generation: ref.indexGeneration, commit: ref.commit, itemSha256: ref.itemSha256, required: ref.required,
    indexId: ref.indexId, sourceId: ref.sourceId, path: ref.path, startLine: ref.startLine, endLine: ref.endLine,
    ...(ref.segmentId ? { segmentId: ref.segmentId, segmentSha256: ref.segmentSha256!, segmentStartLine: ref.segmentStartLine!, segmentEndLine: ref.segmentEndLine! } : {}),
  }));
}

/** 참조가 가리키는 원본 경로 — 형식 2는 `path`, 형식 1은 항목 ID 의 `<원본>:` 뒤 첫 `#` 앞 */
export function knowledgeRefPath(ref: { itemId: string; path?: string }): string {
  if (ref.path) return ref.path;
  const colon = ref.itemId.indexOf(":");
  const hash = ref.itemId.indexOf("#", colon + 1);
  return colon >= 0 && hash > colon ? ref.itemId.slice(colon + 1, hash) : "";
}

/** 인계의 정본 해시 — 참조 순서는 보지 않는다. 승인 근거·검증 기록·같은 인계 판정이 쓴다 */
export function knowledgeDigest(handoff: KnowledgeHandoff): string {
  const refs = [...(handoff.refs as { itemId: string; segmentId?: string | null }[])].sort((a, b) => (knowledgeRefKey(a) < knowledgeRefKey(b) ? -1 : knowledgeRefKey(a) > knowledgeRefKey(b) ? 1 : 0));
  return `sha256:${sha256(canonicalJson({ version: handoff.version, refs }))}`;
}
export const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Grep", "Glob", "Write", "Edit", "MultiEdit", "TodoWrite", "Task",
  "Bash(code-agent *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
  "PowerShell(code-agent *)", "PowerShell(git status*)", "PowerShell(git diff*)", "PowerShell(git log*)",
];
export const DEFAULT_HOST_PROFILE: ClaudeHostProfile = {
  kind: "claude", command: ["claude"], permissionMode: "acceptEdits", allowedTools: DEFAULT_ALLOWED_TOOLS,
  // 질문 도구는 사람이 없는 실행에서 답을 받을 수 없다 — 동의·질문은 master 의 위임 또는 사람의 응답으로 받는다
  disallowedTools: ["AskUserQuestion"],
};

export function hostProfileOf(raw: unknown): HostProfile {
  if (raw === undefined) return { ...DEFAULT_HOST_PROFILE };
  if (!plain(raw)) throw new ControlError("invalid-request", "host 설정은 객체여야 합니다");
  const allowedKeys = raw.kind === "codex" ? ["kind", "command", "sandbox", "model"] : ["kind", "command", "permissionMode", "allowedTools", "disallowedTools", "model"];
  const extra = Object.keys(raw).filter((key) => !allowedKeys.includes(key));
  if (extra.length) throw new ControlError("invalid-request", `모르는 host 설정 키: ${extra.join(", ")}`);
  const strings = (value: unknown, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new ControlError("invalid-request", `${name} 는 문자열 배열입니다`);
    return value as string[];
  };
  if (raw.kind === "codex") {
    const sandbox = raw.sandbox ?? "workspace-write";
    if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new ControlError("policy-forbids", "Codex sandbox는 read-only·workspace-write만 지원합니다");
    const command = strings(raw.command, "host.command") ?? ["codex"];
    if (!command.length || command.some(arg => arg.startsWith("-"))) throw new ControlError("policy-forbids", "Codex command는 실행 파일과 진입점만 지정합니다. 실행·권한 옵션은 감독이 구성합니다");
    return { kind: "codex", command, sandbox, ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}) };
  }
  if (raw.kind !== undefined && raw.kind !== "claude") throw new ControlError("unsupported", "host.kind 는 claude·codex를 지원합니다");
  const mode = raw.permissionMode ?? DEFAULT_HOST_PROFILE.permissionMode;
  if (!["acceptEdits", "dontAsk", "manual", "auto"].includes(String(mode))) {
    throw new ControlError("policy-forbids", "permissionMode 는 acceptEdits·dontAsk·manual·auto 중 하나입니다(bypassPermissions·plan 은 받지 않는다)");
  }
  const command = strings(raw.command, "host.command") ?? DEFAULT_HOST_PROFILE.command;
  if (!command.length) throw new ControlError("invalid-request", "host.command 가 비었습니다");
  const allowed = strings(raw.allowedTools, "host.allowedTools") ?? DEFAULT_HOST_PROFILE.allowedTools;
  if (allowed.some((tool) => /^(?:Bash|PowerShell)(?:\(\*\))?$/.test(tool))) throw new ControlError("policy-forbids", "셸 전체 허용(Bash·PowerShell·Bash(*))은 받지 않습니다 — 명령 접두어로 좁혀 주세요");
  const disallowed = [...new Set([...(strings(raw.disallowedTools, "host.disallowedTools") ?? []), "AskUserQuestion"])];
  return { kind: "claude", command, permissionMode: mode as ClaudeHostProfile["permissionMode"], allowedTools: allowed, disallowedTools: disallowed,
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
  if (((MUTATING_TYPES as readonly string[]).includes(raw.type) || raw.type === "pair") && raw.commandId === undefined) {
    throw new ControlError("invalid-request", `${raw.type} 에는 commandId 가 필요합니다(같은 ID 의 재전송은 한 번만 실행된다)`);
  }
  return raw as unknown as RequestEnvelope;
}

/** 같은 commandId 의 재전송인지 가르는 해시 — 토큰·세대는 넣지 않는다(내용이 같으면 같은 명령) */
export function requestHash(request: RequestEnvelope): string {
  return `sha256:${sha256(canonicalJson({ type: request.type, controller: request.controller ?? null, expect: request.expect ?? null, payload: request.payload ?? null }))}`;
}

/** 대시보드 페어링(pair) 계약 — 버전·서명 도메인·챌린지 수명 */
export const PAIRING_VERSION = 1;
export const PAIR_DOMAIN = "code-agent.master-pair.v1";
export const PAIR_CHALLENGE_TTL_MS = 5 * 60_000;
export interface PairApproval { actor: string; approvedAt: string; shownHash: string }
/** pair 서명 대상 — 챌린지의 nonce·프로젝트 경로와 요청의 commandId·사람의 확인을 묶는다(Ed25519, base64) */
export function pairSigningMessage(fields: { challengeId: string; nonce: string; projectRoot: string; controller: string; commandId: string; approval: PairApproval }): string {
  return canonicalJson({ domain: PAIR_DOMAIN, challengeId: fields.challengeId, nonce: fields.nonce, projectRoot: fields.projectRoot, controller: fields.controller,
    commandId: fields.commandId, approval: fields.approval });
}

/** 이벤트 종류 — events 응답의 type */
export const EVENT_TYPES = [
  "binding.enabled", "binding.disabled", "controller.added", "human-channel.changed", "grant.added", "grant.revoked", "policy.changed",
  "command.accepted", "command.rejected",
  "run.accepted", "run.starting", "run.started", "run.stop-requested", "run.finished", "run.abandoned", "run.orphaned", "run.unknown",
  "master.disconnected", "master.reconnected",
  "work.bound", "phase.changed", "attempt.changed", "resume.changed", "question.opened", "question.answered", "consent.opened", "consent.updated", "consent.closed",
  "verification.recorded", "graph.changed", "interaction.changed", "decision.recorded", "decision.applied", "decision.rejected", "answer.recorded",
  "knowledge.verified", "knowledge.blocked", "knowledge.replaced",
  "handover.requested", "handover.stopping", "handover.stopped", "handover.transferred", "handover.accepted", "handover.aborted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
