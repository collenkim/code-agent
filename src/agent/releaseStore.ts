/**
 * 릴리스 저장소 — 새 버전을 **실행 중인 설치 폴더를 건드리지 않고** 별도 폴더에 설치한다.
 *
 * 순서: 저장소 잠금 → 임시 폴더(`.staging-…`)에 지정 커밋을 꺼냄(소스의 색인·작업 트리는 그대로) → 잠금 의존성 설치·빌드 →
 * 개발 의존성 정리 → 검증(진입 파일·버전·모듈 로드·도움말 실행) → `release.json` → 이름 바꾸기 한 번으로 `<ID>/` 등록.
 * 이름 바꾸기 전에는 어느 진입점도 이 폴더를 고르지 않는다(runtimeSelect.installedRelease 가 `<ID>/release.json` 만 본다) —
 * 중간에 끊긴 설치·실패한 빌드는 임시 폴더로만 남고 다음 설치가 치운다. 등록한 폴더는 바꾸지 않는다.
 *
 * 설치 정책은 둘이다. Git 소스(개발 설치)는 upstream 의 커밋을 받아 빌드한다(installGitRelease — 식별값은 커밋·트리).
 * npm 패키지는 사람이 패키지 관리자로 설치한 것을 그대로 복사한다(installPackageRelease — 식별값은 내용 해시, 받기·빌드 없음).
 */
import { spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, sep } from "path";

import { acquireLock, pidAlive } from "./lock";
import { installedRelease, RELEASE_ID, releaseHome, SELF_ENV, type ReleaseInfo } from "./runtimeSelect";
import { Stop } from "./stop";

export type RunNpm = (args: readonly string[], cwd: string) => string | void;
export interface GitReleaseSource { source: string; remote: string; ref: string }
export interface InstallOutcome { id: string; dir: string; created: boolean; log: string[] }

const STAGING = ".staging-";
/** 끊긴 설치의 임시 폴더를 이만큼 지나면(주인 프로세스가 살아 있어도) 치운다 */
const STAGING_STALE_MS = 24 * 60 * 60 * 1000;

function command(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}, timeout = 120_000) {
  return spawnSync(file, [...args], {
    cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env },
  });
}

export function run(file: string, args: readonly string[], cwd: string, label: string, env: NodeJS.ProcessEnv = {}, timeout?: number): string {
  const result = command(file, args, cwd, env, timeout);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error || result.status !== 0) {
    throw new Stop(`${label} 실패${result.status === null ? "" : ` (exit ${result.status})`}: ${result.error?.message ?? ""}\n${output}`);
  }
  return output;
}

export function npm(args: readonly string[], cwd: string): string {
  // npm.cmd 는 Windows 에서 cmd.exe 가 필요하다. 아래 고정 인자 목록만 이 셸로 간다 — 경로·호출자 문자열은 셸 글자가 되지 않는다
  return process.platform === "win32"
    ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], cwd, `npm ${args.join(" ")}`, {}, 900_000)
    : run("npm", args, cwd, `npm ${args.join(" ")}`, {}, 900_000);
}

/** 설치·정리를 한 PC 에서 하나씩 — 같은 저장소에 두 갱신이 겹치면 두 번째는 기다리다 멈춘다(설치 중인 폴더를 서로 지우지 않게) */
export function lockStore(home = releaseHome()): () => void {
  mkdirSync(home, { recursive: true });
  return acquireLock(join(home, "install.lock"), {
    waitMs: 2_000, ageReclaim: true, label: "릴리스 설치",
    messages: { busy: (lock) => `다른 code-agent 갱신이 같은 릴리스 저장소에 설치하는 중입니다 (pid ${lock.pid}). 끝난 뒤 다시 실행하세요 — 잠금: ${lock.display}` },
  });
}

/** 저장소의 릴리스 — 설치한 순서대로(오래된 것 먼저) */
export function listReleases(home = releaseHome()): ReleaseInfo[] {
  let names: string[];
  try { names = readdirSync(home); } catch { return []; }
  return names.filter((name) => RELEASE_ID.test(name)).flatMap((name) => installedRelease(name, home)?.info ?? [])
    .sort((a, b) => a.installedAt.localeCompare(b.installedAt));
}

