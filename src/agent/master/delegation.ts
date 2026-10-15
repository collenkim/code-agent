/**
 * 위임 판단 — master 의 판단을 사람이 TTY 에서 준 권한(grant) 범위 안에서만 받는다. 연결(토큰)만으로는 아무것도 승인하지 못한다.
 *
 * 공통 조건(사람 응답 경로와 같은 것): 동의는 같은 적용 함수(consent.ts applyLocked)로 적용된다 — 스냅샷 대조·확인 화면 대조·도메인 함수의
 * 전제(요구 확정 해시·계획 해시·검증 게이트·반영 범위)가 그대로 돈다. 위임 쪽 추가 조건은 아래다.
 *
 * 1. 사람만 하는 동작(HUMAN_ONLY_ACTIONS)은 받지 않는다. 프로젝트가 requireVerifiedApproval 이면 위임을 받지 않는다.
 * 2. 권한: 이 제어자에게 준 것, 회수·만료·소진 아님, 동작 포함, 작업(또는 master 임무)이 범위 안, 계획 파일·반영 대상이 paths 안.
 * 3. 판단 기록: decisionId(한 번만)·분류·이유·근거를 적용 전에 decisions.jsonl 에 남기고 결과를 따로 남긴다.
 * 4. 분류: 승인·답은 routine 만. ambiguous 는 재검토(수정 요청·보류)만, critical 은 human-required 로 돌려보낸다.
 * 5. 대상: master 실행 세션이 준비한 동의만(준비 세션이 이 프로젝트의 master 실행), 그 실행이 끝났을 때만, master 가 본 내용 해시가
 *    지금과 같을 때만. 질문 답은 master 가 본 questions.md 해시가 지금과 같을 때만.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { answerHash, answerSources, appendDelegatedAnswer } from "../answers";
import { decideDelegatedConsent, delegationView, loadConsent, type ConsentRecord } from "../consent";
import { outsideChanges, planPaths } from "../evidence";
import { questionsFile } from "../layout";
import { parseQuestions, structuralLine, usableAnswer } from "../questions";
import { Stop } from "../stop";
import { loadManifestIfAny, loadWork } from "../work";
import { observeProgress } from "./observe";
import {
  ControlError, DECISION_CATEGORIES, DELEGABLE_ACTIONS, HUMAN_ONLY_ACTIONS, sha256, validId, VERDICTS,
  type DecisionCategory, type Verdict,
} from "./protocol";
import { activeRuns } from "./runs";
import {
  appendDecisionRow, decisionRows, emit, grantViews, listRuns, readWorkBinding, type GrantView,
} from "./store";

export interface DelegationContext { controller: string; generation: number; commandId: string }

/** 아주 작은 glob — `**`(여러 단계), `*`(한 단계 안), `?` */
export function globMatch(path: string, glob: string): boolean {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      pattern += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += glob[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`).test(path);
}

function workScope(root: string, grant: GrantView, workId: string): boolean {
  if (grant.works.includes(workId)) return true;
  const binding = readWorkBinding(root, workId);
  return !!binding?.links.missionId && grant.missions.includes(binding.links.missionId);
}

/** 쓸 수 있는 권한 — 없으면 이유를 가른 오류 코드로 */
export function requireGrant(root: string, ctx: DelegationContext, grantId: unknown, action: string, workId: string, now = Date.now()): GrantView {
  if (!validId(grantId)) throw new ControlError("invalid-request", "grantId 가 필요합니다");
  if ((HUMAN_ONLY_ACTIONS as readonly string[]).includes(action)) throw new ControlError("human-required", `${action} 은 사람만 정합니다 — 위임하지 않습니다`);
  if (!(DELEGABLE_ACTIONS as readonly string[]).includes(action)) throw new ControlError("unsupported", `위임할 수 없는 동작: ${action}`);
  const grant = grantViews(root, now).find((item) => item.id === grantId);
  if (!grant || grant.controller !== ctx.controller) throw new ControlError("grant-missing", `이 제어자(${ctx.controller})에게 준 권한 ${grantId} 가 없습니다`);
  if (grant.revoked) throw new ControlError("grant-revoked", `권한 ${grantId} 는 ${grant.revoked.at} 에 회수됐습니다`);
  if (grant.expired) throw new ControlError("grant-expired", `권한 ${grantId} 는 ${grant.expiresAt} 에 만료됐습니다`);
  if (grant.exhausted) throw new ControlError("grant-exhausted", `권한 ${grantId} 의 사용 한도(${grant.maxUses})를 다 썼습니다`);
  if (!grant.actions.includes(action)) throw new ControlError("scope-exceeded", `권한 ${grantId} 에 ${action} 이 없습니다(허용: ${grant.actions.join(", ")})`);
  if (!readWorkBinding(root, workId)) throw new ControlError("not-enabled", `작업 ${workId} 는 master 실행이 연 작업이 아닙니다 — 연동하지 않은 작업은 위임 판단을 받지 않습니다`);
  if (!workScope(root, grant, workId)) throw new ControlError("scope-exceeded", `작업 ${workId} 는 권한 ${grantId} 의 범위(작업·임무) 밖입니다`);
  return grant;
}

function requirePathsInScope(grant: GrantView, paths: string[], what: string): void {
  const outside = paths.filter((path) => !grant.paths.some((glob) => globMatch(path, glob)));
  if (outside.length) throw new ControlError("scope-exceeded", `${what} 중 권한 ${grant.id} 의 paths 밖: ${outside.slice(0, 10).join(", ")}${outside.length > 10 ? ` 외 ${outside.length - 10}` : ""}`, { outside });
}

function requireVerifiedOff(root: string): void {
  // request.ts requiresVerified 와 같은 읽기 — 매니페스트를 읽지 못하면 받지 않는 쪽으로 닫는다
  let strict: boolean;
  try { strict = loadManifestIfAny(root)?.workOrder.requireVerifiedApproval ?? false; } catch { strict = true; }
  if (strict) throw new ControlError("policy-forbids", "이 프로젝트는 사람의 존재가 확인된 승인만 받습니다(workOrder.requireVerifiedApproval) — 위임 판단을 받지 않습니다");
}

function requireNewDecision(root: string, decisionId: unknown): string {
  if (!validId(decisionId)) throw new ControlError("invalid-request", "decisionId 가 필요합니다");
  if (decisionRows(root).some((row) => row.decisionId === decisionId)) throw new ControlError("duplicate-decision", `판단 ${decisionId} 는 이미 받았습니다 — 같은 판단을 두 번 쓰지 않습니다`);
  return decisionId;
}

function judgment(payload: Record<string, unknown>, human: boolean): { category: DecisionCategory; reason: string; evidence: string[] } {
  const category = (human && payload.category === undefined ? "routine" : payload.category) as DecisionCategory;
  if (!(DECISION_CATEGORIES as readonly string[]).includes(category)) throw new ControlError("invalid-request", `category 는 ${DECISION_CATEGORIES.join("·")} 중 하나입니다`);
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!reason) throw new ControlError("invalid-request", "판단 이유(reason)가 필요합니다 — 실행 전에 기록합니다");
  if (reason.length > 2000) throw new ControlError("invalid-request", "reason 은 2000자 이하입니다");
  const evidence = Array.isArray(payload.evidence) ? payload.evidence.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 500)).slice(0, 20) : [];
  if (!human && evidence.length === 0) throw new ControlError("invalid-request", "판단 근거(evidence)가 하나 이상 필요합니다");
  return { category, reason, evidence };
}

/** master 실행 세션이 준비했고 그 실행이 끝난 동의인가 */
function requireMasterPrepared(root: string, record: Readonly<ConsentRecord>): void {
  const session = record.preparedSession?.id;
  const runs = listRuns(root).filter((run) => run.sessionId === session);
  if (!session || !runs.length) throw new ControlError("human-required", "master 실행 세션이 준비한 동의가 아닙니다 — 사람이 그 세션에서 응답합니다");
  if (activeRuns(root).some((run) => run.sessionId === session)) throw new ControlError("busy", "동의를 준비한 실행이 아직 끝나지 않았습니다 — 실행이 멈춘 뒤 판단합니다");
}

export function decideConsent(root: string, ctx: DelegationContext, payload: Record<string, unknown>, stateVersion: () => string, expectState?: string): unknown {
  requireVerifiedOff(root);
  const consentId = payload.consentId;
  if (typeof consentId !== "string") throw new ControlError("invalid-request", "consentId 가 필요합니다");
  const verdict = payload.verdict as Verdict;
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new ControlError("invalid-request", `verdict 는 ${VERDICTS.join("·")} 중 하나입니다`);
  const decisionId = requireNewDecision(root, payload.decisionId);
  const { category, reason, evidence } = judgment(payload, false);
  if (category === "critical") throw new ControlError("human-required", "중대한 판단(critical)은 사람에게 넘깁니다 — 위임으로 받지 않습니다");
  if (category === "ambiguous" && verdict === "approve") throw new ControlError("policy-forbids", "모호한 판단(ambiguous)은 승인하지 않습니다 — 재검토(request-changes·defer)하거나 추가 정보를 받은 뒤 다시 분류하세요");
  let view: ReturnType<typeof delegationView>;
  try { view = delegationView(root, consentId); } catch (error) { throw new ControlError("not-found", error instanceof Error ? error.message : String(error)); }
  if (!view.workId) throw new ControlError("invalid-state", "작업·접수에 묶이지 않은 동의입니다 — 위임하지 않습니다");
  const grant = requireGrant(root, ctx, payload.grantId, view.action, view.workId);
  if (payload.shownHash !== view.shownHash) throw new ControlError("stale-state", "판단한 동의 내용이 지금과 다릅니다 — consents 로 다시 읽고 판단하세요", { shownHash: view.shownHash });
  if (expectState !== undefined && expectState !== stateVersion()) throw new ControlError("stale-state", "판단한 뒤 code-agent 상태가 바뀌었습니다 — 다시 조회하세요", { stateVersion: stateVersion() });
  const choices = payload.choices === undefined ? undefined : payload.choices;
  if (choices !== undefined && (typeof choices !== "object" || choices === null || Array.isArray(choices))) throw new ControlError("invalid-request", "choices 는 {번호: 적용|유지} 입니다");
  if (verdict === "approve" && view.decision !== "reject") {
    const work = view.action === "request" ? undefined : loadWork(root);
    if (view.action === "plan" || view.action === "deliver") {
      if (!work?.plan) throw new ControlError("invalid-state", "제출된 계획이 없습니다");
      requirePathsInScope(grant, planPaths(work), "계획 파일");
    }
    if (view.action === "deliver" && work) {
      const outside = outsideChanges(work);
      if (outside.length) throw new ControlError("scope-exceeded", `계획 밖 변경이 있습니다 — 위임으로 반영하지 않습니다: ${outside.slice(0, 10).map((change) => change.path).join(", ")}`);
      const applied = Object.entries((choices ?? {}) as Record<string, unknown>).filter(([, value]) => value === "적용").map(([index]) => view.choices.find((choice) => String(choice.index) === index)?.target ?? `#${index}`);
      requirePathsInScope(grant, applied, "적용할 문서 변경");
    }
  }
  appendDecisionRow(root, { type: "decision", at: new Date().toISOString(), decisionId, controller: ctx.controller, generation: ctx.generation, commandId: ctx.commandId,
    grantId: grant.id, action: view.action, actor: "ai", category, verdict, reason, evidence, target: { consentId, workId: view.workId, shownHash: view.shownHash } });
  emit(root, "decision.recorded", { commandId: ctx.commandId, data: { decisionId, consentId, action: view.action, verdict, category, grantId: grant.id } });
  try {
    const outcome = decideDelegatedConsent(root, consentId, {
      decisionId, grantId: grant.id, controller: ctx.controller, generation: ctx.generation, commandId: ctx.commandId, verdict, category, reason,
      at: new Date().toISOString(), ...(choices ? { choices: choices as Record<string, string> } : {}),
    }, (record) => {
      requireMasterPrepared(root, record);
      if (record.workId !== view.workId) throw new ControlError("stale-state", "동의의 작업이 바뀌었습니다");
    });
    appendDecisionRow(root, { type: "decision-result", at: new Date().toISOString(), decisionId, state: "applied", detail: outcome.status });
    emit(root, "decision.applied", { commandId: ctx.commandId, data: { decisionId, consentId, status: outcome.status } });
    try { observeProgress(root); } catch { /* 관찰은 보조다 */ }
    return { decisionId, consentId, action: view.action, verdict, status: outcome.status, ...(outcome.result ? { result: outcome.result } : {}),
      ...(outcome.failure ? { failure: outcome.failure } : {}), ...(outcome.after ? { next: outcome.after } : {}), presence: "master-delegation(verified false)" };
  } catch (error) {
    const code = error instanceof ControlError ? error.code : "invalid-state";
    const message = error instanceof Error ? error.message : String(error);
    appendDecisionRow(root, { type: "decision-result", at: new Date().toISOString(), decisionId, state: error instanceof ControlError ? "rejected" : "failed", detail: message.split("\n")[0] });
    emit(root, "decision.rejected", { commandId: ctx.commandId, data: { decisionId, consentId, code, message: message.split("\n")[0] } });
    if (error instanceof ControlError) throw error;
    if (error instanceof Stop) throw new ControlError("invalid-state", message);
    throw error;
  }
}

