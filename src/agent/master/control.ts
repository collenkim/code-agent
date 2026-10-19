/**
 * `code-agent master call` — 요청 한 건을 받아 응답 한 건을 낸다. 판단 순서(모든 요청이 같다):
 *
 * 1. 꼴 검사(protocol.parseRequest) → hello 는 인증 없이 기능을 알린다.
 * 2. 연동 확인(binding.json — 사람이 TTY 에서 켠 프로젝트만) → 제어자 토큰 대조(unauthorized).
 * 3. 상태를 바꾸는 요청은 제어 잠금 안에서: commandId 기록 대조(같은 내용이면 기록된 응답, 다른 내용이면 conflict) → 소유·세대 대조
 *    (fenced·handover-in-progress·handover-unaccepted) → 실행·인계 재조정 → 처리 → 응답을 commandId 로 기록.
 * 4. 읽기 요청은 기록하지 않고, 지금 제어자의 요청이면 마지막 연락 시각만 고친다.
 *
 * 실행은 기존 흐름을 바꾸지 않는다: 감독이 호스트(claude -p)를 띄워 기존 스킬·hook·CLI 를 그대로 돌리고, 동의는 consent.ts 의 같은 적용
 * 함수로, 상태 조회는 stateView(읽기 전용)로 한다.
 */
import { randomUUID } from "crypto";
import { timingSafeEqual } from "crypto";
import { writeFileSync } from "fs";

import { consentReceipts } from "../consentReceipts";
import { readLease, releaseLease } from "../lease";
import { loadRequestSession } from "../request";
import { STATE_SCHEMA } from "../runtimeSelect";
import { GRAPH_VERSION } from "../graph/types";
import { stateView, type StateJson } from "../stateView";
import { consentsView, decideConsent, answerQuestions, questionsView } from "./delegation";
import { acceptHandover, abortHandover, advanceHandover, requestHandover } from "./handover";
import { liveness } from "./processes";
import {
  ACTIVE_RUN_STATES, COMMAND_TYPES, ControlError, DECISION_CATEGORIES, DELEGABLE_ACTIONS, ERROR_CODES, EVENT_TYPES, HUMAN_ONLY_ACTIONS, mergePolicy,
  MUTATING_TYPES, OPEN_TYPES, parseRequest, plain, PROTOCOL, PROTOCOL_VERSION, READ_TYPES, requestHash, sha256, SUPPORTED_VERSIONS, TERMINAL_RUN_STATES,
  UNSUPPORTED, validId, type RequestEnvelope, type ResponseEnvelope,
} from "./protocol";
import { activeRuns, createRun, newRunId, reconcileRuns, requestStop, spawnSupervisor } from "./runs";
import {
  CONTROL_LOCK, type CommandRecord, emit, eventPosition, grantViews, listRuns, readBinding, readCommand, readEvents, readOwner, readRun, readWorkBinding, runPrompt,
  tokenHash, withLock, writeBinding, writeCommand, writeOwner, appendGrantRow, type Binding, type Links, type Owner, type RunRecord,
} from "./store";

const MAX_PROMPT = 20_000;

function packageVersion(): string {
  try { return (require("../../../package.json") as { version: string }).version; } catch { return "unknown"; }
}

function envelope(type: string, fields: Partial<ResponseEnvelope>, root?: string): ResponseEnvelope {
  const position = root ? eventPosition(root) : undefined;
  const owner = root ? safeOwner(root) : undefined;
  return {
    protocol: PROTOCOL, version: PROTOCOL_VERSION, ok: fields.ok ?? true, type, ...fields,
    ...(position && position.logId ? { events: position } : {}),
    ...(owner ? { ownership: { controller: owner.controller, generation: owner.generation, ...(owner.handover ? { handover: `${owner.handover.id}:${owner.handover.state}` } : {}) } } : {}),
    at: new Date().toISOString(),
  };
}
function safeOwner(root: string): Owner | undefined { try { return readOwner(root); } catch { return undefined; } }
function errorOf(error: unknown): { code: (typeof ERROR_CODES)[number]; message: string; detail?: unknown } {
  if (error instanceof Error && error.name === "ZodError") return { code: "invalid-request", message: "요청 스키마·입력 조건이 올바르지 않습니다", detail: JSON.parse(error.message) };
  if (error instanceof ControlError) return { code: error.code, message: error.message, ...(error.detail !== undefined ? { detail: error.detail } : {}) };
  return { code: "internal", message: (error instanceof Error ? error.message : String(error)).split("\n")[0] };
}

