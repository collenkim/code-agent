import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexHook } from "../agent/codexHook";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { doctor } from "../agent/doctor";
import { decide, READ_ONLY_ROLES, readOnlyRoleGuard } from "../agent/hook";
import { assetText } from "../agent/assets";
import { CODEX_EVENTS, codexWindowsCommand, codexWindowsProblem, init, installedHook } from "../agent/init";
import { update } from "../agent/update";
import { writeFixture } from "./consentFixture";
import { root, cli, startWork } from "./hookPathsFixture";

import "./hookPathsFixture";
test("T-13-3·T-13-4·H3 설치 — Claude matcher 에 mcp__.*, Codex PreToolUse 만 비Windows 명령을 || exit 2 로 감싸고, Windows 명령은 PowerShell 의 종료 코드를 넘긴다", () => {
  init(root, { host: "both", cli });
  const claude = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert.match("mcp__fs__write_file", new RegExp(`^(${claude.hooks.PreToolUse[0].matcher})$`));
  const codexHooks = () => JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks as Record<string, { hooks: { type?: string; command: string; commandWindows?: string }[] }[]>;
  const codex = codexHooks();
  const [pretool] = codex.PreToolUse[0].hooks;
  const node = `node "${cli.replace(/\\/g, "/")}" codex-event`;
  const windowsNode = `node '${cli.replace(/\\/g, "/").replace(/'/g, "''")}' codex-event`;
  assert.equal(pretool.command, `${node} || exit 2`);
  assert.equal(pretool.commandWindows, `${windowsNode}; if ($LASTEXITCODE -ne 0) { exit 2 }`);
  assert.equal(codex.UserPromptSubmit[0].hooks[0].commandWindows, `${windowsNode}; exit $LASTEXITCODE`);
  for (const event of ["UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop"]) {
    const [entry] = codex[event][0].hooks;
    assert.equal(entry.command, node, event);
    if (event !== "UserPromptSubmit") assert.equal(entry.commandWindows, windowsNode, event);
  }
  assert.equal(codexWindowsCommand("Stop"), "cmd /c code-agent codex-event", "--cli 가 없으면 cmd 로 푼다(npm 의 .ps1 을 고르지 않는다)");
  assert.equal(codexWindowsCommand("PreToolUse"), "cmd /c code-agent codex-event; if ($LASTEXITCODE -ne 0) { exit 2 }");
  assert.match(installedHook(root, "PreToolUse", "codex-event", "codex") ?? "", /\|\| exit 2$/);
  assert.match(doctor(root).text, /✓ Codex PreToolUse:/);
  init(root, { host: "codex", cli });
  assert.equal((JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks.PreToolUse as unknown[]).length, 1, "다시 설치해도 래핑된 항목을 우리 것으로 읽어 하나로 맞춘다");
  // 옛 설치(Windows 명령이 감싸지 않은 꼴·없음)는 doctor 가 막는 문제로 알리고, update --templates-only 가 고친다
  const old = codexHooks();
  old.PreToolUse[0].hooks[0].commandWindows = node;
  delete old.UserPromptSubmit[0].hooks[0].commandWindows;
  writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify({ hooks: old }, null, 2));
  assert.match(codexWindowsProblem(root, "PreToolUse") ?? "", /commandWindows/);
  assert.match(codexWindowsProblem(root, "UserPromptSubmit") ?? "", /\(없음\)/);
  const text = doctor(root).text;
  assert.match(text, /✗ Codex PreToolUse: Windows 명령\(commandWindows\)이 이 버전의 꼴과 다릅니다[\s\S]*update --templates-only --host codex/);
  assert.match(text, /✗ Codex UserPromptSubmit: Windows 명령/);
  // --cli 설치의 Stop·Subagent·SessionStart 는 commandWindows 가 없어도 Codex 가 같은 node 명령을 PowerShell 로 돌린다 — 문제가 아니다
  for (const event of ["Stop", "SubagentStart", "SubagentStop", "SessionStart"] as const) {
    delete old[event][0].hooks[0].commandWindows;
  }
  writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify({ hooks: old }, null, 2));
  for (const event of ["Stop", "SubagentStart", "SubagentStop", "SessionStart"] as const) assert.equal(codexWindowsProblem(root, event), undefined, event);
  assert.doesNotMatch(doctor(root).text, /✗ Codex (Stop|SubagentStart|SubagentStop|SessionStart):/);
  assert.match(codexWindowsProblem(root, "UserPromptSubmit") ?? "", /종료 코드/);
  assert.doesNotMatch(codexWindowsProblem(root, "UserPromptSubmit") ?? "", /code-agent\.ps1/, "--cli 설치는 .ps1 을 고르지 않는다");
  // --cli 없는 옛 설치(command 만 `code-agent codex-event`)의 Stop 은 실행 정책 사유다
  const plainOld = codexHooks();
  plainOld.Stop[0].hooks[0] = { type: "command", command: "code-agent codex-event" };
  writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify({ hooks: plainOld }, null, 2));
  assert.match(codexWindowsProblem(root, "Stop") ?? "", /\(없음\) — PowerShell 이 npm 의 code-agent\.ps1/);
  assert.doesNotMatch(codexWindowsProblem(root, "Stop") ?? "", /종료 코드/);
  writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify({ hooks: old }, null, 2));
  const updated = update(root, { host: "codex" });
  assert.match(updated, /\.codex\/hooks\.json: 갱신/);
  for (const event of CODEX_EVENTS) assert.equal(codexWindowsProblem(root, event), undefined, event);
  assert.equal(codexHooks().PreToolUse[0].hooks[0].command, `${node} || exit 2`, "update 는 --cli 를 승계한다");
});

