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
import { delimiter, isAbsolute, relative, sep } from "path";
import { canonical } from "../layout";
import { hostBaseEnv } from "../crossEnv";
import { hostLaunch } from "../hosts";
import { POWERSHELL_COMMAND_GUIDE } from "../hostText";
import { requireManagedHost } from "./hostProfile";
import { CodexTransport } from "./codexTransport";
import { acquireLock } from "../lock";
import { hideGitWindowInThisProcess, stateView } from "../stateView";
import { killVerified } from "./processes";
import { ACTIVE_RUN_STATES, type HostProfile, type Policy, type RunState } from "./protocol";
import { buildResult, readHostOutput } from "./result";
import { observeProgress } from "./observe";
import { CODEX_PERMISSION_FORM, MASTER_RUN_ENV } from "./runGuard";
import {
  emit, masterPath, readBinding, readOwner, readRun, RUN_LOCK, runErrors, runOutput, runPrompt, updateRun, type RunRecord,
} from "./store";

/** 실행 세션의 규칙 — 호스트의 시스템 프롬프트 뒤에 붙인다(SessionStart 의 masterRunNote 와 같은 뜻) */
export const MASTER_SYSTEM_RULES = [
  "이 세션은 code-agent master 실행이다. 사람이 이 대화를 보지 않는다.",
  "질문 도구로 사람에게 묻지 않는다. 동의가 필요하면 code-agent consent prepare 까지만 하고 동의 ID·요약을 보고한 뒤 턴을 끝낸다.",
  "설정·개발·복구·운영의 업무 질문은 code-agent interaction publish <질문.json>으로 저장하고 human-input 대기를 보고한 뒤 턴을 끝낸다. questions.md에 연결한 질문은 source:questions로 발행한다. 작업 ID가 없어도 질문할 수 있다. 답·추천 근거를 지어내지 않는다.",
  "승인·확정 기록을 만들거나 고치지 않는다. code-agent 명령은 code-agent 로 부른다(node 경로로 부르지 않는다).",
  "작업 재개는 code-agent flow advance --json 으로 한다. 반환한 procedure·instruction만 수행하고 결과 기록 뒤 같은 명령으로 돌아간다. kind:wait이면 반복 조회하지 않고 턴을 끝낸다.",
  "hook 이 도구를 막으며 정지를 알리면 도구를 더 쓰지 않고 한 일과 멈춘 자리를 보고한 뒤 끝낸다.",
].join("\n");

