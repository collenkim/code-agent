/**
 * master 인계 근거의 **진행 게이트** — 작업에 고정된 required 참조가 검증되기 전이거나 검증에 실패했으면 그 작업의 진행(단계 이동·계획
 * 실행·검증 실행·관리 실행 재개)을 멈춘다. 다른 작업과 인계가 없는 작업(단독 실행·off 기본)은 판정에 들지 않는다.
 *
 * 판정은 기록만 읽는다 — 생산자·어댑터를 부르지 않는다(hook·상태 조회가 매번 부른다).
 * - 인계: 작업 연결(`master/works/<ID>.json`)의 `knowledge`. 엄격 검사를 지나지 못하면 멈춘다(`invalid-handoff`).
 * - 검증 기록: `master/knowledge/<ID>.json` — context(analysis~plan)와 `code-agent knowledge verify`·master `knowledge verify` 가 어댑터로
 *   대조한 결과를 쓴다. 진단 로그(`log/knowledge/context.jsonl`)는 근거로 쓰지 않는다 — 지워도 판정이 같다.
 * - 기록은 인계의 정본 해시가 같고, 기록 형식을 알고, 만료(`KNOWLEDGE_VERIFY_TTL_MS`) 전이고, 확인한 범위가 **지금 파일에서도 같은
 *   해시**일 때만 인정한다. 참조·문서·범위·형식이 바뀌면 다시 검증한다.
 *
 * 회복은 같은 참조의 유효한 재검증이나 master 의 명시적 인계 교체(재계획)뿐이다. required 를 낮추거나 최신 항목으로 갈음하지 않는다.
 *
 * hook 경로 모듈이다 — fs·path·crypto·layout·stop·workKnowledge(순수 계약)만 읽는다.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadActive, STATE_DIR } from "./layout";
import { knowledgeRefKey, knowledgeRefPath } from "./master/protocol";
import { managedKnowledgeOf, type ManagedKnowledge } from "./master/workKnowledge";
import { Stop } from "./stop";

export const KNOWLEDGE_RECORD_SCHEMA = "code-agent.knowledge-verification";
export const KNOWLEDGE_RECORD_VERSION = 1;
/** 검증 기록을 인정하는 시간 — 지나면 같은 참조를 다시 검증한다(생산자 세대 보존·폐기 상태를 다시 본다) */
export const KNOWLEDGE_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** 검증 기록의 참조 하나 — 확인했으면 지금 파일에서 확인한 범위와 그 해시 */
export interface KnowledgeRecordRef {
  itemId: string;
  segmentId?: string;
  required: boolean;
  ok: boolean;
  reason?: string;
  path?: string;
  start?: number;
  end?: number;
  /** 확인한 범위(생산자 해시 규칙의 줄)를 "\n" 으로 이은 글의 SHA-256 */
  sha256?: string;
}

export interface KnowledgeRecord {
  schema: typeof KNOWLEDGE_RECORD_SCHEMA;
  version: typeof KNOWLEDGE_RECORD_VERSION;
  workId: string;
  /** 검증한 인계의 정본 해시 */
  digest: string;
  at: string;
  /** 누가 검증했나 — context(analysis~plan 의 문서 검색)·verify(명령)·master(제어 명령) */
  by: "context" | "verify" | "master";
  /** 검증 때 지식 검색 모드 */
  mode: "off" | "shadow" | "enabled";
  plugin?: string;
  refs: KnowledgeRecordRef[];
}

/** 멈춘 원인 갈래 — master·사람이 회복 경로를 고르는 단위 */
export type KnowledgeCause = "unverified" | "hash-mismatch" | "identity-mismatch" | "expired" | "source-changed" | "source-deleted" | "scope" | "adapter";
export type KnowledgeRecovery = "reverify" | "replan";
export const KNOWLEDGE_CAUSES: readonly KnowledgeCause[] = ["unverified", "hash-mismatch", "identity-mismatch", "expired", "source-changed", "source-deleted", "scope", "adapter"];

