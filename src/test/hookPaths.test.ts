import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { codexHook, runCodexHook } from "../agent/codexHook";
import { start } from "../agent/commands";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { doctor } from "../agent/doctor";
import { decide, expandTilde, type HookInput } from "../agent/hook";
import { foldWindowsAlias, shareInside } from "../agent/layout";
import { hookInstallProblems, init, installedHook } from "../agent/init";
import { requestBegin } from "../agent/request";
import { sessionAnchor } from "../agent/sessionHook";
import { storePath } from "../agent/plugins/store";
import { CONSENT_SPEC, CONSENT_WORK_ID, approveAndApplyFixture, setupConsentProject, submitConsentRequest, writeFixture } from "./consentFixture";
import { deadPid } from "./deadPid";

let root: string, home: string;
const saved = { home: process.env.CODE_AGENT_HOME, claude: process.env.CLAUDECODE };
const cli = join(__dirname, "../agent/cli.js");
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-hookpaths-")));
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-hookhome-")));
  process.env.CODE_AGENT_HOME = join(home, ".code-agent");
  mkdirSync(process.env.CODE_AGENT_HOME, { recursive: true });
  writeFileSync(storePath(), "{}");
  setupConsentProject(root);
});
afterEach(() => {
  for (const [key, value] of [["CODE_AGENT_HOME", saved.home], ["CLAUDECODE", saved.claude]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const temporary = realpathSync.native(tmpdir());
  for (const target of [resolve(root), resolve(home)]) {
    assert.ok(target.startsWith(temporary + sep) && /^ca-hook/.test(target.slice(temporary.length + 1)));
    rmSync(target, { recursive: true, force: true });
  }
});

const tool = (tool_name: string, tool_input: HookInput["tool_input"], extra: Partial<HookInput> = {}) => decide({ cwd: root, session_id: "s", tool_name, tool_input, ...extra });
const write = (file_path: string) => tool("Write", { file_path });
const bash = (command: string) => tool("Bash", { command });
function startWork(): void {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  start(root, join(root, CONSENT_SPEC));
}
const store = () => dirname(storePath());

// ---- CON-8 ----

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

// ---- CON-9 ----

test("T-9-1·T-9-2 Windows 의 이름 끝 점·공백과 로컬 관리 공유 경로를 같은 파일로 판정한다", { skip: process.platform !== "win32" }, () => {
  for (const path of [".code-agent./active.json", ".code-agent /active.json", ".claude./settings.json", "doc/work/W-1/requirement.md "]) {
    assert.match(write(path) ?? "", /이름 끝의 점·공백/, path);
  }
  const drive = root.slice(0, 1), rest = root.slice(2);
  for (const alias of [`\\\\localhost\\${drive}$${rest}`, `\\\\127.0.0.1\\${drive}$${rest}`, `\\\\?\\UNC\\localhost\\${drive}$${rest}`]) {
    assert.match(write(`${alias}\\.code-agent\\active.json`) ?? "", /도구로 고칠 수 없습니다/, alias);
  }
});

// ---- CON-13 ----

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

test("T-13-3·T-13-4 설치 — Claude matcher 에 mcp__.*, Codex PreToolUse 만 비Windows 명령을 || exit 2 로 감싼다", () => {
  init(root, { host: "both", cli });
  const claude = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert.match("mcp__fs__write_file", new RegExp(`^(${claude.hooks.PreToolUse[0].matcher})$`));
  const codex = JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks as Record<string, { hooks: { command: string; commandWindows?: string }[] }[]>;
  const [pretool] = codex.PreToolUse[0].hooks;
  assert.match(pretool.command, / codex-event \|\| exit 2$/);
  assert.match(pretool.commandWindows ?? "", / codex-event$/);
  for (const event of ["UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop"]) {
    const [entry] = codex[event][0].hooks;
    assert.match(entry.command, / codex-event$/, event);
    assert.equal(entry.commandWindows, undefined, event);
  }
  assert.match(installedHook(root, "PreToolUse", "codex-event", "codex") ?? "", /\|\| exit 2$/);
  assert.match(doctor(root).text, /✓ Codex PreToolUse:/);
  init(root, { host: "codex", cli });
  assert.equal((JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks.PreToolUse as unknown[]).length, 1, "다시 설치해도 래핑된 항목을 우리 것으로 읽어 하나로 맞춘다");
});

// ---- CON-17 ----

test("T-17-1 세션 밖 셸이 hook 설정 파일을 가리키면 거부한다", () => {
  for (const command of ["echo {} > .claude/settings.json", "type .codex\\hooks.json", "cat .claude/settings.local.json", "cat .codex/config.toml"]) {
    assert.match(bash(command) ?? "", /호스트 hook 설정/, command);
  }
  assert.equal(bash("git status"), undefined);
});

test("T-17-2 hook 누락 감지 — 실행 중인 호스트의 누락은 시작을 막고, 다른 호스트·판별 불가는 경고만 한다", () => {
  delete process.env.CLAUDECODE;
  assert.deepEqual(hookInstallProblems(root), [], "hosts.json 이 없으면 감지하지 않는다");
  init(root, { host: "both", cli });
  assert.deepEqual(hookInstallProblems(root), []);
  const file = join(root, ".claude/settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8"));
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((entry: { hooks: { command: string }[] }) => !entry.hooks.some((hook) => / hook$/.test(hook.command)));
  writeFileSync(file, JSON.stringify(settings));
  assert.deepEqual(hookInstallProblems(root), [{ host: "claude", problems: ["Claude PreToolUse(hook)"] }]);
  assert.match(sessionAnchor(root), /hook 설정이 빠져 있습니다: Claude PreToolUse\(hook\)/);
  process.env.CLAUDECODE = "1";
  const blocked = /이 호스트\(Claude Code\)의 hook 설정이 빠져 있어 시작하지 않습니다/;
  assert.throws(() => start(root, join(root, CONSENT_SPEC)), blocked);
  assert.throws(() => requestBegin(root, "W-1", "feature"), blocked);
  assert.throws(() => docsBegin(root), blocked);
  delete process.env.CLAUDECODE;
  assert.match(requestBegin(root, "W-1", "feature"), /경고: code-agent hook 설정이 빠져 있습니다/, "표지가 없는 사람의 터미널은 막지 않는다");
  init(root, { host: "claude", cli });
  rmSync(join(root, ".codex/hooks.json"));
  process.env.CLAUDECODE = "1";
  assert.deepEqual(hookInstallProblems(root).map((entry) => entry.host), ["codex"]);
  docsEnd(root);
  assert.match(docsBegin(root), /경고: code-agent hook 설정이 빠져 있습니다: Codex PreToolUse/, "다른 설치 호스트의 누락은 경고만 한다");
});

// ---- LRN-5 · CON-15 ----

test("T-L5-1 세션 밖에서도 소스 업데이트는 사람의 확인이 필요하다 — 템플릿 적용은 연다", () => {
  for (const command of ["code-agent update", "code-agent update --host both"]) assert.match(bash(command) ?? "", /사람의 확인이 필요합니다/, command);
  assert.equal(bash("code-agent update --templates-only"), undefined);
});

test("세션 밖에서도 사용자 수준 hook 설정은 쓰기 도구로 쓰지 않는다 — 셸 언급 거부와 같은 파일(E29)", () => {
  for (const target of [join(homedir(), ".claude", "settings.json"), "~/.claude/settings.local.json", join(homedir(), ".codex", "config.toml"), "~/.codex/hooks.json"]) {
    assert.match(write(target) ?? "", /사용자 수준 호스트 설정[\s\S]*disableAllHooks/, target);
  }
  assert.equal(write(join(homedir(), ".claude", "notes.md")), undefined, "다른 사용자 파일은 관여하지 않는다");
});

test("T-15-3 동의 적용 잠금을 살아 있는 프로세스가 쥐고 있으면 쓰기를 거부한다", () => {
  const lock = join(root, ".code-agent/consents/apply.lock");
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: "t" }));
  assert.match(write("src/a.ts") ?? "", /확인·적용이 진행 중입니다[\s\S]*\.code-agent\/consents\/apply\.lock 을 지웁니다/);
  // 저장소 밖 쓰기는 동의 스냅샷과 무관하다 — 잠금 pid 가 재사용돼도 막지 않는다(E26)
  assert.equal(write(join(tmpdir(), "ca-outside-scratch.txt")), undefined);
  const dead = deadPid();
  writeFileSync(lock, JSON.stringify({ pid: dead, host: hostname(), at: "t" }));
  assert.equal(write("src/a.ts"), undefined);
});

