import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { codexHook } from "../agent/codexHook";

import { type HookInput } from "../agent/hook";
import { storePath } from "../agent/plugins/store";
import { writeFixture } from "./consentFixture";
import { takeTicket } from "../agent/consentTicket";
import { loadActive, saveActive } from "../agent/layout";
import { root, tool, write, bash, startWork, store, home } from "./hookPathsFixture";

import "./hookPathsFixture";
test("1-3·1-4 MCP 셸과 모든 하위 담당의 진행·동의·임대 변경을 막는다", () => {
  startWork();
  for (const phase of ["plan", "deliver"] as const) {
    saveActive(root, { ...loadActive(root)!, phase });
    const mcp = (command: string) => tool("mcp__jetbrains__execute_terminal_command", { command });
    assert.ok(mcp("node scripts/write.js"), phase);
    assert.equal(mcp("git status"), undefined, phase);
  }
  const commands = ["next", "back", "start doc/work/x.md", "plan submit plan.json", "planning advance", "planning dispatch task-1", "planning cancel task-1", "consent prepare --action plan", "consent apply 12345678-1234-1234-1234-123456789abc", "consent finish 12345678-1234-1234-1234-123456789abc", "takeover"];
  for (const role of ["ca-implementer", "ca-tester", "ca-analyst", "ca-explorer", "ca-reviewer", undefined]) {
    for (const command of commands) {
      const extra = { agent_id: "child", agent_type: role };
      for (const name of ["Bash", "PowerShell", "mcp__serena__execute_shell_command"]) {
        assert.ok(tool(name, { command: `code-agent ${command}` }, extra), `${role} ${name} ${command}`);
      }
    }
    assert.equal(tool("Bash", { command: "code-agent status" }, { agent_id: "child", agent_type: role }), undefined);
  }
  assert.equal(takeTicket(root, "prepare"), undefined);
  assert.equal(takeTicket(root, "apply", "12345678-1234-1234-1234-123456789abc"), undefined);
  assert.match(tool("Bash", { command: "code-agent takeover" }, { agent_type: "ca-reviewer" }) ?? "", /읽기 전용 담당/);
  if (process.platform === "win32") {
    const result = codexHook({ cwd: root, session_id: "s", agent_id: "child", agent_type: "ca-implementer", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "code-agent next" } });
    assert.match(JSON.stringify(result), /deny/);
  }
});

