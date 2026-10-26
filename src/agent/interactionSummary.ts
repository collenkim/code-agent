/** 상태·hook용 읽기 전용 요약. 응답 대기 중인 원래 세션의 전진을 막는다. */
import { readInteractions } from "./interactionState";
import { checkoutBranch } from "./branchCursor";
import type { InteractionRecord } from "./interactions";
import { nativeEvidenceReader } from "./nativeQuestionEvidence";

export interface InteractionSummary { cursor: number; pending: string[]; responded: string[]; deferred: string[]; recoverable?: string[] }
export function interactionSummary(root: string, sessionId?: string): InteractionSummary {
  const ledger = readInteractions(root);
  if (!ledger) return { cursor: 0, pending: [], responded: [], deferred: [] };
  const branch = checkoutBranch(root) ?? null;
  const observed = nativeEvidenceReader(root);
  const scoped = (Object.values(ledger.requests) as InteractionRecord[])
    .filter(r => r.context.branch === branch && (!sessionId || r.context.sessionId === sessionId) && r.kind !== "consent");
  const recoverable = scoped.filter(r => ["pending", "deferred", "expired"].includes(r.status) && observed(r)).map(r => r.requestId);
  const requests = scoped.filter(r => !recoverable.includes(r.requestId));
  return { cursor: ledger.seq, pending: requests.filter(r => r.status === "pending").map(r => r.requestId), responded: requests.filter(r => r.status === "responded").map(r => r.requestId), deferred: requests.filter(r => r.status === "deferred").map(r => r.requestId), ...(recoverable.length ? { recoverable } : {}) };
}
