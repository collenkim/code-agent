/**
 * 실행 결과의 근거 — 모델의 완료 발언이 아니라 code-agent 상태·검증 증거·실제 변경·커밋으로 낸다. master 는 이것을 받아 자기 검증과
 * 전체 완료 판정을 따로 한다(이 결과는 code-agent 의 완료 조건을 바꾸지 않는다).
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadWork } from "../work";
import type { StateJson } from "../stateView";
import { sha256 } from "./protocol";
import { runOutput, type RunRecord } from "./store";

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  } catch { return undefined; }
}
const fileHash = (root: string, path: string): string | undefined => {
  const full = join(root, path);
  return existsSync(full) ? `sha256:${sha256(readFileSync(full, "utf8"))}` : undefined;
};

export interface HostOutcome {
  sessionId?: string; exitCode: number | null; signal: string | null; subtype?: string; isError?: boolean; numTurns?: number; durationMs?: number;
  totalCostUsd?: number; permissionDenials: unknown[]; finalMessage?: string; finalMessageHash?: string; outputHash?: string; lines: number;
}

/** 호스트 출력(stream-json 줄)에서 세션·결과 줄을 읽는다 — 결과 줄이 없으면 그 사실만 남긴다 */
export function readHostOutput(root: string, runId: string, exitCode: number | null, signal: string | null): HostOutcome {
  const file = runOutput(root, runId);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const outcome: HostOutcome = { exitCode, signal, permissionDenials: [], lines: 0, ...(text ? { outputHash: `sha256:${sha256(text)}` } : {}) };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    outcome.lines += 1;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row.type === "system" && row.subtype === "init" && typeof row.session_id === "string") outcome.sessionId = row.session_id;
    if (row.type === "thread.started" && typeof row.thread_id === "string") outcome.sessionId = row.thread_id;
    if (row.type === "permission.denied" && outcome.permissionDenials.length < 50) outcome.permissionDenials.push(row);
    if (row.type === "turn.completed") { outcome.subtype = "success"; outcome.isError ??= false; }
    if (row.type === "turn.failed" || row.type === "error") { outcome.subtype = "error_during_execution"; outcome.isError = true; }
    if (row.type === "item.completed" && row.item && typeof row.item === "object") {
      const item = row.item as { type?: string; text?: string };
      if (item.type === "agent_message" && typeof item.text === "string") { outcome.finalMessage = item.text.slice(0, 4000); outcome.finalMessageHash = `sha256:${sha256(item.text)}`; }
    }
    if (row.type === "result") {
      if (typeof row.session_id === "string") outcome.sessionId = row.session_id;
      if (typeof row.subtype === "string") outcome.subtype = row.subtype;
      if (typeof row.is_error === "boolean") outcome.isError = row.is_error;
      if (typeof row.num_turns === "number") outcome.numTurns = row.num_turns;
      if (typeof row.duration_ms === "number") outcome.durationMs = row.duration_ms;
      if (typeof row.total_cost_usd === "number") outcome.totalCostUsd = row.total_cost_usd;
      if (Array.isArray(row.permission_denials)) outcome.permissionDenials = row.permission_denials.slice(0, 50);
      if (typeof row.result === "string") { outcome.finalMessage = row.result.slice(0, 4000); outcome.finalMessageHash = `sha256:${sha256(row.result)}`; }
    }
  }
  return outcome;
}

export interface ChangeEntry { path: string; status: string; category: "product" | "work-record" | "code-agent"; planned?: boolean }

/** 실행 전 HEAD 와 지금 작업 트리의 차이(커밋된 것 포함)와 새 파일 — 무시된 파일은 보지 않는다 */
export function changesSince(root: string, base: string | null, planned: Set<string>): ChangeEntry[] {
  const out = new Map<string, ChangeEntry>();
  const category = (path: string): ChangeEntry["category"] =>
    path.startsWith(".code-agent/") ? "code-agent" : /^doc\/work\//.test(path) ? "work-record" : "product";
  const put = (status: string, path: string) => { if (path) out.set(path, { path, status, category: category(path), ...(planned.has(path) ? { planned: true } : {}) }); };
  if (base) {
    const diff = git(root, ["diff", "--name-status", "-z", "--no-renames", base]) ?? "";
    const parts = diff.split("\0").filter(Boolean);
    for (let index = 0; index + 1 < parts.length; index += 2) put(parts[index], parts[index + 1].replace(/\\/g, "/"));
  }
  for (const path of (git(root, ["ls-files", "-z", "--others", "--exclude-standard"]) ?? "").split("\0").filter(Boolean)) put("??", path);
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function buildResult(root: string, run: RunRecord, host: HostOutcome, view: StateJson): Record<string, unknown> {
  const head = view.repo.head;
  let planned = new Set<string>();
  let planFiles: string[] = [];
  try {
    const work = loadWork(root);
    planFiles = (work?.plan?.files ?? []).map((file) => file.path);
    planned = new Set(planFiles);
  } catch { /* 작업이 없거나(반영 뒤) 읽지 못하면 계획 표시 없이 변경만 낸다 */ }
  const commits = run.baseHead && head && run.baseHead !== head
    ? (git(root, ["log", "--format=%H%x09%s", `${run.baseHead}..${head}`]) ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    })
    : [];
  const changes = changesSince(root, run.baseHead, planned);
  const evidencePath = view.files.evidence;
  return {
    runId: run.runId, commandId: run.commandId, links: run.links, sessionId: host.sessionId ?? run.sessionId,
    host: {
      exitCode: host.exitCode, signal: host.signal, subtype: host.subtype ?? null, isError: host.isError ?? null, numTurns: host.numTurns ?? null,
      durationMs: host.durationMs ?? null, totalCostUsd: host.totalCostUsd ?? null, permissionDenials: host.permissionDenials,
      finalMessage: host.finalMessage ?? null, finalMessageHash: host.finalMessageHash ?? null, outputHash: host.outputHash ?? null, outputLines: host.lines,
    },
    state: {
      before: run.baseStateVersion, after: view.stateVersion,
      work: view.work ? { id: view.work.id, phase: view.work.phase, kind: view.work.kind ?? null, branch: view.work.branch ?? null, baseCommit: view.work.baseCommit ?? null } : null,
      attempt: view.attempt, request: view.request, approval: view.approval, questions: view.questions,
      consents: view.consents.open, resume: { code: view.resume.code, action: view.resume.next.action, by: view.resume.next.by, reasons: view.resume.reasons.slice(0, 8) },
      findings: view.findings, ...(view.graph ? { graph: view.graph } : {}),
    },
    verification: view.verification ? {
      rounds: view.verification.rounds, bound: view.verification.bound, phases: view.verification.phases,
      ...(evidencePath ? { evidence: { path: evidencePath, hash: fileHash(root, evidencePath) ?? null } } : {}),
    } : null,
    changes: { baseHead: run.baseHead, head, commits, files: changes, planFiles },
    note: "모델의 완료 발언(finalMessage)은 성공 근거가 아니다 — code-agent 상태·검증 증거·변경 목록으로 판정한다",
  };
}