test("H9 Codex 하위 에이전트 조율 도구(collaboration 이름공간 — 0.161.0 실측 이름)는 미판정 도구로 세지 않는다", () => {
  startWork();
  const pre = (tool_name: string) => codexHook({ cwd: root, hook_event_name: "PreToolUse", session_id: "c", tool_name, tool_input: { agent_type: "ca_explorer" } });
  assert.deepEqual(pre("collaborationspawn_agent"), {});
  assert.deepEqual(pre("collaborationwait_agent"), {});
  const log = join(root, ".code-agent/log/codex-tools.json");
  assert.equal(existsSync(log), false, "알려진 비파일 도구는 기록하지 않는다");
  assert.deepEqual(pre("spawn_agent"), {});
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(log, "utf8"))), ["spawn_agent"], "모르는 이름은 그대로 센다");
});

test("H4 읽기 전용 담당(Claude 정의의 tools 에 쓰기·셸이 없는 역할)은 Codex 하위 에이전트로 돌아도 파일을 쓰거나 작업을 진행하지 않는다", () => {
  const readOnly = ["ca-analyst", "ca-critic", "ca-explorer", "ca-implementer", "ca-reviewer", "ca-surveyor", "ca-tester", "ca-writer"].filter((agent) => {
    const tools = /^tools: (.+)$/m.exec(assetText(`template/claude/agents/${agent}.md`))?.[1] ?? "";
    return !/\b(?:Write|Edit|Bash)\b/.test(tools);
  });
  assert.deepEqual([...READ_ONLY_ROLES], readOnly, "READ_ONLY_ROLES 를 정의 파일의 tools 에 맞추세요");
  startWork();
  const pre = (agent_type: string | undefined, tool_name: string, tool_input: Record<string, unknown>) => ((codexHook({ cwd: root, hook_event_name: "PreToolUse", session_id: "s",
    ...(agent_type ? { agent_id: `id-${agent_type}`, agent_type } : {}), tool_name, tool_input }) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? "");
  const patch = { command: "*** Begin Patch\n*** Add File: src/review-note.md\n+x\n*** End Patch" };
  for (const role of READ_ONLY_ROLES) {
    const codexRole = role.replace(/-/g, "_");
    assert.match(pre(codexRole, "apply_patch", patch), /읽기 전용 담당입니다/, role);
    assert.match(pre(codexRole, "Bash", { command: "code-agent next" }), /읽기 전용 담당입니다/, role);
    assert.doesNotMatch(pre(codexRole, "Bash", { command: "code-agent status" }), /읽기 전용 담당/, `${role} 의 읽기 명령은 연다`);
    assert.match(decide({ cwd: root, session_id: "s", agent_id: "x", agent_type: role, tool_name: "Write", tool_input: { file_path: join(root, "src/a.md") } }) ?? "", /읽기 전용 담당입니다/, `Claude 표기 ${role}`);
  }
  for (const role of ["ca_writer", "ca_implementer", undefined]) assert.doesNotMatch(pre(role, "apply_patch", patch), /읽기 전용 담당/, String(role));
  // surveyor 는 코드를 읽기만 하고 초안 자리 바로 아래의 .md 만 쓴다 — 본문을 메인 대화로 돌려 writer 프롬프트에 다시 싣지 않게
  const surveyor = (file: string) => readOnlyRoleGuard({ cwd: root, session_id: "s", agent_id: "x", agent_type: "ca-surveyor", tool_name: "Write", tool_input: { file_path: join(root, file) } }, root);
  assert.equal(surveyor("doc/.survey/architecture-structure.md"), undefined);
  for (const file of ["doc/architecture.md", "doc/.survey/a/b.md", "doc/.survey/a.txt", "doc/.survey/../x.md", "src/a.md"]) assert.match(surveyor(file) ?? "", /초안\(\.md\)만/, file);
  assert.match(pre("ca_surveyor", "apply_patch", patch), /초안\(\.md\)만/);
  assert.match(pre("ca_surveyor", "Bash", { command: "code-agent next" }), /초안\(\.md\)만/);
  assert.doesNotMatch(pre("ca_surveyor", "Bash", { command: "code-agent survey" }), /초안/);
});

test("문서 세션은 surveyor 초안 자리를 Git 밖에 열고 닫을 때 지운다", () => {
  docsBegin(root);
  assert.equal(readFileSync(join(root, "doc/.survey/.gitignore"), "utf8"), "*\n");
  writeFileSync(join(root, "doc/.survey/conventions-naming.md"), "# 초안\n");
  assert.equal(spawnSync("git", ["status", "--porcelain", "--", "doc/.survey"], { cwd: root, encoding: "utf8" }).stdout, "", "초안은 Git 이 보지 않는다");
  docsEnd(root);
  assert.equal(existsSync(join(root, "doc/.survey")), false);
});

/** Codex 가 Windows 에서 hook 을 돌리는 꼴 — `powershell.exe -NoProfile -Command "<commandWindows>"`(0.161.0 실측) */
test("PowerShell Restricted에서도 .cmd read는 .ps1 없이 문서를 읽는다", { skip: process.platform !== "win32" }, () => {
  writeFixture(root, "code-agent.ps1", "throw 'ps1 must not run'");
  writeFixture(root, "code-agent.cmd", `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  writeFixture(root, "read-probe.md", "read-probe-ok\n");
  const command = `code-agent.cmd read '${join(root, "read-probe.md").replace(/'/g, "''")}' 1 300`;
  const result = powershellHook(command, "", { ...process.env, PATH: `${root};${process.env.PATH ?? ""}` }, "Restricted", root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /read-probe-ok/);
});

