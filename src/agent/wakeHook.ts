/**
 * 쉬는 메인 깨우기 — Claude `wake-event`(SubagentStop, 설치 항목에 `asyncRewake: true`). Claude Code 의 asyncRewake hook 은 백그라운드로 돌고
 * exit 2 로 끝나면 그 출력을 다음 메시지로 넣어 쉬는 메인의 새 턴을 연다(2.1.312 — 바이너리의 실행 경로, SDK 스트리밍 입력에서 실측).
 *
 * 메인이 담당 완료 전에 턴을 끝냈는데(완료 알림을 기다린다) 완료 알림이 새 턴을 열지 않으면 Stop hook 도 다시 돌지 않아 흐름이 사람 입력까지
 * 멈춘다 — 그 자리를 닫는다. 판정은 Stop 의 이어가기(stopHook.wakeReason)와 같고, 상기는 완료마다 세션당 한 번이다(hookLog.nudgedBefore).
 * 1. 대화형 CLI(`CLAUDE_CODE_ENTRYPOINT=cli`)이고, 메인 대화 기록의 호스트 버전이 WAKE.minVersion 이상이고, 설치 항목에 asyncRewake 가 있을 때만
 *    기다린다. 그 밖(`-p`·관리 실행·모르는 버전)에서는 이 hook 이 동기로 돌 수 있고 동기 SubagentStop 의 exit 2 는 담당 되돌림이라 바로 0 으로 끝낸다.
 * 2. 담당 hook 이 이 담당의 완료를 장부에 남길 때까지 WAKE.recordMs 기다린다 — 되돌림·늦은 결과·중복이면 완료가 남지 않아 끝낸다.
 * 3. 완료 뒤 WAKE.graceMs 동안 메인이 처리(진행 명령·새 담당)하거나 다른 담당이 돌면 끝낸다. 완료 뒤 메인의 턴 끝(Stop)이 기록됐으면
 *    Stop 이 이미 판정했으므로 끝낸다.
 * 4. 그래도 남았으면 이어가기 사유(사람 판단 자리·이미 한 상기는 빼고)를 stderr 로 내고 exit 2 — 호스트가 메인을 깨운다. 같은 완료(eventId)는
 *    장부 잠금 안에서 한 hook 만 잡는다(agentRuns.claimWake) — 되돌림 뒤 곧 끝난 같은 담당의 hook 둘이 함께 깨우지 않는다.
 * 실패는 삼키고 0 으로 끝낸다(cli.ts hookFailureExit 표도 0).
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "fs";
import { join } from "path";
import { findRepoRoot, STATE_DIR } from "./layout";
import { crossChild } from "./crossEnv";
import { claimWake, pendingCompletion } from "./agentRuns";
import { noteHookOutput } from "./hookLog";
import { withNotation } from "./hostText";
import { wakeReason } from "./stopHook";
import { readTimeline, recordEvent } from "./timeline";
import { loadWork } from "./work";

export const WAKE = {
  /** asyncRewake 가 백그라운드로 도는 것을 바이너리와 실행으로 확인한 호스트 버전 */
  minVersion: "2.1.312",
  /** 담당 hook 이 완료를 장부에 남기기를 기다리는 시간 */
  recordMs: 15_000,
  /** 완료 뒤 메인이 처리하기를 기다리는 시간 — 실측 완료 → 다음 명령은 수 초다 */
  graceMs: 60_000,
  pollMs: 1_000,
  /** 설치 항목의 timeout(초) — recordMs + graceMs 보다 길다 */
  timeoutSec: 120,
} as const;