/** 끊긴 설치의 임시 폴더 — 주인 프로세스가 없거나 오래된 것만. 저장소 잠금 안에서 부른다 */
export function sweepStaging(home = releaseHome(), now = Date.now()): string[] {
  let names: string[];
  try { names = readdirSync(home); } catch { return []; }
  const removed: string[] = [];
  for (const name of names.filter((entry) => entry.startsWith(STAGING))) {
    const pid = Number(/-(\d+)-[0-9a-f]{8}(?:\.index)?$/.exec(name)?.[1]);
    let age = 0;
    try { age = now - statSync(join(home, name)).mtimeMs; } catch { continue; }
    if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid) && age < STAGING_STALE_MS) continue;
    try { rmSync(join(home, name), { recursive: true, force: true }); removed.push(name); } catch { /* 다음 설치가 다시 본다 */ }
  }
  return removed;
}

/** 배포물 내용의 해시 — 실행에 쓰는 dist·template·package.json(설치 의존성은 잠금 파일이 정한다) */
export function contentHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (path: string): string[] => {
    if (!existsSync(path)) return [];
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path).sort().flatMap((name) => walk(join(path, name)));
  };
  for (const file of ["dist", "template", "package.json"].flatMap((entry) => walk(join(dir, entry)))) {
    hash.update(relative(dir, file).split("\\").join("/")).update("\0").update(readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
}

/**
 * 설치한 폴더가 실행될 수 있는지 — 진입 파일·버전, 모든 모듈 로드(cli.js 제외 — 읽으면 명령이 돈다), `help` 실행.
 * 등록 전에만 부른다. 실패하면 Stop.
 */
export function verifyRelease(dir: string, version: string): void {
  const cli = join(dir, "dist", "agent", "cli.js");
  if (!existsSync(cli)) throw new Stop(`빌드된 CLI가 없습니다: ${cli}`);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
  if (manifest.version !== version) throw new Stop(`빌드 결과의 버전(${manifest.version})이 설치하려던 버전(${version})과 다릅니다.`);
  const probe = "const fs=require('fs'),p=require('path');const d=p.join(process.cwd(),'dist');const w=x=>fs.statSync(x).isDirectory()?fs.readdirSync(x).flatMap(n=>w(p.join(x,n))):[x];" +
    "for(const f of w(d)){if(!f.endsWith('.js')||f.includes(p.sep+'test'+p.sep)||f===p.join(d,'agent','cli.js'))continue;require(f)}";
  run(process.execPath, ["-e", probe], dir, "새 버전 모듈 로드 검사");
  const help = run(process.execPath, [cli, "help"], dir, "새 버전 실행 검사", { [SELF_ENV]: "1" });
  if (!help.startsWith("code-agent")) throw new Stop(`새 버전의 도움말 출력이 예상과 다릅니다: ${help.slice(0, 200)}`);
}

/** 이름 바꾸기 — Windows 에서 방금 쓴 파일을 백신 등이 잠깐 쥐면 EPERM·EBUSY 가 난다. 짧게 다시 본다 */
function renameDir(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function git(source: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return run("git", args, source, `git ${args[0] === "-c" ? args[2] : args[0]}`, env).trim();
}

/**
 * Git 소스의 upstream 을 받아 그 커밋을 릴리스로 설치한다. 소스의 작업 트리·색인·브랜치는 바꾸지 않는다(받기는 FETCH_HEAD 만 쓴다).
 * 이미 설치한 커밋이면 다시 빌드하지 않는다. 실패하면 아무것도 등록하지 않는다.
 */
export function installGitRelease(from: GitReleaseSource, runNpm: RunNpm = npm, home = releaseHome()): InstallOutcome {
  const release = lockStore(home);
  const log: string[] = [];
  let staging: string | undefined;
  try {
    const swept = sweepStaging(home);
    if (swept.length) log.push(`끊긴 설치의 임시 폴더 ${swept.length}개를 치웠습니다`);
    // 지정한 원격 브랜치만 — 강제 refspec·태그·하위 모듈·다른 원격 없음. --refmap= 은 원격 추적 브랜치도 옮기지 않는다(FETCH_HEAD 만)
    log.push(git(from.source, ["fetch", "--no-tags", "--no-recurse-submodules", "--refmap=", "--", from.remote, from.ref]));
    const commit = git(from.source, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    const tree = git(from.source, ["rev-parse", "--verify", `${commit}^{tree}`]);
    const pkg = JSON.parse(git(from.source, ["show", `${commit}:package.json`])) as { version?: unknown };
    if (typeof pkg.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(pkg.version)) throw new Stop("받은 커밋의 package.json 에 버전이 없습니다.");
    const id = `${pkg.version}-${commit.slice(0, 12)}`;
    const existing = installedRelease(id, home);
    if (existing) {
      log.push(`${id} 은 이미 설치되어 있습니다 — 다시 빌드하지 않습니다`);
      return { id, dir: existing.dir, created: false, log };
    }
    staging = join(home, `${STAGING}${id}-${process.pid}-${randomUUID().slice(0, 8)}`);
    mkdirSync(staging, { recursive: true });
    // 소스의 색인 대신 임시 색인으로 그 커밋의 트리를 꺼낸다 — 사용자의 작업 트리·스테이징은 그대로다
    const index = { GIT_INDEX_FILE: `${staging}.index` };
    try {
      git(from.source, ["read-tree", commit], index);
      git(from.source, ["-c", "core.longpaths=true", `--work-tree=${staging}`, "checkout-index", "-a", "-f"], index);
    } finally { rmSync(`${staging}.index`, { force: true }); }
    if (!["npm-shrinkwrap.json", "package-lock.json"].some((file) => existsSync(join(staging!, file)))) {
      throw new Stop("받은 커밋에 npm 잠금 파일이 없습니다. 의존성 설치와 빌드를 하지 않았습니다.");
    }
    log.push("npm ci --include=dev", runNpm(["ci", "--include=dev"], staging) ?? "");
    log.push("npm run build", runNpm(["run", "build"], staging) ?? "");
    try { log.push("npm prune --omit=dev", runNpm(["prune", "--omit=dev"], staging) ?? ""); }
    catch (error) { log.push(`개발 의존성 정리를 건너뜁니다(실행에는 지장 없음): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
    verifyRelease(staging, pkg.version);
    const info: ReleaseInfo = {
      schema: 1, id, version: pkg.version, stateSchema: stateSchemaOf(staging), installedAt: new Date().toISOString(),
      source: { kind: "git", commit, tree, remote: from.remote, ref: from.ref }, contentHash: contentHash(staging),
    };
    writeFileSync(join(staging, "release.json"), `${JSON.stringify(info, null, 2)}\n`);
    const target = join(home, id);
    if (installedRelease(id, home)) {
      log.push(`${id} 은 다른 갱신이 먼저 설치했습니다`);
    } else {
      rmSync(target, { recursive: true, force: true });   // 기록 없는 같은 이름 폴더(손상) — 등록된 릴리스가 아니다
      renameDir(staging, target);
      staging = undefined;
      log.push(`${id} 을 설치했습니다 — ${target}`);
    }
    return { id, dir: target, created: true, log };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    release();
  }
}

/**
 * npm 으로 설치한 패키지(진입점)를 릴리스로 복사한다 — 패키지 관리자가 그 폴더를 바꿔도(다음 설치) 이 사본으로 고정한 작업은 그대로 돈다.
 * 받지 않고 이미 설치된 것만 복사한다(배포 경로·신뢰 기준은 사람이 쓴 패키지 관리자의 것 그대로). 식별값은 dist·template·package.json 의
 * 내용 해시다 — 같은 내용이면 다시 복사하지 않는다. 의존성은 그 패키지가 실제로 읽는 폴더를 따라 복사하고(링크는 실제 내용으로),
 * 복사한 내용이 처음 본 해시와 같고 검증을 마친 뒤에만 등록한다.
 */
export function installPackageRelease(packageRoot: string, home = releaseHome()): InstallOutcome {
  const { id, version, hash } = packageRelease(packageRoot);
  const found = installedRelease(id, home);
  if (found) return { id, dir: found.dir, created: false, log: [`${id} 은 이미 릴리스 저장소에 있습니다`] };
  const release = lockStore(home);
  const log: string[] = [];
  let staging: string | undefined;
  try {
    const swept = sweepStaging(home);
    if (swept.length) log.push(`끊긴 설치의 임시 폴더 ${swept.length}개를 치웠습니다`);
    const again = installedRelease(id, home);
    if (again) return { id, dir: again.dir, created: false, log: [...log, `${id} 은 다른 명령이 먼저 복사했습니다`] };
    staging = join(home, `${STAGING}${id}-${process.pid}-${randomUUID().slice(0, 8)}`);
    mkdirSync(staging, { recursive: true });
    for (const entry of ["dist", "template", "package.json", "npm-shrinkwrap.json", "package-lock.json"]) {
      if (existsSync(join(packageRoot, entry))) cpSync(join(packageRoot, entry), join(staging, entry), { recursive: true, dereference: true });
    }
    copyDependencies(packageRoot, staging);
    if (contentHash(staging) !== hash) throw new Stop("복사하는 동안 패키지 내용이 바뀌었습니다 — 패키지 설치가 끝난 뒤 다시 실행하세요.");
    verifyRelease(staging, version);
    const info: ReleaseInfo = {
      schema: 1, id, version, stateSchema: stateSchemaOf(staging), installedAt: new Date().toISOString(),
      source: { kind: "package", contentHash: hash }, contentHash: hash,
    };
    writeFileSync(join(staging, "release.json"), `${JSON.stringify(info, null, 2)}\n`);
    const target = join(home, id);
    rmSync(target, { recursive: true, force: true });   // 기록 없는 같은 이름 폴더(손상) — 등록된 릴리스가 아니다
    renameDir(staging, target);
    staging = undefined;
    log.push(`npm 패키지 ${version} 을 ${id} 로 복사했습니다 — ${target}`);
    return { id, dir: target, created: true, log };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    release();
  }
}

/** npm 패키지의 릴리스 ID — `<버전>-<내용 해시 12자>`. 복사하지 않고 계산만 한다 */
export function packageRelease(packageRoot: string): { id: string; version: string; hash: string } {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(manifest.version)) throw new Stop(`패키지의 package.json 에 버전이 없습니다: ${packageRoot}`);
  const hash = contentHash(packageRoot);
  return { id: `${manifest.version}-${hash.slice(0, 12)}`, version: manifest.version, hash };
}

/** Node의 검색 순서와 중첩 버전을 보존한다. 위 폴더에서 찾은 같은 사본만 최상위에서 공유한다. */
function copyDependencies(packageRoot: string, staging: string): void {
  const copies = new Map<string, string>(), visited = new Set<string>();
  const dependencies = (from: string) => Object.keys((JSON.parse(readFileSync(join(from, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
  const locate = (from: string, name: string): { source: string; local: boolean } => {
      let dir = from;
      for (;;) {
        const candidate = join(dir, "node_modules", name);
        if (existsSync(join(candidate, "package.json"))) return { source: realpathSync.native(candidate), local: dir === from };
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      throw new Stop(`패키지의 실행 의존성 ${name} 을 찾지 못했습니다(${packageRoot} 기준).`);
  };
  const copy = (source: string, target: string) => {
    copies.set(target, source);
    cpSync(source, target, { recursive: true, dereference: true });
  };
  const visit = (from: string, to: string): void => {
    if (visited.has(to)) return;
    visited.add(to);
    for (const name of dependencies(from)) {
      const found = locate(from, name);
      let ancestor = to, existing: string | undefined;
      for (;;) {
        const candidate = join(ancestor, "node_modules", name);
        if (copies.has(candidate) || existsSync(join(candidate, "package.json"))) { existing = candidate; break; }
        if (ancestor === staging) break;
        ancestor = dirname(ancestor);
        if (!ancestor.startsWith(staging + sep) && ancestor !== staging) break;
      }
      if (existing && copies.get(existing) === found.source) continue;
      const flat = join(staging, "node_modules", name);
      const target = found.local || existing || copies.has(flat) ? join(to, "node_modules", name) : flat;
      copy(found.source, target);
      visit(found.source, target);
    }
  };
  // 최상위 직접 의존성을 먼저 고정해야 하위 패키지의 다른 버전이 그 이름을 차지하지 않는다.
  const direct = dependencies(packageRoot).map(name => ({ ...locate(packageRoot, name), target: join(staging, "node_modules", name) }));
  for (const item of direct) copy(item.source, item.target);
  for (const item of direct) visit(item.source, item.target);
}

/**
 * 새 릴리스가 읽고 쓰는 상태의 세대 — 빌드한 runtimeSelect 의 STATE_SCHEMA. 그 상수가 없는 빌드(이 기능 전)는 1 이다.
 * 진입점과 다른 버전의 모듈을 읽지 않도록 파일 글자에서 찾는다.
 */
function stateSchemaOf(dir: string): number {
  try {
    const found = /STATE_SCHEMA\s*=\s*(\d+)/.exec(readFileSync(join(dir, "dist", "agent", "runtimeSelect.js"), "utf8"))?.[1];
    return found ? Number(found) : 1;
  } catch { return 1; }
}

