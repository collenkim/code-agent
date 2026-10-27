/** 공개 조회·사람 응답과 원래 처리기의 적용. 전송 수신과 적용·재개는 별개다. */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { z } from "zod";
import { writeAtomic } from "../core/atomic";
import { acquireLock } from "./lock";
import { leaseConflict, leaseConflictText, leaseConflictView, type LeaseConflict } from "./lease";
import { loadActive, loadDocsSession, questionsFile } from "./layout";
import { parseQuestions, structuralLine, usableAnswer } from "./questions";
import { appendDashboardAnswer, answerHash, readAnswerRows, questionHash } from "./answers";
import { InteractionSubmission, validateInteractionAnswers, INTERACTION_STAGES } from "./interactionSchema";
import { bumpInteraction, contextMatches, currentInteractions, interactionContext, interactionHash, interactionRunId, INTERACTIONS_DIR, mutateInteractions, needInteraction, readInteractions, type InteractionRecord } from "./interactions";
import { synchronizeInteractions } from "./interactionSources";
import { verifyHumanSubmission } from "./interactionHuman";
import { entryScript } from "./runtimeSelect";
import { Stop } from "./stop";
import { ControlError, type RequestEnvelope } from "./master/protocol";
import { activeRuns, createRun, reconcileRuns, spawnSupervisor } from "./master/runs";
import { CONTROL_LOCK, listRuns, readBinding, readOwner, readRun, runPrompt, withLock, type Binding, type RunRecord } from "./master/store";

export const INTERACTION_CAPABILITIES = {
  schemaVersion: 1, transport: "code-agent.master v1 / local CLI", stages: INTERACTION_STAGES,
  commands: ["interactions", "interaction", "interaction.respond", "interaction.result"],
  humanChannel: "dashboard-human", signature: "Ed25519", independentSessions: true, beforeDocumentConfirmation: true,
  questionConsumer: ["host", "questions"], consentActions: ["setup", "docs", "baseline", "request", "plan", "deliver", "knowledge-prune", "model", "abort", "plugin-add", "plugin-remove", "update", "repro-log", "judgment"],
  continuation: { live: "동일 세션의 interaction consume·complete", detached: "기록된 Claude·Codex 실행의 확인된 동일 세션 자동 재개", codexDetached: true, independentRecovery: "tty-native-transcript" },
  hostPermissions: { host: "codex", kind: "host-permission", transport: "app-server/stdio", decisions: ["accept", "decline"], scope: "once", liveOnly: true },
};
const ResponsePayload = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().positive(), contentHash: z.string(), challenge: z.string().uuid(), channelId: z.string().uuid(), signature: z.string().max(1000), submission: InteractionSubmission }).strict();
/** 조회·수신·소비·적용·재개가 함께 쓰는 임대 판정 — 요청을 발행한 호스트·세션 기준(lease.ts leaseConflict) */
function interactionLease(root: string, record: InteractionRecord, session: string = record.context.sessionId): LeaseConflict | undefined {
  return leaseConflict(root, { host: record.context.host, session });
}
function leaseBusy(conflict: LeaseConflict): ControlError {
  return new ControlError("busy", leaseConflictText(conflict), { leaseConflict: leaseConflictView(conflict) });
}
function validateContext(root: string, record: InteractionRecord): void {
  if (!contextMatches(root, record.context)) throw new ControlError("stale-state", "프로젝트·브랜치·HEAD·작업 문맥이 바뀌었습니다. 원래 작업에서 요청을 다시 확인하세요");
  const conflict = interactionLease(root, record);
  if (conflict) throw leaseBusy(conflict);
  if (record.unavailableReason) throw new ControlError("unsupported", record.unavailableReason);
}
/**
 * 수신 전 거절 — 질문 원장을 쓰지 않았으므로(응답·commandId 없음, revision·challenge 그대로) 원래 요청은 그대로 대기다. detail 의 received:false 로 처리 실패와 구분한다.
 * 원인을 해결한 뒤 최신 요청을 다시 조회해 그 revision 으로 제출한다. 처리기의 Stop 은 internal 이 아니라 invalid-state 다.
 */