export interface WakeHookInput { cwd?: string; hook_event_name?: string; session_id?: string; agent_id?: string; agent_type?: string; transcript_path?: string }
export interface WakeOptions { recordMs?: number; graceMs?: number; pollMs?: number; env?: NodeJS.ProcessEnv }

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** 메인 대화 기록 끝부분의 호스트 버전(줄마다 `"version"`이 있다) — 읽지 못하면 undefined */
export function transcriptVersion(path: string | undefined): string | undefined {
  if (!path) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size, length = Math.min(size, 256 * 1024), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const found = [...buffer.toString("utf8").matchAll(/"version":"(\d+\.\d+\.\d+)"/g)];
    return found.at(-1)?.[1];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const [a, b] = [version, minimum].map((value) => value.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return true;
}

/** 깨울 사유 — 깨우지 않으면 undefined. 시간 값은 시험이 줄인다 */
export function wakeMain(input: WakeHookInput, projectDir?: string, options: WakeOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  if (env.CLAUDE_CODE_ENTRYPOINT !== "cli" || !input.agent_id || !input.session_id) return undefined;
  const version = transcriptVersion(input.transcript_path);
  if (!version || !versionAtLeast(version, WAKE.minVersion)) return undefined;
  const root = findRepoRoot(projectDir ?? input.cwd ?? process.cwd());
  if (!existsSync(join(root, STATE_DIR))) return undefined;
  // 설치 항목의 asyncRewake 를 손으로 지웠으면 동기로 돌 수 있다(doctor 도 같은 판정으로 알린다)
  if (!(require("./init") as typeof import("./init")).wakeHookAsync(root)) return undefined;
  const work = loadWork(root);
  if (!work) return undefined;
  const workId = work.active.id, pollMs = options.pollMs ?? WAKE.pollMs;
  // 2. 이 담당의 완료가 장부에 남기를 기다린다
  let eventId: string | undefined, finishedAt = 0;
  for (const until = Date.now() + (options.recordMs ?? WAKE.recordMs); ; sleep(pollMs)) {
    const pending = pendingCompletion(root, workId);
    if (pending?.completion.agent === input.agent_id) { eventId = pending.completion.eventId; finishedAt = Date.parse(pending.completion.at); break; }
    if (Date.now() >= until) return undefined;
  }
  // 3. 메인이 처리하거나 다른 담당이 돌면 끝낸다
  for (const until = finishedAt + (options.graceMs ?? WAKE.graceMs); ; sleep(pollMs)) {
    const pending = pendingCompletion(root, workId);
    if (!pending || pending.completion.eventId !== eventId || pending.running > 0) return undefined;
    if (Date.now() >= until) break;
  }
  const stopped = readTimeline(root).some((event) => event.type === "host.stopped" && event.session === input.session_id && Date.parse(event.at) >= finishedAt);
  if (stopped) return undefined;
  // 4. Stop 의 이어가기와 같은 판정 — 사람 판단 자리이거나 같은 사유로 이미 상기했으면 깨우지 않는다. 같은 완료는 한 hook 만 깨운다
  const reason = wakeReason({ cwd: root, session_id: input.session_id }, root);
  return reason && claimWake(root, workId, eventId!) ? reason : undefined;
}

export function runWakeHook(stdin: string): number {
  // 교차 실행이 띄운 다른 호스트 안에서는 깨우지 않는다
  if (crossChild()) return 0;
  try {
    const input = JSON.parse(stdin) as WakeHookInput;
    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    const reason = withNotation("claude", () => wakeMain(input, projectDir));
    if (!reason) return 0;
    const root = findRepoRoot(projectDir ?? input.cwd ?? process.cwd());
    noteHookOutput(root, { host: "claude", event: "SubagentStop", kind: "wake", text: reason, ...(input.agent_type ? { tool: input.agent_type } : {}),
      ...(input.session_id ? { session: input.session_id } : {}), ...(input.agent_id ? { agent: input.agent_id } : {}) });
    recordEvent(root, { type: "host.woken", host: "claude", ...(input.session_id ? { session: input.session_id } : {}), ...(input.agent_id ? { agent: input.agent_id } : {}),
      reason: `깨움: ${reason.split("\n")[0]}` });
    process.stderr.write(reason);
    return 2;
  } catch (error) {
    process.stderr.write(`code-agent wake-event: ${error instanceof Error ? error.message : error} (메인을 깨우지 않았습니다)\n`);
    return 0;
  }
}
