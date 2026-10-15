/**
 * 버전 선택·적용 — 실제 code-agent 릴리스 둘(A·B, 이 저장소의 빌드를 격리된 릴리스 저장소에 옮긴 것)로 본다.
 * 고정 진입점(dist/agent/cli.js)이 프로젝트마다 적용 버전을 골라 같은 프로세스에서 넘기는지, 진행 중인 일이 있으면 적용을 예약했다가
 * 다음 작업을 열 때 적용하는지, 템플릿 보존·되돌리기·상태 세대·선택 UI MCP 를 실행 기록(CODE_AGENT_RUNTIME_TRACE)으로 확인한다.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";

import { baselineFiles } from "../agent/bootstrap";
import { prepareConsent } from "../agent/consent";
import { hostAssets } from "../agent/hosts";
import { init } from "../agent/init";
import { packageRelease } from "../agent/releaseStore";
import { STATE_SCHEMA } from "../agent/runtimeSelect";
import { setupConsentProject } from "./consentFixture";

const REPO = join(__dirname, "..", "..");
const ENTRY = join(REPO, "dist", "agent", "cli.js");
const A = "1.0.0-aaaaaaaaaaaa", B = "1.0.0-bbbbbbbbbbbb", GONE = "1.0.0-cccccccccccc";
const B_MARK = "\n<!-- release B -->\n";
let scratch: string, store: string, trace: string;
let count = 0;

/** 이 저장소의 빌드로 릴리스 폴더를 만든다 — 의존성은 이 저장소의 node_modules 를 가리킨다 */
function release(id: string, change?: (dir: string) => void): void {
  const dir = join(store, id);
  for (const part of ["agent", "core"]) cpSync(join(REPO, "dist", part), join(dir, "dist", part), { recursive: true });
  cpSync(join(REPO, "template"), join(dir, "template"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(dir, "package.json"));
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "junction");
  change?.(dir);
  writeFileSync(join(dir, "release.json"), JSON.stringify({ schema: 1, id, version: "1.0.0", stateSchema: STATE_SCHEMA, installedAt: new Date().toISOString(),
    source: { kind: "git", commit: id.slice(-12).repeat(4).slice(0, 40), tree: "0".repeat(40), remote: "origin", ref: "refs/heads/main" }, contentHash: "0".repeat(64) }));
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const value: NodeJS.ProcessEnv = { ...process.env, CODE_AGENT_RELEASE_HOME: store, CODE_AGENT_RUNTIME_TRACE: trace, ...extra };
  for (const key of ["CLAUDE_PROJECT_DIR", ...(extra.CODE_AGENT_RUNTIME_SELF ? [] : ["CODE_AGENT_RUNTIME_SELF"]), ...(extra.CODE_AGENT_ENTRY ? [] : ["CODE_AGENT_ENTRY"])]) delete value[key];
  return value;
}

function cli(project: string, args: string[], input = ""): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd: project, input, encoding: "utf8", env: env(), timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 갱신이 하는 그대로 — 그 릴리스의 CLI 가 스스로(고르지 않고) 적용한다 */
function applyAs(project: string, id: string, trigger = "update"): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(store, id, "dist", "agent", "cli.js"), "update", "--apply-release", id, "--trigger", trigger],
    { cwd: project, encoding: "utf8", env: env({ CODE_AGENT_RUNTIME_SELF: "1", CODE_AGENT_ENTRY: ENTRY }), timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 그 명령을 마지막으로 실제로 돌린 코드의 버전(실행 기록) — 시험은 차례로 돌므로 마지막 줄이 방금 실행이다 */
function lastRun(command: string): string {
  const rows = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { command: string | null; runtime: string });
  return rows.filter((row) => row.command === command).at(-1)!.runtime;
}