export function hostArgs(profile: HostProfile, run: Pick<RunRecord, "mode" | "sessionId"> & Partial<Pick<RunRecord, "runId">>): { command: string; args: string[] } {
  const resolved = hostLaunch(profile.kind, profile.command);
  if (typeof resolved === "string") throw new Error(resolved);
  const { file: command, prefix } = resolved;
  if (profile.kind === "codex") {
    const rules = `${MASTER_SYSTEM_RULES}\n${POWERSHELL_COMMAND_GUIDE}\nGit 쓰기가 필요한 code-agent start·verify·repro가 샌드박스 권한으로 실패하면 같은 명령의 단건 실행 권한을 호스트 셸 도구로 요청한다. ${CODEX_PERMISSION_FORM} 권한 응답은 감독이 사람에게 전달한다. 업무 동의를 권한 승인으로 대신하거나 직접 git 명령으로 우회하지 않는다.\n관리 실행 표지: ${run.runId ?? run.sessionId}`;
    return { command, args: [...prefix, "app-server", "--listen", "stdio://", "-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="user"', "-c", `sandbox_mode=${JSON.stringify(profile.sandbox)}`,
      "-c", "sandbox_workspace_write.network_access=false", "-c", `developer_instructions=${JSON.stringify(rules)}`,
      // 셸 명령(승인받은 단건 실행 포함)의 환경에도 현재 폴더 검색 끄기를 명시한다 — 사용자 설정의 shell_environment_policy 가 상속 변수를 줄여도 남는다
      ...(process.platform === "win32" ? ["-c", `shell_environment_policy.set.${NO_CWD_SEARCH}="1"`] : []),
      ...(profile.model ? ["-c", `model=${JSON.stringify(profile.model)}`] : [])] };
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

/** Windows 에서 cmd·npm 의 .cmd shim·node 의 자식 실행이 PATH 보다 현재 폴더를 먼저 찾지 않게 하는 변수 */
const NO_CWD_SEARCH = "NoDefaultCurrentDirectoryInExePath";

/**
 * 호스트 환경 — 부른 쪽 Claude·Codex 세션의 표지·통로를 지우고 실행 표지를 넣는다.
 * Codex는 PATH의 상대·저장소 안 항목을 지우고 Windows의 현재 폴더 검색도 끈다 — 승인받아 샌드박스 밖에서 도는
 * 명령(code-agent.cmd 가 찾는 node, code-agent 가 부르는 git 포함)이 모델이 저장소에 둔 같은 이름 파일로 바뀌지 않게 한다
 */
export function hostEnv(base: NodeJS.ProcessEnv, runId: string, kind: "claude" | "codex" = "claude", root?: string): NodeJS.ProcessEnv {
  const env = hostBaseEnv(base) as NodeJS.ProcessEnv;
  env[MASTER_RUN_ENV] = runId;
  env.CODE_AGENT_HOST = kind;
  if (kind === "codex") {
    if (process.platform === "win32") env[NO_CWD_SEARCH] = "1";
    const key = Object.keys(env).find(k => k.toUpperCase() === "PATH"), repo = root && canonical(root);
    if (key) env[key] = (env[key] ?? "").split(delimiter).filter(entry => {
      const dir = entry.trim().replace(/^"(.*)"$/, "$1");
      if (!dir || !isAbsolute(dir) || /^[\\/]{2}[.?]/.test(dir)) return false;
      const rel = repo ? relative(repo, canonical(dir)) : "..";
      return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    }).join(delimiter);
  }
  return env;
}

function finalState(run: RunRecord, host: { exitCode: number | null; isError?: boolean; subtype?: string; permissionDenials?: unknown[] }, resume: string, timedOut: boolean): { state: RunState; reason: string } {
  if (timedOut) return { state: "failed", reason: "실행 시간 상한을 넘었습니다" };
  if (run.stop) return { state: run.stop.mode === "cancel" ? "cancelled" : "paused", reason: run.stop.reason };
  if (host.exitCode !== 0 || host.isError) return { state: "failed", reason: `호스트가 실패로 끝났습니다(exit ${host.exitCode}, ${host.subtype ?? "결과 없음"})` };
  // 감독이 받지 않은 권한 요청은 사람의 거절과 구분해 그 사유(받는 꼴)를 남긴다
  const automatic = host.permissionDenials?.find((d): d is { automatic: true; reason?: string } => !!d && typeof d === "object" && (d as { automatic?: unknown }).automatic === true);
  if (automatic) return { state: "blocked", reason: `감독이 호스트 권한 요청을 받지 않았습니다: ${automatic.reason ?? "지원 범위 밖"}` };
  if (host.permissionDenials?.length) return { state: "blocked", reason: "호스트 실행 권한이 거절·취소되었습니다" };
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
    let codex: CodexTransport | undefined;

    const finish = async (exitCode: number | null, signal: string | null): Promise<void> => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      try {
        codex?.close();
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
        try { codex?.poll(); } catch (error) { failCodex(error instanceof Error ? error.message : String(error)); }
      } catch (error) {
        try { appendFileSync(runErrors(root, runId), `감독 주기 오류: ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* 기록 실패 */ }
      }
    };
    const timer = setInterval(tick, Math.max(100, Math.min(policy.heartbeatMs, policy.progressMs, 1000)));
    const failCodex = (message: string): void => {
      sessionError ??= message;
      if (!finished) run = updateRun(root, runId, current => { current.stop ??= { mode: "pause", requestedAt: new Date().toISOString(), reason: message, by: "supervisor", graceMs: 0, forceRequested: true }; });
    };

    try {
      // 설치만 본다 — Codex 의 프로젝트·hook 신뢰는 CodexTransport 가 실제로 쓸 app-server 에 같은 판정(classifyCodexReadiness)으로 묻는다
      requireManagedHost(root, profile, { codex: "static" });
      const { command, args } = hostArgs(profile, run);
      child = spawn(command, args, { cwd: root, env: hostEnv(process.env, runId, profile.kind, root), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
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
    const consumeOutput = (chunk: Buffer): void => {
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
    };
    if (profile.kind === "codex") codex = new CodexTransport(root, run, profile, child, row => consumeOutput(Buffer.from(JSON.stringify(row) + "\n")), failCodex);
    else child.stdout?.on("data", consumeOutput);
    child.stderr?.on("data", (chunk: Buffer) => { err.write(chunk); });
    child.on("close", (code, signal) => finish(code, signal));
    try {
      const prompt = readFileSync(runPrompt(root, runId), "utf8");
      if (codex) void codex.start(prompt); else child.stdin?.end(prompt);
    } catch (error) {
      err.write(`프롬프트를 넘기지 못했습니다: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    tick();
  });
}

