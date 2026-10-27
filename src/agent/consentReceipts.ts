/**
 * 동의 영수증과 원장 끝줄 대조.
 *
 * 승인 원장(approvals/<slug>.jsonl·<slug>/request.jsonl)은 해시 사슬이라 중간 줄을 고치거나 지우면 읽기를 거부하지만, **끝줄 삭제**는
 * 사슬만으로 드러나지 않는다. 반영 때 이 작업의 동의 기록(consents/*.json — gitignore 라 커밋되지 않는다)과 원장을 대조하고, 선택 label·
 * 시각·세션·실패 원인만 남긴 영수증(approvals/<slug>/consents.jsonl)을 반영 커밋에 함께 넣는다.
 *
 * consent.ts 를 import 하지 않는다(consent.ts 가 deliver.ts 를 import 하므로 순환을 피한다) — 동의 기록 파일을 직접 읽는다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { APPROVALS_DIR, readLedger } from "../core/approval";
import { writeAtomic } from "../core/atomic";
import { slug } from "../core/workOrder";
import { CONSENT_DIR } from "./consentState";
import { readRequestLedger } from "./request";
import type { Work } from "./work";

export interface Receipt {
  id: string; action: string; decision?: string; kind?: string; createdAt: string;
  /** applying 은 이 반영 커밋을 만드는 동의라 this-commit 으로 적는다 */
  status: string;
  channel?: string; preparedSession?: { host: string; id: string }; sessionId?: string;
  observed: { at: string; toolId: string; choices: string[] }[];
  failure?: { class: string; kind?: string; detail: string };
  /** master 위임 판단으로 답한 동의 — 사람의 응답(observed)이 아니다 */
  delegation?: { decisionId: string; grantId: string; controller: string; generation: number; verdict: string; category: string; at: string };
  dashboardHuman?: { receiptId: string; channelId: string; sessionId: string; shownHash: string; verdict: string; at: string };
}
interface StoredConsent {
  id?: string; workId?: string; createdAt?: string; status?: string; channel?: string; sessionId?: string;
  action?: { action?: string; decision?: string; kind?: string };
  preparedSession?: { host?: string; id?: string };
  observed?: { at?: string; toolId?: string; answers?: Record<string, unknown> }[];
  failure?: { class?: string; kind?: string; detail?: string };
  delegation?: { decisionId?: string; grantId?: string; controller?: string; generation?: number; verdict?: string; category?: string; at?: string };
  dashboardHuman?: Receipt["dashboardHuman"];
}

function storedConsents(root: string, workId: string): StoredConsent[] {
  const dir = join(root, CONSENT_DIR);
  if (!existsSync(dir)) return [];
  const records: StoredConsent[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as StoredConsent;
      if (record?.workId === workId && typeof record.id === "string" && typeof record.createdAt === "string") records.push(record);
    } catch { /* 깨진 기록은 영수증에 싣지 않는다 */ }
  }
  return records.sort((a, b) => a.createdAt!.localeCompare(b.createdAt!));
}

/** 이 작업의 동의 영수증 — 질문 원문(요약 전문)은 싣지 않고 선택 label 만 싣는다 */
export function consentReceipts(root: string, workId: string): Receipt[] {
  return storedConsents(root, workId).map((record) => ({
    id: record.id!, action: record.action?.action ?? "?",
    ...(record.action?.decision && record.action.decision !== "accept" ? { decision: record.action.decision } : {}),
    ...(record.action?.kind ? { kind: record.action.kind } : {}),
    createdAt: record.createdAt!,
    status: record.status === "applying" ? "this-commit" : record.status ?? "?",
    ...(record.channel ? { channel: record.channel } : {}),
    ...(record.dashboardHuman ? { dashboardHuman: record.dashboardHuman } : {}),
    ...(record.preparedSession?.id ? { preparedSession: { host: record.preparedSession.host ?? "?", id: record.preparedSession.id } } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    observed: (record.observed ?? []).map((row) => ({ at: row.at ?? "", toolId: row.toolId ?? "",
      choices: Object.values(row.answers ?? {}).filter((value): value is string => typeof value === "string") })),
    ...(record.failure?.class ? { failure: { class: record.failure.class, ...(record.failure.kind ? { kind: record.failure.kind } : {}), detail: record.failure.detail ?? "" } } : {}),
    ...(record.delegation?.decisionId ? { delegation: { decisionId: record.delegation.decisionId, grantId: record.delegation.grantId ?? "?", controller: record.delegation.controller ?? "?",
      generation: record.delegation.generation ?? 0, verdict: record.delegation.verdict ?? "?", category: record.delegation.category ?? "?", at: record.delegation.at ?? "" } } : {}),
  }));
}

export function receiptsFile(work: Work): string {
  return `${APPROVALS_DIR}/${slug(work.active.id)}/consents.jsonl`;
}

/** 영수증을 통째로 다시 쓴다 — 반영 커밋 직전에 부른다(경로가 deliveryPaths 의 approvals/<slug> 안이라 같은 커밋에 든다) */
export function writeConsentReceipts(work: Work): void {
  const receipts = consentReceipts(work.repoRoot, work.active.id);
  const path = join(work.repoRoot, receiptsFile(work));
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + (receipts.length ? "\n" : ""));
}

/**
 * 적용된 plan·request 동의마다 그 원장에 판정 줄(presence.detail 에 동의 ID)이 있어야 한다 — 없으면 원장 끝줄이 지워졌을 수 있다.
 * 동의 기록이 없거나(다른 PC·정리됨) 작업 ID 를 모르는 이전 형식 기록은 대조하지 않는다.
 */
export function consentLedgerProblems(work: Work): string[] {
  const { repoRoot, active } = work;
  const applied = storedConsents(repoRoot, active.id).filter((record) => record.status === "applied" &&
    (record.action?.action === "plan" || record.action?.action === "request"));
  if (!applied.length) return [];
  const problems: string[] = [];
  let plan: string[] | undefined, request: string[] | undefined;
  for (const record of applied) {
    let details: string[];
    try {
      details = record.action!.action === "plan"
        ? plan ??= readLedger(repoRoot, active.id).map((row) => row.presence?.detail ?? "")
        : request ??= readRequestLedger(repoRoot, active.id).map((row) => row.presence?.detail ?? "");
    } catch { continue; }   // 사슬이 끊긴 원장은 읽기 자체가 거부된다 — 그 문구는 다른 게이트가 낸다
    if (!details.some((detail) => detail.includes(record.id!))) {
      problems.push(`승인 원장에서 동의 ${record.id!.slice(0, 8)}(${record.action!.action}, ${record.createdAt})의 판정 줄이 없습니다 — 원장 끝줄이 지워졌을 수 있습니다. git 으로 원장을 복원하세요.`);
    }
  }
  return problems;
}