function authenticate(binding: Binding, request: RequestEnvelope): string {
  const controller = request.controller;
  const entry = controller ? binding.controllers[controller] : undefined;
  if (!controller || !entry || typeof request.token !== "string") throw new ControlError("unauthorized", "등록된 제어자와 토큰이 필요합니다");
  const given = Buffer.from(tokenHash(request.token)), stored = Buffer.from(entry.tokenHash);
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw new ControlError("unauthorized", "토큰이 맞지 않습니다");
  return controller;
}

/** 상태를 바꾸는 요청의 소유 대조 — 인계 중 단계별로 받는 요청이 다르다 */
function fence(owner: Owner, request: RequestEnvelope): void {
  const action = request.type === "handover" ? String(request.payload?.action ?? "") : "";
  if (request.controller !== owner.controller) {
    throw new ControlError("fenced", `지금 제어자는 ${owner.controller}(세대 ${owner.generation})입니다 — 이 요청은 받지 않습니다`, { controller: owner.controller, generation: owner.generation });
  }
  if (request.generation !== owner.generation) {
    throw new ControlError("fenced", `세대가 다릅니다(요청 ${request.generation ?? "없음"}, 지금 ${owner.generation}) — 이전 소유의 늦은 요청은 받지 않습니다`, { generation: owner.generation });
  }
  const handover = owner.handover;
  if (!handover) return;
  if (handover.state === "transferred") {
    if (!(request.type === "handover" && (action === "accept" || action === "status"))) throw new ControlError("handover-unaccepted", `인계 ${handover.id} 를 먼저 인수(accept)하세요`);
    return;
  }
  const allowed = ["pause", "cancel", "reconcile", "revoke"].includes(request.type) || (request.type === "handover" && ["advance", "abort", "status"].includes(action));
  if (!allowed) throw new ControlError("handover-in-progress", `인계 ${handover.id} 가 진행 중입니다(${handover.state}) — 끝나거나 취소될 때까지 실행·판단을 받지 않습니다`);
}

function runSummary(run: RunRecord, deep = false): Record<string, unknown> {
  const now = Date.now();
  const beat = run.supervisor?.heartbeatAt ? now - Date.parse(run.supervisor.heartbeatAt) : null;
  return {
    runId: run.runId, commandId: run.commandId, state: run.state, mode: run.mode, sessionId: run.sessionId, links: run.links, workId: run.workId,
    acceptedAt: run.acceptedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), ...(run.outcome ? { outcome: run.outcome } : {}),
    ...(run.stop ? { stop: run.stop } : {}),
    liveness: {
      supervisor: run.supervisor ? { pid: run.supervisor.pid, heartbeatAgeMs: beat } : null,
      host: run.host ? { pid: run.host.pid, ...(deep && ACTIVE_RUN_STATES.includes(run.state) ? { process: liveness(run.host.pid, run.host.marker) } : {}), exitCode: run.host.exitCode ?? null } : null,
      progress: run.progress ?? null,
    },
  };
}

