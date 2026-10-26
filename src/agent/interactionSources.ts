import { loadRequestSession } from "./requestSession";
/** 기존 질문 문서·동의와 공통 요청의 연결. 추천은 Markdown 문구에서 추측하지 않는다. */
import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { join } from "path";
import { DOCS_SESSION_FILE, loadActive, questionsFile, REQUEST_SESSION_FILE } from "./layout";
import { readLease } from "./lease";
import { parseQuestions } from "./questions";
import { PublishInteraction, type InteractionQuestion } from "./interactionSchema";
import { contextMatches, currentInteractions, interactionContext, interactionHash, publishInteraction, mutateInteractions, bumpInteraction, type InteractionRecord } from "./interactions";
import { listRuns, readBinding, readOwner } from "./master/store";
import type { AnswerRow } from "./answers";
import { askVia } from "./hostText";
import { nativeEvidenceReader } from "./nativeQuestionEvidence";
import { Stop } from "./stop";
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
  const binding = readBinding(root), owner = readOwner(root), channel = binding?.humanChannel;
  if (!channel || !owner || owner.handover || channel.generation !== owner.generation || channel.controller !== owner.controller || Date.parse(channel.expiresAt) <= Date.now()) {
    throw new Stop(`질문을 표시할 대시보드 사람 채널이 연결되지 않았습니다. 대화형 세션은 ${askVia(ticket.host)} 질문하세요. 관리 실행은 사람이 대시보드를 연결한 뒤 질문을 발행하세요. 질문을 표시하지 않은 채 응답 대기로 보고하지 마세요.`);
  }
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

