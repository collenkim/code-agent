import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { initialize, init } from "../agent/init";
import { execution } from "../agent/executionCommands";
import { executionMode } from "../agent/executionMode";
import { crossEnabled, selectedHosts } from "../agent/hosts";
import { crossRequired } from "../agent/review";
import { decide as decideTool } from "../agent/hook";
import { withInteraction } from "../agent/tty";
import { CODEX_MARKERS } from "../agent/crossEnv";
import { saveActive, type ActiveWork } from "../agent/layout";
import { readWorkBinding, writeRunRecord, writeWorkBinding, type RunRecord } from "../agent/master/store";
import { managedExecution } from "../agent/master/workExecution";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ca-execution-")); roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root }); return root;
}
afterEach(() => { for (const root of roots.splice(0)) { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); assert.match(root, /ca-execution-/); rmSync(root, { recursive: true, force: true }); } });
test("공개 init은 옵션 없이 두 호스트와 MCP를 준비하고 실행 방식은 선택하지 않는다", () => {
  const root = fixture();
  const cli = resolve(__dirname, "../agent/cli.js");
  // CLI init 은 Codex 준비를 묻는다 — 실제 Codex·사용자 CODEX_HOME 대신 모의 app-server 와 임시 홈으로
  const home = mkdtempSync(join(tmpdir(), "ca-execution-home-")); roots.push(home);
  const env = { ...process.env, CODEX_HOME: join(home, "codex"), CODE_AGENT_HOME: join(home, "code-agent"), CODE_AGENT_CODEX_BIN: join(__dirname, "masterCodexFakeHost.js") };
  execFileSync(process.execPath, [cli, "init", "--cli", cli], { cwd: root, env });
  assert.deepEqual(selectedHosts(root), ["claude", "codex"]);
  for (const file of [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", "CLAUDE.md", "AGENTS.md"]) assert.ok(existsSync(join(root, file)), file);
  assert.equal(executionMode(root), "auto"); assert.equal(crossRequired(root), false);
  assert.match(readFileSync(join(root, ".codex/config.toml"), "utf8"), /code_agent/);
  execFileSync(process.execPath, [cli, "init", "--host", "claude", "--cli", cli], { cwd: root, env });
  assert.equal(selectedHosts(root).length, 2);
});
test("세 실행 경로와 재설치가 같은 설정을 보존하고 모델은 교차 검증을 끄지 못한다", () => {
  const root = fixture(); initialize(root);
  const saved = { ...process.env };
  try {
    delete process.env.CLAUDECODE; for (const key of CODEX_MARKERS) delete process.env[key];
    for (const mode of ["claude", "codex", "both"]) {
      withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "fixture" }), ask: () => "" }, () => execution(root, mode));
      assert.equal(executionMode(root), mode); assert.equal(crossEnabled(root), mode === "both");
      assert.equal(crossRequired(root), mode === "both"); initialize(root); assert.equal(executionMode(root), mode);
    }
    process.env.CLAUDECODE = "1";
    assert.throws(() => execution(root, "claude"), /호스트 밖 터미널/);
  } finally { process.env = saved; }
});
test("기존 both 설치의 교차 의무를 유지하고 잘못된 정책은 닫힌다", () => {
  const root = fixture(); init(root, { host: "both" });
  assert.equal(crossRequired(root), true); initialize(root); assert.equal(executionMode(root), "both");
  writeFileSync(join(root, ".code-agent/execution.json"), JSON.stringify({ version: 1, mode: "invalid" }));
  assert.throws(() => initialize(root), /실행 방식 기록/);
  assert.throws(() => crossRequired(root), /실행 방식 기록/);
});
test("선택하지 않은 호스트의 쓰기를 막고 상태 조회는 허용한다", () => {
  const root = fixture(); initialize(root);
  writeFileSync(join(root, ".code-agent/execution.json"), JSON.stringify({ version: 1, mode: "claude" }));
  const base = { cwd: root, session_id: "session", host: "codex" as const };
  assert.match(decideTool({ ...base, tool_name: "Write", tool_input: { file_path: join(root, "product.ts"), content: "x" } })!, /claude 단독/);
  assert.equal(decideTool({ ...base, tool_name: "Bash", tool_input: { command: "code-agent execution" } }), undefined);
});
test("master 가 고른 실행 방식이 그 실행·작업의 교차 검증과 단독 호스트 판정을 정하고 프로젝트 실행 방식은 그대로다", () => {
  const root = fixture(); initialize(root);
  const saved = { ...process.env };
  const run = (execution: RunRecord["execution"]) => writeRunRecord(root, { version: 1, runId: "run-chosen", commandId: "c", controller: "m", generation: 1, mode: "start", links: {},
    state: "running", acceptedAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", sessionId: "s", promptHash: "h", timeoutMs: 1000, workId: null, baseHead: null,
    baseStateVersion: "v", history: [], ...(execution ? { execution } : {}) });
  const write = (host: "claude" | "codex") => decideTool({ cwd: root, session_id: "s", host, tool_name: "Write", tool_input: { file_path: join(root, "product.ts"), content: "x" } });
  try {
    delete process.env.CLAUDECODE; for (const key of CODEX_MARKERS) delete process.env[key];
    assert.equal(executionMode(root), "auto"); assert.equal(crossEnabled(root), false);
    // 작업을 열기 전 — 이 세션의 master 실행이 받은 선택
    process.env.CODE_AGENT_MASTER_RUN = "run-chosen";
    run({ mode: "both", main: "codex" });
    assert.deepEqual(managedExecution(root), { mode: "both", main: "codex" }); assert.equal(crossEnabled(root), true); assert.equal(crossRequired(root), true);
    run({ mode: "claude" });
    assert.equal(crossEnabled(root), false);
    assert.match(write("codex")!, /master 요청에서 고른 실행 방식\(claude 단독\)/); assert.doesNotMatch(write("claude") ?? "", /단독/);
    // 작업이 열리면 작업에 고정한 선택이 정본이다 — 실행 표지가 없는 세션(사람·제어 프로세스)도 같은 판정을 본다
    delete process.env.CODE_AGENT_MASTER_RUN;
    saveActive(root, { id: "W-1", spec: "doc/W-1.md", target: "all" } as ActiveWork);
    assert.equal(managedExecution(root), undefined);
    writeWorkBinding(root, { workId: "W-1", links: {}, boundAt: "2026-10-21T00:00:00Z", runId: "run-chosen", controller: "m", runs: ["run-chosen"], execution: { mode: "both", main: "claude" } });
    assert.equal(crossEnabled(root), true); assert.doesNotMatch(write("codex") ?? "", /단독/);
    assert.match(withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "fixture" }), ask: () => "" }, () => execution(root)), /master 요청에서 고른 실행 방식을 따릅니다: both · 주 호스트 claude/);
    writeWorkBinding(root, { ...readWorkBinding(root, "W-1")!, execution: undefined });
    assert.equal(crossEnabled(root), false); assert.doesNotMatch(write("codex") ?? "", /단독/);
    assert.equal(executionMode(root), "auto");
  } finally { process.env = saved; }
});
