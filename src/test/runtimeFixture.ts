/**
 * 버전 선택·적용 — 실제 code-agent 릴리스 둘(A·B, 이 저장소의 빌드를 격리된 릴리스 저장소에 옮긴 것)로 본다.
 * 고정 진입점(dist/agent/cli.js)이 프로젝트마다 적용 버전을 골라 같은 프로세스에서 넘기는지, 진행 중인 일이 있으면 적용을 예약했다가
 * 다음 작업을 열 때 적용하는지, 템플릿 보존·되돌리기·상태 세대·선택 UI MCP 를 실행 기록(CODE_AGENT_RUNTIME_TRACE)으로 확인한다.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { after, before } from "node:test";

import { init } from "../agent/init";

import { STATE_SCHEMA } from "../agent/runtimeSelect";

import { CALLER_KEYS } from "./reviewFixture";

export const REPO = join(__dirname, "..", "..");
export const ENTRY = join(REPO, "dist", "agent", "cli.js");
export const A = "1.0.0-aaaaaaaaaaaa", B = "1.0.0-bbbbbbbbbbbb", GONE = "1.0.0-cccccccccccc";
export const B_MARK = "\n<!-- release B -->\n";
export let scratch: string, store: string, trace: string;
export let count = 0;
export const nextProjectNumber = (): number => ++count;

/** 이 저장소의 빌드로 릴리스 폴더를 만든다 — 의존성은 이 저장소의 node_modules 를 가리킨다 */
export function release(id: string, change?: (dir: string) => void): void {
  const dir = join(store, id);
  for (const part of ["agent", "core"]) cpSync(join(REPO, "dist", part), join(dir, "dist", part), { recursive: true });
  cpSync(join(REPO, "template"), join(dir, "template"), { recursive: true });
  cpSync(join(REPO, "package.json"), join(dir, "package.json"));
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "junction");
  change?.(dir);
  writeFileSync(join(dir, "release.json"), JSON.stringify({ schema: 1, id, version: "1.0.0", stateSchema: STATE_SCHEMA, installedAt: new Date().toISOString(),
    source: { kind: "git", commit: id.slice(-12).repeat(4).slice(0, 40), tree: "0".repeat(40), remote: "origin", ref: "refs/heads/main" }, contentHash: "0".repeat(64) }));
}

export function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // doctor·init 은 Codex 준비를 묻는다 — 실제 Codex·사용자 CODEX_HOME 대신 모의 app-server 와 임시 CODEX_HOME 으로
  const value: NodeJS.ProcessEnv = { ...process.env, CODE_AGENT_HOME: join(scratch, "pc-store"), CODE_AGENT_RELEASE_HOME: store, CODE_AGENT_RUNTIME_TRACE: trace,
    CODEX_HOME: join(scratch, "codex-home"), CODE_AGENT_CODEX_BIN: join(__dirname, "masterCodexFakeHost.js"), ...extra };
  for (const key of ["CLAUDE_PROJECT_DIR", ...(extra.CODE_AGENT_RUNTIME_SELF ? [] : ["CODE_AGENT_RUNTIME_SELF"]), ...(extra.CODE_AGENT_ENTRY ? [] : ["CODE_AGENT_ENTRY"])]) delete value[key];
  // 사람의 터미널로 둔다 — 시험을 어느 호스트 안에서 돌려도 같게(시작 게이트는 실행 호스트의 설치 기록을 본다)
  for (const key of CALLER_KEYS) if (!(key in extra)) delete value[key];
  return value;
}

export function cli(project: string, args: string[], input = ""): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd: project, input, encoding: "utf8", env: env(), timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 갱신이 하는 그대로 — 그 릴리스의 CLI 가 스스로(고르지 않고) 적용한다 */
export function applyAs(project: string, id: string, trigger = "update"): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(store, id, "dist", "agent", "cli.js"), "update", "--apply-release", id, "--trigger", trigger],
    { cwd: project, encoding: "utf8", env: env({ CODE_AGENT_RUNTIME_SELF: "1", CODE_AGENT_ENTRY: ENTRY }), timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 그 명령을 마지막으로 실제로 돌린 코드의 버전(실행 기록) — 시험은 차례로 돌므로 마지막 줄이 방금 실행이다 */
export function lastRun(command: string): string {
  const rows = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { command: string | null; runtime: string });
  return rows.filter((row) => row.command === command).at(-1)!.runtime;
}

export function project(host: "claude" | "both" = "claude"): string {
  const root = join(scratch, `project ${nextProjectNumber()}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  init(root, { host });
  writeFileSync(join(root, "README.md"), "project\n");
  return root;
}

export function runtime(root: string): { applied?: string; pending?: { id: string; reason: string }; stateSchema?: number; adopted?: string } | undefined {
  const file = join(root, ".code-agent", "runtime.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

export function fileSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    }
  }
  visit("");
  return result;
}

export const preToolUse = (root: string) => JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(root, "README.md") } });
export const versionOf = (root: string) => JSON.parse(cli(root, ["version", "--json"]).stdout) as {
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