/** questions.md 의 한 질문에 답을 쓴다 — `[Answer]:` 줄을 바꾸고 출처 줄을 붙이며, `[Status]:` 가 있으면 answered 로 */
function writeAnswer(text: string, q: string, answer: string, source: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${q}`) && (line.length === 3 + q.length || /\s/.test(line[3 + q.length])));
  if (start < 0) throw new ControlError("not-found", `질문 ${q} 가 없습니다`);
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  const marker = lines.findIndex((line, index) => index > start && index < end && line.trim().startsWith("[Answer]:"));
  if (marker < 0) throw new ControlError("invalid-state", `질문 ${q} 에 [Answer]: 칸이 없습니다`);
  const block = lines.slice(start, end).map((line, index) => {
    const at = start + index;
    if (at === marker) return `[Answer]: ${answer}\n[Source]: ${source}`;
    if (/^\s*\[Status\]:/.test(line)) return "[Status]: answered";
    return line;
  });
  // 다른 줄은 그대로 둔다 — 쓴 뒤 다시 읽은 답이 다르면(답 칸 뒤의 글이 답에 섞이면) 호출자가 되돌리고 거부한다
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

export function answerQuestions(root: string, ctx: DelegationContext, payload: Record<string, unknown>, workId: string): unknown {
  const actor = payload.actor === "human" ? "human" : payload.actor === "ai" ? "ai" : undefined;
  if (!actor) throw new ControlError("invalid-request", "actor 는 ai(위임 판단) 또는 human(사람 답 전달)입니다");
  const decisionId = requireNewDecision(root, payload.decisionId);
  const { category, reason, evidence } = judgment(payload, actor === "human");
  if (actor === "ai" && category !== "routine") {
    throw new ControlError(category === "critical" ? "human-required" : "policy-forbids", category === "critical"
      ? "중대한 질문은 사람에게 넘깁니다 — actor human 으로 사람의 답을 전달하세요"
      : "모호한 질문은 위임으로 답하지 않습니다 — 재검토하거나 추가 정보를 받은 뒤 다시 분류하세요");
  }
  const grant = requireGrant(root, ctx, payload.grantId, "answer", workId);
  if (activeRuns(root).length) throw new ControlError("busy", "실행 중인 master 실행이 있습니다 — 질문 문서는 실행이 멈춘 뒤 고칩니다");
  const path = questionsFile(workId);
  const full = join(root, path);
  if (!existsSync(full)) throw new ControlError("not-found", `${path} 가 없습니다`);
  const before = readFileSync(full, "utf8");
  const normalized = before.replace(/\r\n/g, "\n");
  if (payload.questionsHash !== `sha256:${sha256(normalized)}`) throw new ControlError("stale-state", "판단한 질문 문서가 지금과 다릅니다 — questions 로 다시 읽으세요", { questionsHash: `sha256:${sha256(normalized)}` });
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  if (!answers.length || answers.length > 20) throw new ControlError("invalid-request", "answers 는 1~20개입니다");
  const current = parseQuestions(normalized);
  let text = normalized;
  const items: { q: string; answer: string }[] = [];
  for (const raw of answers) {
    const item = raw as { q?: unknown; answer?: unknown };
    if (typeof item?.q !== "string" || !/^Q\d+$/.test(item.q) || typeof item.answer !== "string") throw new ControlError("invalid-request", "답은 {q: \"Q<n>\", answer: 문자열} 입니다");
    const answer = item.answer.trim();
    if (!answer || !usableAnswer(answer) || structuralLine(answer) || answer.length > 2000) throw new ControlError("invalid-request", `${item.q} 의 답을 쓸 수 없습니다(빈 답·보류·구조 줄·2000자 초과)`);
    const question = current.find((entry) => entry.id === item.q);
    if (!question) throw new ControlError("not-found", `질문 ${item.q} 가 없습니다`);
    if (question.answer) throw new ControlError("conflict", `질문 ${item.q} 에는 이미 답이 있습니다 — 고치지 않습니다`);
    text = writeAnswer(text, item.q, answer, `master ${actor === "ai" ? "위임" : "전달"} ${decisionId}`);
    items.push({ q: item.q, answer });
  }
  appendDecisionRow(root, { type: "decision", at: new Date().toISOString(), decisionId, controller: ctx.controller, generation: ctx.generation, commandId: ctx.commandId,
    grantId: grant.id, action: "answer", actor, category, reason, evidence, target: { workId, questions: items.map((item) => item.q), questionsHash: payload.questionsHash as string } });
  emit(root, "decision.recorded", { commandId: ctx.commandId, data: { decisionId, action: "answer", actor, category, questions: items.map((item) => item.q), grantId: grant.id } });
  writeFileSync(full, before.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);
  const parsed = parseQuestions(text);
  const problems = items.filter((item) => parsed.find((entry) => entry.id === item.q)?.answer !== item.answer);
  if (problems.length) {
    writeFileSync(full, before);
    appendDecisionRow(root, { type: "decision-result", at: new Date().toISOString(), decisionId, state: "failed", detail: `답을 다시 읽지 못했습니다: ${problems.map((item) => item.q).join(", ")}` });
    throw new ControlError("internal", "쓴 답을 다시 읽은 값이 다릅니다 — 질문 문서를 되돌렸습니다");
  }
  for (const item of items) {
    appendDelegatedAnswer(root, workId, { type: "delegated", at: new Date().toISOString(), q: item.q, hash: answerHash(item.answer), actor, decisionId, grantId: grant.id,
      controller: ctx.controller, generation: ctx.generation, category });
  }
  const sources = answerSources(root, workId, parsed);
  appendDecisionRow(root, { type: "decision-result", at: new Date().toISOString(), decisionId, state: "applied", detail: items.map((item) => `${item.q}:${sources.get(item.q)}`).join(" ") });
  emit(root, "answer.recorded", { commandId: ctx.commandId, data: { decisionId, workId, actor, questions: items.map((item) => ({ q: item.q, source: sources.get(item.q) })) } });
  try { observeProgress(root); } catch { /* 관찰은 보조다 */ }
  return { decisionId, workId, actor, questions: items.map((item) => ({ q: item.q, source: sources.get(item.q) ?? "legacy" })) };
}

/** 지금 질문 문서 — 답할 때 낼 해시와 함께 */
export function questionsView(root: string, workId: string): unknown {
  const path = questionsFile(workId);
  const full = join(root, path);
  if (!existsSync(full)) return { workId, path, exists: false, questions: [] };
  const text = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
  const questions = parseQuestions(text);
  const sources = answerSources(root, workId, questions);
  const blocks = text.split(/^## /m).slice(1);
  return {
    workId, path, exists: true, questionsHash: `sha256:${sha256(text)}`,
    questions: questions.map((question, index) => ({ id: question.id, title: question.title, answered: !!question.answer, ...(question.answer ? { answer: question.answer, source: sources.get(question.id) } : {}),
      ...(question.origin ? { origin: question.origin } : {}), ...(question.options ? { options: question.options } : {}), body: `## ${blocks[index] ?? ""}`.slice(0, 4000) })),
  };
}

/** 열린 동의 — 위임 판단에 낼 shownHash 와 함께 */
export function consentsView(root: string, ids: string[]): unknown[] {
  return ids.map((id) => {
    try {
      const view = delegationView(root, id);
      const record = loadConsent(root, id);
      return { ...view, humanOnly: (HUMAN_ONLY_ACTIONS as readonly string[]).includes(view.action), preparedByMasterRun: !!record.preparedSession && listRuns(root).some((run) => run.sessionId === record.preparedSession!.id) };
    } catch (error) {
      return { id, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
