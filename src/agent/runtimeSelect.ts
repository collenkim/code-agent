/**
 * 실행 버전 선택 — 진입점(cli.ts)이 명령마다 가장 먼저 부른다. 프로젝트가 적용한 릴리스가 진입점의 번들과 다르면 그 릴리스의
 * cli.js 를 같은 프로세스에서 읽어 넘긴다(hook 은 도구 호출마다 새 프로세스라 다음 호출부터 새 릴리스로 돈다 — 호스트를 다시 열 필요가 없다).
 *
 * 모든 릴리스가 지키는 위임 계약 — 바꾸면 이미 설치된 진입점이 새 릴리스를 부르지 못한다:
 *  - 프로젝트의 적용 버전은 `<루트>/.code-agent/runtime.json` 의 `applied`(릴리스 ID)다. 없으면 진입점의 번들로 돈다.
 *    `home` 은 그 릴리스가 든 저장소다 — 호스트가 환경 변수를 넘기지 않는 프로세스(Codex 의 MCP 서버 등)도 같은 릴리스를 찾는다.
 *  - 릴리스는 `releaseHome()/<ID>/` 에 있고 `release.json`(`id` 가 폴더 이름과 같다)과 `dist/agent/cli.js` 가 있어야 한다.
 *    폴더는 설치·검증을 마친 뒤 이름 바꾸기 한 번으로 생기고 그 뒤로 바뀌지 않는다(releaseStore.ts).
 *  - 위임은 `globalThis[RUNTIME_KEY] = { id, stdin? }` 를 둔 뒤 `require(<릴리스>/dist/agent/cli.js)` 다. 이 값이 있으면 받은 쪽은
 *    다시 고르지 않고, hook 이면 stdin 을 다시 읽지 않고 이 값을 쓴다.
 *  - 환경 변수 `CODE_AGENT_RUNTIME_SELF=1` 은 "고르지 말고 이 릴리스로 돌아라" 다(갱신이 새 릴리스의 적용 명령을 직접 부를 때).
 *    읽은 뒤 지운다 — 자식 프로세스(교차 실행이 띄운 호스트의 hook 등)로 새지 않게.
 *
 * 이 모듈은 fs·path·os 와 layout·stateJson 만 읽는다 — hook 경로에서 도구 호출마다 돈다.
 */
import { existsSync, readFileSync, realpathSync, readdirSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

import { findRepoRoot, STATE_DIR } from "./layout";
import { readJson } from "./stateJson";

export const RUNTIME_KEY = Symbol.for("code-agent.runtime");
export const RUNTIME_FILE = `${STATE_DIR}/runtime.json`;
export const SELF_ENV = "CODE_AGENT_RUNTIME_SELF";
/** 이 코드가 읽고 쓰는 프로젝트 상태(승인 원장·증거·작업 기록)의 형식 세대 — 낮은 세대의 릴리스는 높은 세대가 쓴 프로젝트에 적용하지 않는다 */
export const STATE_SCHEMA = 16;
/** 릴리스 ID — `<패키지 버전>-<식별값 12자>`. 경로 조각으로 쓰므로 이 꼴만 받는다 */
export const RELEASE_ID = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}-[0-9a-f]{12}$/;

export interface RuntimeHandoff { id: string; stdin?: string }
export interface ReleaseInfo {
  schema: 1; id: string; version: string; stateSchema: number; installedAt: string;
  /** 식별값 — Git 소스면 커밋·트리, 패키지 사본이면 내용 해시 */
  source: { kind: "git"; commit: string; tree: string; remote: string; ref: string } | { kind: "package"; contentHash: string };
  contentHash: string;
}
export interface RuntimeState {
  schema: 1;
  /** home: applied 가 든 릴리스 저장소(이 PC 의 경로 — runtime.json 은 커밋하지 않는다) */
  applied?: string; appliedAt?: string; stateSchema?: number; home?: string;
  /** npm 패키지 진입점에서 마지막으로 들인 릴리스 — 사람이 그 뒤 다른 릴리스를 골랐으면(--release) 새 패키지가 설치될 때까지 그 선택을 둔다 */
  adopted?: string;
  pending?: { id: string; since: string; reason: string; home?: string };
}
export type RuntimeChoice =
  | { kind: "self"; root?: string; stdin?: string }
  | { kind: "delegate"; id: string; cli: string; root: string; stdin?: string }
  /** 적용 버전이 없어졌거나 깨졌는데 진행 중인 일이 있다 — 다른 버전으로 이어 가면 섞이므로 돌리지 않는다 */
  | { kind: "unavailable"; id: string; root: string; stdin?: string; reason: string };

/** 릴리스 저장소 — PC·사용자별. 저장소에 공유되는 설정에는 이 경로를 쓰지 않는다 */
export function releaseHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CODE_AGENT_RELEASE_HOME?.trim() || join(homedir(), ".code-agent", "releases"));
}

