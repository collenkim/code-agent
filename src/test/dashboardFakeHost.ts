/** 감독·실제 CLI 왕복용 모의 호스트. 실제 모델·사람 응답을 흉내낸 검증이라고 명시한다. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd(), cli = join(__dirname, "../agent/cli.js");
const args = process.argv.slice(2), session = args[args.indexOf("--resume") + 1];
const prompt = readFileSync(0, "utf8"), id = /요청 ([a-f0-9-]{36})/.exec(prompt)![1];
function call(parts: string[]) {
  const hook = spawnSync(process.execPath, [cli, "hook"], { cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root, session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `code-agent ${parts.join(" ")}` } }), env: process.env });
  if (hook.status !== 0 || hook.stdout.includes('"deny"')) throw new Error(hook.stderr + hook.stdout);
  const result = spawnSync(process.execPath, [cli, ...parts], { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
const answer = call(["interaction", "consume", id]);
if (!answer.answers?.length) throw new Error("수신한 실제 답이 없습니다");
mkdirSync(join(root, "doc"), { recursive: true });
writeFileSync(join(root, "doc/interaction-result.json"), JSON.stringify({ summary: "모의 호스트가 같은 세션에서 답을 반영함" }));
call(["interaction", "complete", id, "doc/interaction-result.json"]);
writeFileSync(join(root, "doc/interaction-next.json"), JSON.stringify({ key: "after-response", stage: "document", title: "후속 질문", questions: [{ questionId: "next", title: "문서 설명", mode: "text", input: { required: true, minLength: 1, maxLength: 100, description: "설명" }, recommendationReason: "앞선 실제 답을 받은 뒤 필요한 설명" }] }));
call(["interaction", "publish", "doc/interaction-next.json"]);
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: session, result: "human-input: 후속 질문 대기(모의 호스트)", num_turns: 1, duration_ms: 10 }) + "\n");
