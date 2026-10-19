/**
 * 실행 감독 — `code-agent master supervise <runId>`(제어 명령이 detached 로 띄운다). 한 실행에 하나만 돈다(실행 잠금을 쥐고 있는 동안).
 *
 * 1. 접수(accepted)된 실행만 시작한다. 시작 전에 정지·포기로 바뀌었으면 아무것도 하지 않고 끝낸다.
 * 2. Claude stream-json 또는 Codex JSONL을 사람이 정한 권한 설정으로 띄운다. Codex는 thread.started로 세션을 확정한다.
 *    이어 실행은 기록된 같은 세션만 재개한다. CODE_AGENT_MASTER_RUN으로 hook이 실행을 알아본다.
 * 3. heartbeat 마다 실행 기록을 고치고 정지 요청·master 연결·시간 상한을 본다. progress 마다 code-agent 상태를 관찰해 이벤트를 남긴다.
 * 4. 정지 요청이 있으면 hook 이 모든 도구를 막아 모델이 턴을 끝내게 한다(협력 정지). 유예가 지나도 살아 있으면 확인된 호스트 트리를
 *    강제 종료한다. 둘은 결과에 따로 적는다.
 * 5. 호스트가 끝나면 결과 근거(상태·검증·변경·커밋)를 만들어 기록하고 끝 상태를 정한다 — 모델의 완료 발언으로 성공 처리하지 않는다.
 */
import { spawn } from "child_process";
import { appendFileSync, createWriteStream, readFileSync } from "fs";

import { CLAUDE_SESSION_ENV, CODEX_MARKERS, CROSS_CHILD_ENV } from "../crossEnv";
import { hostCommand } from "../hosts";
import { requireManagedHost } from "./hostProfile";
import { acquireLock } from "../lock";
import { hideGitWindowInThisProcess, stateView } from "../stateView";
import { killVerified, liveness } from "./processes";
import { ACTIVE_RUN_STATES, type HostProfile, type Policy, type RunState } from "./protocol";
import { buildResult, readHostOutput } from "./result";
import { observeProgress } from "./observe";
import { MASTER_RUN_ENV } from "./runGuard";
import {
  emit, masterPath, readBinding, readOwner, readRun, RUN_LOCK, runErrors, runOutput, runPrompt, updateRun, type RunRecord,
} from "./store";

/** 실행 세션의 규칙 — 호스트의 시스템 프롬프트 뒤에 붙인다(SessionStart 의 masterRunNote 와 같은 뜻) */
export const MASTER_SYSTEM_RULES = [
  "이 세션은 code-agent master 실행이다. 사람이 이 대화를 보지 않는다.",
  "질문 도구로 사람에게 묻지 않는다. 동의가 필요하면 code-agent consent prepare 까지만 하고 동의 ID·요약을 보고한 뒤 턴을 끝낸다.",
  "설정·개발·복구·운영의 업무 질문은 code-agent interaction publish <질문.json>으로 저장하고 human-input 대기를 보고한 뒤 턴을 끝낸다. questions.md에 연결한 질문은 source:questions로 발행한다. 작업 ID가 없어도 질문할 수 있다. 답·추천 근거를 지어내지 않는다.",
  "승인·확정 기록을 만들거나 고치지 않는다. code-agent 명령은 code-agent 로 부른다.",
  "작업 재개는 code-agent flow advance --json 으로 한다. 반환한 procedure·instruction만 수행하고 결과 기록 뒤 같은 명령으로 돌아간다. kind:wait이면 반복 조회하지 않고 턴을 끝낸다.",
  "hook 이 도구를 막으며 정지를 알리면 도구를 더 쓰지 않고 한 일과 멈춘 자리를 보고한 뒤 끝낸다.",
].join("\n");

