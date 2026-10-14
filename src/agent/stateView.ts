import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";

import { hashManifest, hashPlan } from "../core/approval";
import type { ApprovalState } from "../core/approval";
import { aidlcBlock } from "./aidlc";
import { openQuestions } from "./answers";
import { nextStep, verifyLimitHint } from "./commands";
import { CONSENT_INDEX, consentLockHeld, readConsentIndex } from "./consentState";
import { loadEvidence, runsOf, treeHashNow, verifyView } from "./evidence";
import type { Evidence, VerifyPhase } from "./evidence";
import { failureHint } from "./failureHint";
import { findingSummary, loadFindings } from "./findings";
import type { FindingsLog } from "./findings";
import { ACTIVE_FILE, experienceFile, findingsFile, loadActive, PHASES, planFile, questionsFile, reviewFile, verifyFile, workDocsDir } from "./layout";
import type { ActiveWork } from "./layout";
import { LEASE_FILE, LEASE_IDLE_MS, readLease } from "./lease";
import { loadPlanning, planningFile, PLANNING_PHASES, ROLE_PHASE, runView } from "./planningState";
import type { PlanningState } from "./planningState";
import { APPROVAL_LABEL, staleEarliest } from "./reentry";
import { requestState } from "./request";
import { retrySummary, TIMING } from "./retryPolicy";
import type { Budget, CounterKey } from "./retryPolicy";
import { loadReview } from "./review";
import type { ReviewLog } from "./review";
import { loadTriage } from "./triageState";
import { approvalOf, loadWork } from "./work";
import type { Work } from "./work";
import { currentAttempt } from "./workAttempt";

/**
 * 기계 판독용 상태 조회 — `code-agent status --json`. 사람용 `status` 문장을 파싱하지 않게 같은 판정을 고정 코드로 낸다.
 *
 * - **읽기 전용**이다: 진행·승인·카운터·임대를 바꾸지 않는다(파일을 쓰지 않는다). 판정은 기존 함수(승인·재진입·임대·한도·실패 안내)를 그대로 부른다.
 * - 아는 것만 쓴다: 읽지 못한 상태는 `unknown` 에 원인과 범위를 적고 재개 코드를 `unobservable` 로 낸다 — 완료·실패로 단정하지 않고,
 *   손상된 파일을 새 상태로 보지 않는다. OS 프로세스 생존은 보지 않는다(호스트 기록뿐) — 실행 러너의 책임이다.
 * - `stateVersion` 은 재개 판단의 근거(작업·단계·시도·승인·검증·임대·열린 동의·사람 판단 발견)의 해시다. 조회 뒤 실행 전에 상태가 바뀌었는지
 *   `--expect-state`·`--expect-work`·`--expect-attempt` 로 대조하면 다를 때 `stale-request` 를 낸다(종료 코드 3).
 * - 재개는 이 출력이 하지 않는다: `next.action` 은 기존 명령·동의 경로이고, 그 경로가 승인·임대·한도를 다시 확인한다. 이 출력이나
 *   외부에서 받은 ID·문자열은 권한 증명이 아니다.
 */

export const STATE_SCHEMA = "code-agent.state";
export const STATE_SCHEMA_VERSION = 1;

/** 재개 판정 코드 — 위가 먼저다(stale-request 는 대조를 요청했을 때만) */
export const RESUME_CODES = [
  "stale-request", "unobservable", "no-work", "ownership-conflict", "wait", "needs-human", "replan-required", "reapproval-required", "limit-reached", "ready",
] as const;
export type ResumeCode = (typeof RESUME_CODES)[number];

export interface Reason { code: string; detail: string }
export interface StateOptions { expectState?: string; expectWork?: string; expectAttempt?: string; session?: string; runId?: string; now?: number }