/**
 * 사유 코드 → 원인·회복. 같은 참조를 다시 검증해 풀릴 수 있는 것(검증 전·만료·어댑터 장애)은 reverify, 참조 자체가 지금 근거와 맞지 않는
 * 것(해시·색인·세대·커밋·원본·범위)은 replan 이다. 모르는 사유는 어댑터 갈래로 본다(다시 검증해 사유를 다시 받는다).
 */
const REASONS: Record<string, [KnowledgeCause, KnowledgeRecovery]> = {
  "not-verified": ["unverified", "reverify"],
  "handoff-changed": ["unverified", "reverify"],
  "record-unreadable": ["unverified", "reverify"],
  "hash-mismatch": ["hash-mismatch", "replan"],
  "generation-mismatch": ["identity-mismatch", "replan"],
  "commit-mismatch": ["identity-mismatch", "replan"],
  "index-mismatch": ["identity-mismatch", "replan"],
  "generation-expired": ["expired", "replan"],
  "verification-expired": ["expired", "reverify"],
  "content-changed": ["source-changed", "replan"],
  "ambiguous": ["source-changed", "replan"],
  "source-changed": ["source-changed", "replan"],
  "range-mismatch": ["source-changed", "replan"],
  "missing-file": ["source-deleted", "replan"],
  "source-deleted": ["source-deleted", "replan"],
  "not-found": ["scope", "replan"],
  "out-of-scope": ["scope", "replan"],
  "not-in-docs": ["scope", "replan"],
  "invalid-ref": ["scope", "replan"],
  "too-many-refs": ["scope", "replan"],
  "invalid-handoff": ["scope", "replan"],
  "knowledge-format": ["scope", "replan"],
  "knowledge-version": ["scope", "replan"],
  "knowledge-limit": ["scope", "replan"],
  "knowledge-too-large": ["scope", "replan"],
  "knowledge-duplicate": ["scope", "replan"],
  "binding-unreadable": ["scope", "replan"],
  // 어댑터 갈래 — 연결(off)·등록·협의·호출이 문제다. 연결·설정·생산자를 고친 뒤 같은 참조를 다시 검증한다(모르는 사유도 여기로)
  "adapter-off": ["adapter", "reverify"],
  "adapter-unregistered": ["adapter", "reverify"],
  "adapter-unsupported": ["adapter", "reverify"],
  "adapter-failed": ["adapter", "reverify"],
  "not-returned": ["adapter", "reverify"],
  "identity-unverifiable": ["adapter", "reverify"],
  "invalid-response": ["adapter", "reverify"],
};

export function knowledgeCause(reason: string): { cause: KnowledgeCause; recovery: KnowledgeRecovery } {
  const [cause, recovery] = REASONS[reason] ?? ["adapter", "reverify"];
  return { cause, recovery };
}

export interface KnowledgeGateRef {
  itemId: string;
  segmentId?: string;
  required: boolean;
  reason: string;
  cause: KnowledgeCause;
  recovery: KnowledgeRecovery;
}

export interface KnowledgeGate {
  /** none: 인계 없음 · pending: required 없는 인계가 아직 검증 전 · verified: 검증됨 · blocked: required 가 검증 전이거나 실패 */
  state: "none" | "pending" | "verified" | "blocked";
  workId?: string;
  digest?: string;
  version?: 1 | 2;
  refs: number;
  required: number;
  verifiedAt?: string;
  expiresAt?: string;
  by?: KnowledgeRecord["by"];
  /** 진행을 멈춘 required 참조 */
  blocked: KnowledgeGateRef[];
  /** 실패한 선택 참조 — 진행은 막지 않는다(진단) */
  optional: KnowledgeGateRef[];
  /** blocked 일 때 다음 동작 — replan 이 하나라도 있으면 knowledge-replan */
  action?: "knowledge-reverify" | "knowledge-replan";
}

