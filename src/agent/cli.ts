#!/usr/bin/env node
/**
 * code-agent 진입점. hook 하위 명령은 도구 호출마다 새 프로세스로 돈다 — 명령 모듈 전체(cliMain)를 읽지 않고 그 hook 의 모듈만
 * 지연 로드한다. 모듈 로드(설치가 깨졌거나 소스 빌드 도중 dist 가 반쯤 바뀐 상태)·stdin 읽기 실패는 retryPolicy.hookFailureExit 표대로
 * 끝낸다: PreToolUse(hook)와 동의 질문·응답은 막고, Stop·SessionStart·SubagentStop·업무 질문·사용자 메시지는 막지 않는다.
 * 판정 함수의 예외는 각 run 함수가 같은 표대로 처리한다.
 *
 * 무엇보다 먼저 이 프로젝트가 적용한 릴리스를 고른다(runtimeSelect.ts) — 다르면 그 릴리스의 cli.js 로 같은 프로세스에서 넘기고
 * 여기서는 아무것도 하지 않는다. 적용 버전이 없어졌는데 진행 중인 일이 있으면 다른 버전으로 이어 가지 않는다.
 *
 * 이 파일은 retryPolicy(순수 모듈)·stop·runtimeSelect(fs·path·layout)만 정적으로 읽는다. 셋을 읽지 못하면 Node 기동 단계의 exit 1(비차단)이다 — 남는 한계.
 */
import { appendFileSync, readFileSync } from "fs";
import { hookFailureExit, hookFailureInput, type HookFailureInput } from "./retryPolicy";
import { busyMarker, handoff, ownRelease, RUNTIME_KEY, selectRuntime, type RuntimeChoice } from "./runtimeSelect";
import { Stop } from "./stop";

type HookCommand = HookFailureInput["command"];
type HookRunner = (stdin: string) => number;
/** hook 하위 명령 — 새 하위 명령은 여기에 지연 로드로 더하고 hookFailureExit 표에도 더한다 */
const HOOKS: Record<HookCommand, () => HookRunner> = {
  "codex-event": () => (require("./codexHook") as typeof import("./codexHook")).runCodexHook,
  hook: () => (require("./hook") as typeof import("./hook")).runHook,
  stop: () => (require("./stopHook") as typeof import("./stopHook")).runStopHook,
  "review-event": () => (require("./reviewHook") as typeof import("./reviewHook")).runReviewHook,
  "planning-event": () => (require("./planningHook") as typeof import("./planningHook")).runPlanningHook,
  "consent-event": () => (require("./consent") as typeof import("./consent")).runConsentHook,
  "session-event": () => (require("./sessionHook") as typeof import("./sessionHook")).runSessionHook,
};
/** 적용 버전을 쓸 수 없을 때도 이 진입점의 번들로 돌리는 명령 — 상태를 보거나 버전을 고치는 자리다 */
const RECOVERY = new Set([undefined, "help", "--help", "-h", "status", "doctor", "version", "update", "abort"]);

/** stdin 읽기·모듈 로드에서 난 예외만 여기서 처리한다 — 공통 처리기(exit 2)로 보내면 Stop·SessionStart 가 막힌다 */
function runHookCommand(command: HookCommand, read: () => string): number {
  let stdin = "";
  try {
    stdin = read();
    return HOOKS[command]()(stdin);
  } catch (error) {
    return hookFailed(command, stdin, error instanceof Error ? error.message : String(error));
  }
}

function hookFailed(command: HookCommand, stdin: string, message: string): number {
  const result = hookFailureExit(hookFailureInput(command, stdin), `hook 을 실행하지 못했습니다: ${message}`);
  process.stderr.write(`code-agent ${command}: hook 을 실행하지 못했습니다 — ${message}\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  return result.code;
}

async function main(argv: string[], stdin: string | undefined): Promise<number> {
  const [command, ...args] = argv;
  // 실행 기록(선택) — 어느 버전이 이 명령을 실제로 돌렸는지. 버전 전환을 실행 결과로 확인할 때만 켠다
  const trace = process.env.CODE_AGENT_RUNTIME_TRACE;
  if (trace) {
    try { appendFileSync(trace, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, command: command ?? null, runtime: ownRelease()?.id ?? "bundle", file: __filename })}\n`); }
    catch { /* 기록은 확인용이다 — 명령을 막지 않는다 */ }
  }
  if (command === "choice-server") {
    if (args.length !== 2 || args[0] !== "--root") throw new Stop("choice-server --root <프로젝트> 형식으로 MCP 클라이언트가 실행합니다.");
    return (require("./choiceServer") as typeof import("./choiceServer")).runChoiceServer(args[1]);
  }
  if (command !== undefined && Object.prototype.hasOwnProperty.call(HOOKS, command)) {
    return runHookCommand(command as HookCommand, () => stdin ?? readFileSync(0, "utf-8"));
  }
  return (require("./cliMain") as typeof import("./cliMain")).runCommand(command, args);
}

function finish(run: Promise<number>): void {
  run.then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = error instanceof Stop ? 1 : 2;
    },
  );
}

function entry(argv: string[]): void {
  const [command, ...args] = argv;
  const hook = command !== undefined && Object.prototype.hasOwnProperty.call(HOOKS, command);
  const given = handoff();
  if (given) return finish(main(argv, given.stdin));
  let choice: RuntimeChoice;
  try {
    choice = selectRuntime(command, args, hook, () => readFileSync(0, "utf-8"));
  } catch (error) {
    // stdin 을 읽지 못한 hook — 예전과 같은 실패 경로
    if (hook) { process.exitCode = hookFailed(command as HookCommand, "", error instanceof Error ? error.message : String(error)); return; }
    throw error;
  }
  if (choice.kind === "delegate") {
    (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = { id: choice.id, ...(choice.stdin !== undefined ? { stdin: choice.stdin } : {}) };
    try {
      require(choice.cli);
      return;
    } catch (error) {
      // 적용 릴리스를 읽지 못했다 — 다른 버전으로 이어 가지 않는다(아래 unavailable 과 같은 처리)
      delete (globalThis as Record<symbol, unknown>)[RUNTIME_KEY];
      const reason = `이 프로젝트에 적용한 code-agent ${choice.id} 를 읽지 못했습니다(${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
      choice = busyMarker(choice.root) ? { kind: "unavailable", id: choice.id, root: choice.root, stdin: choice.stdin, reason }
        : { kind: "self", root: choice.root, stdin: choice.stdin };
    }
  }
  if (choice.kind === "unavailable") {
    const fix = "사람이 code-agent version 으로 확인하고 code-agent update 로 다시 설치하세요.";
    if (hook) { process.exitCode = hookFailed(command as HookCommand, choice.stdin ?? "", `${choice.reason} — 다른 버전으로 대신 판정하지 않습니다. ${fix}`); return; }
    if (!RECOVERY.has(command)) { process.stderr.write(`${choice.reason} — 진행 중인 일이 있어 다른 버전으로 이어 가지 않습니다. ${fix}\n`); process.exitCode = 1; return; }
    process.stderr.write(`경고: ${choice.reason} — 상태 확인·복구 명령만 이 진입점의 번들로 실행합니다.\n`);
  }
  finish(main(argv, choice.stdin));
}

entry(process.argv.slice(2));