/**
 * 이 명령을 시작한 진입 파일(고정 진입점) — MCP 설정처럼 버전이 바뀌어도 그대로여야 하는 자리에 쓴다(릴리스 폴더가 아니다).
 * 위임은 같은 프로세스라 require.main 이 진입점이고, 갱신이 새 릴리스의 적용 명령을 직접 부를 때는 CODE_AGENT_ENTRY 로 넘긴다.
 * 진입점이 cli.js 가 아니면(라이브러리로 부른 시험 등) 이 코드 옆의 cli.js 다.
 */
export function entryScript(env: NodeJS.ProcessEnv = process.env): string {
  const main = require.main?.filename;
  return env.CODE_AGENT_ENTRY?.trim() || (main && /[\\/]cli\.js$/.test(main) ? main : join(__dirname, "cli.js"));
}

/**
 * 진입점이 npm 으로 설치한 패키지면 그 패키지 폴더 — 패키지 관리자가 통째로 바꾸는 자리라 작업은 그 사본(릴리스)으로 돈다
 * (runtimeGate.atNextWork 가 다음 작업을 열 때 복사해 고정한다). Git 소스(개발 설치 — 빌드가 곧 적용)·릴리스 폴더는 아니다.
 */
export function entryPackage(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let root: string;
  try { root = realpathSync.native(resolve(entryScript(env), "..", "..", "..")); } catch { return undefined; }
  if (!root.split(/[\\/]/).includes("node_modules") || existsSync(join(root, ".git")) || readRelease(root)) return undefined;
  return existsSync(join(root, "package.json")) && existsSync(join(root, "dist", "agent", "cli.js")) ? root : undefined;
}

export function handoff(): RuntimeHandoff | undefined {
  return (globalThis as Record<symbol, RuntimeHandoff | undefined>)[RUNTIME_KEY];
}

/** 이 코드가 든 릴리스 — 저장소 밖의 번들(소스 폴더·npm 패키지·단일 실행 파일)이면 undefined */
export function ownRelease(): ReleaseInfo | undefined {
  return readRelease(join(__dirname, "..", ".."));
}

/** 이 릴리스가 든 저장소 — 릴리스일 때만 의미가 있다 */
export function ownStore(): string {
  return resolve(__dirname, "..", "..", "..");
}

/** 적용 버전의 저장소 — 기록이 있으면 그 경로, 없으면(이전 기록) 지금 환경의 저장소 */
export function appliedStore(state: RuntimeState | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return state?.home ?? releaseHome(env);
}

/** 버전 조회·직접 선택은 프로젝트의 저장소와 기본 저장소를 함께 본다. */
export function releaseHomes(state: RuntimeState | undefined): string[] {
  return [...new Set([appliedStore(state), releaseHome(), ...(state?.pending?.home ? [state.pending.home] : [])])];
}

export function readRelease(dir: string): ReleaseInfo | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as ReleaseInfo;
    if (value?.schema !== 1 || typeof value.id !== "string" || !RELEASE_ID.test(value.id) || typeof value.stateSchema !== "number") return undefined;
    return value;
  } catch { return undefined; }
}

/** 설치를 마친 릴리스 — 폴더 이름과 기록의 ID 가 같고 진입 파일이 있을 때만 */
export function installedRelease(id: string, home = releaseHome()): { dir: string; cli: string; info: ReleaseInfo } | undefined {
  if (!RELEASE_ID.test(id)) return undefined;
  const dir = join(home, id), info = readRelease(dir), cli = join(dir, "dist", "agent", "cli.js");
  return info?.id === id && existsSync(cli) ? { dir, cli, info } : undefined;
}

export function readRuntime(root: string): RuntimeState | undefined {
  const path = join(root, RUNTIME_FILE);
  if (!existsSync(path)) return undefined;
  return readJson(path, { parse(raw) {
    const value = raw as RuntimeState | null;
    const id = (v: unknown) => typeof v === "string" && RELEASE_ID.test(v);
    const home = (v: unknown) => v === undefined || typeof v === "string" && isAbsolute(v) && !v.includes("\0");
    if (value?.schema !== 1 || (value.applied !== undefined && !id(value.applied)) || !home(value.home) ||
        (value.adopted !== undefined && !id(value.adopted)) ||
        (value.stateSchema !== undefined && (!Number.isInteger(value.stateSchema) || value.stateSchema < 1)) ||
        (value.pending !== undefined && (!value.pending || !id(value.pending.id) || !home(value.pending.home) ||
          typeof value.pending.since !== "string" || typeof value.pending.reason !== "string"))) throw new Error("적용 버전 기록의 필드 형식이 아닙니다");
    return value;
  } }, RUNTIME_FILE);
}

/** status·doctor 의 한 줄 — 적용 버전·적용 대기·없어진 적용 버전. 고정한 적이 없으면 undefined */
export function runtimeLine(root: string): string | undefined {
  let state: RuntimeState | undefined;
  try { state = readRuntime(root); } catch (error) { return `!! ${RUNTIME_FILE} 을 읽지 못했습니다(${error instanceof Error ? error.message : String(error)}) — code-agent version 으로 확인`; }
  if (!state) return undefined;
  const parts = [`적용 버전 ${state.applied ?? "진입점 번들"}`];
  if (state.pending) parts.push(`적용 대기 ${state.pending.id}(다음 작업부터)`);
  if (state.applied && !installedRelease(state.applied, appliedStore(state))) parts.push("!! 적용 버전이 릴리스 저장소에 없음 — code-agent version 으로 확인");
  return parts.join(" · ");
}

