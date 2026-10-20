/** 모의 app-server. 권한 승인도 합성 시험 응답이며 실제 사람 승인·모델 실행이 아니다. */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
const prompt = readFileSync(join(process.cwd(), ".code-agent/master/runs", `${process.env.CODE_AGENT_MASTER_RUN}.prompt.md`), "utf8");
let session = randomUUID() as string;
const turnId = randomUUID();
const line = (row: unknown) => process.stdout.write(JSON.stringify(row) + "\n");
const notify = (method: string, params: object) => line({ method, params: { threadId: session, ...params } });
let timer: NodeJS.Timeout | undefined;
function finish(failed = false) {
  notify("item/completed", { turnId, item: { type: "agentMessage", id: "answer", text: "모의 Codex 결과" } });
  notify("turn/completed", { turn: { id: turnId, status: failed ? "failed" : "completed" } });
}
const input = createInterface({ input: process.stdin });
input.on("close", () => { if (timer) clearInterval(timer); });
input.on("line", text => {
  const row = JSON.parse(text), p = row.params;
  if (row.method === "initialize") line({ id: row.id, result: { userAgent: "fixture" } });
  if (row.method === "hooks/list") line({ id: row.id, result: { data: [{ cwd: process.cwd(), errors: [], hooks: [{ eventName: "preToolUse", handlerType: "command", enabled: true, async: false, trustStatus: prompt.includes("MODE=untrusted-hooks") ? "untrusted" : "trusted", sourcePath: join(process.cwd(), ".codex/hooks.json"), command: "code-agent codex-event" }] }] } });
  if (["thread/start", "thread/resume"].includes(row.method)) {
    if (p.threadId) session = p.threadId;
    if (prompt.includes("MODE=mismatch")) session = randomUUID();
    line({ id: row.id, result: { thread: prompt.includes("MODE=missing") ? {} : { id: session } } });
  }
  if (row.method === "turn/start") {
    line({ id: row.id, result: { turn: { id: turnId } } });
    notify("turn/started", { turn: { id: turnId } });
    if (prompt.includes("MODE=changed-thread")) { notify("thread/started", { thread: { id: randomUUID() } }); return; }
    if (prompt.includes("MODE=hang")) return;
    if (prompt.includes("MODE=permission")) {
      line({ id: 700, method: "item/commandExecution/requestApproval", params: { threadId: session, turnId, itemId: "git-start", kind: "command", cwd: process.cwd(), command: "code-agent start doc/work/WORK-0001/requirement.md", reason: ".git/index.lock: Permission denied" } });
      return;
    }
    if (prompt.includes("MODE=loop")) {
      timer = setInterval(() => {
        const result = spawnSync(process.execPath, [join(__dirname, "../agent/cli.js"), "codex-event"], {
          input: JSON.stringify({ cwd: process.cwd(), session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "code-agent status" } }), encoding: "utf8", windowsHide: true,
        });
        if (result.stdout.includes('"deny"')) { clearInterval(timer); finish(); }
      }, 200);
    } else finish(prompt.includes("MODE=fail"));
  }
  if (row.id === 700 && row.result) {
    writeFileSync(join(process.cwd(), ".code-agent", "fixture-permission.json"), JSON.stringify(row.result));
    if (row.result.decision === "accept") {
      const result = spawnSync("git", ["config", "--local", "code-agent.permissionFixture", "accepted"], { cwd: process.cwd(), windowsHide: true });
      notify("item/completed", { turnId, item: { type: "commandExecution", id: "git-start", status: "completed", exitCode: result.status } });
    }
    finish();
  }
});