function notReceived(root: string, requestId: string, error: unknown): unknown {
  if (!(error instanceof ControlError) && !(error instanceof Stop)) return error;
  const status = readInteractions(root)?.requests[requestId]?.status ?? null;
  const detail = { ...(error instanceof ControlError && error.detail && typeof error.detail === "object" ? error.detail : {}), received: false, requestId, status };
  return new ControlError(error instanceof ControlError ? error.code : "invalid-state", error instanceof Stop ? error.message.split("\n")[0] : error.message, detail);
}
export function interactionView(root: string, record: InteractionRecord, binding?: Binding): unknown {
  const channel = binding?.humanChannel, owner = readOwner(root);
  let reason = record.unavailableReason;
  if (!reason && record.kind === "host-permission") reason = (require("./master/codexPermissions") as typeof import("./master/codexPermissions")).permissionUnavailable(root, record);
  if (!reason && record.origin.type === "consent" && record.status === "pending") {
    try {
      const consent = (require("./consent") as typeof import("./consent")).loadConsent(root, record.origin.id);
      if (consent.status !== "pending" || consent.observed?.length || consent.binding || consent.delegation) reason = "원래 호스트에서 이미 응답을 시작한 동의입니다. 해당 채널의 결과를 확인하세요.";
    } catch (error) { reason = `동의 기록을 읽지 못했습니다(${record.origin.id}): ${error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)}`; }
  }
  if (!reason && !contextMatches(root, record.context)) reason = "원래 브랜치·HEAD·작업에서 조회하세요.";
  // 수신(validateContext)과 같은 판정이다 — 조회가 응답 가능으로 보인 요청을 수신이 임대로 거절하지 않는다
  const conflict = !reason && ["pending", "deferred", "responded"].includes(record.status) ? interactionLease(root, record) : undefined;
  if (conflict) reason = leaseConflictText(conflict);
  if (!reason && (!channel || channel.generation !== owner?.generation || channel.controller !== owner?.controller || owner.handover || Date.parse(channel.expiresAt) <= Date.now())) reason = "대시보드 사람 채널을 현재 소유권에 연결해야 합니다.";
  return { ...record, canRespond: !reason && ["pending", "deferred"].includes(record.status), unavailableReason: reason ?? null, leaseConflict: conflict ? leaseConflictView(conflict) : null,
    humanChannel: channel ? { channelId: channel.id, generation: channel.generation, algorithm: "Ed25519" } : null,
    consumer: record.origin.type, blocking: { workId: record.context.workId, sessionId: record.context.sessionId, runId: interactionRunId(record) ?? null } };
}
export function queryInteractions(root: string, binding: Binding, type: string, payload: Record<string, unknown>): unknown {
  synchronizeInteractions(root);
  const all = currentInteractions(root);
  if (type === "interactions") {
    const after = typeof payload.after === "number" ? payload.after : 0;
    const limit = typeof payload.limit === "number" && Number.isInteger(payload.limit) ? Math.min(200, Math.max(1, payload.limit)) : 100;
    const rows = all.requests.filter(r => r.revision > after).sort((a, b) => a.revision - b.revision).slice(0, limit);
    for (const row of rows) if (row.response && !["failed", "cancelled", "superseded"].includes(row.status)) kickInteractionWorker(root, row.requestId);
    return { schemaVersion: 1, sourceInstanceId: all.sourceInstanceId, cursor: rows.at(-1)?.revision ?? after, latestCursor: all.cursor, requests: rows.map(r => interactionView(root, r, binding)) };
  }
  const record = needInteraction(readInteractions(root), String(payload.requestId ?? ""));
  if (type === "interaction.result" && record.response && !["failed", "cancelled", "superseded"].includes(record.status)) kickInteractionWorker(root, record.requestId);
  return interactionView(root, record, binding);
}
export function respondInteraction(root: string, binding: Binding, request: RequestEnvelope): unknown {
  const payload = ResponsePayload.parse(request.payload);
  const { withConsentLock } = require("./consent") as typeof import("./consent");
  let response: unknown;
  try { response = withConsentLock(root, () => mutateInteractions(root, state => {
    const record = needInteraction(state, payload.requestId);
    const channel = verifyHumanSubmission(root, binding, request, record);
    const hash = interactionHash({ controller: request.controller, generation: request.generation, ...payload });
    const prior = state.commands[request.commandId!];
    if (prior) { if (prior.hash !== hash) throw new ControlError("conflict", "같은 commandId의 응답 내용이 다릅니다"); return { ...(prior.response as object), replayed: true }; }
    if (record.revision !== payload.expectedRevision || record.contentHash !== payload.contentHash) throw new ControlError("stale-state", "질문 버전·전문이 바뀌었습니다");
    if (Date.parse(record.expiresAt) <= Date.now()) throw new ControlError("invalid-state", "요청이 만료됐습니다");
    validateContext(root, record);
    const submission = payload.submission;
    if (record.kind === "host-permission") (require("./master/codexPermissions") as typeof import("./master/codexPermissions")).validatePermissionSubmission(root, record, submission);
    if (record.kind === "consent") {
      (require("./consent") as typeof import("./consent")).validateDashboardConsent(root, record.origin.id, record.context.sessionId, record.consent!.shownHash);
    }
    if (submission.intent === "reopen") {
      if (record.status !== "deferred") throw new ControlError("invalid-state", "보류한 요청만 다시 열 수 있습니다");
      validateInteractionAnswers([], submission); record.status = "pending";
    } else {
      if (record.status !== "pending" || record.response) throw new ControlError("conflict", "이미 응답했거나 대기 중이 아닌 요청입니다");
      if (record.kind === "consent" && submission.intent === "submit") {
        if (submission.permissionDecision) throw new ControlError("invalid-request", "실행 권한 응답은 업무 동의가 아닙니다");
        if (!submission.verdict || submission.answers || submission.shownHash !== record.consent?.shownHash) throw new ControlError("invalid-request", "동의는 전문 해시와 명시적 승인·수정 요청으로 응답해야 합니다");
        const choices = record.consent!.choices;
        if (submission.verdict === "approve" && (Object.keys(submission.choices ?? {}).length !== choices.length || choices.some(c => !(String(c.index) in (submission.choices ?? {}))))) throw new ControlError("invalid-request", "모든 변경 후보를 명시적으로 선택해야 합니다");
      } else if (record.kind !== "host-permission") validateInteractionAnswers(record.questions, submission);
      if (submission.intent === "defer") record.status = "deferred";
      else if (submission.intent === "cancel") record.status = "cancelled";
      else {
        record.status = "responded";
        record.response = { receiptId: randomUUID(), commandId: request.commandId!, at: new Date().toISOString(), channel: "dashboard-human", channelId: channel.id, generation: channel.generation, submission };
        record.continuation = { state: record.kind === "host-permission" ? "waiting-host" : interactionRunId(record) ? "queued" : "waiting-host" };
      }
    }
    bumpInteraction(state, record);
    const result = { requestId: record.requestId, revision: record.revision, status: record.status, receiptId: record.response?.receiptId ?? null, applied: false };
    state.commands[request.commandId!] = { hash, requestId: record.requestId, response: result };
    return result;
  })); } catch (error) { throw notReceived(root, payload.requestId, error); }
  if (payload.submission.intent === "cancel") {
    const record = needInteraction(readInteractions(root), payload.requestId);
    if (record.origin.type === "consent") (require("./consent") as typeof import("./consent")).closeCancelledDashboardConsent(root, record.origin.id);
  }
  // 대기열 저장이 먼저다. 시작 실패·서버 종료는 result/list 조회나 drain에서 복구한다.
  kickInteractionWorker(root, payload.requestId);
  return response;
}