test("1-1 스마트 따옴표의 괄호 평가를 PowerShell과 Codex 경로에서 거부한다", () => {
  startWork();
  for (const quote of "‘’‚‛“”„") {
    const command = `git status ${quote}\"${quote} (Write-Output injected)`;
    assert.ok(tool("PowerShell", { command }), command);
    assert.ok(tool("Bash", { command }, { shell: "powershell" }), command);
    assert.ok(bash(`git status ${quote}$(echo injected)${quote}`), "Bash 치환도 거부한다");
    if (process.platform === "win32") {
      const result = codexHook({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      assert.match(JSON.stringify(result), /deny/, command);
    }
  }
  assert.equal(tool("PowerShell", { command: "git status 'plain'" }), undefined);
  assert.equal(bash("git status ‘plain’"), undefined, "Bash의 일반 글자는 그대로 받는다");
});

test("Windows .cmd 명령은 조회·임대·읽기 전용 역할·셸 제한을 같은 순서로 판정한다", () => {
  startWork();
  for (const toolName of ["Bash", "PowerShell"]) {
    const run = (command: string, extra: Partial<HookInput> = {}) => tool(toolName, { command }, extra);
    for (const command of ["status", "read code-agent.json", "doctor", "request"]) {
      assert.equal(run(`code-agent.cmd ${command}`), undefined, command);
    }
    for (const command of ["abort", "approve", "status; echo x", "status && echo x", "status | echo x", "status > out", "status\nwhoami"]) {
      assert.ok(run(`code-agent.cmd ${command}`), command);
    }
    for (const command of [".\\code-agent.cmd status", "code-agent.cmd.exe status", "cmd /c code-agent.cmd status"]) {
      assert.ok(run(command), command);
    }
    assert.match(run("code-agent.cmd next", { agent_type: "ca-reviewer" }) ?? "", /읽기 전용 담당/);
    assert.equal(run("code-agent.cmd status", { session_id: "other" }), undefined);
    assert.equal(run("code-agent.cmd next"), undefined);
    assert.ok(run("code-agent.cmd next", { session_id: "other" }), "다른 세션의 진행은 임대로 막는다");
  }
  assert.ok(tool("PowerShell", { command: "code-agent.cmd status (Remove-Item src)" }));
  const previous = process.env.CODE_AGENT_CROSS;
  try {
    process.env.CODE_AGENT_CROSS = "1";
    assert.equal(bash("code-agent.cmd status"), undefined);
    assert.ok(bash("code-agent.cmd next"));
  } finally {
    if (previous === undefined) delete process.env.CODE_AGENT_CROSS;
    else process.env.CODE_AGENT_CROSS = previous;
  }
  writeFixture(root, ".code-agent/active.json", "{broken");
  assert.equal(bash("code-agent.cmd status"), undefined);
});

test("T-8-1 Grep glob·Glob pattern 의 정적 접두와 키 저장소 상위 폴더 검색을 모든 모드에서 거부한다", () => {
  const check = (mode: string) => {
    for (const [name, input] of [
      ["Grep", { path: home, glob: ".code-agent/credentials.json" }],
      ["Grep", { path: home, glob: "**/credentials.json" }],
      ["Glob", { pattern: `${store()}/*` }],
      ["Grep", { path: dirname(store()) }],
    ] as const) {
      assert.match(tool(name, input) ?? "", /등록된 플러그인 키가 (있는 자리는 읽을 수 없습니다|들어 있는 상위 폴더)/, `${mode} ${name} ${JSON.stringify(input)}`);
    }
    assert.equal(tool("Grep", { path: root, glob: "**/*.ts" }), undefined, mode);
    assert.equal(tool("Read", { file_path: join(root, "code-agent.json") }), undefined, mode);
  };
  check("세션 밖");
  startWork();
  check("작업 중");
  writeFixture(root, ".code-agent/active.json", "{broken");
  check("상태 읽기 실패");
});

test("T-9-1·T-9-2 Windows 의 이름 끝 점·공백과 로컬 관리 공유 경로를 같은 파일로 판정한다", { skip: process.platform !== "win32" }, () => {
  for (const path of [".code-agent./active.json", ".code-agent /active.json", ".claude./settings.json", "doc/work/W-1/requirement.md "]) {
    assert.match(write(path) ?? "", /이름 끝의 점·공백/, path);
  }
  const drive = root.slice(0, 1), rest = root.slice(2);
  for (const alias of [`\\\\localhost\\${drive}$${rest}`, `\\\\127.0.0.1\\${drive}$${rest}`, `\\\\?\\UNC\\localhost\\${drive}$${rest}`]) {
    assert.match(write(`${alias}\\.code-agent\\active.json`) ?? "", /도구로 고칠 수 없습니다/, alias);
  }
});

test("T-13-1 Claude MCP 도구 — 로컬 파일 서버는 모든 경로를, 그 밖의 서버는 저장소·키 저장소 안 절대 경로만 판정한다", () => {
  startWork();
  assert.match(tool("mcp__fs__write_file", { path: "src/outside.ts" }) ?? "", /^MCP 도구 mcp__fs__write_file: /);
  assert.match(tool("mcp__fs__read_file", { path: storePath() }) ?? "", /키가 있는 자리는 읽을 수 없습니다/);
  assert.equal(tool("mcp__slack__post_message", { text: "x" }), undefined);
  assert.equal(tool("mcp__github__create_or_update_file", { path: "src/outside.ts" }), undefined, "원격 서비스의 상대 경로");
  assert.equal(tool("mcp__drive__upload_file", { path: "/My Drive/x" }), undefined, "원격 서비스의 절대 경로 모양 인자");
  assert.match(tool("mcp__github__write", { path: join(root, ".code-agent/active.json") }) ?? "", /도구로 고칠 수 없습니다/);
  assert.match(tool("mcp__fs__edit", { options: { file: `file://${join(root, ".code-agent/active.json").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` } }) ?? "", /MCP 도구/);
  // 쓰기 동사는 낱말로 맞춘다 — compute 의 put·output 의 put 같은 부분 문자열로 읽기 도구가 쓰기가 되지 않는다(E30)
  assert.equal(tool("mcp__hasher__compute_checksum", { path: join(root, "README.md") }), undefined);
  assert.equal(tool("mcp__logs__read_output_file", { file: join(root, "README.md") }), undefined);
  assert.match(tool("mcp__hasher__writeChecksum", { path: join(root, "src/outside.ts") }) ?? "", /^MCP 도구 mcp__hasher__writeChecksum: /, "camelCase 낱말도 본다");
  // 프로젝트 상대 경로 키(Serena relative_path, JetBrains pathInProject)는 서버 이름과 무관하게 저장소 기준으로 판정한다(E30)
  assert.match(tool("mcp__serena__replace_regex", { relative_path: "src/outside.ts" }) ?? "", /^MCP 도구 mcp__serena__replace_regex: /);
  assert.match(tool("mcp__jetbrains__replace_file_text_by_path", { pathInProject: ".code-agent/active.json" }) ?? "", /도구로 고칠 수 없습니다/);
  writeFixture(root, ".code-agent/active.json", "{broken");
  assert.match(tool("mcp__fs__write_file", { path: "src/a.ts" }) ?? "", /상태·설정을 읽지 못했습니다/);
  assert.equal(tool("mcp__fs__write_file", { path: "code-agent.json" }), undefined);
});

test("T-13-2 Codex MCP 는 판정하고, 판정하지 않는 도구 이름은 작업 중에만 기록한다", () => {
  const pre = (tool_name: string, tool_input: Record<string, unknown>) => codexHook({ cwd: root, hook_event_name: "PreToolUse", session_id: "c", tool_name, tool_input }) as { hookSpecificOutput?: unknown };
  assert.ok(pre("mcp__fs__write_file", { path: ".code-agent/active.json" }).hookSpecificOutput);
  assert.deepEqual(pre("spawn_agent", { agent_type: "x" }), {});
  const log = join(root, ".code-agent/log/codex-tools.json");
  assert.throws(() => readFileSync(log), "작업·세션이 없으면 기록하지 않는다");
  startWork();
  assert.deepEqual(pre("spawn_agent", { agent_type: "x" }), {});
  assert.equal(JSON.parse(readFileSync(log, "utf8")).spawn_agent.count, 1);
  writeFixture(root, ".code-agent/active.json", "{broken");
  assert.deepEqual(pre("spawn_agent", { agent_type: "x" }), {});
  assert.equal(JSON.parse(readFileSync(log, "utf8")).spawn_agent.count, 2);
});
