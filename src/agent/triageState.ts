import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { Stop } from "./stop";
import { skill } from "./hostText";
import { readJson } from "./stateJson";

// 접수 전 조사 자료는 기존 log/ 제외 규칙을 쓴다. 인계할 때 작업 문서로 복사한다.
export const TRIAGE_DIR = ".code-agent/log/triage";
export const TRIAGE_ACTIVE = `${TRIAGE_DIR}/active.json`;
export const TRIAGE_INPUT = ".code-agent/log/triage-input.json";
const text = z.string().trim().min(1);
export const JiraSchema = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/), url: z.url() });
export const TriageReportSchema = z.object({
  title: text,
  errorLog: z.string().min(1).refine(value => value.trim().length > 0),
  release: text,
  facts: z.array(text).min(1),
  hypotheses: z.array(text),
  cause: z.enum(["code", "data", "environment", "external", "mixed", "unknown"]),
  codeChange: z.enum(["required", "unnecessary", "undetermined"]),
  reason: text,
  evidence: z.array(z.object({ path: text, line: z.number().int().positive(), quote: text })),
  nextActions: z.array(text).min(1),
  missingEvidence: z.array(text),
  duplicate: z.object({ status: z.enum(["unchecked", "none", "existing"]), evidence: text, jira: JiraSchema.optional() }),
  candidateReview: z.array(z.object({ id: text, decision: z.enum(["different", "same", "uncertain", "reassess"]), reason: text })).optional(),
  proposal: z.object({ target: text, scope: z.array(text).min(1), preserve: z.array(text).min(1),
    requirements: z.array(text).min(1), done: z.array(text).min(1) }).optional(),
}).superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.cause === "unknown" && value.codeChange !== "undetermined") issue("원인 미확인은 판단 보류로 제출하세요");
  if (value.codeChange === "undetermined" && !value.missingEvidence.length) issue("판단 보류에는 필요한 추가 증거를 적으세요");
  if (value.codeChange === "required" && (!value.proposal || !value.evidence.length)) issue("코드 변경 필요에는 코드 근거와 수정 제안이 필요합니다");
  if (value.duplicate.status === "existing" && !value.duplicate.jira) issue("기존 Jira의 키와 URL이 필요합니다");
  if (value.duplicate.status !== "existing" && value.duplicate.jira) issue("기존 Jira는 existing 판정에만 적습니다");
});
export type TriageReport = z.infer<typeof TriageReportSchema>;
const RecordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/), source: text, report: TriageReportSchema.optional(),
  base: text.optional(),
  revision: z.number().int().nonnegative(), codeHashes: z.record(z.string(), z.string()).optional(),
  jira: JiraSchema.optional(), handedOff: z.boolean().optional(),
  intake: z.object({ project: text, fingerprint: text, family: text, reliable: z.boolean(),
    original: z.string().refine(x => !!x.trim()), count: z.number().int().positive(), firstSeen: text, lastSeen: text,
    release: text.optional(), candidates: z.array(text) }).optional(),
  lifecycle: z.enum(["investigating", "fixing", "awaiting-deployment", "resolved", "paused", "operational"]).optional(),
  deployment: z.object({ release: text, evidence: text, at: text }).optional(),
  related: text.optional(),
  reassessmentReason: text.optional(),
});
export type TriageRecord = z.infer<typeof RecordSchema>;
export const triageFolder = (id: string): string => `${TRIAGE_DIR}/${id}`;
export const triageDraft = (id: string): string => `${triageFolder(id)}/draft.json`;
export const triageRecordFile = (id: string): string => `${triageFolder(id)}/record.json`;

export function readTriageRecord(root: string, id: string): TriageRecord {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Stop("사전 판별 ID 형식이 잘못됐습니다");
  const record = readJson(join(root, triageRecordFile(id)), RecordSchema, triageRecordFile(id));
  if (record.id !== id) throw new Stop("사전 판별 기록의 ID가 경로와 다릅니다");
  return record;
}
export function loadTriage(root: string): TriageRecord | undefined {
  const path = join(root, TRIAGE_ACTIVE);
  if (!existsSync(path)) return undefined;
  const active = readJson(path, z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }), TRIAGE_ACTIVE);
  return readTriageRecord(root, active.id);
}
export function triageSummary(record: TriageRecord): string {
  const next = record.related ? `code-agent triage status ${record.related}`
    : record.lifecycle === "resolved" ? "발생 버전과 배포 버전을 비교하고 재발 여부를 확인합니다"
    : record.lifecycle === "awaiting-deployment" ? `배포 확인 뒤 code-agent triage deployed ${record.id} <버전> <근거>`
    : record.lifecycle === "operational" ? `운영 판정을 재사용합니다. 새 근거는 code-agent triage reassess ${record.id} <사유>`
    : record.handedOff ? `${skill("ca-fix")} ${record.jira!.key} 로 기존 접수를 이어갑니다`
    : record.lifecycle === "paused" ? `code-agent triage reassess ${record.id} <사유>`
    : record.jira ? "code-agent triage handoff"
    : record.report?.codeChange === "required" ? "code-agent triage jira — 중복 확인 뒤 Jira 본문을 준비합니다"
    : record.report?.codeChange === "unnecessary" ? "운영 조치를 보고하고 code-agent triage close"
    : `${skill("ca-fix")} 의 사전 판별로 조사한 뒤 code-agent triage submit`;
  return `사전 판별: ${record.source} · ${record.report?.codeChange ?? "조사 중"}${record.jira ? ` · ${record.jira.key}` : ""}${record.lifecycle ? ` · ${record.lifecycle}` : ""}\n조사 ID: ${record.id}${record.intake ? ` · 접수 ${record.intake.count}회 · 유사 후보: ${record.intake.candidates.join(", ") || "없음"}` : ""}\n초안: ${triageDraft(record.id)}\n다음: ${next}`;
}
export function requireNoTriage(root: string): void {
  if (loadTriage(root)) throw new Stop("사전 판별 중입니다 — 코드 변경 필요 판정과 Jira 연결 뒤 code-agent triage handoff 로 접수하거나, triage close 로 조사를 닫으세요.");
}