function powershellHook(command: string, stdin: string, env: NodeJS.ProcessEnv, policy?: string, cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const childEnv = { ...env };
  delete childEnv.PSExecutionPolicyPreference;
  const run = spawnSync(exe, ["-NoProfile", ...(policy ? ["-ExecutionPolicy", policy] : []), "-Command", command], { cwd, input: stdin, encoding: "utf8", env: childEnv, windowsHide: true, timeout: 60_000 });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

test("H3 Windows — 설치된 commandWindows 를 PowerShell 로 돌리면 PreToolUse 실패는 2, 동의 응답 실패 2 는 그대로, cli 가 없으면 PreToolUse 2·UserPromptSubmit 1, node 가 없으면 PreToolUse 2·UserPromptSubmit 0", { skip: process.platform !== "win32" }, () => {
  init(root, { host: "codex", cli });
  const hooks = JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks as Record<string, { hooks: { commandWindows: string }[] }[]>;
  const windows = (event: string) => hooks[event][0].hooks[0].commandWindows;
  // 동의 응답이 실패하면 codex-event 는 2 로 끝난다 — PowerShell 5.1 이 1 로 바꾸지 않게 넘긴다(메시지가 모델로 가지 않는다)
  const reply = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, session_id: "s", prompt: "code-agent consent respond 00000000-0000-0000-0000-000000000000 approve" });
  assert.equal(powershellHook(windows("UserPromptSubmit"), reply, process.env).status, 2);
  const plain = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, session_id: "s", prompt: "안녕하세요" });
  assert.equal(powershellHook(windows("UserPromptSubmit"), plain, process.env).status, 0);
  const shell = JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, session_id: "s", tool_name: "Bash", tool_input: { command: "git status" } });
  const allowed = powershellHook(windows("PreToolUse"), shell, process.env);
  assert.deepEqual([allowed.status, allowed.stdout], [0, "{}"]);
  // cli 가 없는 설치(모듈 로드 전 종료 1) — PreToolUse 는 2 로 닫는다
  const missing = join(root, "없는-cli.js").replace(/\\/g, "/");
  const broken = windows("PreToolUse").replace(cli.replace(/\\/g, "/"), missing);
  assert.equal(powershellHook(broken, shell, process.env).status, 2);
  // 같은 깨진 설치의 UserPromptSubmit 은 1(모듈 로드 전 종료) — Codex 는 2 만 막음으로 받으므로 사용자 메시지를 막지 않는다
  assert.equal(powershellHook(windows("UserPromptSubmit").replace(cli.replace(/\\/g, "/"), missing), plain, process.env).status, 1);
  // node 가 PATH 에 없다 — PreToolUse 는 막고(2), 사용자 메시지는 막지 않는다(0)
  const noNode = { ...process.env, PATH: (process.env.PATH ?? "").split(";").filter((dir) => dir && !existsSync(join(dir, "node.exe"))).join(";") };
  assert.equal(powershellHook(windows("PreToolUse"), shell, noNode).status, 2);
  assert.equal(powershellHook(windows("UserPromptSubmit"), plain, noNode).status, 0);
});

