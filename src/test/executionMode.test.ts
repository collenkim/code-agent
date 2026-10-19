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

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ca-execution-")); roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root }); return root;
}
afterEach(() => { for (const root of roots.splice(0)) { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); assert.match(root, /ca-execution-/); rmSync(root, { recursive: true, force: true }); } });
test("공개 init은 옵션 없이 두 호스트와 MCP를 준비하고 실행 방식은 선택하지 않는다", () => {
  const root = fixture();
  const cli = resolve(__dirname, "../agent/cli.js");
  execFileSync(process.execPath, [cli, "init", "--cli", cli], { cwd: root });
  assert.deepEqual(selectedHosts(root), ["claude", "codex"]);
  for (const file of [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", "CLAUDE.md", "AGENTS.md"]) assert.ok(existsSync(join(root, file)), file);
  assert.equal(executionMode(root), "auto"); assert.equal(crossRequired(root), false);
  assert.match(readFileSync(join(root, ".codex/config.toml"), "utf8"), /code_agent/);
  execFileSync(process.execPath, [cli, "init", "--host", "claude", "--cli", cli], { cwd: root });
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