function hello(root: string, binding: Binding | undefined): unknown {
  const owner = binding ? safeOwner(root) : undefined;
  let strict = false;
  try { strict = (require("../work") as typeof import("../work")).loadManifestIfAny(root)?.workOrder.requireVerifiedApproval ?? false; } catch { strict = true; }
  return {
    protocol: PROTOCOL, versions: SUPPORTED_VERSIONS, codeAgent: { version: packageVersion(), stateSchema: STATE_SCHEMA, stateView: "code-agent.state v1" },
    execution: { framework: "langgraph", graphVersion: GRAPH_VERSION, checkpoint: "sqlite", resume: "code-agent flow advance --json", authority: "domain-records", arbitraryCheckpointResume: false },
    interactions: (require("../interactionService") as typeof import("../interactionService")).INTERACTION_CAPABILITIES,
    project: { root, projectId: binding?.projectId ?? null, enabled: !!binding },
    controllers: binding ? Object.keys(binding.controllers) : [],
    ownership: owner ? { controller: owner.controller, generation: owner.generation, handover: owner.handover ? { id: owner.handover.id, state: owner.handover.state, to: owner.handover.to } : null } : null,
    commands: { open: OPEN_TYPES, read: READ_TYPES, mutating: MUTATING_TYPES, all: COMMAND_TYPES },
    hosts: [{ kind: "claude", supported: true, modes: ["start", "continue"], output: "stream-json", profile: binding ? { permissionMode: binding.host.permissionMode, allowedTools: binding.host.allowedTools, disallowedTools: binding.host.disallowedTools } : null },
      { kind: "codex", supported: false }],
    approvals: {
      human: ["tty", "claude-question", "codex-prompt", "codex-elicitation", "dashboard-human"],
      delegated: { channel: "master-delegation", verified: false, actions: DELEGABLE_ACTIONS, humanOnly: HUMAN_ONLY_ACTIONS, categories: DECISION_CATEGORIES, requires: "사람이 TTY 에서 준 grant(code-agent master grant)" },
      requireVerifiedApproval: strict, delegationAvailable: !!binding && !strict,
    },
    events: { types: EVENT_TYPES, pageLimit: binding?.policy.eventPageLimit ?? null, cursor: "seq(logId 안에서 1씩 증가)" },
    runStates: { all: [...ACTIVE_RUN_STATES, ...TERMINAL_RUN_STATES], active: ACTIVE_RUN_STATES, terminal: TERMINAL_RUN_STATES },
    errors: ERROR_CODES,
    policy: binding?.policy ?? null,
    unsupported: UNSUPPORTED,
  };
}

function requireActiveSlot(root: string): void {
  const active = activeRuns(root);
  if (active.length) throw new ControlError("busy", `실행 중인 master 실행이 있습니다: ${active.map((run) => `${run.runId}(${run.state})`).join(", ")}`, { runs: active.map((run) => run.runId) });
}

function linksOf(raw: unknown): Links {
  if (raw === undefined) return {};
  if (!plain(raw)) throw new ControlError("invalid-request", "links 는 객체입니다");
  const links: Links = {};
  for (const key of ["missionId", "taskId", "attemptId", "planVersion", "invocationId"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!validId(value)) throw new ControlError("invalid-request", `links.${key} 형식이 올바르지 않습니다`);
    links[key] = value;
  }
  return links;
}

const STARTABLE = new Set(["no-work", "ready", "replan-required"]);
/** 재개 판정의 '다시 받을 확인 요청' → 그 동의 동작 */
const REVISE_ACTION: Record<string, string> = { "confirm-request": "request", "plan-consent": "plan", "deliver-consent": "deliver" };

/**
 * master 위임 판단이 수정 요청으로 닫은 확인 요청을 같은 세션이 고쳐 다시 준비할 자리인가. 재개 판정은 다시 받을 확인 요청을 사람 몫으로
 * 보이지만, 고쳐 다시 준비하는 것은 그 동의를 준비한 세션이고 다시 준비한 동의의 응답은 다시 사람이나 위임 판단이 한다.
 * 사람이 낸 수정 요청(위임 기록 없음)은 여기에 들지 않는다 — 사람 경로로 남는다.
 */
function delegatedRevision(root: string, view: StateJson, bound: string | null, sessionId: string): boolean {
  const action = REVISE_ACTION[view.resume.next.action];
  if (!bound || !action || !["needs-human", "reapproval-required"].includes(view.resume.code)) return false;
  const last = consentReceipts(root, bound).filter((receipt) => receipt.action === action).at(-1);
  return last?.status === "changes-requested" && last.channel === "master-delegation" && last.delegation?.verdict === "request-changes" && last.preparedSession?.id === sessionId;
}