export function hostArgs(profile: HostProfile, run: Pick<RunRecord, "mode" | "sessionId"> & Partial<Pick<RunRecord, "runId">>): { command: string; args: string[] } {
  let [command, ...prefix] = profile.command;
  if (profile.command.length === 1 && command === profile.kind) {
    const resolved = hostCommand(profile.kind);
    if (typeof resolved === "string") throw new Error(resolved);
    command = resolved.file; prefix = resolved.prefix;
  }
  if (profile.kind === "codex") {
    const rules = `${MASTER_SYSTEM_RULES}\n관리 실행 표지: ${run.runId ?? run.sessionId}`;
    return { command, args: [...prefix, "exec", "-c", 'approval_policy="never"', "-c", `sandbox_mode=${JSON.stringify(profile.sandbox)}`,
      "-c", "sandbox_workspace_write.network_access=false", "-c", `developer_instructions=${JSON.stringify(rules)}`,
      ...(profile.model ? ["--model", profile.model] : []), ...(run.mode === "continue" ? ["resume", run.sessionId] : []), "--json", "-"] };
  }
  const args = [...prefix, "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", profile.permissionMode, "--permission-prompts", "none",
    ...(run.mode === "continue" ? ["--resume", run.sessionId] : ["--session-id", run.sessionId]),
    ...(profile.model ? ["--model", profile.model] : []),
    "--append-system-prompt", MASTER_SYSTEM_RULES,
    ...(profile.allowedTools.length ? ["--allowedTools", ...profile.allowedTools] : []),
    ...(profile.disallowedTools.length ? ["--disallowedTools", ...profile.disallowedTools] : []),
  ];
  return { command, args };
}

/** 호스트 환경 — 부른 쪽 Claude·Codex 세션의 표지·통로를 지우고 실행 표지를 넣는다 */
export function hostEnv(base: NodeJS.ProcessEnv, runId: string, kind: "claude" | "codex" = "claude"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of [...CLAUDE_SESSION_ENV, ...CODEX_MARKERS, "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", CROSS_CHILD_ENV]) delete env[key];
  env[MASTER_RUN_ENV] = runId;
  env.CODE_AGENT_HOST = kind;
  return env;
}

function finalState(run: RunRecord, host: { exitCode: number | null; isError?: boolean; subtype?: string }, resume: string, timedOut: boolean): { state: RunState; reason: string } {
  if (timedOut) return { state: "failed", reason: "실행 시간 상한을 넘었습니다" };
  if (run.stop) return { state: run.stop.mode === "cancel" ? "cancelled" : "paused", reason: run.stop.reason };
  if (host.exitCode !== 0 || host.isError) return { state: "failed", reason: `호스트가 실패로 끝났습니다(exit ${host.exitCode}, ${host.subtype ?? "결과 없음"})` };
  if (["needs-human", "limit-reached", "unobservable", "ownership-conflict", "stale-request"].includes(resume)) return { state: "blocked", reason: `code-agent 재개 판정 ${resume}` };
  return { state: "completed", reason: `호스트 턴이 끝났습니다 — code-agent 재개 판정 ${resume}` };
}

