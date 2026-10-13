#!/usr/bin/env node
/**
 * code-agent 진입점. hook 하위 명령은 도구 호출마다 새 프로세스로 돈다 — 명령 모듈 전체(cliMain)를 읽지 않고 그 hook 의 모듈만
 * 지연 로드한다. 모듈 로드(설치가 깨졌거나 소스 빌드 도중 dist 가 반쯤 바뀐 상태)·stdin 읽기 실패는 retryPolicy.hookFailureExit 표대로
 * 끝낸다: PreToolUse(hook)와 동의 질문·응답은 막고, Stop·SessionStart·SubagentStop·업무 질문·사용자 메시지는 막지 않는다.
 * 판정 함수의 예외는 각 run 함수가 같은 표대로 처리한다.
 *
 * 이 파일은 retryPolicy(순수 모듈)·stop 만 정적으로 읽는다. 둘을 읽지 못하면 Node 기동 단계의 exit 1(비차단)이다 — 남는 한계.
 */
import { readFileSync } from "fs";
import { hookFailureExit, hookFailureInput, type HookFailureInput } from "./retryPolicy";
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

/** stdin 읽기·모듈 로드에서 난 예외만 여기서 처리한다 — 공통 처리기(exit 2)로 보내면 Stop·SessionStart 가 막힌다 */
function runHookCommand(command: HookCommand): number {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf-8");
    return HOOKS[command]()(stdin);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = hookFailureExit(hookFailureInput(command, stdin), `hook 을 실행하지 못했습니다: ${message}`);
    process.stderr.write(`code-agent ${command}: hook 을 실행하지 못했습니다 — ${message}\n`);
    if (result.stdout) process.stdout.write(result.stdout);
    return result.code;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "choice-server") {
    if (args.length !== 2 || args[0] !== "--root") throw new Stop("choice-server --root <프로젝트> 형식으로 MCP 클라이언트가 실행합니다.");
    return (require("./choiceServer") as typeof import("./choiceServer")).runChoiceServer(args[1]);
  }
  if (command !== undefined && Object.prototype.hasOwnProperty.call(HOOKS, command)) return runHookCommand(command as HookCommand);
  return (require("./cliMain") as typeof import("./cliMain")).runCommand(command, args);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Stop ? 1 : 2;
  },
);
