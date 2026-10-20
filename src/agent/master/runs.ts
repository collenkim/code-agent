/**
 * 실행 기록의 제어 쪽 — 접수·감독 시작·정지 요청·재조정. 감독 프로세스(supervisor.ts)와 같은 기록을 짧은 잠금 안에서 고친다.
 *
 * 재조정은 실행 잠금(감독이 사는 동안 쥔다)과 호스트 명령줄 표지로 실제 프로세스를 대조한다. heartbeat 가 끊긴 것만으로는 끝났다고
 * 보지 않는다: 감독이 죽고 호스트가 살아 있으면 orphaned(끝나지 않음), 둘 다 끝났으면 unknown(출력에서 읽은 결과를 붙이되 성공으로
 * 처리하지 않는다), 접수 뒤 감독이 시작하지 않았으면 abandoned. 어느 경우도 자동으로 다시 실행하지 않는다.
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { join } from "path";

import { acquireLock } from "../lock";
import { stateView } from "../stateView";
import { killVerified, liveness, waitDead } from "./processes";
import { ACTIVE_RUN_STATES, ControlError, TERMINAL_RUN_STATES, type Policy, type RunState } from "./protocol";
import { buildResult, readHostOutput } from "./result";
import { emit, listRuns, masterPath, readRun, RUN_LOCK, updateRun, writeRunRecord, type RunRecord, type StopRequest } from "./store";

export const newRunId = (): string => `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

export function activeRuns(root: string): RunRecord[] {
  return listRuns(root).filter((run) => ACTIVE_RUN_STATES.includes(run.state));
}

/** 감독 프로세스를 띄운다 — 부른 프로세스와 떨어져 계속 돈다 */
export function spawnSupervisor(root: string, runId: string): void {
  const cli = join(__dirname, "..", "cli.js");
  const child = spawn(process.execPath, [cli, "master", "supervise", runId], { cwd: root, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env } });
  child.on("error", () => { /* 시작 기한이 지나면 재조정이 abandoned 로 둔다 */ });
  child.unref();
}

/** 실행 잠금을 바로 잡아 본다 — 잡히면 감독이 없다(같은 PC 의 죽은 주인은 회수된다). 잡은 잠금은 run 안에서만 쥔다 */
function withoutSupervisor<T>(root: string, runId: string, run: () => T): { held: true; value: T } | { held: false } {
  let release: () => void;
  try {
    release = acquireLock(masterPath(root, RUN_LOCK(runId)), { waitMs: 0, ageReclaim: false, label: "master 실행", display: RUN_LOCK(runId) });
  } catch {
    return { held: false };
  }
  try { return { held: true, value: run() }; } finally { release(); }
}

function finishWithoutHost(root: string, runId: string, state: RunState, reason: string, extra: Partial<RunRecord> = {}): RunRecord {
  (require("./codexPermissions") as typeof import("./codexPermissions")).closeCodexPermissions(root, runId, reason);
  const run = updateRun(root, runId, (current) => {
    Object.assign(current, extra);
    current.state = state;
    current.finishedAt = new Date().toISOString();
    current.outcome = { state, reason, ...(current.stop ? { cooperative: !current.stop.forcedAt, forced: !!current.stop.forcedAt } : {}) };
    current.history.push({ at: current.finishedAt, state, note: reason });
  });
  const type = state === "abandoned" ? "run.abandoned" : state === "unknown" ? "run.unknown" : "run.finished";
  emit(root, type, { runId, commandId: run.commandId, data: { state, reason } });
  return run;
}