export function knowledgeRecordFile(root: string, workId: string): string {
  return join(root, STATE_DIR, "master", "knowledge", `${encodeURIComponent(workId)}.json`);
}

export function readKnowledgeRecord(root: string, workId: string): KnowledgeRecord | undefined | "unreadable" {
  const file = knowledgeRecordFile(root, workId);
  if (!existsSync(file)) return undefined;
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as Partial<KnowledgeRecord>;
    if (record.schema !== KNOWLEDGE_RECORD_SCHEMA || record.version !== KNOWLEDGE_RECORD_VERSION || record.workId !== workId ||
      typeof record.digest !== "string" || typeof record.at !== "string" || !Array.isArray(record.refs)) return "unreadable";
    return record as KnowledgeRecord;
  } catch {
    return "unreadable";
  }
}

/** 생산자 해시 규칙(BOM 제거, `\r\n`·`\n`·`\r` 줄 끝)으로 범위를 이은 글의 해시 — 읽지 못하면 undefined */
export function rangeHash(root: string, path: string, start: number, end: number): string | undefined | "missing" {
  let text: string;
  try { text = readFileSync(join(root, path), "utf8"); } catch { return "missing"; }
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  if (end > lines.length || start < 1 || start > end) return undefined;
  return createHash("sha256").update(lines.slice(start - 1, end).join("\n"), "utf8").digest("hex");
}

const NONE: KnowledgeGate = { state: "none", refs: 0, required: 0, blocked: [], optional: [] };

/** 판정할 작업 — 지금 작업(없으면 판정 없음) */
function activeWorkId(root: string): string | undefined {
  try { return loadActive(root)?.id; } catch { return undefined; }
}

/**
 * 작업 하나의 근거 게이트 판정. `managed` 를 주지 않으면 지금 작업의 인계를 읽는다(작업 연결 → 이 세션의 master 실행).
 * 작업이 없으면(접수 전) 판정하지 않는다 — 단계 이동이 없다.
 */
export function knowledgeGate(root: string, env: Readonly<Record<string, string | undefined>> = process.env, now = Date.now(),
  workId = activeWorkId(root), managed?: ManagedKnowledge): KnowledgeGate {
  if (!workId) return NONE;
  const found = managed ?? managedKnowledgeOf(root, env, workId);
  if (!found) return NONE;
  const base = { workId, digest: found.digest, ...(found.handoff ? { version: found.handoff.version } : {}), refs: found.refs.length, required: found.refs.filter((ref) => ref.required).length };
  if (found.invalid) {
    // 인계 기록이 엄격 검사를 지나지 못했다 — 어느 참조가 required 였는지 믿을 수 없으므로 작업 전체를 멈춘다
    const reason = found.invalid;
    return { ...base, state: "blocked", blocked: [{ itemId: "(인계 기록)", required: true, reason, ...knowledgeCause(reason) }], optional: [], action: "knowledge-replan" };
  }
  const record = readKnowledgeRecord(root, workId);
  const usable = record && record !== "unreadable" && record.digest === found.digest ? record : undefined;
  const expiresAt = usable ? Date.parse(usable.at) + KNOWLEDGE_VERIFY_TTL_MS : Number.NaN;
  const expired = usable !== undefined && !(Number.isFinite(expiresAt) && now < expiresAt);
  const blocked: KnowledgeGateRef[] = [];
  const optional: KnowledgeGateRef[] = [];
  for (const ref of found.refs) {
    const key = knowledgeRefKey(ref);
    const entry = usable?.refs.find((candidate) => knowledgeRefKey(candidate) === key);
    let reason: string | undefined;
    if (record === "unreadable") reason = "record-unreadable";
    else if (record && !usable) reason = "handoff-changed";
    else if (!entry) reason = "not-verified";
    else if (!entry.ok) reason = entry.reason ?? "not-verified";
    else if (expired) reason = "verification-expired";
    else if (!entry.path || entry.start === undefined || entry.end === undefined || !entry.sha256 || entry.path !== knowledgeRefPath(ref)) reason = "not-verified";
    else {
      // 확인한 범위가 지금 파일에서도 같은가 — 문서를 고쳤거나 지웠으면 그 사이 근거가 바뀐 것이다
      const current = rangeHash(root, entry.path, entry.start, entry.end);
      if (current === "missing") reason = "source-deleted";
      else if (current !== entry.sha256) reason = "source-changed";
    }
    if (!reason) continue;
    const judged: KnowledgeGateRef = { itemId: ref.itemId, ...(ref.segmentId ? { segmentId: ref.segmentId } : {}), required: ref.required, reason, ...knowledgeCause(reason) };
    (ref.required ? blocked : optional).push(judged);
  }
  const verified = usable && !expired ? { verifiedAt: usable.at, expiresAt: new Date(expiresAt).toISOString(), by: usable.by } : {};
  if (blocked.length > 0) {
    return { ...base, ...verified, state: "blocked", blocked, optional, action: blocked.some((entry) => entry.recovery === "replan") ? "knowledge-replan" : "knowledge-reverify" };
  }
  return { ...base, ...verified, state: usable && !expired ? "verified" : base.required > 0 ? "blocked" : "pending", blocked, optional };
}