function submit(root: string, binding: Binding, owner: Owner, request: RequestEnvelope, mode: "start" | "continue", payload: Record<string, unknown>): unknown {
  requireActiveSlot(root);
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT) throw new ControlError("invalid-request", `prompt 는 1~${MAX_PROMPT}자입니다`);
  const links = linksOf(payload.links);
  const timeoutMs = payload.timeoutMs === undefined ? binding.policy.runTimeoutMs
    : typeof payload.timeoutMs === "number" && Number.isInteger(payload.timeoutMs) && payload.timeoutMs >= 1_000 && payload.timeoutMs <= binding.policy.runTimeoutMs ? payload.timeoutMs
      : (() => { throw new ControlError("invalid-request", `timeoutMs 는 1000~${binding.policy.runTimeoutMs} 입니다`); })();
  const runs = listRuns(root);
  let sessionId: string;
  if (mode === "continue") {
    if (typeof payload.sessionId !== "string") throw new ControlError("invalid-request", "이어 실행에는 sessionId 가 필요합니다");
    const previous = runs.filter((run) => run.sessionId === payload.sessionId);
    if (!previous.length) throw new ControlError("not-found", "이 프로젝트의 master 실행 세션이 아닙니다");
    sessionId = payload.sessionId;
  } else sessionId = randomUUID();
  const expect = request.expect ?? {};
  let view = stateView(root, { session: sessionId, expectState: expect.stateVersion, expectWork: expect.work === null ? "" : expect.work ?? undefined, expectAttempt: expect.attempt === null ? "" : expect.attempt ?? undefined });
  if (view.resume.code === "stale-request") throw new ControlError("stale-state", "조회한 뒤 상태가 바뀌었습니다 — 다시 조회해 판단하세요", { stateVersion: view.stateVersion, mismatches: view.expect?.mismatches });
  // 끝난 master 실행의 세션이 쥔 임대는 그 실행의 종료가 확인됐으므로 푼다 — 다른 세션의 임대는 건드리지 않는다
  if (view.resume.code === "ownership-conflict") {
    const lease = readLease(root);
    const ours = lease && runs.some((run) => run.sessionId === lease.session && TERMINAL_RUN_STATES.includes(run.state));
    if (!ours) throw new ControlError("busy", "다른 세션이 이 작업을 진행 중입니다(작업 임대) — 그 실행이 끝났는지 확인될 때까지 새로 시작하지 않습니다", { resume: view.resume });
    releaseLease(root);
    view = stateView(root, { session: sessionId });
  }
  const workId = view.work?.id ?? null;
  let requestId: string | null = null;
  try { requestId = workId ? null : loadRequestSession(root)?.id ?? null; } catch { requestId = null; }
  const bound = workId ?? requestId;
  if (bound) {
    const binding = readWorkBinding(root, bound);
    if (!binding) throw new ControlError("not-enabled", `작업 ${bound} 는 master 실행이 연 작업이 아닙니다 — 연동하지 않은 작업은 이어 실행하지 않습니다`);
    if (binding.links.missionId && links.missionId && binding.links.missionId !== links.missionId) throw new ControlError("conflict", `작업 ${bound} 는 임무 ${binding.links.missionId} 에 묶여 있습니다`);
    if (binding.links.taskId && links.taskId && binding.links.taskId !== links.taskId) throw new ControlError("conflict", `작업 ${bound} 는 master 작업 ${binding.links.taskId} 에 묶여 있습니다`);
  } else if (mode === "continue") {
    // 작업 없이 이어 실행 — 이전 실행이 작업을 열지 않았거나 반영으로 닫았다. 같은 세션의 대화를 잇는 것이라 받는다
  }
  const waitingOnOwnAttempt = view.resume.code === "wait" && mode === "continue" && view.resume.reasons.every((reason) => reason.code === "attempt-running");
  if (!STARTABLE.has(view.resume.code) && !waitingOnOwnAttempt && !(mode === "continue" && delegatedRevision(root, view, bound, sessionId))) {
    const code = view.resume.code === "wait" ? "busy" : "invalid-state";
    throw new ControlError(code, `지금 code-agent 재개 판정(${view.resume.code}: ${view.resume.next.action})에서는 실행을 시작하지 않습니다 — ${view.resume.next.by === "human" ? "판단(decide·answer)이나 사람의 조치가 먼저입니다" : "기다린 뒤 다시 조회하세요"}`,
      { resume: view.resume, stateVersion: view.stateVersion });
  }
  if (mode === "start" && workId && view.resume.code === "no-work") throw new ControlError("invalid-state", "작업 상태를 다시 조회하세요");
  const runId = newRunId();
  const at = new Date().toISOString();
  const text = [`[code-agent master 실행 ${runId}${links.missionId ? ` · 임무 ${links.missionId}` : ""}${links.taskId ? ` · 작업 ${links.taskId}` : ""}${links.attemptId ? ` · 시도 ${links.attemptId}` : ""}]`, "", prompt, ""].join("\n");
  writeFileSync(runPrompt(root, runId), text, "utf8");
  const run: RunRecord = {
    version: 1, runId, commandId: request.commandId!, controller: owner.controller, generation: owner.generation, mode, links, state: "accepted", acceptedAt: at, updatedAt: at,
    sessionId, ...(mode === "continue" ? { resumeOf: sessionId } : {}), promptHash: `sha256:${sha256(text)}`, timeoutMs,
    workId: bound, baseHead: view.repo.head, baseStateVersion: view.stateVersion, history: [{ at, state: "accepted" }],
  };
  createRun(root, run);
  emit(root, "run.accepted", { runId, commandId: request.commandId, stateVersion: view.stateVersion, data: { mode, sessionId, links, workId: bound } });
  spawnSupervisor(root, runId);
  return { runId, sessionId, state: "accepted", mode, workId: bound, stateVersion: view.stateVersion, resume: view.resume.code };
}

