/** 질문·응답·소비·적용 영속 원장. 하나의 잠금과 원자적 파일 교체로 첫 응답만 수락한다. */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { writeAtomic, writeIfChanged } from "../core/atomic";
import { acquireLock } from "./lock";
import { checkoutBranch } from "./branchCursor";
import { loadActive, REQUEST_SESSION_FILE } from "./layout";
import { commitOf } from "./tree";
import { canonicalJson, ControlError, sha256 } from "./master/protocol";
import type { InteractionQuestion, InteractionSubmission, PublishInteraction } from "./interactionSchema";

import { INTERACTIONS_DIR } from "./interactionPaths";
export { INTERACTIONS_DIR } from "./interactionPaths";
export interface InteractionContext { root: string; branch: string | null; head: string | null; workId: string | null; sessionId: string; host: "claude" | "codex"; runId?: string }
export interface InteractionRecord {
  schemaVersion: 1; source: "code-agent"; sourceInstanceId: string; requestId: string; revision: number; contentHash: string; key: string;
  createdAt: string; updatedAt: string; expiresAt: string; challenge: string;
  stage: PublishInteraction["stage"]; kind: "question" | "consent" | "recovery-decision" | "host-permission"; title: string; questions: InteractionQuestion[];
  context: InteractionContext;
  /** 원래 서명 문맥은 유지하고 TTY로 확인한 독립 세션 복원만 따로 연결한다. */
  recoveredRunId?: string;
  origin: { type: "host" | "questions" | "consent" | "codex-command"; id: string; hash?: string };
  permission?: { command: string; cwd: string; reason: string; threadId: string; turnId: string; itemId: string; rpcId: string | number; connectionId: string; generation: number; controller: string; scope: "once" };
  consent?: { consentId: string; action: string; summary: string; shownHash: string; choices: { index: number; shown: string; target?: string; key?: string }[]; allowedResponses: string[]; humanOnly: boolean };
  status: "pending" | "responded" | "applied" | "deferred" | "expired" | "cancelled" | "superseded" | "failed";
  response?: { receiptId: string; commandId: string; at: string; channel: "dashboard-human" | "claude-question" | "codex-elicitation"; submission: InteractionSubmission; channelId?: string; generation?: number };
  consumed?: { at: string; sessionId: string };
  application?: { state: "applying" | "applied" | "failed"; at: string; result?: unknown; error?: string };
  continuation?: { state: "waiting-host" | "queued" | "started" | "blocked"; runId?: string; detail?: string };
  unavailableReason?: string;
  nativeCallIds?: string[];
  /** 조회에 따른 외부 응답 처리기 중복 실행을 잠금 안에서 제한한다. */
  drainRequestedAt?: string;
  /** 표시 실패는 사용자 응답 대기·보류와 구분하며 실제 재표시 때 지운다. */
  presentation?: { state: "failed"; at: string };
}
interface Ledger { version: 1; instanceId: string; seq: number; requests: Record<string, InteractionRecord>; commands: Record<string, { hash: string; requestId: string; response: unknown }> }
export const interactionHash = (value: unknown) => `sha256:${sha256(canonicalJson(value))}`;
export const interactionRunId = (record: InteractionRecord): string | undefined => record.context.runId ?? record.recoveredRunId;
const file = (root: string) => join(root, INTERACTIONS_DIR, "state.json");
export function readInteractions(root: string): Ledger | undefined {
  if (!existsSync(file(root))) return undefined;
  const value = JSON.parse(readFileSync(file(root), "utf8")) as Ledger;
  if (value.version !== 1 || !value.instanceId || !value.requests || !Number.isInteger(value.seq)) throw new Error("질문 원장 형식을 확인할 수 없습니다");
  return value;
}
export function mutateInteractions<T>(root: string, action: (state: Ledger) => T): T {
  mkdirSync(join(root, INTERACTIONS_DIR), { recursive: true });
  writeIfChanged(join(root, INTERACTIONS_DIR, ".gitignore"), "*\n");
  const release = acquireLock(join(root, INTERACTIONS_DIR, "store.lock"), { waitMs: 10000, ageReclaim: false, label: "질문 원장" });
  try {
    const saved = readInteractions(root), state = saved ?? { version: 1, instanceId: randomUUID(), seq: 0, requests: {}, commands: {} };
    const before = saved && JSON.stringify(saved);
    const result = action(state);
    const after = JSON.stringify(state);
    if (before !== after) writeAtomic(file(root), after + "\n");
    return result;
  } finally { release(); }
}
export function interactionContext(root: string, sessionId: string, host: "claude" | "codex", runId?: string): InteractionContext {
  const active = loadActive(root);
  const intake = existsSync(join(root, REQUEST_SESSION_FILE)) ? JSON.parse(readFileSync(join(root, REQUEST_SESSION_FILE), "utf8")) : undefined;
  return { root: realpathSync(root), branch: checkoutBranch(root) ?? null, head: existsSync(join(root, ".git")) ? commitOf(root, "HEAD") ?? null : null,
    workId: active?.id ?? intake?.id ?? null, sessionId, host, ...(runId ? { runId } : {}) };
}
export function contextMatches(root: string, context: InteractionContext): boolean {
  return canonicalJson(interactionContext(root, context.sessionId, context.host, context.runId)) === canonicalJson(context);
}
export function bumpInteraction(state: Ledger, record: InteractionRecord): void { record.revision = ++state.seq; record.updatedAt = new Date().toISOString(); }
export function needInteraction(state: Ledger | undefined, id: string): InteractionRecord {
  const record = state?.requests[id];
  if (!record) throw new ControlError("not-found", "질문 요청이 없습니다");
  return record;
}
export function publishInteraction(root: string, input: PublishInteraction, context: InteractionContext, origin: InteractionRecord["origin"] = { type: "host", id: input.key }, consent?: InteractionRecord["consent"], unavailableReason?: string, renewApplied = false): InteractionRecord {
  return mutateInteractions(root, state => {
    const contentHash = interactionHash({ stage: input.stage, kind: consent ? "consent" : input.kind, title: input.title, questions: input.questions, context, origin, consent });
    const old = Object.values(state.requests).filter(r => r.key === input.key && r.context.sessionId === context.sessionId && r.origin.type === origin.type).at(-1);
    if (old && old.contentHash === contentHash && !(renewApplied && old.status === "applied")) return old;
    if (old?.status === "responded") throw new ControlError("conflict", "이미 수신한 답을 먼저 소비·적용해야 질문을 바꿀 수 있습니다");
    if (old && ["pending", "deferred"].includes(old.status)) { old.status = "superseded"; bumpInteraction(state, old); }
    const at = new Date().toISOString();
    const record: InteractionRecord = { schemaVersion: 1, source: "code-agent", sourceInstanceId: state.instanceId, requestId: randomUUID(), revision: 0, contentHash,
      key: input.key, stage: input.stage, kind: consent ? "consent" : input.kind, title: input.title, questions: input.questions, context, origin, consent,
      createdAt: at, updatedAt: at, expiresAt: new Date(Date.now() + input.expiresInMs).toISOString(), challenge: randomUUID(), status: "pending", unavailableReason };
    bumpInteraction(state, record); state.requests[record.requestId] = record; return record;
  });
}
export function currentInteractions(root: string): { sourceInstanceId: string | null; cursor: number; requests: InteractionRecord[] } {
  const state = readInteractions(root);
  return { sourceInstanceId: state?.instanceId ?? null, cursor: state?.seq ?? 0, requests: Object.values(state?.requests ?? {}) };
}