export function consumeInteraction(root: string, id: string, sessionId: string, complete?: unknown): unknown {
  return withLock(root, CONTROL_LOCK, () => mutateInteractions(root, state => {
    const r = needInteraction(state, id);
    if (r.context.sessionId !== sessionId) throw new ControlError("unauthorized", "요청을 발행한 세션만 소비할 수 있습니다");
    if (r.origin.type !== "host") return { requestId: id, status: r.status, receiptId: r.response?.receiptId, application: r.application ?? null };
    if (r.status !== "applied") {
      if (complete !== undefined && r.consumed) {
        const now = interactionContext(root, sessionId, r.context.host);
        if (now.root !== r.context.root || now.branch !== r.context.branch) throw new ControlError("stale-state", "소비한 세션의 프로젝트·브랜치가 달라졌습니다");
        const conflict = interactionLease(root, r, sessionId);
        if (conflict) throw leaseBusy(conflict);
      } else validateContext(root, r);
      if (r.response?.channel === "dashboard-human") {
        const channel = readBinding(root)?.humanChannel, owner = readOwner(root);
        if (!channel || !owner || owner.handover || channel.id !== r.response.channelId || channel.generation !== owner.generation || channel.controller !== owner.controller || owner.generation !== r.response.generation || Date.parse(channel.expiresAt) <= Date.now()) throw new ControlError("human-required", "응답 채널 권한이 회수되거나 만료되었습니다");
      }
    }
    if (!r.response || !["responded", "applied"].includes(r.status)) return { requestId: id, status: r.status, waiting: true };
    if (!r.consumed) { r.consumed = { at: new Date().toISOString(), sessionId }; bumpInteraction(state, r); }
    if (complete !== undefined && r.status !== "applied") {
      const result = z.object({ summary: z.string().min(1).max(4000) }).strict().parse(complete);
      r.status = "applied"; r.application = { state: "applied", at: new Date().toISOString(), result }; bumpInteraction(state, r);
    }
    return { requestId: id, status: r.status, receiptId: r.response.receiptId, source: r.response.channel, answers: r.response.submission.answers, application: r.application ?? null, consumed: r.consumed };
  }));
}