function dispatch(root: string, binding: Binding, owner: Owner, request: RequestEnvelope): unknown {
  const payload = request.payload ?? {};
  const ctx = { controller: owner.controller, generation: owner.generation, commandId: request.commandId ?? "" };
  switch (request.type) {
    case "submit": {
      const mode = payload.mode === "continue" ? "continue" : payload.mode === "start" || payload.mode === undefined ? "start" : undefined;
      if (!mode) throw new ControlError("invalid-request", "mode 는 start 또는 continue 입니다");
      return submit(root, binding, owner, request, mode, payload);
    }
    case "resume": {
      if (!validId(payload.runId)) throw new ControlError("invalid-request", "runId 가 필요합니다");
      const run = readRun(root, payload.runId);
      if (!run) throw new ControlError("not-found", `실행 ${payload.runId} 가 없습니다`);
      if (!["paused", "blocked", "completed", "failed", "unknown", "cancelled"].includes(run.state)) throw new ControlError("invalid-state", `${run.state} 실행은 이어 가지 않습니다`);
      return submit(root, binding, owner, request, "continue", { ...payload, sessionId: run.sessionId, links: payload.links ?? run.links,
        prompt: typeof payload.prompt === "string" ? payload.prompt : "중단한 자리에서 이어 간다. code-agent status 로 위치를 확인하고 ca-next 절차대로 진행한다." });
    }
    case "pause": case "cancel": {
      if (!validId(payload.runId)) throw new ControlError("invalid-request", "runId 가 필요합니다");
      const result = requestStop(root, payload.runId, { mode: request.type, reason: typeof payload.reason === "string" ? payload.reason.slice(0, 300) : `master ${request.type}`,
        by: `controller:${owner.controller}`, commandId: request.commandId, graceMs: typeof payload.graceMs === "number" ? Math.max(0, Math.min(payload.graceMs, binding.policy.stopGraceMs)) : binding.policy.stopGraceMs,
        force: payload.force === true, waitMs: typeof payload.waitMs === "number" ? payload.waitMs : 0 });
      return { run: runSummary(result.run, true), stopped: result.stopped, requested: true,
        note: result.stopped ? "실행이 멈췄습니다(끝 상태 확인)" : "정지를 요청했습니다 — 실제 정지는 run.finished 이벤트나 snapshot 으로 확인합니다" };
    }
    case "decide": return decideConsent(root, ctx, payload, () => stateView(root).stateVersion, request.expect?.stateVersion);
    case "answer": {
      const workId = typeof payload.workId === "string" ? payload.workId : stateView(root).work?.id ?? loadRequestSession(root)?.id;
      if (!workId) throw new ControlError("invalid-state", "답할 작업이 없습니다");
      return answerQuestions(root, ctx, payload, workId);
    }
    case "handover": {
      const action = payload.action;
      // 요청 뒤 바로 한 단계 진행 — 멈출 실행이 없으면 그 자리에서 넘긴다(인수는 새 제어자가 따로 한다)
      if (action === "request") { requestHandover(root, binding, owner, payload.to, request.commandId!); return advanceHandover(root, binding.policy) ?? null; }
      if (action === "advance") return advanceHandover(root, binding.policy) ?? null;
      if (action === "accept") return acceptHandover(root, owner, request.controller!, request.generation, payload.handoverId);
      if (action === "abort") return abortHandover(root, owner, payload.handoverId);
      if (action === "status") return owner;
      throw new ControlError("invalid-request", "handover action 은 request·advance·accept·abort·status 입니다");
    }
    case "reconcile": {
      const changed = reconcileRuns(root, binding.policy, true);
      advanceHandover(root, binding.policy);
      return { changed: changed.map((run) => runSummary(run)), runs: listRuns(root).slice(-10).map((run) => runSummary(run, true)) };
    }
    case "policy": {
      const next = mergePolicy(binding.policy, payload.patch);
      writeBinding(root, { ...binding, policy: next });
      emit(root, "policy.changed", { commandId: request.commandId, data: { policy: next, by: owner.controller } });
      return { policy: next };
    }
    case "revoke": {
      const grant = grantViews(root).find((item) => item.id === payload.grantId);
      if (!grant || grant.controller !== owner.controller) throw new ControlError("grant-missing", "이 제어자의 권한이 아닙니다");
      if (grant.revoked) return { grantId: grant.id, revoked: grant.revoked };
      const at = new Date().toISOString();
      appendGrantRow(root, { type: "revoke", at, id: grant.id, by: { kind: "controller", name: owner.controller }, ...(typeof payload.reason === "string" ? { reason: payload.reason.slice(0, 300) } : {}) });
      emit(root, "grant.revoked", { commandId: request.commandId, data: { grantId: grant.id, by: `controller:${owner.controller}` } });
      return { grantId: grant.id, revoked: { at, by: `controller:${owner.controller}` } };
    }
  }
  throw new ControlError("unsupported", `지원하지 않는 명령: ${request.type}`);
}