// ---- §3.12 hook 실패 코드 ----

test("T-12-1 Codex 사용자 메시지 판정 실패는 동의 응답만 막는다", () => {
  const run = (event: object) => {
    const stdout = process.stdout.write, stderr = process.stderr.write;
    let out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { return { code: runCodexHook(JSON.stringify(event)), out }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  };
  assert.deepEqual(run({ hook_event_name: "UserPromptSubmit", prompt: "안녕" }), { code: 0, out: "{}" }, "작업 경로가 없는 일반 메시지도 막지 않는다");
  assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "code-agent consent respond x 1" }).code, 2);
  const broken = spawnSync(process.execPath, [cli, "codex-event"], { cwd: root, input: "not json", encoding: "utf8" });
  assert.equal(broken.status, 0);
  assert.match(JSON.parse(broken.stdout).hookSpecificOutput.permissionDecisionReason, /판정에 실패해 막았습니다/);
  const business = spawnSync(process.execPath, [cli, "consent-event"], { cwd: root, encoding: "utf8",
    input: JSON.stringify({ cwd: root, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [] } }) });
  assert.equal(business.status, 0, "업무 질문은 막지 않는다");
});

// ---- 독립 검토 반영: `~` 전개·Windows 별칭·소스 update 명령 꼴 ----