test("H3 Windows — --cli 없는 설치(cmd /c code-agent)는 실행 정책 Restricted 에서도 npm 의 .cmd 로 풀리고 종료 코드·stdout 이 지난다", { skip: process.platform !== "win32" }, () => {
  const bin = join(root, "fake-npm-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "fake.cjs"), "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({via:'cmd',got:JSON.parse(s).hook_event_name}));process.exit(Number(process.env.FAKE_EXIT||0));});\n");
  writeFileSync(join(bin, "code-agent.cmd"), "@node \"%~dp0fake.cjs\" %*\r\n");
  writeFileSync(join(bin, "code-agent.ps1"), "Write-Output 'ps1'; exit 0\r\n");
  const env = (exit: number) => ({ ...process.env, PATH: `${bin};${process.env.PATH}`, FAKE_EXIT: String(exit) });
  const stdin = JSON.stringify({ hook_event_name: "PreToolUse" });
  for (const [exit, expected] of [[0, 0], [1, 2], [2, 2]] as const) {
    const run = powershellHook(codexWindowsCommand("PreToolUse"), stdin, env(exit), "Restricted");
    assert.equal(run.status, expected, `exit ${exit}`);
    assert.equal(run.stdout, JSON.stringify({ via: "cmd", got: "PreToolUse" }));
  }
  assert.equal(powershellHook(codexWindowsCommand("UserPromptSubmit"), stdin, env(2), "Restricted").status, 2);
  assert.equal(powershellHook(codexWindowsCommand("Stop"), stdin, env(0), "Restricted").stdout, JSON.stringify({ via: "cmd", got: "PreToolUse" }));
});
