/**
 * master 감독 시험용 가짜 호스트 — claude -p 대신 감독이 띄운다(모의 시험 전용, 실제 모델 실행이 아니다).
 * 프롬프트의 `MODE=<값>` 으로 동작을 고른다:
 *   complete  결과 줄을 내고 끝낸다(WRITE=<경로> 가 있으면 그 파일을 쓴다)
 *   loop      도구를 쓰기 전처럼 실제 hook(code-agent hook)을 주기마다 부르고, 거부되면 보고하고 끝낸다(협력 정지)
 *   hang      hook 을 보지 않고 끝나지 않는다(강제 종료 시험)
 *   fail      실패 결과로 끝난다
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const session = flag("--session-id") ?? flag("--resume") ?? "unknown";
const prompt = readFileSync(0, "utf8");
const mode = /MODE=(\w+)/.exec(prompt)?.[1] ?? "complete";
const line = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const result = (text: string, error = false): void => line({ type: "result", subtype: error ? "error_during_execution" : "success", is_error: error, result: text,
  session_id: session, num_turns: 1, duration_ms: 10, permission_denials: [] });

line({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), tools: ["Bash"] });
const cli = join(__dirname, "..", "agent", "cli.js");

function denied(): string | undefined {
  const input = { cwd: process.cwd(), session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "code-agent status" } };
  const run = spawnSync(process.execPath, [cli, "hook"], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() } });
  if (!run.stdout.trim()) return undefined;
  try { return (JSON.parse(run.stdout) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason; } catch { return undefined; }
}

if (mode === "complete") {
  const write = /WRITE=(\S+)/.exec(prompt)?.[1];
  if (write) { mkdirSync(dirname(join(process.cwd(), write)), { recursive: true }); writeFileSync(join(process.cwd(), write), `written by fake host ${session}\n`); }
  result("작업을 마쳤습니다(가짜 호스트)");
  process.exit(0);
} else if (mode === "fail") {
  result("실패(가짜 호스트)", true);
  process.exit(3);
} else if (mode === "hang") {
  setInterval(() => { /* 끝나지 않는다 */ }, 1000);
} else {
  const started = Date.now();
  const timer = setInterval(() => {
    const reason = denied();
    if (reason) {
      clearInterval(timer);
      result(`hook 이 도구를 막아 멈췄습니다: ${reason.slice(0, 80)}`);
      process.exit(0);
    }
    if (Date.now() - started > 60_000) { clearInterval(timer); result("시간이 지나 끝냈습니다"); process.exit(0); }
  }, 150);
}