function read(root: string, binding: Binding, request: RequestEnvelope): unknown {
  const payload = request.payload ?? {};
  switch (request.type) {
    case "snapshot": {
      reconcileRuns(root, binding.policy);
      const view: StateJson = stateView(root);
      const runs = listRuns(root);
      return {
        project: { projectId: binding.projectId, root }, owner: readOwner(root), policy: binding.policy,
        runs: { active: runs.filter((run) => ACTIVE_RUN_STATES.includes(run.state)).map((run) => runSummary(run, true)), recent: runs.slice(-10).map((run) => runSummary(run)) },
        state: view, events: eventPosition(root),
        works: [...new Set([view.work?.id, ...runs.map((run) => run.workId)].filter((id): id is string => !!id))].map((id) => readWorkBinding(root, id) ?? { workId: id, bound: false }),
      };
    }
    case "events": {
      const after = typeof payload.after === "number" && Number.isInteger(payload.after) && payload.after >= 0 ? payload.after : 0;
      const limit = typeof payload.limit === "number" ? Math.max(1, Math.min(payload.limit, binding.policy.eventPageLimit)) : binding.policy.eventPageLimit;
      return readEvents(root, after, typeof payload.logId === "string" ? payload.logId : undefined, limit);
    }
    case "heartbeat": {
      reconcileRuns(root, binding.policy);
      const owner = readOwner(root);
      return { owner, runs: activeRuns(root).map((run) => runSummary(run)), events: eventPosition(root), stateVersion: stateView(root).stateVersion };
    }
    case "command": {
      if (!validId(payload.commandId)) throw new ControlError("invalid-request", "commandId 가 필요합니다");
      const record = readCommand(root, payload.commandId);
      if (!record) return { commandId: payload.commandId, known: false };
      if (record.controller && record.controller !== request.controller) throw new ControlError("unauthorized", "다른 제어자의 명령입니다");
      const run = record.runId ? readRun(root, record.runId) : undefined;
      return { commandId: record.commandId, known: true, type: record.type, status: record.status, receivedAt: record.receivedAt, requestHash: record.requestHash,
        response: record.response, ...(run ? { run: runSummary(run, true), phase: run.state } : {}) };
    }
    case "result": {
      if (!validId(payload.runId)) throw new ControlError("invalid-request", "runId 가 필요합니다");
      const run = readRun(root, payload.runId);
      if (!run) throw new ControlError("not-found", `실행 ${payload.runId} 가 없습니다`);
      return { run: runSummary(run, true), result: run.result ?? null, final: TERMINAL_RUN_STATES.includes(run.state) };
    }
    case "questions": {
      const workId = typeof payload.workId === "string" ? payload.workId : stateView(root).work?.id ?? loadRequestSession(root)?.id;
      if (!workId) return { workId: null, questions: [] };
      return questionsView(root, workId);
    }
    case "consents": {
      const view = stateView(root);
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === "string") : view.consents.open.map((entry) => entry.id);
      return { consents: consentsView(root, ids) };
    }
    case "grants": return { grants: grantViews(root).filter((grant) => grant.controller === request.controller) };
  }
  throw new ControlError("unsupported", `지원하지 않는 명령: ${request.type}`);
}