function project(host: "claude" | "both" = "claude"): string {
  const root = join(scratch, `project ${++count}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  init(root, { host });
  writeFileSync(join(root, "README.md"), "project\n");
  return root;
}

function runtime(root: string): { applied?: string; pending?: { id: string; reason: string }; stateSchema?: number; adopted?: string } | undefined {
  const file = join(root, ".code-agent", "runtime.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

const preToolUse = (root: string) => JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(root, "README.md") } });
const versionOf = (root: string) => JSON.parse(cli(root, ["version", "--json"]).stdout) as {
  running: { id: string | null }; project: { applied: string | null; pending: { id: string } | null };
  choiceServers: { connector: string; lastCall?: { handler: string } }[];
};

before(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-runtime-")));
  store = join(scratch, "release store");
  trace = join(scratch, "trace.jsonl");
  release(A);
  release(B, (dir) => {
    for (const name of ["ca-status", "ca-next"]) appendFileSync(join(dir, "template", "claude", "skills", name, "SKILL.md"), B_MARK);
  });
});

after(() => {
  for (const id of [A, B]) try { unlinkSync(join(store, id, "node_modules")); } catch { /* 이미 없다 */ }
  assert.ok(scratch.startsWith(realpathSync.native(tmpdir()) + sep));
  rmSync(scratch, { recursive: true, force: true });
});

describe("적용 버전 선택 — 고정 진입점", () => {
  test("작업이 없으면 그 릴리스가 스스로 적용하고, 다음 hook·명령부터 호스트를 다시 열지 않고 그 릴리스로 돈다", () => {
    const root = project();
    assert.equal(cli(root, ["hook"], preToolUse(root)).status, 0);
    assert.equal(lastRun("hook"), "bundle", "고정한 적이 없으면 진입점의 번들이 돈다");
    const applied = applyAs(root, A);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, new RegExp(`적용 버전: 번들 → ${A}`));
    assert.match(applied.stdout, /호스트를 다시 열 필요가 없습니다\./);
    assert.match(applied.stdout, /CLI·hook·검증은 다음 호출부터 새 버전으로 돕니다/);
    assert.equal(runtime(root)?.applied, A);
    assert.equal(JSON.parse(readFileSync(join(root, ".code-agent", "templates.json"), "utf8")).release, A);
    assert.equal(cli(root, ["hook"], preToolUse(root)).status, 0);
    assert.equal(lastRun("hook"), A, "다음 hook 호출은 새 프로세스라 적용 버전으로 돈다");
    const view = versionOf(root);
    assert.equal(view.running.id, A);
    assert.equal(view.project.applied, A);
    assert.match(cli(root, ["status"]).stdout, new RegExp(`code-agent: 적용 버전 ${A}`));
  });

  test("프로젝트마다 다른 버전 — 한 프로젝트의 적용이 다른 프로젝트를 바꾸지 않는다", () => {
    const one = project(), two = project();
    assert.equal(applyAs(one, A).status, 0);
    assert.equal(applyAs(two, B).status, 0);
    assert.equal(versionOf(one).running.id, A);
    assert.equal(versionOf(two).running.id, B);
    cli(one, ["hook"], preToolUse(one));
    assert.equal(lastRun("hook"), A);
    cli(two, ["hook"], preToolUse(two));
    assert.equal(lastRun("hook"), B);
    assert.ok(!readFileSync(join(one, ".claude", "skills", "ca-status", "SKILL.md"), "utf8").includes(B_MARK.trim()), "다른 프로젝트의 지침은 그대로다");
    assert.ok(readFileSync(join(two, ".claude", "skills", "ca-status", "SKILL.md"), "utf8").includes(B_MARK.trim()));
  });

  test("설치되지 않은 폴더 — update 의 어느 갈래도 아무것도 쓰지 않고 멈춘다(프로젝트 밖·설치하지 않은 저장소의 하위 폴더)", () => {
    const outside = join(scratch, `not installed ${++count}`), repo = join(scratch, `bare repo ${++count}`);
    mkdirSync(join(outside, "sub"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const releases = readdirSync(store).sort();
    for (const cwd of [outside, join(outside, "sub"), join(repo, "src")]) {
      for (const args of [["update", "--templates-only"], ["update", "--templates-only", "--host", "codex"], ["update", "--bundled"], ["update", "--release", A], ["update"]]) {
        const run = cli(cwd, args);
        assert.equal(run.status, 1, `${cwd}: ${args.join(" ")}`);
        assert.match(run.stdout + run.stderr, /에는 code-agent 가 설치되어 있지 않아 갱신하지 않습니다 — 아무것도 바꾸지 않았습니다\. .*code-agent init/);
      }
      assert.equal(applyAs(cwd, A).status, 1, "릴리스가 스스로 적용하는 내부 갈래도 같다");
    }
    assert.deepEqual(readdirSync(outside), ["sub"]);
    assert.deepEqual(readdirSync(join(outside, "sub")), []);
    assert.deepEqual(readdirSync(repo).sort(), [".git", "src"]);
    assert.deepEqual(readdirSync(join(repo, "src")), []);
    assert.deepEqual(readdirSync(store).sort(), releases, "릴리스 저장소도 그대로다");
    // 설치된 프로젝트는 하위 폴더에서 실행해도 그 저장소 루트를 갱신한다
    const root = project();
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    const nested = cli(join(root, "src", "deep"), ["update", "--templates-only"]);
    assert.equal(nested.status, 0, nested.stderr);
    assert.ok(nested.stdout.includes(`다시 설치했습니다 — ${root}`), nested.stdout);
    assert.ok(!existsSync(join(root, "src", "deep", ".claude")));
  });

  test("적용은 바뀐 설치 파일만 쓴다 — 쓸 수 없는 .codex/(Codex 샌드박스)도 그대로면 적용되고, 바뀌어야 하면 되돌린 뒤 안내와 함께 예약을 남긴다", () => {
    const root = project("both");
    assert.equal(applyAs(root, A).status, 0);
    // git autocrlf 체크아웃처럼 줄바꿈만 다른 사본 — 같은 내용이라 쓰지 않는다
    const crlf = join(root, ".claude", "skills", "ca-plan", "SKILL.md");
    writeFileSync(crlf, readFileSync(crlf, "utf8").replace(/\r?\n/g, "\r\n"));
    const locked = [join(root, ".codex", "config.toml"), join(root, ".codex", "hooks.json"), crlf];
    const lock = () => { for (const file of locked) chmodSync(file, 0o444); };
    const unlock = () => { for (const file of locked) chmodSync(file, 0o666); };
    lock();
    try {
      const switched = applyAs(root, B);
      assert.equal(switched.status, 0, switched.stdout + switched.stderr);
      assert.equal(runtime(root)?.applied, B);
      assert.ok(readFileSync(join(root, ".agents", "skills", "ca-status", "SKILL.md"), "utf8").includes(B_MARK.trim()), "바뀐 Codex 스킬은 썼다");
      assert.match(readFileSync(crlf, "utf8"), /\r\n/, "줄바꿈만 다른 사본은 건드리지 않았다");

      // .codex/ 아래가 바뀌어야 하는 버전 — 쓰기가 거부되면 반영한 파일을 되돌리고 지금 버전으로 연다
      unlock();
      const config = join(root, ".codex", "config.toml");
      writeFileSync(config, readFileSync(config, "utf8").replace("tool_timeout_sec = 3600", "tool_timeout_sec = 60"));
      lock();
      writeFileSync(join(root, ".code-agent", "docs-session.json"), JSON.stringify({ startedAt: new Date().toISOString(), version: 2, writable: ["doc"] }));
      assert.equal(applyAs(root, A).status, 3);
      rmSync(join(root, ".code-agent", "docs-session.json"));
      const next = cli(root, ["docs", "begin"]);
      assert.equal(next.status, 0, next.stderr);
      assert.match(next.stdout, /템플릿 적용 중 실패했습니다 — (?:EPERM|EACCES)[\s\S]*반영 전 파일로 모두 되돌렸습니다/);
      assert.match(next.stdout, /샌드박스는 \.codex\/·\.agents\/ 아래를 쓰지 못하게 합니다[\s\S]*code-agent update --templates-only 를 실행하면 적용합니다/);
      assert.match(next.stdout, new RegExp(`지금 버전\\(${B}\\)으로 시작합니다 — 적용 대기는 그대로 둡니다`));
      assert.equal(lastRun("docs"), B);
      assert.deepEqual([runtime(root)?.applied, runtime(root)?.pending?.id], [B, A]);
      for (const skill of [join(root, ".claude", "skills", "ca-status", "SKILL.md"), join(root, ".agents", "skills", "ca-status", "SKILL.md")]) {
        assert.ok(readFileSync(skill, "utf8").includes(B_MARK.trim()), `먼저 쓴 사본도 되돌렸다: ${skill}`);
      }
    } finally { unlock(); }
  });

  test("다음 작업을 여는 셸 명령 직전의 hook 이 예약된 새 버전을 적용하고, 그 명령은 새 버전으로 보고를 낸 뒤 연다(샌드박스 셸이 쓰지 못하는 사본은 hook 이 쓴다)", () => {
    const root = project("both");
    assert.equal(applyAs(root, A).status, 0);
    const session = join(root, ".code-agent", "docs-session.json");
    writeFileSync(session, JSON.stringify({ startedAt: new Date().toISOString(), version: 2, writable: ["doc"] }));
    assert.equal(applyAs(root, B).status, 3);
    const bash = (command: string) => JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
    assert.equal(cli(root, ["hook"], bash("code-agent docs begin")).status, 0);
    assert.equal(runtime(root)?.pending?.id, B, "진행 중인 일이 있으면 hook 도 적용하지 않는다");
    rmSync(session);
    assert.equal(cli(root, ["hook"], bash("code-agent status")).status, 0);
    assert.equal(runtime(root)?.applied, A, "여는 명령이 아니면 적용하지 않는다");
    cli(root, ["hook"], bash("code-agent docs begin; git status"));
    assert.equal(runtime(root)?.applied, A, "연결자가 든 명령은 적용하지 않는다");
    const sub = JSON.stringify({ ...JSON.parse(bash("code-agent docs begin")), agent_id: "a1", agent_type: "ca-writer" });
    cli(root, ["hook"], sub);
    assert.equal(runtime(root)?.applied, A, "하위 에이전트의 셸 명령은 적용하지 않는다");

    const hooked = cli(root, ["hook"], bash("code-agent.cmd docs begin"));
    assert.equal(hooked.status, 0, hooked.stderr);
    assert.equal(hooked.stdout, "", "판정은 바꾸지 않는다(허용)");
    assert.deepEqual([runtime(root)?.applied, runtime(root)?.pending], [B, undefined]);
    assert.ok(readFileSync(join(root, ".agents", "skills", "ca-status", "SKILL.md"), "utf8").includes(B_MARK.trim()));
    // 그 명령은 샌드박스 셸처럼 .agents/·.codex/ 를 쓰지 못해도 된다 — 적용은 끝났고 보고만 낸다
    const locked = [join(root, ".agents", "skills", "ca-status", "SKILL.md"), join(root, ".codex", "config.toml")];
    for (const file of locked) chmodSync(file, 0o444);
    try {
      const opened = cli(root, ["docs", "begin"]);
      assert.equal(opened.status, 0, opened.stderr);
      assert.match(opened.stdout, new RegExp(`적용 버전: ${A} → ${B}[\\s\\S]*호스트를 다시 열 필요가 없습니다[\\s\\S]*문서 작성 세션을 열었습니다`));
      assert.equal(lastRun("docs"), B);
      assert.ok(!existsSync(join(root, ".code-agent", "log", "runtime-applied.json")), "보고는 한 번만 낸다");
    } finally { for (const file of locked) chmodSync(file, 0o666); }
  });

  test("진행 중인 일이 있으면 설치만 하고 예약한다 — 지금 일은 기존 버전으로 끝까지, 다음 작업을 열 때 새 버전으로 연다", () => {
    const root = project();
    assert.equal(applyAs(root, A).status, 0);
    const opened = cli(root, ["docs", "begin"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(lastRun("docs"), A);
    const reserved = applyAs(root, B);
    assert.equal(reserved.status, 3, reserved.stderr);
    assert.ok(reserved.stdout.includes(`새 버전 ${B} 설치 완료. 현재 작업은 기존 버전(${A})으로 계속 진행하며, 작업 완료 후 다음 작업부터 새 버전을 적용합니다.`));
    assert.match(reserved.stdout, /대기 사유: 공통 문서 준비 세션/);
    assert.match(reserved.stdout, /호스트를 종료할 필요가 없습니다/);
    assert.deepEqual([runtime(root)?.applied, runtime(root)?.pending?.id], [A, B]);
    assert.ok(!readFileSync(join(root, ".claude", "skills", "ca-status", "SKILL.md"), "utf8").includes(B_MARK.trim()), "예약만 하면 템플릿을 쓰지 않는다");
    cli(root, ["hook"], preToolUse(root));
    assert.equal(lastRun("hook"), A, "진행 중인 일의 hook 은 기존 버전 그대로");
    // 사람이 바로 적용하려 해도 일이 끝나기 전에는 바꾸지 않는다(종료 코드 3)
    const early = cli(root, ["update", "--templates-only"]);
    assert.equal(early.status, 3, early.stderr);
    assert.equal(runtime(root)?.applied, A);
    assert.match(cli(root, ["version"]).stdout, new RegExp(`적용 대기: ${B}[\\s\\S]*적용 시점: 진행 중인 일이 끝난 뒤 다음 작업을 시작할 때 자동으로`));

    rmSync(join(root, ".code-agent", "docs-session.json"));   // 지금 일이 끝났다
    const next = cli(root, ["docs", "begin"]);
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, new RegExp(`적용 버전: ${A} → ${B}`));
    assert.match(next.stdout, /문서 작성 세션을 열었습니다/);
    assert.equal(lastRun("docs"), B, "다음 작업은 새 버전이 연다");
    assert.equal(runtime(root)?.applied, B);
    assert.equal(runtime(root)?.pending, undefined);
    assert.ok(readFileSync(join(root, ".claude", "skills", "ca-status", "SKILL.md"), "utf8").includes(B_MARK.trim()));
  });

  test("적용 버전이 없어지면 진행 중인 일은 다른 버전으로 잇지 않는다 — PreToolUse 는 막고 Stop 은 막지 않으며 조회·복구 명령만 번들로 돈다", () => {
    const root = project();
    mkdirSync(join(root, ".code-agent"), { recursive: true });
    writeFileSync(join(root, ".code-agent", "runtime.json"), JSON.stringify({ schema: 1, applied: GONE }));
    assert.equal(cli(root, ["hook"], preToolUse(root)).status, 0, "쉬는 중이면 진입점 번들로 돈다");
    assert.equal(lastRun("hook"), "bundle");
    writeFileSync(join(root, ".code-agent", "docs-session.json"), JSON.stringify({ startedAt: new Date().toISOString(), version: 2, writable: ["doc"] }));
    const blocked = cli(root, ["hook"], preToolUse(root));
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, new RegExp(`${GONE} 가 릴리스 저장소`));
    assert.equal(cli(root, ["stop"], JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "Stop" })).status, 0, "Stop 은 막지 않는다");
    const next = cli(root, ["next"]);
    assert.equal(next.status, 1);
    assert.match(next.stderr, /다른 버전으로 이어 가지 않습니다/);
    const version = cli(root, ["version"]);
    assert.equal(version.status, 0);
    assert.match(version.stderr, /상태 확인·복구 명령만 이 진입점의 번들로 실행합니다/);
    assert.match(cli(root, ["doctor"]).stdout, new RegExp(`✗ 적용 버전: ${GONE} 가 릴리스 저장소\\(.+\\)에 없습니다`));
  });

  test("기존 절대 경로 설치(--cli 의 hook·MCP)는 설정을 바꾸지 않고 그대로 이행한다 — 그 경로의 cli.js 가 고정 진입점이다", () => {
    const root = join(scratch, `project ${++count}`);
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    init(root, { host: "both", cli: ENTRY });
    writeFileSync(join(root, "README.md"), "project\n");
    const files = [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml"].map((file) => join(root, file));
    const before = files.map((file) => readFileSync(file, "utf8"));
    assert.ok(before.every((text) => text.includes(JSON.stringify(ENTRY).slice(1, -1)) || text.includes(ENTRY.split("\\").join("/")) || text.includes(ENTRY)));
    assert.equal(applyAs(root, A).status, 0);
    assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), before, "hook·MCP 설정은 그대로 — 릴리스 폴더를 쓰지 않는다");
    cli(root, ["hook"], preToolUse(root));
    assert.equal(lastRun("hook"), A, "설정된 그 경로로 부른 hook 이 적용 버전으로 돈다");
    cli(root, ["codex-event"], JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: ["code-agent", "status"] } }));
    assert.equal(lastRun("codex-event"), A, "Codex hook 은 작업 경로를 stdin 으로만 받아도 같은 버전을 고른다");
  });

  test("설치 중(임시 폴더·설치 잠금)에 부른 hook·CLI 는 지금 적용 버전으로 돈다", () => {
    const root = project();
    assert.equal(applyAs(root, A).status, 0);
    const staging = join(store, `.staging-1.0.0-dddddddddddd-${process.pid}-abcdef12`);
    mkdirSync(join(staging, "dist", "agent"), { recursive: true });
    writeFileSync(join(staging, "dist", "agent", "cli.js"), "throw new Error('half installed')");
    writeFileSync(join(store, "install.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    try {
      assert.equal(cli(root, ["hook"], preToolUse(root)).status, 0);
      assert.equal(lastRun("hook"), A);
      assert.equal(versionOf(root).running.id, A);
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(join(store, "install.lock"), { force: true });
    }
  });

  test("응답·적용을 기다리는 확인이 있으면 바꾸지 않고 예약한다 — 지금 적용 중인 갱신 동의 자신은 세지 않는다", () => {
    const root = join(scratch, `project ${++count}`);
    mkdirSync(root, { recursive: true });
    setupConsentProject(root);
    init(root, { host: "claude" });
    const id = JSON.parse(prepareConsent(root, { action: "docs" }, { binding: { id: "owner", host: "claude" } })).id as string;
    const reserved = applyAs(root, A);
    assert.equal(reserved.status, 3, reserved.stderr);
    assert.match(reserved.stdout, /대기 사유: 응답·적용을 기다리는 확인: /);
    const result = spawnSync(process.execPath, [join(store, A, "dist", "agent", "cli.js"), "update", "--apply-release", A, "--trigger", "update", "--consent", id],
      { cwd: root, encoding: "utf8", env: env({ CODE_AGENT_RUNTIME_SELF: "1", CODE_AGENT_ENTRY: ENTRY }) });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(runtime(root)?.applied, A);
  });

  test("상태 형식 세대가 더 높은 프로젝트에는 낮은 세대의 릴리스를 적용하지 않는다(되돌리기의 한계)", () => {
    const root = project();
    mkdirSync(join(root, ".code-agent"), { recursive: true });
    const newer = STATE_SCHEMA + 1;
    writeFileSync(join(root, ".code-agent", "runtime.json"), JSON.stringify({ schema: 1, stateSchema: newer }));
    const refused = applyAs(root, A);
    assert.equal(refused.status, 1);
    assert.ok(refused.stderr.includes(`더 새 형식(세대 ${newer})`), refused.stderr);
    assert.deepEqual(runtime(root), { schema: 1, stateSchema: newer });
  });
});

describe("템플릿 적용", () => {
  test("사람이 고친 사본은 덮어쓰지 않고 새 번들을 template-conflicts 에 둔다 — 고치지 않은 사본은 새 버전으로 바뀐다", () => {
    const root = project();
    assert.equal(applyAs(root, A).status, 0);
    const mine = join(root, ".claude", "skills", "ca-next", "SKILL.md");
    writeFileSync(mine, `${readFileSync(mine, "utf8")}\n팀 규칙: 재개 전에 담당자에게 알린다\n`);
    const applied = applyAs(root, B);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(readFileSync(mine, "utf8"), /팀 규칙: 재개 전에 담당자에게 알린다/);
    assert.ok(!readFileSync(mine, "utf8").includes(B_MARK.trim()));
    assert.ok(readFileSync(join(root, ".code-agent", "template-conflicts", ".claude", "skills", "ca-next", "SKILL.md"), "utf8").includes(B_MARK.trim()));
    assert.ok(readFileSync(join(root, ".claude", "skills", "ca-status", "SKILL.md"), "utf8").includes(B_MARK.trim()));
    assert.match(applied.stdout, /사람이 고친 사본 1개는 덮어쓰지 않았습니다: \.claude\/skills\/ca-next\/SKILL\.md/);
    assert.match(applied.stdout, /바뀐 스킬 1개\(\.claude\/skills\/ca-status\/SKILL\.md\) — 대화에 이미 실린 스킬 본문은 이전 버전입니다\. 지금 단계의 스킬은 그 SKILL\.md 를 파일로 다시 읽고 따릅니다/);
    assert.match(applied.stdout, /호스트를 다시 열 필요가 없습니다\./);
    assert.doesNotMatch(applied.stdout, /손으로 고쳐 두었던 파일을 덮어썼습니다/, "새 번들로 바뀐 사본을 사람이 고친 것으로 잘못 알리지 않는다");
    // 사람이 병합한 뒤(새 번들 내용을 받아들임) 다시 반영하면 기록이 맞춰진다
    writeFileSync(mine, readFileSync(join(root, ".code-agent", "template-conflicts", ".claude", "skills", "ca-next", "SKILL.md"), "utf8"));
    const again = cli(root, ["update", "--templates-only"]);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /사람이 고친 사본/);
  });

  test("템플릿 반영 도중 실패하면 반영 전 파일로 되돌리고 적용 버전을 바꾸지 않는다", () => {
    const root = project();
    assert.equal(applyAs(root, A).status, 0);
    // B 는 ca-next·ca-status 를 바꾼다 — 나중에 쓰는 ca-status 를 쓸 수 없게 해 먼저 쓴 ca-next 가 되돌려지는지 본다
    const paths = [...hostAssets("claude").keys()];
    const [first, later] = ["ca-next", "ca-status"].map((name) => paths.find((path) => path.endsWith(`/skills/${name}/SKILL.md`))!);
    assert.ok(paths.indexOf(first) < paths.indexOf(later));
    const written = join(root, ...first.split("/")), blocked = join(root, ...later.split("/"));
    const before = readFileSync(written, "utf8");
    chmodSync(blocked, 0o444);
    try {
      const failed = applyAs(root, B);
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /템플릿 적용 중 실패했습니다[\s\S]*반영 전 파일로 모두 되돌렸습니다[\s\S]*적용 버전은 바꾸지 않았습니다/);
    } finally { chmodSync(blocked, 0o666); }
    assert.equal(readFileSync(written, "utf8"), before, "먼저 쓴 사본도 되돌린다");
    assert.equal(runtime(root)?.applied, A);
    assert.equal(JSON.parse(readFileSync(join(root, ".code-agent", "templates.json"), "utf8")).release, A);
  });

  test("바뀐 설치 파일과 templates.json 은 다음 작업의 준비 커밋 대상이고, 이 PC 의 적용 버전 기록은 커밋하지 않는다", () => {
    const root = project();
    assert.equal(applyAs(root, A).status, 0);
    const files = baselineFiles(root);
    assert.ok(files.includes(".code-agent/templates.json"));
    assert.ok(!files.includes(".code-agent/runtime.json"));
    for (const file of [".code-agent/runtime.json", ".code-agent/runtime.lock", ".code-agent/template-conflicts/x"]) {
      assert.equal(spawnSync("git", ["check-ignore", "-q", file], { cwd: root }).status, 0, `${file} 는 .gitignore 블록이 제외한다`);
    }
  });
});

describe("npm 패키지 진입점 — 사람이 패키지 관리자로 설치한 패키지를 릴리스로 들인다", () => {
  const PKG_MARK = "\n<!-- package reinstalled -->\n";
  let pkgRoot: string, hoisted: string;
  const pkgCli = (root: string, args: string[], input = "", extra: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, [join(pkgRoot, "dist", "agent", "cli.js"), ...args], { cwd: root, input, encoding: "utf8", env: env(extra), timeout: 120_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const endSession = (root: string) => rmSync(join(root, ".code-agent", "docs-session.json"));
  const reinstall = (mark: string) => appendFileSync(join(pkgRoot, "template", "claude", "skills", "ca-status", "SKILL.md"), mark);

  before(() => {
    const global = join(scratch, "global", "node_modules");
    pkgRoot = join(global, "code-agent");
    for (const part of ["agent", "core"]) cpSync(join(REPO, "dist", part), join(pkgRoot, "dist", part), { recursive: true });
    cpSync(join(REPO, "template"), join(pkgRoot, "template"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(pkgRoot, "package.json"));
    // 의존성은 위 폴더에 끌어올려져 있다(npm 의 평탄한 설치). 링크라서 복사는 실제 내용을 따라가야 한다
    hoisted = join(global, "zod");
    symlinkSync(join(REPO, "node_modules", "zod"), hoisted, "junction");
  });
  after(() => {
    unlinkSync(hoisted);
    // 복사본이 링크를 그대로 옮겼다면 바깥 정리가 이 저장소의 의존성을 따라 지우지 않게 먼저 끊는다
    for (const name of readdirSync(store)) {
      const dep = join(store, name, "node_modules", "zod");
      try { if (lstatSync(dep).isSymbolicLink()) unlinkSync(dep); } catch { /* 없다 */ }
    }
  });

  test("다음 작업을 열 때 그 패키지를 릴리스로 복사해 적용하고, 패키지를 다시 설치해도 진행 중인 작업은 사본으로 돈다", () => {
    const root = project();
    const first = packageRelease(pkgRoot).id;
    const opened = pkgCli(root, ["docs", "begin"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.ok(opened.stdout.includes(`npm 패키지 1.0.0 을 ${first} 로 복사했습니다`), opened.stdout);
    assert.match(opened.stdout, new RegExp(`적용 버전: 번들 → ${first}`));
    assert.match(opened.stdout, /문서 작성 세션을 열었습니다/);
    assert.equal(lastRun("docs"), first, "작업은 패키지의 사본(릴리스)이 연다");
    assert.deepEqual([runtime(root)?.applied, runtime(root)?.adopted], [first, first]);
    const copied = JSON.parse(readFileSync(join(store, first, "release.json"), "utf8")) as { source: unknown; contentHash: string };
    assert.deepEqual(copied.source, { kind: "package", contentHash: copied.contentHash });
    assert.ok(!lstatSync(join(store, first, "node_modules", "zod")).isSymbolicLink(), "의존성은 실제 내용으로 복사한다");

    // 사람이 npm 으로 새 버전을 설치했다 — 진입점 패키지가 통째로 바뀐다
    reinstall(PKG_MARK);
    const second = packageRelease(pkgRoot).id;
    assert.notEqual(second, first);
    pkgCli(root, ["hook"], preToolUse(root));
    assert.equal(lastRun("hook"), first, "진행 중인 작업의 hook 은 복사해 둔 이전 버전 그대로");
    const view = JSON.parse(pkgCli(root, ["version", "--json"]).stdout) as { running: { entryPackage: { id: string } }; project: { applied: string } };
    assert.deepEqual([view.running.entryPackage.id, view.project.applied], [second, first]);
    assert.ok(pkgCli(root, ["version"]).stdout.includes(`진입점 npm 패키지: ${second} — 다음 작업을 열 때 이 패키지의 사본을 적용합니다`));

    endSession(root);   // 지금 일이 끝났다
    const next = pkgCli(root, ["docs", "begin"]);
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, new RegExp(`적용 버전: ${first} → ${second}`));
    assert.equal(lastRun("docs"), second);
    assert.ok(readFileSync(join(root, ".claude", "skills", "ca-status", "SKILL.md"), "utf8").includes(PKG_MARK.trim()));
  });

  test("사람이 고른 릴리스(--release)는 같은 패키지로 되돌리지 않고, 새 패키지를 설치하면 다음 작업부터 그 패키지로 간다", () => {
    const root = project();
    assert.equal(pkgCli(root, ["docs", "begin"]).status, 0);
    endSession(root);
    const current = packageRelease(pkgRoot).id;
    assert.equal(runtime(root)?.applied, current);
    // update --release A — 터미널 확인 뒤 그 릴리스가 스스로 적용한다
    assert.equal(applyAs(root, A, "release").status, 0);
    const kept = pkgCli(root, ["docs", "begin"]);
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(lastRun("docs"), A, "같은 패키지로는 되돌리지 않는다");
    assert.deepEqual([runtime(root)?.applied, runtime(root)?.adopted], [A, current]);
    assert.ok(pkgCli(root, ["version"]).stdout.includes(`진입점 npm 패키지: ${current} — 사람이 고른 적용 버전을 둡니다`));
    endSession(root);
    reinstall("\n<!-- package 3 -->\n");
    const third = packageRelease(pkgRoot).id;
    const moved = pkgCli(root, ["docs", "begin"]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, new RegExp(`적용 버전: ${A} → ${third}`));
  });

  test("설치되지 않은 폴더에는 패키지를 들이지 않는다 — 다음 작업을 여는 명령도, update --templates-only 도", () => {
    const bare = join(scratch, `bare package repo ${++count}`);
    mkdirSync(bare, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: bare });
    const releases = readdirSync(store).sort();
    reinstall(`\n<!-- not installed ${count} -->\n`);   // 아직 아무 프로젝트도 들이지 않은 패키지
    pkgCli(bare, ["docs", "begin"]);
    const refused = pkgCli(bare, ["update", "--templates-only"]);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout + refused.stderr, /code-agent 가 설치되어 있지 않아 갱신하지 않습니다/);
    assert.ok(!existsSync(join(bare, ".claude")), "스킬·hook 을 새로 쓰지 않는다");
    assert.ok(!existsSync(join(bare, ".code-agent", "runtime.json")));
    assert.ok(!existsSync(join(bare, ".code-agent", "templates.json")));
    assert.deepEqual(readdirSync(store).sort(), releases, "패키지를 복사하지 않는다");
  });

  test("update --templates-only 는 지금 패키지를 들인다 — 진행 중이면 예약(종료 코드 3)하고 일이 끝난 뒤 다시 실행하면 적용한다", () => {
    const root = project();
    mkdirSync(join(root, ".code-agent"), { recursive: true });
    writeFileSync(join(root, ".code-agent", "docs-session.json"), JSON.stringify({ startedAt: new Date().toISOString(), version: 2, writable: ["doc"] }));
    const id = packageRelease(pkgRoot).id;
    const reserved = pkgCli(root, ["update", "--templates-only"]);
    assert.equal(reserved.status, 3, reserved.stderr);
    assert.ok(reserved.stdout.includes(`새 버전 ${id} 설치 완료. 현재 작업은 기존 버전(번들)으로 계속 진행하며`), reserved.stdout);
    assert.equal(runtime(root)?.pending?.id, id);
    endSession(root);
    const applied = pkgCli(root, ["update", "--templates-only"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual([runtime(root)?.applied, runtime(root)?.pending, runtime(root)?.adopted], [id, undefined, id]);
  });

  test("복사·검증에 실패하거나 저장소를 쓸 수 없으면 아무것도 등록하지 않고 지금 버전으로 작업을 연다", () => {
    const root = project();
    const broken = join(pkgRoot, "dist", "agent", "zzBroken.js");
    writeFileSync(broken, "throw new Error('broken package');\n");
    try {
      const id = packageRelease(pkgRoot).id;
      const opened = pkgCli(root, ["docs", "begin"]);
      assert.equal(opened.status, 0, opened.stderr);
      assert.match(opened.stdout, /진입점 npm 패키지를 이 프로젝트에 적용하지 못했습니다 — 새 버전 모듈 로드 검사 실패/);
      assert.match(opened.stdout, /문서 작성 세션을 열었습니다/);
      assert.equal(runtime(root)?.applied, undefined);
      assert.ok(!existsSync(join(store, id)), "검증하지 못한 사본은 등록하지 않는다");
      assert.deepEqual(readdirSync(store).filter((name) => name.startsWith(".staging-")), [], "임시 폴더도 남기지 않는다");
    } finally { rmSync(broken); }
    endSession(root);
    const notAStore = join(scratch, "not a store");
    writeFileSync(notAStore, "");
    const refused = pkgCli(root, ["docs", "begin"], "", { CODE_AGENT_RELEASE_HOME: notAStore });
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stdout, /진입점 npm 패키지를 이 프로젝트에 적용하지 못했습니다/);
    assert.equal(runtime(root)?.applied, undefined);
  });
});

describe("선택 UI MCP — 장시간 실행", () => {
  test("연결부는 시작 때의 버전, 질문 처리는 호출마다 지금 적용 버전 — 결과와 version 으로 확인한다", async () => {
    const root = project("both");
    assert.equal(applyAs(root, A).status, 0);
    // Codex 는 MCP 서버에 임의의 환경 변수를 넘기지 않는다(0.162.1 실측) — 저장소 위치는 runtime.json 의 기록으로 찾는다
    const bare = env();
    delete bare.CODE_AGENT_RELEASE_HOME;
    delete bare.CODE_AGENT_RUNTIME_TRACE;
    const child = spawn(process.execPath, [ENTRY, "choice-server", "--root", root], { cwd: root, env: bare, stdio: ["pipe", "pipe", "pipe"] });
    const queue: Record<string, any>[] = [];
    let waiter: ((message: Record<string, any>) => void) | undefined;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (waiter) { const take = waiter; waiter = undefined; take(message); } else queue.push(message);
    });
    const next = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Record<string, any>>((resolve) => { waiter = resolve; });
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    try {
      send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } } });
      assert.equal((await next()).result.serverInfo.version, A);
      // MCP 가 도는 동안 B 를 적용한다 — 선택 UI 연결은 진행 중인 일이 아니다. MCP 설정은 고정 진입점이라 그대로이고 다시 열 필요가 없다
      const config = readFileSync(join(root, ".codex", "config.toml"), "utf8");
      const switched = applyAs(root, B);
      assert.equal(switched.status, 0, switched.stderr);
      assert.equal(readFileSync(join(root, ".codex", "config.toml"), "utf8"), config);
      assert.ok(!config.includes("release store"), "MCP 설정에 릴리스 폴더를 쓰지 않는다");
      assert.match(switched.stdout, /\.codex\/config\.toml 선택 UI: 그대로/);
      assert.match(switched.stdout, /호스트를 다시 열 필요가 없습니다\./);
      assert.doesNotMatch(switched.stdout, /Codex를 다시 열고 프로젝트 훅을 검토/);
      send({ id: 2, method: "tools/call", params: { name: "ask", arguments: { questions: [{ title: "버전 확인", options: ["예", "아니오"] }] } } });
      const form = await next();
      assert.equal(form.method, "elicitation/create");
      send({ id: form.id, result: { action: "accept", content: { q1: "예" } } });
      const answer = await next();
      const value = JSON.parse(answer.result.content[0].text);
      assert.equal(value.status, "answered");
      assert.equal(value.runtime, B, "이번 호출은 지금 적용 버전의 처리기가 받았다");
      const servers = versionOf(root).choiceServers;
      assert.equal(servers.length, 1);
      assert.equal(servers[0].connector, A);
      assert.equal(servers[0].lastCall?.handler, B);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    assert.deepEqual(versionOf(root).choiceServers, [], "끝난 연결부는 기록을 지운다");
  });
});