export interface StateJson {
  schema: typeof STATE_SCHEMA;
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  observedAt: string;
  stateVersion: string;
  repo: { root: string; head: string | null; branch: string | null; uncommitted: { known: boolean; count?: number; paths?: string[]; truncated?: boolean } };
  work: null | { id: string; target: string; kind?: string; phase: string; stage?: string; task?: string; branch?: string; base?: string; baseCommit?: string; planningVersion?: number };
  attempt: null | { id: string; kind: string };
  request: null | { status: string };
  approval: null | { status: string; label: string; staleFrom?: string };
  planning: null | { attempts: { task: string; role: string; phase: string; dispatchId: string; status: string; at: string; run?: { state: string; observedStart: boolean; elapsedMin: number; agentSession?: string } }[] };
  verification: null | { rounds: number; bound: { valid: boolean; problems: string[] }; phases: Partial<Record<VerifyPhase, { round: number; runs: number; passed: boolean }>> };
  review: null | { rounds: number };
  retry: null | { used: Record<CounterKey, number>; budgets?: Record<string, Pick<Budget, "used" | "limit" | "left" | "exhausted">> };
  questions: null | { unanswered: string[]; unverified: string[] };
  ownership: { lease: { state: "none" | "held" | "idle" | "released" | "other-work" | "unreadable"; host?: string; session?: string; seenAt?: string; idleMs?: number; self?: boolean }; process: "unverified" };
  consents: { open: { id: string; action: string; status: string; createdAt: string; lockHeld?: boolean }[]; readable: boolean };
  findings: null | { total: number; open: number; blocking: number; humanDecision: number; readable: boolean };
  files: Record<string, string>;
  resume: { code: ResumeCode; observed?: ResumeCode; reasons: Reason[]; next: { action: string; by: "model" | "human" | "runner" | "none"; hint?: string } };
  expect?: { state?: string; work?: string; attempt?: string; matches: boolean; mismatches: string[] };
  correlation?: { runId: string };
  unknown: string[];
}

/** 조회는 git 색인도 갱신하지 않는다(`GIT_OPTIONAL_LOCKS=0` — status 가 index.lock 을 잡고 색인을 다시 쓰지 않는다) */
function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  } catch {
    return undefined;
  }
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const rel = (repoRoot: string, path: string): string => relative(repoRoot, path).replace(/\\/g, "/");
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300);

/** 키 순서를 고정한 JSON — 해시 입력 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function repoFacts(repoRoot: string): StateJson["repo"] {
  const head = git(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || null;
  const status = git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status === undefined) return { root: repoRoot, head, branch, uncommitted: { known: false } };
  const paths = status.split("\n").filter(Boolean).map((line) => line.slice(3));
  return { root: repoRoot, head, branch, uncommitted: { known: true, count: paths.length, paths: paths.slice(0, 20), ...(paths.length > 20 ? { truncated: true } : {}) } };
}

function ownershipOf(repoRoot: string, active: ActiveWork | undefined, now: number, session: string | undefined, unknown: string[]): StateJson["ownership"] {
  const process = "unverified" as const;
  if (!existsSync(join(repoRoot, LEASE_FILE))) return { lease: { state: "none" }, process };
  const lease = readLease(repoRoot);
  if (!lease) {
    unknown.push(`작업 임대(${LEASE_FILE})를 읽을 수 없습니다 — 누가 진행 중인지 모릅니다`);
    return { lease: { state: "unreadable" }, process };
  }
  const idleMs = Math.max(0, now - Date.parse(lease.seenAt));
  const base = { host: lease.host, session: lease.session, seenAt: lease.seenAt, idleMs, ...(session ? { self: session === lease.session } : {}) };
  if (!active || lease.id !== active.id || lease.target !== active.target) return { lease: { state: "other-work", ...base }, process };
  if (lease.released) return { lease: { state: "released", ...base }, process };
  return { lease: { state: idleMs >= LEASE_IDLE_MS ? "idle" : "held", ...base }, process };
}

function consentsOf(repoRoot: string, unknown: string[]): StateJson["consents"] {
  if (!existsSync(join(repoRoot, CONSENT_INDEX))) return { open: [], readable: true };
  const index = readConsentIndex(repoRoot);
  if (!index) {
    unknown.push(`동의 색인(${CONSENT_INDEX})을 읽을 수 없습니다 — 열린 동의를 모릅니다`);
    return { open: [], readable: false };
  }
  const held = !!consentLockHeld(repoRoot);
  return {
    open: Object.entries(index.open).map(([id, entry]) => ({ id, action: entry.action, status: entry.status, createdAt: entry.createdAt, ...(entry.status === "applying" ? { lockHeld: held } : {}) })),
    readable: true,
  };
}

/** 증거의 묶임 — bindingProblems 와 같은 네 대조를 항목 코드로(문구를 파싱하지 않는다) */
function verificationOf(work: Work, evidence: Evidence): NonNullable<StateJson["verification"]> {
  const problems: string[] = [];
  if (evidence.baseCommit !== work.active.baseCommit) problems.push("base-commit");
  if (evidence.treeHash !== treeHashNow(work)) problems.push("tree");
  if (evidence.manifestHash !== hashManifest(work.manifest)) problems.push("manifest");
  if (work.plan && evidence.planHash !== hashPlan(work.plan)) problems.push("plan");
  const phases: NonNullable<StateJson["verification"]>["phases"] = {};
  for (const phase of ["repro", "check", "test", "integrate"] as VerifyPhase[]) {
    const runs = runsOf(evidence, phase);
    if (runs.length === 0) continue;
    const round = Math.max(...runs.map((run) => run.round));
    const latest = runs.filter((run) => run.round === round);
    phases[phase] = { round, runs: latest.length, passed: latest.every((run) => run.outcome === "passed") };
  }
  return { rounds: evidence.rounds, bound: { valid: problems.length === 0, problems }, phases };
}