export function supervise(root: string, runId: string): Promise<number> {
  // 감독은 콘솔 없이(detached) 돈다 — 주기마다 부르는 상태 조회의 git 이 콘솔을 새로 할당하지 않게 한다(그동안 이벤트 루프가 막혀
  // 호스트에 프롬프트를 넘기지도, heartbeat 를 남기지도 못했다)
  hideGitWindowInThisProcess();
  let release: () => void;
  try {
    release = acquireLock(masterPath(root, RUN_LOCK(runId)), { waitMs: 0, ageReclaim: false, label: "master 실행", display: `.code-agent/master/${RUN_LOCK(runId)}` });
  } catch {
    return Promise.resolve(1); // 다른 감독이 이미 돈다
  }
  const binding = readBinding(root);
  const initial = readRun(root, runId);
  if (!binding || !initial || initial.state !== "accepted") { release(); return Promise.resolve(0); }
  const policy: Policy = binding.policy;
  const marker = `master supervise ${runId}`;
  let run = updateRun(root, runId, (current) => {
    current.state = "starting";
    current.supervisor = { pid: process.pid, startedAt: new Date().toISOString(), marker, heartbeatAt: new Date().toISOString() };
    current.history.push({ at: new Date().toISOString(), state: "starting" });
  });
  emit(root, "run.starting", { runId, commandId: run.commandId, data: { pid: process.pid } });

  return new Promise<number>((resolveRun) => {
    const profile = run.hostProfile ?? binding.host;
    const out = createWriteStream(runOutput(root, runId), { flags: "a" });
    const err = createWriteStream(runErrors(root, runId), { flags: "a" });
    let child: ReturnType<typeof spawn>;
    let spawnError: string | undefined;
    const startedAt = Date.now();
    let timedOut = false, forced = false, finished = false;
    let disconnected = false;
    let lastHeartbeat = 0, lastProgress = 0;
    let buffer = "";
    let sessionSeen: string | undefined;
    let sessionError: string | undefined;

    const finish = async (exitCode: number | null, signal: string | null): Promise<void> => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      try {
        await Promise.all([new Promise<void>(done => out.end(done)), new Promise<void>(done => err.end(done))]);
        const host = readHostOutput(root, runId, exitCode, signal);
        let progressed: ReturnType<typeof observeProgress> | undefined;
        try { progressed = observeProgress(root, run); } catch { progressed = undefined; }
        const view = progressed?.view ?? stateView(root, { session: run.sessionId, runId });
        const latest = readRun(root, runId) ?? run;
        if (profile.kind === "codex" && !sessionSeen && !latest.stop) sessionError ??= "Codex thread.started를 확인하지 못했습니다";
        if (profile.kind === "codex" && !host.subtype && !latest.stop) sessionError ??= "Codex 턴 종료 이벤트를 확인하지 못했습니다";
        const failure = spawnError ?? sessionError;
        const verdict = failure ? { state: "failed" as RunState, reason: failure } : finalState(latest, host, view.resume.code, timedOut);
        const result = buildResult(root, latest, host, view);
        run = updateRun(root, runId, (current) => {
          current.state = verdict.state;
          current.finishedAt = new Date().toISOString();
          if (current.host) { current.host.exitCode = exitCode; current.host.signal = signal; current.host.exitedAt = current.finishedAt; }
          current.outcome = { state: verdict.state, reason: verdict.reason, ...(current.stop ? { cooperative: !forced, forced } : {}) };
          current.result = result;
          current.history.push({ at: current.finishedAt, state: verdict.state, note: verdict.reason });
        });
        emit(root, "run.finished", { runId, commandId: run.commandId, stateVersion: view.stateVersion,
          data: { state: verdict.state, reason: verdict.reason, ...(run.stop ? { stop: run.stop.mode, cooperative: !forced, forced } : {}), resume: view.resume.code } });
      } catch (error) {
        try { appendFileSync(runErrors(root, runId), `감독 마무리 실패: ${error instanceof Error ? error.stack : String(error)}\n`); } catch { /* 기록 실패 */ }
      } finally {
        release();
        resolveRun(0);
      }
    };

    const tick = (): void => {
      if (finished) return;
      const now = Date.now();
      try {
        if (now - lastHeartbeat >= policy.heartbeatMs) {
          lastHeartbeat = now;
          run = updateRun(root, runId, (current) => { if (current.supervisor) current.supervisor.heartbeatAt = new Date(now).toISOString(); });
          // master 연결 — 마지막 요청이 오래되면 끊김으로 알린다(실패·재배정 근거가 아니다). 정책이 pause 면 협력 정지를 건다
          const owner = readOwner(root);
          const seen = owner?.lastSeenAt ? Date.parse(owner.lastSeenAt) : Date.parse(run.acceptedAt);
          if (!disconnected && now - seen > policy.masterTimeoutMs) {
            disconnected = true;
            emit(root, "master.disconnected", { runId, data: { lastSeenAt: owner?.lastSeenAt ?? null, policy: policy.onMasterDisconnect } });
            if (policy.onMasterDisconnect === "pause" && !run.stop) {
              run = updateRun(root, runId, (current) => { current.stop ??= { mode: "pause", requestedAt: new Date(now).toISOString(), reason: "master 연결이 끊겼습니다(정책 pause)", by: "supervisor", graceMs: policy.stopGraceMs }; });
              emit(root, "run.stop-requested", { runId, data: { mode: "pause", by: "supervisor", reason: "master-disconnected" } });
            }
          } else if (disconnected && now - seen <= policy.masterTimeoutMs) {
            disconnected = false;
            emit(root, "master.reconnected", { runId, data: { lastSeenAt: owner?.lastSeenAt ?? null } });
          }
        }
        if (!timedOut && now - startedAt > run.timeoutMs) {
          timedOut = true;
          run = updateRun(root, runId, (current) => { current.stop ??= { mode: "pause", requestedAt: new Date(now).toISOString(), reason: "실행 시간 상한", by: "supervisor", graceMs: Math.min(policy.stopGraceMs, 60_000) }; });
          emit(root, "run.stop-requested", { runId, data: { mode: run.stop?.mode, by: "supervisor", reason: "timeout" } });
        }
        if (run.stop && run.state !== "stopping") {
          run = updateRun(root, runId, (current) => { if (ACTIVE_RUN_STATES.includes(current.state)) { current.state = "stopping"; current.history.push({ at: new Date(now).toISOString(), state: "stopping", note: current.stop?.reason }); } });
        }
        if (run.stop && !forced && child?.pid && run.host) {
          const due = Date.parse(run.stop.requestedAt) + run.stop.graceMs;
          if (run.stop.forceRequested || now >= due) {
            const killed = killVerified(child.pid, run.host.marker);
            forced = true;
            run = updateRun(root, runId, (current) => { if (current.stop) current.stop.forcedAt = new Date().toISOString(); current.history.push({ at: new Date().toISOString(), state: "stopping", note: `강제 종료: ${killed.detail}` }); });
          }
        }
        if (now - lastProgress >= policy.progressMs) {
          lastProgress = now;
          try {
            const { view } = observeProgress(root, run);
            run = updateRun(root, runId, (current) => { current.progress = { at: new Date().toISOString(), stateVersion: view.stateVersion, phase: view.work?.phase, resume: view.resume.code }; });
          } catch { /* 관찰 실패는 다음 주기가 다시 본다 */ }
        }
        // 기록이 바뀌었을 수 있다(정지 요청) — 다음 주기를 위해 다시 읽는다
        run = readRun(root, runId) ?? run;
      } catch (error) {
        try { appendFileSync(runErrors(root, runId), `감독 주기 오류: ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* 기록 실패 */ }
      }
    };
    const timer = setInterval(tick, Math.max(100, Math.min(policy.heartbeatMs, policy.progressMs, 1000)));

    try {
      requireManagedHost(root, profile);
      const { command, args } = hostArgs(profile, run);
      child = spawn(command, args, { cwd: root, env: hostEnv(process.env, runId, profile.kind), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      finish(null, null);
      return;
    }
    child.on("error", (error) => { spawnError = error.message; finish(null, null); });
    if (child.pid) {
      run = updateRun(root, runId, (current) => {
        current.state = current.stop ? "stopping" : "running";
        current.host = { pid: child.pid!, startedAt: new Date().toISOString(), marker: profile.kind === "codex" ? runId : run.sessionId };
        current.history.push({ at: new Date().toISOString(), state: current.state, note: `호스트 pid ${child.pid}` });
      });
      emit(root, "run.started", { runId, commandId: run.commandId, data: { pid: child.pid, sessionId: run.sessionId, mode: run.mode } });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      out.write(chunk);
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line || sessionError || (profile.kind === "claude" && sessionSeen)) continue;
        try {
          const row = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string; thread_id?: string };
          if (profile.kind === "codex" && row.type === "thread.started") {
            if (!row.thread_id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.thread_id) || ((run.mode === "continue" || sessionSeen) && row.thread_id !== run.sessionId)) {
              sessionError = "Codex thread ID가 없거나 재개할 세션과 다릅니다";
              run = updateRun(root, runId, current => { current.stop = { mode: "pause", requestedAt: new Date().toISOString(), reason: sessionError!, by: "supervisor", graceMs: 0, forceRequested: true }; });
              tick();
            } else {
              sessionSeen = row.thread_id;
              run = updateRun(root, runId, current => { current.sessionId = row.thread_id!; current.sessionConfirmed = true; });
            }
          }
          if (profile.kind === "claude" && row.type === "system" && row.subtype === "init" && row.session_id) {
            sessionSeen = row.session_id;
            if (sessionSeen !== run.sessionId) appendFileSync(runErrors(root, runId), `호스트 세션 ID 가 다릅니다: 기대 ${run.sessionId}, 실제 ${sessionSeen}\n`);
          }
        } catch { /* stream-json 이 아닌 줄 */ }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { err.write(chunk); });
    child.on("close", (code, signal) => finish(code, signal));
    try {
      child.stdin?.end(readFileSync(runPrompt(root, runId), "utf8"));
    } catch (error) {
      err.write(`프롬프트를 넘기지 못했습니다: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    tick();
  });
}

/** 같은 표지로 호스트가 아직 살아 있는지 — 재조정이 쓴다 */
export function hostAlive(run: RunRecord): ReturnType<typeof liveness> {
  return run.host ? liveness(run.host.pid, run.host.marker) : "dead";
}
