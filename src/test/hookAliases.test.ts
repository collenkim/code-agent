import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { codexHook, runCodexHook } from "../agent/codexHook";
import { start } from "../agent/commands";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { expandTilde } from "../agent/hook";
import { foldWindowsAlias, shareInside } from "../agent/layout";
import { hookInstallProblems, init } from "../agent/init";

import { requestBegin } from "../agent/request";
import { sessionAnchor } from "../agent/sessionHook";
import { CONSENT_SPEC } from "./consentFixture";
import { deadPid } from "./deadPid";
import { withCaller } from "./reviewFixture";
import { root, cli, tool, write, bash, startWork, home } from "./hookPathsFixture";

import "./hookPathsFixture";
test("T-17-1 세션 밖 셸이 hook 설정 파일을 가리키면 거부한다", () => {
  for (const command of ["echo {} > .claude/settings.json", "type .codex\\hooks.json", "cat .claude/settings.local.json", "cat .codex/config.toml"]) {
    assert.match(bash(command) ?? "", /호스트 hook 설정/, command);
  }
  assert.equal(bash("git status"), undefined);
});

test("T-17-2 hook 누락 감지 — 실행 중인 호스트의 누락은 시작을 막고, 다른 호스트·판별 불가는 경고만 한다", () => withCaller(undefined, () => {
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
}));

test("작업 중인 세션도 code-agent master trust·untrust·call 은 부르지 못한다 — 세션 밖 판정은 masterPairing.test 가 본다", () => {
  startWork();
  for (const command of ["code-agent master trust --controller dashboard", "code-agent master untrust --controller dashboard", "code-agent master trust --list", "code-agent master call"]) {
    assert.ok(bash(command), command);
    assert.ok(tool("PowerShell", { command: command.replace("code-agent", "code-agent.cmd") }), `PowerShell ${command}`);
  }
});

test("T-L5-1 세션 밖에서도 소스 업데이트는 사람의 확인이 필요하다 — 템플릿 적용은 연다", () => {
  for (const command of ["code-agent update", "code-agent update --host both"]) assert.match(bash(command) ?? "", /사람의 확인이 필요합니다/, command);
  assert.equal(bash("code-agent update --templates-only"), undefined);
  for (const flags of ["--install-only --preview --json", "--install-only --shown-hash sha256:abc --json", "--release release-id --preview --json", "--release release-id --shown-hash sha256:abc --json", "--preview", "--shown-hash=sha256:abc", "--install-only"]) {
    for (const prefix of ["code-agent update", "code-agent update --templates-only", "node dist/agent/cli.js update"]) {
      assert.match(bash(`${prefix} ${flags}`) ?? "", /사람의 확인이 필요합니다/, `${prefix} ${flags}`);
    }
  }
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
