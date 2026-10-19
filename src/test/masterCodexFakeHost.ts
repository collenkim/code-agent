/** 모의 Codex JSONL 호스트. 실제 모델·인증·승인을 사용하지 않는다. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2), at = args.indexOf("resume");
const prompt = readFileSync(0, "utf8");
const session = prompt.includes("MODE=mismatch") ? randomUUID() : at >= 0 ? args[at + 1] : randomUUID();
const line = (row: unknown) => process.stdout.write(JSON.stringify(row) + "\n");
if (!prompt.includes("MODE=missing")) line({ type: "thread.started", thread_id: session });
if (prompt.includes("MODE=changed-thread")) line({ type: "thread.started", thread_id: randomUUID() });
function finish(failed = false) {
  line({ type: "item.completed", item: { type: "agent_message", text: "모의 Codex 결과" } });
  line(failed ? { type: "turn.failed", error: { message: "모의 실패" } } : { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}
if (prompt.includes("MODE=hang")) setInterval(() => {}, 1000);
else if (prompt.includes("MODE=loop")) {
  const timer = setInterval(() => {
    const result = spawnSync(process.execPath, [join(__dirname, "../agent/cli.js"), "codex-event"], {
      input: JSON.stringify({ cwd: process.cwd(), session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "code-agent status" } }),
      encoding: "utf8", windowsHide: true,
    });
    if (result.stdout.includes('"deny"')) { clearInterval(timer); finish(); }
  }, 200);
} else finish(prompt.includes("MODE=fail"));
