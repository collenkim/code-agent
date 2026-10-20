/** 기존 질문 문서·동의와 공통 요청의 연결. 추천은 Markdown 문구에서 추측하지 않는다. */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { DOCS_SESSION_FILE, loadActive, questionsFile, REQUEST_SESSION_FILE } from "./layout";
import { readLease } from "./lease";
import { parseQuestions } from "./questions";
import { PublishInteraction, type InteractionQuestion } from "./interactionSchema";
import { contextMatches, currentInteractions, interactionContext, interactionHash, publishInteraction, mutateInteractions, bumpInteraction, type InteractionRecord } from "./interactions";
import { listRuns } from "./master/store";
import type { ConsentRecord } from "./consent";
import type { InteractionTicket } from "./interactionTicket";

export function stageOf(root: string): PublishInteraction["stage"] {
  const phase = loadActive(root)?.phase;
  if (!phase) return existsSync(join(root, REQUEST_SESSION_FILE)) ? "request" : existsSync(join(root, DOCS_SESSION_FILE)) ? "document" : "setup";
  if (["analysis", "impact", "design", "plan"].includes(phase)) return "planning";
  if (phase === "implement") return "implementation";
  if (phase === "review") return "review";
  if (phase === "deliver" || phase === "integrate") return "delivery";
  return "verification";
}
export function publishHostInteraction(root: string, raw: unknown, ticket: InteractionTicket): InteractionRecord {
  const input = PublishInteraction.parse(raw);
  const context = interactionContext(root, ticket.sessionId, ticket.host, ticket.runId);
  let origin: InteractionRecord["origin"] = { type: "host", id: input.key };
  if (input.source === "questions") {
    if (!context.workId) throw new Error("질문 문서 연결에는 접수·작업 ID가 필요합니다");
    const text = readFileSync(join(root, questionsFile(context.workId)), "utf8").replace(/\r\n/g, "\n");
    const questions = parseQuestions(text);
    if (input.questions.some(q => !questions.some(old => old.id === q.questionId && !old.answer))) throw new Error("미응답 질문 문서의 ID와 일치해야 합니다");
    origin = { type: "questions", id: context.workId, hash: interactionHash(text) };
  }
  return publishInteraction(root, input, context, origin);
}
export function publishConsentInteraction(root: string, record: ConsentRecord): InteractionRecord {
  const { delegationView } = require("./consent") as typeof import("./consent");
  const view = delegationView(root, record.id);
  const session = record.preparedSession;
  const run = listRuns(root).filter(r => r.sessionId === session?.id).at(-1);
  const stage: PublishInteraction["stage"] = record.action.action === "setup" || record.action.action === "baseline" ? "setup"
    : record.action.action === "docs" ? "document" : record.action.action === "request" ? "request" : record.action.action === "plan" ? "planning"
      : record.action.action === "deliver" ? "delivery" : record.action.action === "judgment" || record.action.action === "repro-log" || record.action.action === "abort" ? "recovery" : "maintenance";
  return publishInteraction(root, { key: `consent:${record.id}`, stage, kind: "question", title: record.summary.split("\n")[0], questions: [], source: "host", expiresInMs: 86400000 },
    interactionContext(root, session?.id ?? record.sessionId ?? "unbound", session?.host ?? "claude", run?.runId), { type: "consent", id: record.id, hash: record.snapshot },
    { consentId: record.id, action: view.action, summary: view.summary, shownHash: view.shownHash, choices: view.choices, allowedResponses: ["approve", "request-changes", "defer"], humanOnly: true },
    session ? undefined : "준비 세션 기록이 없는 이전 동의입니다. 원래 사람 채널에서 처리하세요.");
}
/** 조회도 현재 질문·동의를 대조하므로 hook이 없는 이전 버전의 빈 선택창을 복원하지 않는다. */
export function synchronizeInteractions(root: string): void {
  // 응답 저장 뒤 프로세스가 종료됐어도 취소한 동의가 열린 승인창으로 남지 않게 한다.
  for (const r of currentInteractions(root).requests) if (r.origin.type === "consent" && r.status === "cancelled") {
    (require("./consent") as typeof import("./consent")).closeCancelledDashboardConsent(root, r.origin.id);
  }
  const { loadConsent } = require("./consent") as typeof import("./consent");
  const consents = join(root, ".code-agent/consents");
  const known = currentInteractions(root).requests;
  if (existsSync(consents)) for (const name of readdirSync(consents)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const record = loadConsent(root, name.slice(0, -5));
    if (record.status === "pending" && !known.some(r => r.origin.type === "consent" && r.origin.id === record.id)) publishConsentInteraction(root, record);
  }
  const active = loadActive(root);
  const workId = active?.id ?? (existsSync(join(root, REQUEST_SESSION_FILE)) ? JSON.parse(readFileSync(join(root, REQUEST_SESSION_FILE), "utf8")).id : undefined);
  const path = workId ? join(root, questionsFile(workId)) : undefined;
  let questionDocumentHash: string | undefined;
  const answeredQuestions = new Set<string>();
  if (path && existsSync(path)) {
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n"), parsed = parseQuestions(text), qs = parsed.filter(q => !q.answer && q.status !== "deferred");
    questionDocumentHash = interactionHash(text);
    if (parsed.some(q => q.answer)) {
      const sources = (require("./answers") as typeof import("./answers")).answerSources(root, workId!, parsed);
      for (const q of parsed) if (q.answer && sources.get(q.id) && sources.get(q.id) !== "unverified") answeredQuestions.add(q.id);
    }
    const covered = currentInteractions(root).requests.filter(r => !["superseded", "expired", "cancelled"].includes(r.status) &&
      (r.origin.type === "questions" && r.origin.id === workId && r.origin.hash === interactionHash(text) || r.origin.type === "host" && r.context.workId === workId && ["pending", "responded", "deferred"].includes(r.status)));
    const missing = qs.filter(q => !covered.some(r => r.questions.some(item => item.questionId === q.id)));
    if (missing.length) {
      const run = listRuns(root).filter(r => r.workId === workId).at(-1), lease = readLease(root);
      const sessionId = lease && !lease.released ? lease.session : run?.sessionId;
      const host = lease && !lease.released ? lease.host : run?.hostProfile?.kind ?? "claude";
      const waitingForSession = (lease?.released && (!run || run.sessionId === lease.session)) ||
        (run?.hostProfile?.kind === "codex" && !run.sessionConfirmed && (!lease || lease.released));
      const questions: InteractionQuestion[] = missing.slice(0, 16).map(q => ({ questionId: q.id, title: q.title, background: "기존 questions.md에서 발행한 질문입니다.", mode: "text", required: true,
        options: [], minSelections: 0, maxSelections: 0, input: { required: true, minLength: 1, maxLength: 2000, description: "업무 답을 직접 입력하세요. 구조 줄이나 보류 문구는 답으로 사용하지 않습니다." },
        recommendedOptionIds: [], defaultOptionIds: [], recommendationReason: "기존 문서에는 구조화된 추천 근거가 없습니다.", evidence: [{ path: questionsFile(workId), summary: "미응답 질문 원문" }] }));
      if (!waitingForSession) publishInteraction(root, { key: `questions:${workId}`, stage: stageOf(root), kind: "question", title: `${workId} 업무 질문`, questions, source: "questions", expiresInMs: 86400000 },
        interactionContext(root, sessionId ?? "unbound", host, run && run.sessionId === sessionId ? run.runId : undefined), { type: "questions", id: workId, hash: interactionHash(text) }, undefined, sessionId ? undefined : "원래 세션을 확인할 수 없습니다. 호스트에서 interaction publish로 발행하세요.");
    }
  }
  if (!currentInteractions(root).requests.length) return;
  mutateInteractions(root, state => {
    for (const r of Object.values(state.requests)) {
      if (!["pending", "deferred", "responded"].includes(r.status)) continue;
      // 원래 질문 모두에 기존 출처 검사를 통과한 답이 있어야 닫는다. 삭제·출처 미확인 답으로 대기를 풀지 않는다.
      if (r.origin.type === "questions" && r.origin.id === workId && questionDocumentHash && r.origin.hash !== questionDocumentHash &&
          !r.response && r.questions.every(q => answeredQuestions.has(q.questionId)) && contextMatches(root, r.context)) {
        r.status = "superseded"; r.unavailableReason = "원래 질문 문서가 바뀌었습니다. 최신 문서·요청에서 확인하세요."; bumpInteraction(state, r); continue;
      }
      if (r.origin.type === "consent") {
        const c = loadConsent(root, r.origin.id);
        if (c.status === "applied" && r.response?.channel !== "dashboard-human") { r.status = "applied"; r.application = { state: "applied", at: new Date().toISOString(), result: c.result }; bumpInteraction(state, r); }
        else if (["failed", "changes-requested"].includes(c.status)) { r.status = c.status === "failed" ? "failed" : "applied"; bumpInteraction(state, r); }
      }
      if (["pending", "deferred"].includes(r.status) && Date.parse(r.expiresAt) <= Date.now()) { r.status = "expired"; bumpInteraction(state, r); }
    }
  });
}