/** os.homedir() 가 읽는 환경(USERPROFILE·HOME)을 잠시 바꾼다 — hook 이 `~` 를 이 폴더로 푼다 */
function withHome<T>(dir: string, run: () => T): T {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = dir; process.env.HOME = dir;
  try { return run(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("검토 #7 Grep·Glob·MCP 의 `~` 는 홈으로 풀어 키 자리를 판정한다 — 모든 모드", () => {
  assert.equal(expandTilde("~/x", "H"), "H/x");
  assert.equal(expandTilde("~", "H"), "H");
  assert.equal(expandTilde("~user/x", "H"), "~user/x", "~user 꼴은 풀지 않는다");
  assert.equal(expandTilde("a/~/x", "H"), "a/~/x");
  const check = (mode: string) => withHome(home, () => {
    for (const [name, input] of [
      ["Grep", { pattern: ".", path: "~/.code-agent" }],
      ["Grep", { pattern: ".", path: "~", glob: ".code-agent/*" }],
      ["Grep", { pattern: ".", path: "~", glob: "**/credentials.json" }],
      ["Glob", { pattern: "*", path: "~/.code-agent" }],
      ["Glob", { pattern: "~/.code-agent/*" }],
      ["Read", { file_path: "~/.code-agent/credentials.json" }],
      ["mcp__filesystem__search_files", { path: "~/.code-agent", pattern: "*" }],
    ] as const) {
      assert.match(tool(name, input) ?? "", /등록된 플러그인 키가 (있는 자리는 읽을 수 없습니다|들어 있는 상위 폴더)/, `${mode} ${name} ${JSON.stringify(input)}`);
    }
    assert.equal(tool("Grep", { pattern: ".", path: root }), undefined, mode);
  });
  check("세션 밖");
  startWork();
  check("작업 중");
});

test("검토 #7 세션 밖 쓰기의 `~/<저장소>/…` 도 저장소 안으로 판정한다", () => {
  withHome(dirname(root), () => {
    const rel = `~/${root.slice(dirname(root).length + 1)}`;
    for (const path of [`${rel}/.code-agent/active.json`, `${rel}/.code-agent/consents/index.json`, `${rel}/.code-agent/consents/tickets/prepare.json`, `${rel}/doc/work/W-1/requirement.md`]) {
      assert.match(write(path) ?? "", /도구로 고칠 수 없습니다|code-agent request submit 이 렌더합니다/, path);
    }
    assert.match(write(`${rel}/.claude/settings.json`) ?? "", /호스트 설정·훅·스킬은 모델이 직접 변경하지 않습니다/);
    assert.equal(write(`${rel}/src/a.ts`), undefined, "세션 밖의 저장소 코드 쓰기는 관여하지 않는다");
  });
});

test("검토 #9 IPv6 리터럴·이 PC 주소의 관리 공유도 드라이브 경로로 접는다", () => {
  const B = "\\";
  const unc = (...parts: string[]) => B + B + parts.join(B);
  assert.equal(foldWindowsAlias(unc("0--1.ipv6-literal.net", "C$", "x", "y"), "win32"), ["C:", "x", "y"].join(B));
  assert.equal(foldWindowsAlias(unc("[::1]", "d$", "x"), "win32"), ["D:", "x"].join(B));
  assert.equal(foldWindowsAlias(unc("0--2.ipv6-literal.net", "C$", "x"), "win32"), unc("0--2.ipv6-literal.net", "C$", "x"), "이 PC 가 아닌 주소는 접지 않는다");
  assert.equal(foldWindowsAlias(unc("0--1.ipv6-literal.net", "C$", "x"), "linux"), unc("0--1.ipv6-literal.net", "C$", "x"));
  if (process.platform !== "win32") return;
  const drive = root.slice(0, 1), rest = root.slice(2);
  const alias = unc("0--1.ipv6-literal.net", `${drive}$${rest}`);
  assert.match(write([alias, ".code-agent", "active.json"].join(B)) ?? "", /도구로 고칠 수 없습니다/);
  const patch = codexHook({ cwd: root, hook_event_name: "PreToolUse", session_id: "c", tool_name: "apply_patch",
    tool_input: { command: ["*** Begin Patch", `*** Add File: ${[alias, ".code-agent", "x.json"].join(B)}`, "+{}", "*** End Patch"].join("\n") } }) as { hookSpecificOutput?: unknown };
  assert.ok(patch.hookSpecificOutput, "Codex apply_patch 도 같은 판정");
});

test("검토 #9 이름으로 접지 못한 UNC 는 공유 쪽 조상의 (dev, ino)로 저장소 안인지 본다", { skip: process.platform !== "win32" }, (context) => {
  const B = "\\";
  const drive = root.slice(0, 1), rest = root.slice(2);
  const share = `${B}${B}localhost${B}${drive}$${rest}`;
  try { statSync(share); } catch { context.skip("이 PC 의 관리 공유에 닿을 수 없다"); return; }
  assert.equal(shareInside(root, [share, ".code-agent", "active.json"].join(B)), join(root, ".code-agent", "active.json"));
  assert.equal(shareInside(root, [share, "없는 폴더", "x.json"].join(B)), join(root, "없는 폴더", "x.json"));
  assert.equal(shareInside(root, [`${B}${B}localhost${B}${drive}$${dirname(rest)}`, "다른-저장소", "x.json"].join(B)), undefined, "저장소 밖");
  assert.equal(shareInside(root, [share, ".code-agent", "active.json"].join(B), "linux"), undefined);
});

test("검토 #10 세션 밖 셸의 Windows 이름 별칭(끝 점·공백·8.3·./)도 상태·hook 설정 언급으로 본다", () => {
  for (const command of [
    "Set-Content '.code-agent./ps.json' 'x'", "Set-Content '.code-agent /ps.json' 'x'", "Set-Content 'CODE-A~1/ps.json' 'x'",
    "python -c \"open('.code-agent./active.json','w')\"", `type .CODE-AGENT${"\\"}active.json`,
  ]) assert.match(bash(command) ?? "", /`\.code-agent\/` 는 code-agent 명령으로만 바뀝니다/, command);
  for (const command of [
    "Set-Content '.claude./settings.json' '{}'", "cp x.json .claude/./settings.json", `copy x.json CLAUDE~1${"\\"}SETTIN~2.JSO`,
    "Set-Content '.codex. /hooks.json' '{}'", `type CODEX~1${"\\"}CONFIG~1.TOM`,
  ]) assert.match(bash(command) ?? "", /호스트 hook 설정/, command);
  for (const command of ["git log HEAD~1", "code-agent status", "cat .code-agent.json", "cat claude~notes.md"]) assert.equal(bash(command), undefined, command);
});

test("검토 #14 소스 update 는 어떻게 불러도 세션 밖 hook 이 막는다 — 템플릿 적용은 연다", () => {
  for (const command of ["code-agent  update", "npx code-agent update", "node C:/x/dist/agent/cli.js update", `& 'C:${"\\"}npm${"\\"}code-agent.cmd' update --host both`]) {
    assert.match(bash(command) ?? "", /사람의 확인이 필요합니다/, command);
  }
  for (const command of ["npx code-agent update --templates-only", "code-agent status"]) assert.equal(bash(command), undefined, command);
});