/** 옛 호스트 질문의 대기를 닫는 근거. 새 응답·승인을 합성하거나 현재 문맥에 과거 답을 적용하지 않는다. */
export function nativeAnswerWasObserved(root: string, r: InteractionRecord, rows?: AnswerRow[]): boolean {
  return nativeEvidenceReader(root)(r, rows);
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
  const unreadable = new Map<string, string>();
  const failed = (id: string, error: unknown): void => {
    const reason = `동의 기록을 읽지 못했습니다(${id}): ${error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)}`;
    unreadable.set(id, reason);
    process.stderr.write(`code-agent: ${reason}\n`);
  };
  // 응답 저장 뒤 프로세스가 종료됐어도 취소한 동의가 열린 승인창으로 남지 않게 한다.
  for (const r of currentInteractions(root).requests) if (r.origin.type === "consent" && r.status === "cancelled") {
    try { (require("./consent") as typeof import("./consent")).closeCancelledDashboardConsent(root, r.origin.id); }
    catch (error) { failed(r.origin.id, error); }
  }
  const { loadConsent, consentGuide } = require("./consent") as typeof import("./consent");
  const consents = join(root, ".code-agent/consents");
  const known = currentInteractions(root).requests;
  if (existsSync(consents)) for (const name of readdirSync(consents)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const id = name.slice(0, -5);
    try {
      const record = loadConsent(root, id);
      if (record.status === "pending" && !known.some(r => r.origin.type === "consent" && r.origin.id === record.id)) publishConsentInteraction(root, record);
    } catch (error) { failed(id, error); }
  }
  const active = loadActive(root);
  const workId = active?.id ?? loadRequestSession(root)?.id;
  const path = workId ? join(root, questionsFile(workId)) : undefined;
  let questionDocumentHash: string | undefined;
  const answeredQuestions = new Set<string>();
  if (workId && path && existsSync(path)) {
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
      // 지금 작업의 임대만 원래 세션의 근거다 — 끝난 작업의 남은 임대로 접수 중 질문을 이전 세션에 묶지 않는다
      const held = readLease(root), lease = held && active && held.id === active.id && held.target === active.target ? held : undefined;
      const run = listRuns(root).filter(r => r.workId === workId).at(-1);
      const sessionId = lease && !lease.released ? lease.session : run?.sessionId;
      const host = lease && !lease.released ? lease.host : run?.hostProfile?.kind ?? "claude";
      const waitingForSession = (lease?.released && (!run || run.sessionId === lease.session)) ||
        (run?.hostProfile?.kind === "codex" && !run.sessionConfirmed && (!lease || lease.released));
      for (let offset = 0; offset < missing.length; offset += 16) {
        const questions: InteractionQuestion[] = missing.slice(offset, offset + 16).map(q => ({ questionId: q.id, title: q.title, background: "기존 questions.md에서 발행한 질문입니다.", mode: "text", required: true,
          options: [], minSelections: 0, maxSelections: 0, input: { required: true, minLength: 1, maxLength: 2000, description: "업무 답을 직접 입력하세요. 구조 줄이나 보류 문구는 답으로 사용하지 않습니다." },
          recommendedOptionIds: [], defaultOptionIds: [], recommendationReason: "기존 문서에는 구조화된 추천 근거가 없습니다.", evidence: [{ path: questionsFile(workId), summary: "미응답 질문 원문" }] }));
        if (!waitingForSession) publishInteraction(root, { key: `questions:${interactionHash({ workId, ids: questions.map(q => q.questionId) }).slice(7, 47)}`, stage: stageOf(root), kind: "question", title: `${workId} 업무 질문`, questions, source: "questions", expiresInMs: 86400000 },
          interactionContext(root, sessionId ?? "unbound", host, run && run.sessionId === sessionId ? run.runId : undefined), { type: "questions", id: workId, hash: interactionHash(text) }, undefined, sessionId ? undefined : "원래 세션을 확인할 수 없습니다. 호스트에서 interaction publish로 발행하세요.");
      }
    }
  }
  if (!currentInteractions(root).requests.length) return;
  const observed = nativeEvidenceReader(root);
  mutateInteractions(root, state => {
    const replacements = new Map<string, Set<string>>();
    for (const next of Object.values(state.requests)) {
      if (!questionDocumentHash || next.origin.type !== "questions" || next.origin.id !== workId || next.origin.hash !== questionDocumentHash ||
          !["pending", "responded", "deferred"].includes(next.status) || !contextMatches(root, next.context)) continue;
      const ids = replacements.get(next.context.sessionId) ?? new Set<string>();
      for (const q of next.questions) ids.add(q.questionId);
      replacements.set(next.context.sessionId, ids);
    }
    for (const r of Object.values(state.requests)) {
      if (["pending", "deferred", "expired"].includes(r.status) && r.key.startsWith("native:")) {
        if (observed(r)) {
          r.status = "superseded"; r.unavailableReason = "같은 세션·호출·질문의 실제 호스트 응답을 답 원장 또는 호스트 원본에서 확인해 낡은 대기를 닫았습니다.";
          bumpInteraction(state, r); continue;
        }
      }
      if (!["pending", "deferred", "responded"].includes(r.status)) continue;
      // 원래 질문의 답 또는 같은 문맥·최신 문서에 발행된 대체 질문이 모두 있어야 닫는다.
      if (r.origin.type === "questions" && r.origin.id === workId && questionDocumentHash && r.origin.hash !== questionDocumentHash &&
          !r.response && r.questions.every(q => answeredQuestions.has(q.questionId) ||
            (r.key.startsWith("questions:") && replacements.get(r.context.sessionId)?.has(q.questionId))) && contextMatches(root, r.context)) {
        r.status = "superseded"; r.unavailableReason = "원래 질문 문서가 바뀌었습니다. 최신 문서·요청에서 확인하세요."; bumpInteraction(state, r); continue;
      }
      if (r.origin.type === "consent") {
        let c: ConsentRecord | undefined;
        if (!unreadable.has(r.origin.id)) {
          try { c = loadConsent(root, r.origin.id); } catch (error) { failed(r.origin.id, error); }
        }
        if (!c) {
          const reason = unreadable.get(r.origin.id)!;
          if (r.unavailableReason !== reason) { r.unavailableReason = reason; bumpInteraction(state, r); }
          continue;
        }
        if (r.unavailableReason?.startsWith("동의 기록을 읽지 못했습니다(")) { delete r.unavailableReason; bumpInteraction(state, r); }
        if (c.status === "applied" && r.response?.channel !== "dashboard-human") { r.status = "applied"; r.application = { state: "applied", at: new Date().toISOString(), result: c.result }; bumpInteraction(state, r); }
        // 대시보드 응답 전에 대상 변경·다른 채널의 응답으로 닫힌 동의는 처리 실패가 아니다 — 닫고 다음 행동을 알린다. 적용 실패는 failed 로 남긴다
        else if (!r.response && (c.status === "deferred" || c.status === "failed" && c.failure?.kind !== "apply" && c.failure?.class !== "consent-apply-failed")) {
          const failure = c.failure ?? { class: "consent-target-changed" as const, kind: c.status === "deferred" ? "response-defer" : "target", detail: c.status };
          r.status = "superseded";
          r.unavailableReason = failure.kind === "target"
            ? `응답을 받기 전에 원래 동의가 대상 변경으로 닫혔습니다(${failure.detail}). 원래 세션이 다시 준비한 요청에 응답합니다 — master 실행이면 원래 실행을 이어 실행(resume)합니다.`
            : `다른 채널의 응답으로 원래 동의가 닫혔습니다. ${consentGuide(failure)}`;
          bumpInteraction(state, r); continue;
        }
        else if (["failed", "changes-requested"].includes(c.status)) { r.status = c.status === "failed" ? "failed" : "applied"; bumpInteraction(state, r); }
      }
      if (["pending", "deferred"].includes(r.status) && Date.parse(r.expiresAt) <= Date.now()) { r.status = "expired"; bumpInteraction(state, r); }
    }
  });
}
