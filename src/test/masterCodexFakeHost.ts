/**
 * 모의 app-server. 권한 승인도 합성 시험 응답이며 실제 사람 승인·모델 실행이 아니다.
 * 준비 조회(config/read·hooks/list)는 실제 Codex 처럼 CODEX_HOME/config.toml 로 답한다 — `trust_level = "trusted"` 가 있으면 프로젝트를
 * 신뢰하고, `trusted_hash` 가 있으면 hook 을 신뢰한다(`trusted_hash = "modified"` 면 바뀜). 신뢰하지 않으면 hook 을 돌려주지 않는다.
 * `# fixture: config-error` 는 config/read 를 RPC 오류로 답한다. 실행(CODE_AGENT_MASTER_RUN)의 프롬프트 MODE 가 그 실행만 바꾼다.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
const prompt = process.env.CODE_AGENT_MASTER_RUN ? readFileSync(join(process.cwd(), ".code-agent/master/runs", `${process.env.CODE_AGENT_MASTER_RUN}.prompt.md`), "utf8") : "";
const configFile = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml");
const config = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
const projectTrusted = /trust_level\s*=\s*"trusted"/.test(config);
const hookStatus = prompt.includes("MODE=untrusted-hooks") || !/trusted_hash/.test(config) ? "untrusted" : /trusted_hash\s*=\s*"modified"/.test(config) ? "modified" : "trusted";
const EVENTS = ["preToolUse", "userPromptSubmit", "subagentStart", "subagentStop", "stop", "sessionStart"];
const hooksOf = () => EVENTS.map((eventName) => ({ eventName, handlerType: "command", enabled: true, async: false, trustStatus: hookStatus,
  sourcePath: join(process.cwd(), ".codex", "hooks.json"), command: ["code-agent", ["codex", "event"].join("-")].join(" ") }));
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
  if (row.method === "config/read") {
    if (config.includes("# fixture: config-error")) { line({ id: row.id, error: { code: -32603, message: "internal error" } }); return; }
    line({ id: row.id, result: { config: {}, origins: {}, layers: [
      { name: { type: "project", dotCodexFolder: join(process.cwd(), ".codex") }, version: "fixture", config: {},
        ...(projectTrusted ? {} : { disabledReason: `To load project-local config, hooks, and exec policies, add ${process.cwd()} as a trusted project in ${configFile}.` }) },
      { name: { type: "user", file: configFile, profile: null }, version: "fixture", config: {} }] } });
  }
  if (row.method === "hooks/list") line({ id: row.id, result: { data: [{ cwd: process.cwd(), warnings: [], errors: [], hooks: projectTrusted ? hooksOf() : [] }] } });
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
      // MODE=permission-unsupported 는 감독이 받지 않는 복합 명령을 요청한다
      const command = prompt.includes("MODE=permission-unsupported") ? 'cmd.exe /c "code-agent start doc/work/WORK-0001/requirement.md & whoami"' : "code-agent start doc/work/WORK-0001/requirement.md";
      line({ id: 700, method: "item/commandExecution/requestApproval", params: { threadId: session, turnId, itemId: "git-start", kind: "command", cwd: process.cwd(), command, reason:".git/index.lock: Permission denied" } });
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