/** 요청 한 건 → 응답 한 건. 던지지 않는다(오류는 ok:false 응답) */
export function call(root: string, text: string): ResponseEnvelope {
  let request: RequestEnvelope;
  try { request = parseRequest(text); }
  catch (error) { return envelope("invalid", { ok: false, error: errorOf(error) }); }
  const type = request.type;
  try {
    const binding = readBinding(root);
    if (type === "hello") return envelope(type, { result: hello(root, binding) }, binding ? root : undefined);
    if (!binding) throw new ControlError("not-enabled", "이 프로젝트는 master 연동이 켜져 있지 않습니다 — 사람이 터미널에서 code-agent master enable 로 켭니다");
    const controller = authenticate(binding, request);
    if (type === "interactions" || type === "interaction" || type === "interaction.result") {
      return envelope(type, { result: (require("../interactionService") as typeof import("../interactionService")).queryInteractions(root, binding, type, request.payload ?? {}) }, root);
    }
    if (type === "interaction.respond") {
      return withLock(root, CONTROL_LOCK, () => {
        const current = readBinding(root), owner = readOwner(root);
        if (!current || !owner) throw new ControlError("not-enabled", "연동이 해제됐습니다");
        authenticate(current, request); fence(owner, request);
        return envelope(type, { commandId: request.commandId, result: (require("../interactionService") as typeof import("../interactionService")).respondInteraction(root, current, request) }, root);
      });
    }
    if (!(MUTATING_TYPES as readonly string[]).includes(type)) {
      const owner = readOwner(root);
      if (owner && controller === owner.controller && request.generation === owner.generation && !owner.handover) touchOwner(root);
      return envelope(type, { result: read(root, binding, request) }, root);
    }
    return withLock(root, CONTROL_LOCK, () => {
      const existing = readCommand(root, request.commandId!);
      const hash = requestHash(request);
      if (existing) {
        if (existing.requestHash !== hash) {
          return envelope(type, { ok: false, commandId: request.commandId, error: { code: "conflict", message: `commandId ${request.commandId} 는 다른 내용으로 이미 받았습니다 — 실행하지 않습니다`, detail: { type: existing.type, status: existing.status } } }, root);
        }
        if (existing.status === "received") return interrupted(root, existing);
        return { ...(existing.response as ResponseEnvelope), replayed: true };
      }
      const owner = readOwner(root);
      if (!owner) throw new ControlError("not-enabled", "연동 소유 기록(owner.json)이 없습니다 — 사람이 code-agent master enable 로 다시 켭니다");
      let response: ResponseEnvelope;
      let runId: string | undefined;
      // 처리 전에 받은 사실을 먼저 남긴다 — 처리 도중 끊기면 같은 commandId 의 재전송이 다시 실행하지 않고 실제 결과를 대조한다
      writeCommand(root, { commandId: request.commandId!, type, controller, generation: request.generation, requestHash: hash, receivedAt: new Date().toISOString(), status: "received", response: null });
      try {
        fence(owner, request);
        reconcileRuns(root, binding.policy);
        if (!(type === "handover" && request.payload?.action !== "advance")) advanceHandover(root, binding.policy);
        const current = readOwner(root) ?? owner;
        fence(current, request);
        const result = dispatch(root, binding, current, request);
        runId = plain(result) && typeof result.runId === "string" ? result.runId : undefined;
        touchOwner(root);
        emit(root, "command.accepted", { commandId: request.commandId, ...(runId ? { runId } : {}), data: { type } });
        response = envelope(type, { commandId: request.commandId, result }, root);
        writeCommand(root, { commandId: request.commandId!, type, controller, generation: request.generation, requestHash: hash, receivedAt: response.at, status: "accepted", response, ...(runId ? { runId } : {}) });
      } catch (error) {
        response = envelope(type, { ok: false, commandId: request.commandId, error: errorOf(error) }, root);
        writeCommand(root, { commandId: request.commandId!, type, controller, generation: request.generation, requestHash: hash, receivedAt: response.at, status: "rejected", response });
        emit(root, "command.rejected", { commandId: request.commandId, data: { type, code: response.error!.code } });
      }
      return response;
    });
  } catch (error) {
    return envelope(type, { ok: false, ...(request.commandId ? { commandId: request.commandId } : {}), error: errorOf(error) });
  }
}