/** 증거 파일이 있는데 읽지 못하는가 — loadEvidence 는 그런 증거를 없는 것으로 본다(다음 실행이 덮는다). 조회는 그 사실을 따로 적는다 */
function unreadableJson(path: string): boolean {
  if (!existsSync(path)) return false;
  try { JSON.parse(readFileSync(path, "utf8")); return false; } catch { return true; }
}

const NEXT_ACTION: Record<string, string> = {
  analysis: "planning-advance", impact: "planning-advance", design: "planning-advance", plan: "planning-advance",
  implement: "implement", check: "verify", test: "verify", review: "review", integrate: "integrate", deliver: "deliver-consent",
};

/** `code-agent status --json` 의 값 */
export function stateView(repoRoot: string, options: StateOptions = {}): StateJson {
  const now = options.now ?? Date.now();
  const unknown: string[] = ["프로세스 생존: 호스트 기록(작업 임대·담당 시작/종료)만 본다 — OS 프로세스 생존·실제 종료는 확인하지 않는다(실행 러너의 책임)"];
  const blockers: Reason[] = [];
  const reasons: Reason[] = [];
  const files: Record<string, string> = {};
  const repo = repoFacts(repoRoot);
  if (!repo.uncommitted.known) unknown.push("미커밋 변경: git status 를 실행하지 못했습니다");

  let active: ActiveWork | undefined;
  try {
    active = loadActive(repoRoot);
  } catch (error) {
    blockers.push({ code: "active-unreadable", detail: `${ACTIVE_FILE} 를 읽을 수 없습니다: ${errorText(error)}` });
  }
  if (active && (active.planningVersion !== undefined && active.planningVersion !== 1 || active.knowledgeVersion !== undefined && active.knowledgeVersion !== 1)) {
    blockers.push({ code: "unsupported-version", detail: `${ACTIVE_FILE} 의 버전(planningVersion ${String(active.planningVersion)}, knowledgeVersion ${String(active.knowledgeVersion)})을 이 code-agent 가 지원하지 않습니다` });
  }
  if (active && !(PHASES as readonly string[]).includes(active.phase)) blockers.push({ code: "unknown-phase", detail: `알 수 없는 스테이지: ${String(active.phase)}` });
  if (existsSync(join(repoRoot, ACTIVE_FILE))) files.active = ACTIVE_FILE;

  let work: Work | undefined;
  if (active && blockers.length === 0) {
    try {
      work = loadWork(repoRoot);
    } catch (error) {
      blockers.push({ code: "work-unreadable", detail: `작업 상태를 읽을 수 없습니다: ${errorText(error)}` });
    }
  }

  let triage = false;
  try { triage = !!loadTriage(repoRoot); } catch (error) { unknown.push(`조사(triage) 상태를 읽을 수 없습니다: ${errorText(error)}`); }

  const ownership = ownershipOf(repoRoot, active, now, options.session, unknown);
  const consents = consentsOf(repoRoot, unknown);
  if (consents.readable) files.consents = CONSENT_INDEX;

  let approval: ApprovalState | undefined;
  let planning: PlanningState | undefined;
  let evidence: Evidence | undefined;
  let review: ReviewLog | undefined;
  let findings: FindingsLog | undefined;
  let findingsReadable = true;
  let staleFrom: string | undefined;
  let attempt: StateJson["attempt"] = null;
  let questions: StateJson["questions"] = null;
  let request: StateJson["request"] = null;
  let budgets: NonNullable<StateJson["retry"]>["budgets"];
  if (work) {
    const { active: cursor } = work;
    if (work.plan) {
      files.plan = rel(repoRoot, planFile(repoRoot, cursor.id, cursor.target));
      try {
        approval = approvalOf(work);
        if (approval.status !== "approved" && approval.status !== "none") staleFrom = staleEarliest(work);
      } catch (error) {
        blockers.push({ code: "approval-unreadable", detail: `승인 원장을 판정할 수 없습니다: ${errorText(error)}` });
      }
    }
    if (cursor.planningVersion) {
      try {
        planning = loadPlanning(work);
        if (existsSync(planningFile(work))) files.planning = rel(repoRoot, planningFile(work));
      } catch (error) {
        blockers.push({ code: "planning-unreadable", detail: `계획 작업 기록을 읽을 수 없습니다: ${errorText(error)}` });
      }
    }
    const verifyPath = verifyFile(repoRoot, cursor.id, cursor.target);
    if (unreadableJson(verifyPath)) unknown.push(`검증 증거(${rel(repoRoot, verifyPath)})를 읽을 수 없습니다 — 기존 흐름은 없는 증거로 보고 다음 검증이 덮어씁니다`);
    evidence = loadEvidence(repoRoot, cursor.id, cursor.target);
    if (evidence) files.evidence = rel(repoRoot, verifyPath);
    const reviewPath = reviewFile(repoRoot, cursor.id, cursor.target);
    if (unreadableJson(reviewPath)) unknown.push(`리뷰 기록(${rel(repoRoot, reviewPath)})을 읽을 수 없습니다 — 기존 흐름은 없는 기록으로 봅니다`);
    review = loadReview(repoRoot, cursor.id, cursor.target);
    if (review) files.review = rel(repoRoot, reviewPath);
    try {
      findings = loadFindings(repoRoot, cursor.id);
      if (findings) files.findings = rel(repoRoot, findingsFile(repoRoot, cursor.id));
    } catch (error) {
      findingsReadable = false;
      unknown.push(errorText(error));
    }
    if (existsSync(join(repoRoot, experienceFile(cursor.id)))) files.experience = experienceFile(cursor.id);
    files.workDocs = workDocsDir(cursor.id);
    try {
      const open = openQuestions(repoRoot, questionsFile(cursor.id));
      questions = { unanswered: open.unanswered.map((question) => question.id), unverified: open.unverified.map((question) => question.id) };
      if (existsSync(join(repoRoot, questionsFile(cursor.id)))) files.questions = questionsFile(cursor.id);
    } catch (error) {
      blockers.push({ code: "questions-unreadable", detail: `질문을 읽을 수 없습니다: ${errorText(error)}` });
    }
    try {
      request = { status: requestState(repoRoot, cursor.id, cursor.spec).status };
    } catch (error) {
      blockers.push({ code: "request-unreadable", detail: `요구사항 확정 원장을 판정할 수 없습니다: ${errorText(error)}` });
    }
    try {
      attempt = currentAttempt(work, planning);
    } catch (error) {
      unknown.push(`시도 식별자를 정하지 못했습니다: ${errorText(error)}`);
    }
    if (evidence && work.plan) {
      try {
        const budget = verifyView(work, evidence).budget;
        budgets = Object.fromEntries(Object.entries(budget).map(([key, value]) => [key, { used: value.used, limit: value.limit, left: value.left, exhausted: value.exhausted }]));
      } catch (error) {
        unknown.push(`검증 한도를 계산하지 못했습니다: ${errorText(error)}`);
      }
    }
  }

  // 열린 동의 중 적용하다 멈춘 것 — 같은 PC 의 살아 있는 프로세스가 잠금을 쥐면 기다리고, 아니면 일부만 반영됐을 수 있다(자동으로 다시 돌리지 않는다)
  for (const consent of consents.open.filter((entry) => entry.status === "applying")) {
    if (!consent.lockHeld) blockers.push({ code: "consent-apply-interrupted", detail: `동의 ${consent.id}(${consent.action}) 적용이 끝나지 않은 채 멈췄을 수 있습니다 — 일부만 반영됐는지 git status·증거로 확인해야 합니다. 같은 PC 가 아니면 적용 프로세스를 확인할 수 없습니다` });
  }

  const attempts = planning && work ? planning.tasks.flatMap((record) => {
    const last = record.attempts.at(-1);
    if (!last) return [];
    const view = last.status === "running" ? runView(planning!, record, last, now) : undefined;
    return [{ task: record.task.id, role: record.task.role, phase: ROLE_PHASE[record.task.role], dispatchId: last.dispatchId, status: last.status, at: last.at,
      ...(view ? { run: { state: view.state, observedStart: view.observedStart, elapsedMin: view.elapsedMin, ...(view.agentSession ? { agentSession: view.agentSession } : {}) } } : {}) }];
  }) : [];
  const summary = findings ? findingSummary(findings) : undefined;

  // ---- 재개 판정 — nextHint 의 순서(질문 → 재진입 → 한도 → 실패 안내)를 따르고 그 앞에 관측·소유·대기를 둔다 ----
  let code: ResumeCode = "ready";
  let action = work ? NEXT_ACTION[work.active.phase] ?? "next" : "none";
  let by: StateJson["resume"]["next"]["by"] = "model";
  const phase = work?.active.phase;
  if (blockers.length > 0) {
    code = "unobservable"; by = "human"; action = "inspect";
    reasons.push(...blockers);
  } else if (!work) {
    code = "no-work"; by = "none"; action = triage ? "triage" : "none";
    if (triage) reasons.push({ code: "triage-open", detail: "열린 조사(triage)가 있습니다 — 작업이 아닙니다" });
  } else {
    const lease = ownership.lease;
    if (lease.state === "held" && !lease.self) {
      code = "ownership-conflict"; by = "runner"; action = "wait";
      reasons.push({ code: "lease-held", detail: `다른 세션(${lease.host} ${lease.session?.slice(0, 8)})이 ${Math.floor((lease.idleMs ?? 0) / 60_000)}분 전까지 이 작업을 진행했습니다 — 그 실행이 끝났는지는 러너가 확인합니다` });
    } else if (lease.state === "unreadable") {
      code = "unobservable"; by = "human"; action = "inspect";
      reasons.push({ code: "lease-unreadable", detail: "작업 임대를 읽을 수 없습니다" });
    }
    if (lease.state === "idle") reasons.push({ code: "lease-idle", detail: `임대가 ${Math.floor((lease.idleMs ?? 0) / 60_000)}분 동안 쓰이지 않았습니다 — 다음 명령이 기존 규칙으로 넘겨받습니다` });
    if (code === "ready") {
      const applying = consents.open.find((entry) => entry.status === "applying" && entry.lockHeld);
      const running = attempts.filter((item) => item.run?.state === "running");
      // openConsent 와 같은 창 — 창 밖의 열린 동의는 버려진 준비로 보고 막지 않는다
      const fresh = consents.open.filter((entry) => Date.parse(entry.createdAt) >= now - TIMING.consentOpenWindowMs);
      const pending = fresh.filter((entry) => entry.status === "pending");
      const approved = fresh.filter((entry) => entry.status === "approved");
      const aidlc = aidlcBlock(repoRoot);
      if (applying) { code = "wait"; by = "runner"; action = "wait"; reasons.push({ code: "consent-applying", detail: `동의 ${applying.id}(${applying.action})를 적용하는 중입니다` }); }
      else if (running.length > 0) {
        code = "wait"; by = "runner"; action = "wait";
        for (const item of running) reasons.push({ code: "attempt-running", detail: `${item.task} 배정(${item.dispatchId})이 ${item.run!.elapsedMin}분째 실행 중으로 기록돼 있습니다` });
      } else if (aidlc) { code = "needs-human"; by = "human"; action = "aidlc"; reasons.push({ code: "aidlc-block", detail: aidlc.split("\n")[0] }); }
      else if (request && request.status !== "confirmed") { code = "needs-human"; by = "human"; action = "confirm-request"; reasons.push({ code: "request-unconfirmed", detail: `요구사항 확정 상태: ${request.status}` }); }
      else if (questions && questions.unanswered.length + questions.unverified.length > 0) {
        code = "needs-human"; by = "human"; action = "answer-questions";
        if (questions.unanswered.length) reasons.push({ code: "questions-open", detail: `답 없는 질문: ${questions.unanswered.join(", ")}` });
        if (questions.unverified.length) reasons.push({ code: "answers-unverified", detail: `답 출처 미확인: ${questions.unverified.join(", ")}` });
      } else if (pending.length > 0) {
        code = "needs-human"; by = "human"; action = "consent";
        for (const entry of pending) reasons.push({ code: "consent-open", detail: `동의 ${entry.id}(${entry.action})가 응답을 기다립니다` });
      } else if (approved.length > 0) {
        action = "consent-apply";
        for (const entry of approved) reasons.push({ code: "consent-approved", detail: `동의 ${entry.id}(${entry.action})가 응답을 받았고 적용을 기다립니다 — 응답을 관찰한 세션이 적용합니다` });
      } else if (approval && approval.status !== "approved" && phase && PHASES.indexOf(phase) >= PHASES.indexOf("plan")) {
        const label = APPROVAL_LABEL[approval.status as Exclude<ApprovalState["status"], "approved">];
        if (approval.status === "none") { code = "needs-human"; by = "human"; action = "plan-consent"; reasons.push({ code: "approval-pending", detail: label }); }
        else if (approval.status === "rejected") { code = "ready"; action = "revise-plan"; reasons.push({ code: "plan-rejected", detail: `${label}: ${approval.record.comment ?? "(사유 없음)"}` }); }
        else if (staleFrom) { code = "replan-required"; by = "model"; action = "back-and-replan"; reasons.push({ code: `approval-${approval.status}`, detail: `${label} — 낡은 계획 작업이 ${staleFrom} 부터 있습니다` }); }
        else { code = "reapproval-required"; by = "human"; action = "plan-consent"; reasons.push({ code: `approval-${approval.status}`, detail: label }); }
      } else if ((phase === "check" || phase === "test") && verifyLimitHint(work)) {
        code = "limit-reached"; by = "human"; action = "judgment";
        reasons.push({ code: "retry-limit", detail: verifyLimitHint(work)!.slice(0, 300) });
      } else if (summary && summary.blockingHuman.length > 0) {
        code = "needs-human"; by = "human"; action = "finding-decision";
        for (const record of summary.blockingHuman) reasons.push({ code: `finding-${record.class}`, detail: `${record.id} ${record.title} — ${record.blockingReason ?? ""}` });
      } else if (phase === "plan" && approval?.status === "approved") {
        action = "next";
      } else if (phase === "deliver") {
        code = "needs-human"; by = "human"; action = "deliver-consent";
        reasons.push({ code: "deliver-consent", detail: "반영은 사람이 확인합니다" });
      }
      for (const item of attempts.filter((entry) => entry.run && entry.run.state !== "running")) {
        reasons.push({ code: `attempt-${item.run!.state}`, detail: `${item.task} 배정(${item.dispatchId}) — 결과 없이 ${item.run!.elapsedMin}분, 기존 흐름(planning advance)이 한도 안에서 다시 배정하거나 사람에게 넘깁니다` });
      }
      for (const item of attempts.filter((entry) => entry.status === "failed" || entry.status === "orphaned")) {
        if (PLANNING_PHASES.includes(phase as (typeof PLANNING_PHASES)[number]) && item.phase === phase) reasons.push({ code: `attempt-${item.status}`, detail: `${item.task} 배정(${item.dispatchId})이 ${item.status} 로 끝났습니다` });
      }
      if (code === "ready") {
        try {
          const failed = failureHint(work);
          if (failed) reasons.push({ code: "failure-recorded", detail: failed.slice(0, 300) });
        } catch { /* 실패 안내는 보조다 */ }
      }
    }
  }
  let hint: string | undefined;
  if (code !== "unobservable") {
    try { hint = nextStep(repoRoot).next; } catch (error) { unknown.push(`다음 할 일 안내를 만들지 못했습니다: ${errorText(error)}`); }
  }

  const workJson: StateJson["work"] = work ? {
    id: work.active.id, target: work.active.target, kind: work.order.kind, phase: work.active.phase,
    ...(work.active.stage ? { stage: work.active.stage } : {}), ...(work.active.task ? { task: work.active.task } : {}),
    ...(work.active.branch ? { branch: work.active.branch } : {}), ...(work.active.base ? { base: work.active.base } : {}),
    ...(work.active.baseCommit ? { baseCommit: work.active.baseCommit } : {}), ...(work.active.planningVersion ? { planningVersion: work.active.planningVersion } : {}),
  } : active ? { id: String(active.id), target: String(active.target), phase: String(active.phase) } : null;
  const approvalJson: StateJson["approval"] = approval ? {
    status: approval.status, label: approval.status === "approved" ? "승인됨" : APPROVAL_LABEL[approval.status], ...(staleFrom ? { staleFrom } : {}),
  } : null;
  const verification = work && evidence ? verificationOf(work, evidence) : null;
  const retry: StateJson["retry"] = work ? { used: retrySummary({ evidence, planning, review }), ...(budgets ? { budgets } : {}) } : null;

  // 재개 판단의 근거 — 관측 시각·경과 분·안내 문장은 넣지 않는다(조회마다 바뀌면 대조가 의미 없다)
  const basis = {
    head: repo.head, work: workJson, attempt, request, approval: approval ? { status: approval.status, at: "record" in approval ? approval.record.at : undefined, staleFrom } : null,
    attempts: attempts.map((item) => [item.task, item.dispatchId, item.status, item.run?.state]),
    verification: verification ? { rounds: verification.rounds, phases: verification.phases, bound: verification.bound.valid } : null,
    review: review ? review.rounds.length : null, questions,
    consents: consents.open.map((entry) => [entry.id, entry.status]),
    lease: { state: ownership.lease.state, session: ownership.lease.session ?? null },
    findings: summary ? summary.blockingHuman.map((record) => [record.id, record.version]) : null,
    blockers: blockers.map((item) => item.code),
  };
  const stateVersion = `sha256:${sha(canonical(basis)).slice(0, 32)}`;

  const result: StateJson = {
    schema: STATE_SCHEMA, schemaVersion: STATE_SCHEMA_VERSION, observedAt: new Date(now).toISOString(), stateVersion, repo,
    work: workJson, attempt, request, approval: approvalJson,
    planning: planning ? { attempts } : null,
    verification, review: review ? { rounds: review.rounds.length } : null, retry, questions, ownership, consents,
    findings: work ? (summary ? { total: summary.total, open: summary.open, blocking: summary.blocking, humanDecision: summary.humanDecision, readable: true }
      : { total: 0, open: 0, blocking: 0, humanDecision: 0, readable: findingsReadable }) : null,
    files,
    resume: { code, reasons, next: { action, by, ...(hint ? { hint } : {}) } },
    unknown,
  };
  if (options.runId) result.correlation = { runId: options.runId };
  if (options.expectState !== undefined || options.expectWork !== undefined || options.expectAttempt !== undefined) {
    const mismatches: string[] = [];
    if (options.expectWork !== undefined && options.expectWork !== (workJson?.id ?? "")) mismatches.push(`work: 기대 ${options.expectWork} ≠ 지금 ${workJson?.id ?? "(없음)"}`);
    if (options.expectAttempt !== undefined && options.expectAttempt !== (attempt?.id ?? "")) mismatches.push(`attempt: 기대 ${options.expectAttempt} ≠ 지금 ${attempt?.id ?? "(없음)"}`);
    if (options.expectState !== undefined && options.expectState !== stateVersion) mismatches.push(`state: 기대 ${options.expectState} ≠ 지금 ${stateVersion}`);
    result.expect = { ...(options.expectState !== undefined ? { state: options.expectState } : {}), ...(options.expectWork !== undefined ? { work: options.expectWork } : {}),
      ...(options.expectAttempt !== undefined ? { attempt: options.expectAttempt } : {}), matches: mismatches.length === 0, mismatches };
    if (mismatches.length > 0) {
      result.resume = { code: "stale-request", observed: code, reasons: [{ code: "stale-request", detail: "조회한 뒤 상태가 바뀌었습니다 — 다시 조회해 판단하세요" }, ...reasons], next: { action: "requery", by: "runner" } };
    }
  }
  return result;
}

/** `--expect-*` 대조가 어긋났으면 3 — 러너가 출력을 파싱하지 않고도 거를 수 있게 */
export function stateExitCode(view: StateJson): number {
  return view.resume.code === "stale-request" ? 3 : 0;
}