/** 사람·모델이 읽는 한 줄 — 멈춘 참조 수·원인과 회복 경로. 게이트가 막지 않으면 undefined */
export function knowledgeHint(gate: KnowledgeGate): string | undefined {
  if (gate.state !== "blocked") return undefined;
  const causes = [...new Set(gate.blocked.map((entry) => entry.cause))].join("·");
  const shown = gate.blocked.slice(0, 3).map((entry) => `${entry.itemId}${entry.segmentId ? `(${entry.segmentId.slice(entry.itemId.length)})` : ""}: ${entry.reason}`).join(", ");
  const more = gate.blocked.length > 3 ? ` 외 ${gate.blocked.length - 3}개` : "";
  return gate.action === "knowledge-replan"
    ? `master 인계 근거가 지금 근거와 맞지 않습니다(${causes} — ${shown}${more}). 범위를 넓혀 다시 찾거나 required 를 낮추지 말고, master 에 재계획(인계 교체)을 요청하세요.`
    : `master 인계 근거를 아직 검증하지 못했습니다(${causes} — ${shown}${more}). code-agent knowledge verify 로 같은 참조를 다시 검증하세요(지식 검색이 off·미등록이면 켠 뒤).`;
}

/** 근거 게이트가 멈춘 진행 — 사유를 기계가 읽을 수 있게 판정을 함께 싣는다 */
export class KnowledgeStop extends Stop {
  constructor(readonly gate: KnowledgeGate, message: string) { super(message); }
}

/** 진행 전 확인 — 멈추면 KnowledgeStop. `what` 은 멈춘 동작(사람이 읽는 말) */
export function requireKnowledge(root: string, what: string, env: Readonly<Record<string, string | undefined>> = process.env): KnowledgeGate {
  const gate = knowledgeGate(root, env);
  if (gate.state !== "blocked") return gate;
  throw new KnowledgeStop(gate, `${what} 수 없습니다 — ${knowledgeHint(gate)}`);
}

/** 상태 조회(stateView)에 싣는 요약 — 인계가 없으면 undefined */
export function knowledgeView(gate: KnowledgeGate): Record<string, unknown> | undefined {
  if (gate.state === "none") return undefined;
  return {
    state: gate.state, workId: gate.workId, digest: gate.digest, ...(gate.version ? { version: gate.version } : {}), refs: gate.refs, required: gate.required,
    ...(gate.verifiedAt ? { verifiedAt: gate.verifiedAt, expiresAt: gate.expiresAt, by: gate.by } : {}),
    blocked: gate.blocked, optional: gate.optional, ...(gate.action ? { action: gate.action } : {}),
  };
}
