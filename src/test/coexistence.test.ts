import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { aidlcBlock, aidlcWarning } from "../agent/aidlc";
import { pendingBaselineFiles } from "../agent/bootstrap";
import { codexHook } from "../agent/codexHook";
import { status } from "../agent/commands";
import { docsBegin } from "../agent/docsCommands";
import { doctor } from "../agent/doctor";
import { decide } from "../agent/hook";
import { init } from "../agent/init";
import { requestBegin } from "../agent/request";
import { gitFixture, setupConsentProject } from "./consentFixture";

let root: string;
const SPACE = "aidlc/spaces/default/intents";
function write(file: string, text: string): void { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
function intent(record: string, state: string, registry?: string): void {
  write(`${SPACE}/${record}/aidlc-state.md`, `# 상태\n- **Status**: ${state}\n`);
  if (registry) write(`${SPACE}/intents.json`, JSON.stringify([{ uuid: "u", slug: record, dirName: record, status: registry }]));
}
function aidlcHooks(): void {
  const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  settings.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: "bun .claude/hooks/aidlc-record-human-turn.ts" }] }];
  write(".claude/settings.json", JSON.stringify(settings, null, 2));
}
const shell = (tool: string, command: string) => decide({ cwd: root, session_id: "s", tool_name: tool, tool_input: { command } });

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-coexist-")));
  setupConsentProject(root);
  init(root, { host: "both" });
});
afterEach(() => {
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-coexist-"));
  rmSync(target, { recursive: true, force: true });
});

test("AI-DLC 의도가 진행 중이면 접수·문서 준비를 막고, 끝나면 연다", () => {
  intent("orders-1a2b3c4d", "Running", "in-flight");
  assert.match(aidlcBlock(root)!, /진행 중인 AWS AI-DLC.*\n.*orders-1a2b3c4d \(in-flight\)/);
  assert.throws(() => requestBegin(root, "CO-1", "feature"), /AWS AI-DLC/);
  assert.throws(() => docsBegin(root), /AWS AI-DLC/);
  assert.match(status(root), /진행 중인 AWS AI-DLC/);
  intent("orders-1a2b3c4d", "Completed", "complete");
  assert.equal(aidlcBlock(root), undefined);
  assert.match(requestBegin(root, "CO-1", "feature"), /접수를 열었습니다/);
});

test("레지스트리가 없으면 상태 파일, 작업 공간 이전 배치(aidlc-docs)도 진행 중으로 본다", () => {
  write("aidlc-docs/aidlc-state.md", "**Status**: Running\n");
  assert.match(aidlcBlock(root)!, /aidlc-docs/);
  write("aidlc-docs/aidlc-state.md", "**Status**: Completed\n");
  intent("pay-11112222", "Running");
  assert.match(aidlcBlock(root)!, /pay-11112222 \(Running\)/);
});

test("끝난 의도라도 AI-DLC 훅이 기록할 수 있으면 막지 않고 경고만 한다", () => {
  intent("orders-1a2b3c4d", "Completed", "complete");
  assert.equal(aidlcWarning(root), undefined, "훅이 없으면 경고하지 않는다");
  aidlcHooks();
  assert.match(aidlcWarning(root)!, /경고: AWS AI-DLC 훅.*orders-1a2b3c4d/);
  assert.match(status(root), /경고: AWS AI-DLC/);
  assert.match(doctor(root).text, /· AWS AI-DLC: 경고/);
  assert.doesNotMatch(doctor(root).text, /✗ AWS AI-DLC/, "경고는 doctor 실패로 세지 않는다");
  assert.match(requestBegin(root, "CO-2", "feature"), /경고: AWS AI-DLC/);
  intent("orders-1a2b3c4d", "Archived", "archived");
  assert.equal(aidlcWarning(root), undefined, "보관된 의도는 커서 없이 해석되지 않는다");
  write(`${SPACE}/active-intent`, "orders-1a2b3c4d\n");
  assert.match(aidlcWarning(root)!, /active-intent/, "커서가 가리키면 보관돼도 기록 대상이다");
});

test("code-agent 세션 중에는 AI-DLC 명령을 분명한 사유로 거부한다", () => {
  requestBegin(root, "CO-3", "feature");
  assert.match(shell("Bash", "bun .claude/tools/aidlc-run.ts start")!, /AWS AI-DLC 를 실행하지 않습니다/);
  assert.match(shell("Bash", "aidlc intent create x")!, /AWS AI-DLC/);
});

test("H5: PowerShell 은 따옴표 밖 괄호·@·$·중괄호와 CR 을 거부하고, 작은따옴표 안은 글자로 둔다", () => {
  requestBegin(root, "CO-4", "feature");
  for (const command of ["git status (New-Item x.txt)", "git status @(Remove-Item src)", "git log {Remove-Item src}", "git status $env:X", 'git status "$(Remove-Item src)"'])
    assert.match(shell("PowerShell", command)!, /PowerShell 에서는/, command);
  assert.match(shell("PowerShell", "git status\rRemove-Item src")!, /줄바꿈/);
  assert.match(shell("Bash", "git status\rrm -rf src")!, /줄바꿈/);
  assert.equal(shell("PowerShell", "git status 'docs (old)/a.md'"), undefined);
  assert.equal(shell("Bash", "git status (x)"), undefined, "Bash 에서 괄호 인자는 실행되지 않는다");
  const codex = codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status (New-Item x.txt)" } });
  assert.equal(JSON.stringify(codex) !== "{}", process.platform === "win32", "Windows 의 Codex 셸은 PowerShell 규칙을 쓴다");
});

test("준비 커밋은 code-agent 가 만든 파일만 담고 다른 도구·사용자 파일은 건드리지 않는다", () => {
  write("README.md", "# 기존\n");
  gitFixture(root, "add", "README.md"); gitFixture(root, "commit", "-qm", "existing");
  write("README.md", "# 고치는 중\n");
  for (const file of [".claude/agents/aidlc-planner-agent.md", ".claude/tools/aidlc-run.ts", ".claude/skills/aidlc/SKILL.md", ".codex/agents/aidlc-x.toml", "doc/raw/source.html"]) write(file, "foreign\n");
  write(".gitignore", `${readFileSync(join(root, ".gitignore"), "utf8")}\n.claude/tools/\ndoc/raw/\n`);
  const pending = pendingBaselineFiles(root);
  for (const foreign of ["README.md", ".claude/agents/aidlc-planner-agent.md", ".claude/tools/aidlc-run.ts", ".claude/skills/aidlc/SKILL.md", ".codex/agents/aidlc-x.toml", "doc/raw/source.html"])
    assert.ok(!pending.includes(foreign), foreign);
  for (const own of ["code-agent.json", ".claude/settings.json", ".claude/skills/ca-plan/SKILL.md", ".agents/skills/ca-plan/criteria.md", ".codex/agents/ca-analyst.toml", "doc/architecture.md"])
    assert.ok(pending.includes(own), own);
});

test("교차 검증 명령은 호스트마다 상대 호스트를 가리킨다", async () => {
  const { hostAssets } = await import("../agent/hosts");
  const claude = readFileSync(join(root, ".claude/skills/ca-review/SKILL.md"), "utf8"), codex = hostAssets("codex").get(".agents/skills/ca-review/SKILL.md")!;
  assert.match(claude, /review cross --by codex/);
  assert.match(codex, /review cross --by claude/);
  assert.match(hostAssets("codex").get(".agents/skills/ca-plan/SKILL.md")!, /planning cross --by claude/);
});