/** 감독이 사라진 실행의 출력에서 결과를 읽어 붙인다 — 성공 판정은 하지 않는다(state 는 호출자가 정한다) */
function recovered(root: string, run: RunRecord): unknown {
  try {
    const host = readHostOutput(root, run.runId, run.host?.exitCode ?? null, run.host?.signal ?? null);
    return { ...buildResult(root, run, host, stateView(root, { session: run.sessionId, runId: run.runId })), recovered: true };
  } catch (error) {
    return { recovered: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 재조정 — deep 이 아니면 heartbeat 가 오래된 실행만 프로세스를 본다(매 요청마다 명령줄을 읽지 않는다).
 * 돌려주는 것: 상태가 바뀐 실행.
 */
export function reconcileRuns(root: string, policy: Policy, deep = false, now = Date.now()): RunRecord[] {
  const changed: RunRecord[] = [];
  for (const run of activeRuns(root)) {
    if (run.state === "accepted") {
      if (!deep && now - Date.parse(run.acceptedAt) < policy.startTimeoutMs) continue;
      if (now - Date.parse(run.acceptedAt) < policy.startTimeoutMs) continue;
      const done = withoutSupervisor(root, run.runId, () => {
        const latest = readRun(root, run.runId);
        return latest?.state === "accepted" ? finishWithoutHost(root, run.runId, "abandoned", `접수 뒤 ${Math.round(policy.startTimeoutMs / 1000)}초 안에 감독이 시작하지 않았습니다 — 다시 실행하지 않습니다`) : undefined;
      });
      if (done.held && done.value) changed.push(done.value);
      continue;
    }
    const beat = Date.parse(run.supervisor?.heartbeatAt ?? run.supervisor?.startedAt ?? run.acceptedAt);
    if (!deep && run.state !== "orphaned" && now - beat < policy.heartbeatMs * 3) continue;
    const done = withoutSupervisor(root, run.runId, () => {
      const latest = readRun(root, run.runId);
      if (!latest || !ACTIVE_RUN_STATES.includes(latest.state)) return undefined;
      const host = latest.host ? liveness(latest.host.pid, latest.host.marker) : "dead";
      if (host === "alive" || host === "unknown") {
        if (latest.state === "orphaned") return undefined;
        const next = updateRun(root, latest.runId, (current) => {
          current.state = "orphaned";
          current.history.push({ at: new Date().toISOString(), state: "orphaned", note: `감독 프로세스가 없고 호스트(pid ${latest.host?.pid})가 ${host === "alive" ? "살아 있습니다" : "확인되지 않습니다"}` });
        });
        emit(root, "run.orphaned", { runId: latest.runId, data: { hostPid: latest.host?.pid, host } });
        return next;
      }
      // 호스트도 끝났다 — 정지 요청이 있었으면 그 결과로, 아니면 unknown(출력 결과는 붙이되 성공으로 보지 않는다)
      const result = recovered(root, latest);
      if (latest.stop) return finishWithoutHost(root, latest.runId, latest.stop.mode === "cancel" ? "cancelled" : "paused", `${latest.stop.reason} — 감독 없이 호스트 종료를 확인했습니다`, { result } as Partial<RunRecord>);
      return finishWithoutHost(root, latest.runId, "unknown", "감독 프로세스와 호스트가 모두 끝났지만 끝맺음 기록이 없습니다 — 결과를 확인하기 전에는 성공·실패로 보지 않습니다", { result } as Partial<RunRecord>);
    });
    if (done.held && done.value) changed.push(done.value);
  }
  return changed;
}

export interface StopInput { mode: "pause" | "cancel"; reason: string; by: string; commandId?: string; graceMs: number; force?: boolean; waitMs?: number }

/**
 * 정지 요청 — 접수됐을 뿐 시작 전이면 바로 끝내고, 실행 중이면 기록에 요청을 남긴다(hook 이 도구를 막고 감독이 유예 뒤 강제 종료한다).
 * 감독이 없는 실행(orphaned)은 force 일 때만 확인된 호스트를 끝낸다. waitMs 동안 실제로 멈췄는지 기다려 본다.
 */
export function requestStop(root: string, runId: string, input: StopInput): { run: RunRecord; stopped: boolean } {
  const run = readRun(root, runId);
  if (!run) throw new ControlError("not-found", `실행 ${runId} 가 없습니다`);
  if (TERMINAL_RUN_STATES.includes(run.state)) return { run, stopped: true };
  const request: StopRequest = { mode: input.mode, requestedAt: new Date().toISOString(), reason: input.reason, by: input.by, graceMs: input.graceMs,
    ...(input.commandId ? { commandId: input.commandId } : {}), ...(input.force ? { forceRequested: true } : {}) };
  if (run.state === "accepted") {
    const done = withoutSupervisor(root, runId, () => {
      const latest = readRun(root, runId);
      if (latest?.state !== "accepted") return undefined;
      return finishWithoutHost(root, runId, input.mode === "cancel" ? "cancelled" : "paused", `${input.reason} — 시작 전에 멈췄습니다`, { stop: request } as Partial<RunRecord>);
    });
    if (done.held && done.value) return { run: done.value, stopped: true };
  }
  const updated = updateRun(root, runId, (current) => {
    // 이미 요청이 있으면 cancel 이 pause 를 올리고, force 는 덧붙인다 — 요청 시각(유예 기준)은 처음 것을 둔다
    if (current.stop) {
      if (input.mode === "cancel") current.stop.mode = "cancel";
      if (input.force) current.stop.forceRequested = true;
    } else current.stop = request;
  });
  emit(root, "run.stop-requested", { runId, ...(input.commandId ? { commandId: input.commandId } : {}), data: { mode: updated.stop?.mode, by: input.by, reason: input.reason, force: !!input.force } });
  if (updated.state === "orphaned" && input.force && updated.host) {
    const killed = killVerified(updated.host.pid, updated.host.marker);
    updateRun(root, runId, (current) => { if (current.stop) current.stop.forcedAt = new Date().toISOString(); current.history.push({ at: new Date().toISOString(), state: "orphaned", note: `강제 종료: ${killed.detail}` }); });
    if (waitDead(updated.host.pid, updated.host.marker, 10_000)) {
      const result = recovered(root, updated);
      return { run: finishWithoutHost(root, runId, input.mode === "cancel" ? "cancelled" : "paused", `${input.reason} — 감독 없는 호스트를 강제 종료했습니다`, { result } as Partial<RunRecord>), stopped: true };
    }
  }
  const deadline = Date.now() + Math.max(0, Math.min(input.waitMs ?? 0, 300_000));
  let latest = updated;
  while (Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    latest = readRun(root, runId) ?? latest;
    if (TERMINAL_RUN_STATES.includes(latest.state)) return { run: latest, stopped: true };
  }
  return { run: latest, stopped: TERMINAL_RUN_STATES.includes(latest.state) };
}

/** 실행 기록 새로 쓰기 — 접수 때 한 번 */
export function createRun(root: string, run: RunRecord): void { writeRunRecord(root, run); }