function answerText(r: InteractionRecord, questionId: string): string {
  const q = r.questions.find(q => q.questionId === questionId)!, a = r.response!.submission.answers!.find(a => a.questionId === questionId)!;
  return [...a.optionIds.map(id => { const o = q.options.find(o => o.optionId === id)!; return o.label + (a.optionInputs[id] ? `: ${a.optionInputs[id]}` : ""); }), ...(a.text ? [a.text] : [])].join("; ").trim();
}
function applyQuestionDocument(root: string, r: InteractionRecord): unknown {
  const full = join(root, questionsFile(r.origin.id));
  const before = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
  const parsed = parseQuestions(before), answers = r.response!.submission.answers ?? [];
  const rows = readAnswerRows(root, r.origin.id);
  const already = answers.every(a => parsed.find(q => q.id === a.questionId)?.answer === answerText(r, a.questionId) && rows.some(row => row.type === "dashboard-human" && row.receiptId === r.response!.receiptId && row.q === a.questionId));
  if (already) return { questions: answers.map(a => a.questionId), recovered: true };
  if (interactionHash(before) !== r.origin.hash) throw new ControlError("stale-state", "질문 문서가 바뀌었습니다");
  let blocks = before.split(/^## /m);
  for (const a of answers) {
    const answer = answerText(r, a.questionId);
    if (!usableAnswer(answer) || structuralLine(answer) || answer.length > 2000 || parsed.find(q => q.id === a.questionId)?.answer) throw new ControlError("invalid-request", "기존 질문의 답 검사에 맞지 않거나 이미 답했습니다");
    const index = blocks.findIndex((block, i) => i > 0 && block.split(/\s/)[0] === a.questionId);
    if (index < 0 || !/^[ \t]*\[Answer\]:/m.test(blocks[index])) throw new ControlError("invalid-state", "질문 Answer 필드가 없습니다");
    blocks[index] = blocks[index].split(/^[ \t]*\[Answer\]:/m)[0].replace(/^[ \t]*\[Status\]:[^\n]*(?:\n|$)/gm, "") + `[Answer]: ${answer}\n[Source]: dashboard-human ${r.response!.receiptId}\n[Status]: answered\n\n`;
  }
  const next = blocks.join("## ");
  if (answers.some(a => parseQuestions(next).find(q => q.id === a.questionId)?.answer !== answerText(r, a.questionId))) throw new ControlError("invalid-request", "답을 다시 읽은 값이 다릅니다");
  for (const a of answers) appendDashboardAnswer(root, r.origin.id, { type: "dashboard-human", at: r.response!.at, q: a.questionId, hash: answerHash(answerText(r, a.questionId)), questionHash: questionHash(root, r.origin.id, a.questionId), receiptId: r.response!.receiptId, requestId: r.requestId });
  writeAtomic(full, next);
  return { questions: answers.map(a => a.questionId), source: "dashboard-human" };
}

export function kickInteractionWorker(root: string, id: string): void {
  const r = readInteractions(root)?.requests[id];
  if (r?.kind === "host-permission") return; // 살아 있는 app-server의 정확한 RPC에만 감독이 응답한다.
  if (!r?.response || r.response.channel !== "dashboard-human" || ["failed", "superseded", "cancelled"].includes(r.status) || r.continuation?.state === "started") return;
  if ((r.origin.type === "host" && !interactionRunId(r)) || r.continuation?.state === "blocked") return;
  if (r.status === "applied" && !interactionRunId(r)) return;
  const reserved = mutateInteractions(root, state => {
    const saved = state.requests[id];
    if (!saved?.response || saved.response.receiptId !== r.response!.receiptId || saved.status !== r.status || saved.continuation?.state === "started") return false;
    const elapsed = Date.now() - Date.parse(saved.drainRequestedAt ?? "");
    if (elapsed >= 0 && elapsed < 5000) return false;
    saved.drainRequestedAt = new Date().toISOString();
    return true;
  });
  if (!reserved) return;
  const child = spawn(process.execPath, [entryScript(), "interaction", "drain", id], { cwd: root, detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, CODE_AGENT_MASTER_RUN: "" } });
  child.on("error", () => { /* 영속 응답은 남는다. 다음 조회가 재시도한다. */ }); child.unref();
}
export function drainInteraction(root: string, id: string): unknown {
  let release: () => void;
  try { release = acquireLock(join(root, INTERACTIONS_DIR, `worker-${id}.lock`), { waitMs: 0, ageReclaim: false, label: "질문 응답 적용" }); }
  catch { return { busy: true }; }
  try { return withLock(root, CONTROL_LOCK, () => {
    let r = needInteraction(readInteractions(root), id);
    if (r.kind === "host-permission") return { status: r.status, waiting: "codex-approval-rpc" };
    if (!r.response || r.response.channel !== "dashboard-human" || !["responded", "applied"].includes(r.status)) return { status: r.status };
    const binding = readBinding(root), owner = readOwner(root);
    if (!binding?.humanChannel || !owner || owner.handover || binding.humanChannel.id !== r.response.channelId || owner.generation !== r.response.generation || binding.humanChannel.generation !== owner.generation || binding.humanChannel.controller !== owner.controller || Date.parse(binding.humanChannel.expiresAt) <= Date.now()) return { waiting: "human-channel" };
    reconcileRuns(root, binding.policy);
    if (activeRuns(root).length && r.origin.type !== "host") return { waiting: "host-exit" };
    if (r.status === "responded" && r.origin.type !== "host") {
      try {
        // 이미 적용된 동의의 영수증은 브랜치·HEAD가 바뀌어도 재실행하지 않고 대조한다.
        const consent = r.origin.type === "consent" ? (require("./consent") as typeof import("./consent")).loadConsent(root, r.origin.id) : undefined;
        if (consent?.status !== "applied") validateContext(root, r);
        let result: unknown;
        if (r.origin.type === "consent") {
          const { applyDashboardConsent } = require("./consent") as typeof import("./consent");
          result = applyDashboardConsent(root, r.origin.id, { receiptId: r.response.receiptId, channelId: r.response.channelId!, sessionId: r.context.sessionId, shownHash: r.consent!.shownHash,
            verdict: r.response.submission.verdict!, choices: r.response.submission.choices ?? {}, at: r.response.at });
        } else result = applyQuestionDocument(root, r);
        mutateInteractions(root, state => { const saved = needInteraction(state, id); saved.status = "applied"; saved.consumed = { at: new Date().toISOString(), sessionId: r.context.sessionId };
          saved.application = { state: "applied", at: new Date().toISOString(), result }; bumpInteraction(state, saved); });
      } catch (error) {
        mutateInteractions(root, state => { const saved = needInteraction(state, id); saved.status = "failed"; saved.application = { state: "failed", at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }; bumpInteraction(state, saved); });
        return { status: "failed" };
      }
    }
    r = needInteraction(readInteractions(root), id);
    if (r.response!.submission.verdict === "request-changes" || r.consent?.action === "abort" || r.consent?.action === "deliver") return { status: r.status };
    resumeInteraction(root, r);
    return { status: r.status };
  }); } finally { release(); }
}
/** 작업을 열기 전의 동의 — 이 응답 뒤에는 접수가 이어진다(요구사항 동의가 적용되면 작업이 열린다) */
const BEFORE_WORK: readonly string[] = ["setup", "docs", "baseline", "request"];
/**
 * 재개 지시 — 작업이 열렸으면 그 작업을 잇고, 작업을 열기 전(접수·문서 세션, 접수 앞 동의)이면 원래 실행의 지시서로 최초 접수를 잇는다.
 * 그 밖에 작업이 없는 응답(반영 뒤 갱신·모델 동의 등)은 접수를 지시하지 않는다. 어느 쪽도 작업 ID를 새로 만들지 않는다.
 */