/** 다음 작업을 여는 셸 명령(cliMain.ts opening 을 지나는 명령) — PreToolUse hook 이 그 직전에 예약된 새 버전을 적용한다 */
export const OPENING_COMMAND = /^code-agent (?:request begin|docs begin|triage (?:begin|ingest|reassess)|start)(?:\s|$)/;

/** 적용을 기다리는 새 버전이 있는가 — hook 이 무거운 적용 모듈을 읽을지 가르는 가벼운 판정 */
export function pendingSwitch(root: string): boolean {
  try { const state = readRuntime(root); return !!state?.pending && state.pending.id !== state.applied; } catch { return false; }
}

/** 진행 중인 일의 표지 — 작업·접수·문서 세션·사전 판별. 없으면 버전이 바뀌어도 이어지는 일이 없다(동의·잠금은 적용 쪽이 따로 본다) */
export const BUSY_FILES = ["active.json", "request-session.json", "docs-session.json", "log/triage/active.json", "graph/run.lock"] as const;
export function pendingInteractionMarker(root: string): string | undefined {
  const file = join(root, STATE_DIR, "interactions/state.json");
  if (!existsSync(file)) return undefined;
  const { nativeEvidenceReader } = require("./nativeQuestionEvidence") as typeof import("./nativeQuestionEvidence");
  const observed = nativeEvidenceReader(root);
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (state.version !== 1 || !state.requests) return file;
    if (Object.values(state.requests).some((r: any) => r.kind !== "consent" && ["pending", "responded", "deferred"].includes(r.status) && !observed(r))) return file;
  } catch { return file; }
  return undefined;
}
export function busyMarker(root: string): string | undefined {
  for (const file of BUSY_FILES) if (existsSync(join(root, STATE_DIR, file))) return `${STATE_DIR}/${file}`;
  const interaction = pendingInteractionMarker(root);
  if (interaction) return interaction;
  const branches = join(root, STATE_DIR, "branches");
  if (existsSync(branches)) {
    const file = readdirSync(branches).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (file) return `${STATE_DIR}/branches/${file}`;
  }
  return undefined;
}

function projectRoot(command: string | undefined, args: string[], stdin: string | undefined, env: NodeJS.ProcessEnv): string {
  if (command === "choice-server" && args[0] === "--root" && args[1]) return findRepoRoot(args[1]);
  if (stdin !== undefined) {
    let cwd: unknown;
    try { cwd = (JSON.parse(stdin) as { cwd?: unknown }).cwd; } catch { /* hook 이 따로 알린다 */ }
    return findRepoRoot(env.CLAUDE_PROJECT_DIR || (typeof cwd === "string" && cwd ? cwd : process.cwd()));
  }
  return findRepoRoot(process.cwd());
}

/**
 * 이 명령을 어느 릴리스가 돌릴지. hook 하위 명령이면 stdin 을 여기서 한 번 읽어 돌려준다(Codex 는 작업 경로가 stdin 에만 있다).
 * 상태 파일을 읽지 못하면 번들로 돌되, 진행 중인 일이 있으면 돌리지 않는다.
 */
export function selectRuntime(command: string | undefined, args: string[], hook: boolean, readStdin: () => string,
  env: NodeJS.ProcessEnv = process.env): RuntimeChoice {
  const self = env[SELF_ENV] === "1";
  delete env[SELF_ENV];
  const stdin = hook ? readStdin() : undefined;
  // 고정 해제(update --bundled)는 진입점의 번들이 스스로 적용한다. npm 패키지 진입점의 update --templates-only 는 그 패키지를 릴리스로 들인다
  if (self || (command === "update" && (args.includes("--bundled") || (args.includes("--templates-only") && entryPackage(env))))) return { kind: "self", stdin };
  let root: string;
  try { root = projectRoot(command, args, stdin, env); } catch { return { kind: "self", stdin }; }
  let state: RuntimeState | undefined;
  try { state = readRuntime(root); }
  catch (error) {
    const reason = `${RUNTIME_FILE} 을 읽지 못했습니다(${error instanceof Error ? error.message : String(error)})`;
    return busyMarker(root) ? { kind: "unavailable", id: "?", root, stdin, reason } : { kind: "self", root, stdin };
  }
  const id = state?.applied;
  if (!id || id === ownRelease()?.id) return { kind: "self", root, stdin };
  const release = installedRelease(id, appliedStore(state, env));
  if (release) return { kind: "delegate", id, cli: release.cli, root, stdin };
  const reason = `이 프로젝트에 적용한 code-agent ${id} 가 릴리스 저장소(${appliedStore(state, env)})에 없습니다`;
  return busyMarker(root) ? { kind: "unavailable", id, root, stdin, reason } : { kind: "self", root, stdin };
}