/**
 * 처리 도중 끊긴 명령의 재전송 — 다시 실행하지 않는다. 그 명령으로 접수된 실행이 있으면 그 실행을 돌려주고, 없으면 결과를 확인할 수
 * 없다고 알린다(받는 쪽이 snapshot 으로 대조한다).
 */
function interrupted(root: string, record: CommandRecord): ResponseEnvelope {
  const run = listRuns(root).find((item) => item.commandId === record.commandId);
  if (run) {
    const result = { runId: run.runId, sessionId: run.sessionId, state: run.state, mode: run.mode, workId: run.workId, stateVersion: run.baseStateVersion, recovered: true };
    const response = envelope(record.type, { commandId: record.commandId, result, replayed: true }, root);
    writeCommand(root, { ...record, status: "accepted", response: { ...response, replayed: undefined }, runId: run.runId });
    return response;
  }
  return envelope(record.type, { ok: false, commandId: record.commandId, replayed: true, error: { code: "internal",
    message: "이 명령은 처리 도중 끊겼고 결과를 확인할 수 없습니다 — 다시 실행하지 않습니다. snapshot 으로 상태를 대조한 뒤 새 commandId 로 요청하세요" } }, root);
}

function touchOwner(root: string): void {
  const owner = readOwner(root);
  if (!owner) return;
  writeOwner(root, { ...owner, lastSeenAt: new Date().toISOString() });
}