function continuationPrompt(root: string, r: InteractionRecord): string {
  const head = `대시보드 사람이 요청 ${r.requestId}에 명시적으로 응답했습니다. 기존 세션을 유지하고 code-agent interaction consume ${r.requestId}로 답 또는 적용 결과를 조회하세요.`;
  const guard = "승인·hook 기록을 직접 만들지 마세요.";
  const active = loadActive(root);
  if (active) return `${head} 기존 작업 ${active.id}의 ID·종류를 유지하고 기존 단계의 검증·승인 규칙으로 이어가세요. 새로운 작업을 접수하거나 승인·hook 기록을 만들지 마세요.`;
  const { loadRequestSession } = require("./request") as typeof import("./request");
  const intake = loadRequestSession(root)?.id;
  if (!intake && !loadDocsSession(root) && !(r.origin.type === "consent" && BEFORE_WORK.includes(r.consent?.action ?? ""))) {
    return `${head} 지금 열린 작업이 없습니다. 원래 실행이 하던 일만 마치고, 새로운 작업을 접수하거나 작업 ID를 만들지 마세요. ${guard}`;
  }
  return `${head} 아직 작업이 열리기 전입니다. 이 세션이 받은 원래 실행의 지시서로 최초 접수를 이어가세요${intake ? ` — 접수 ID ${intake}를 그대로 씁니다` : " — 작업 ID는 지시서·접수 규칙이 정한 값을 씁니다"}. ` +
    `code-agent status 의 다음 할 일을 따르고, 작업 ID를 임의로 만들거나 다른 ID로 접수하지 마세요. ${guard}`;
}
function resumeInteraction(root: string, r: InteractionRecord): void {
  if (!interactionRunId(r) || r.continuation?.state === "started" || r.continuation?.state === "blocked") return;
  if (currentInteractions(root).requests.some(other => other.requestId !== r.requestId && other.context.sessionId === r.context.sessionId && ["pending", "deferred"].includes(other.status))) return;
  // 호출자가 소유권 잠금을 보유한다. 적용과 재개 사이에 권한을 바꾸지 못한다.
  {
    const binding = readBinding(root)!, owner = readOwner(root)!, previous = readRun(root, interactionRunId(r)!);
    if (r.origin.type === "host") {
      try { validateContext(root, r); }
      catch (error) { mutateInteractions(root, state => { const saved = needInteraction(state, r.requestId); saved.continuation = { state: "blocked", detail: String(error) }; bumpInteraction(state, saved); }); return; }
    }
    if (!previous || !["completed", "blocked"].includes(previous.state) || previous.stop || owner.handover || previous.generation !== owner.generation) return;
    let profile: import("./master/protocol").HostProfile;
    try {
      const { requireResumeProfile, requireRunHosts } = require("./master/hostProfile") as typeof import("./master/hostProfile");
      profile = requireResumeProfile(root, binding, previous); requireRunHosts(root, profile, previous.execution);
    } catch (error) {
      // 조회 실패·확인 중은 지나가는 상태다 — 막힘으로 굳히지 않고 대기로 두어 다음 조회의 재시도가 다시 판정한다
      const passing = error instanceof ControlError && ["query-failed", "checking"].includes(String((error.detail as { state?: unknown } | undefined)?.state));
      mutateInteractions(root, state => { const saved = needInteraction(state, r.requestId); saved.continuation = { state: passing ? "queued" : "blocked", detail: String(error) }; bumpInteraction(state, saved); }); return;
    }
    const commandId = `interaction:${r.requestId}`, existing = listRuns(root).find(run => run.commandId === commandId);
    if (existing) { mutateInteractions(root, state => { const saved = needInteraction(state, r.requestId); saved.continuation = { state: "started", runId: existing.runId }; bumpInteraction(state, saved); }); return; }
    if (activeRuns(root).length) return;
    const runId = `run-${randomUUID()}`, at = new Date().toISOString();
    const prompt = continuationPrompt(root, r);
    writeFileSync(runPrompt(root, runId), prompt, "utf8");
    const run: RunRecord = { version: 1, runId, commandId, controller: owner.controller, generation: owner.generation, mode: "continue", links: previous.links,
      state: "accepted", acceptedAt: at, updatedAt: at, sessionId: previous.sessionId, resumeOf: previous.sessionId, hostProfile: profile, ...(previous.execution ? { execution: previous.execution } : {}),
      ...(profile.kind === "codex" ? { sessionAlias: previous.sessionId, sessionConfirmed: true } : {}), promptHash: interactionHash(prompt), timeoutMs: binding.policy.runTimeoutMs,
      workId: previous.workId, baseHead: r.context.head, baseStateVersion: previous.baseStateVersion, history: [{ at, state: "accepted", note: `사람 응답 ${r.response!.receiptId}` }] };
    createRun(root, run);
    // 실행 예약이 먼저다. 중단 뒤에는 같은 run을 조회하며 새 실행을 예약하지 않는다.
    mutateInteractions(root, state => { const saved = needInteraction(state, r.requestId); saved.continuation = { state: "started", runId }; bumpInteraction(state, saved); });
    spawnSupervisor(root, runId);
  }
}
