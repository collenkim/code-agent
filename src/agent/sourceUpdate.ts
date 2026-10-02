import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";

import { isPackaged } from "./assets";
import { loadActive } from "./layout";
import { Stop } from "./stop";

export interface SourceUpdateOptions {
  /** Hook CLI override, as in update(). Execution always uses the newly built CLI. */
  cli?: string;
  /** Installation overrides for embedders/tests; never inferred from the target repository. */
  sourceRoot?: string;
  packaged?: boolean;
  /** Optional binding to sourceUpdateSnapshot() captured when consent was shown. */
  expectedSourceSnapshot?: string;
  /** Only npm is replaceable: tests still exercise real Git and fresh CLI subprocesses. */
  runNpm?: (args: readonly string[], cwd: string) => string | void;
}

interface Audit {
  installType: "git-source" | "npm-package" | "non-git" | "binary";
  source?: string;
  target: string;
  branch?: string;
  remote?: string;
  remoteRef?: string;
  upstream?: string;
  // Keep URLs out of displayed summaries: configured credentials may be present.
  remoteUrls?: string;
  remoteFetch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  blocked?: string;
}

function canonical(path: string): string {
  return realpathSync.native(resolve(path));
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function command(file: string, args: readonly string[], cwd: string, timeout = 120_000) {
  return spawnSync(file, [...args], {
    cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    // A preview must not refresh/write the index. Never prompt invisibly for credentials.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

function run(file: string, args: readonly string[], cwd: string, label: string, timeout?: number): string {
  const result = command(file, args, cwd, timeout);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error || result.status !== 0) {
    throw new Stop(`${label} 실패${result.status === null ? "" : ` (exit ${result.status})`}: ${result.error?.message ?? ""}\n${output}`);
  }
  return output;
}

function git(source: string, args: string[]): string {
  return run("git", args, source, `git ${args[0]}`).trim();
}

function localGit(source: string, args: string[]): string | undefined {
  const result = command("git", args, source);
  return !result.error && result.status === 0 ? result.stdout.trim() : undefined;
}

function counts(source: string, upstream: string): [number, number] {
  const values = git(source, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`, "--"]).split(/\s+/).map(Number);
  if (values.length !== 2 || values.some(value => !Number.isInteger(value) || value < 0)) throw new Stop("Git upstream 이력을 확인하지 못했습니다.");
  return values as [number, number];
}

function clean(source: string): void {
  const status = git(source, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status) throw new Stop(`소스에 미커밋 변경이 있습니다. 먼저 사용자 변경을 커밋한 뒤 다시 실행하세요.\n${status}`);
  const states = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"];
  const paths = git(source, ["rev-parse", ...states.flatMap(state => ["--git-path", state])]).split(/\r?\n/);
  if (paths.length !== states.length) throw new Stop("진행 중인 Git 작업 상태를 확인하지 못했습니다.");
  for (let index = 0; index < states.length; index++) {
    if (existsSync(resolve(source, paths[index]))) throw new Stop(`소스에 진행 중인 Git 작업이 있습니다 (${states[index]}). 먼저 해당 작업을 마치세요.`);
  }
}

function audit(repoRoot: string, options: SourceUpdateOptions): Audit {
  const target = canonical(repoRoot);
  if (options.packaged ?? isPackaged()) return {
    installType: "binary", source: process.execPath, target,
    blocked: "단일 실행 파일은 여기서 소스 업데이트할 수 없습니다. 기존 배포 경로에서 새 실행 파일을 받아 교체한 뒤 update --templates-only 를 실행하세요.",
  };
  // Same package root as assets.ts, including npm links and Git worktrees.
  const source = canonical(options.sourceRoot ?? join(dirname(require.resolve("./assets")), "..", ".."));
  const result: Audit = { installType: source.split(/[\\/]/).includes("node_modules") ? "npm-package" : "non-git", source, target };
  const top = localGit(source, ["rev-parse", "--show-toplevel"]);
  if (!top || !samePath(canonical(top), source)) {
    if (existsSync(join(source, ".git"))) {
      result.installType = "git-source";
      result.blocked = "Git 소스 설치의 상태를 읽지 못했습니다. Git 실행 환경과 저장소 접근 권한을 확인하세요.";
      return result;
    }
    result.blocked = result.installType === "npm-package"
      ? "npm 패키지 설치입니다. 기존 설치에 사용한 패키지 관리자·패키지 지정·설치 범위로 업데이트한 뒤 update --templates-only 를 실행하세요. 원본 Git 주소나 전역 설치 여부는 추정하지 않습니다."
      : "이 설치 폴더는 Git 소스 저장소가 아닙니다. 기존 설치/배포 방법으로 새 버전을 설치한 뒤 update --templates-only 를 실행하세요.";
    return result;
  }
  result.installType = "git-source";
  try {
    result.branch = localGit(source, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!result.branch) throw new Stop("소스가 detached HEAD 상태입니다. upstream 이 설정된 브랜치로 전환하세요.");
    result.head = git(source, ["rev-parse", "HEAD"]);
    result.remote = localGit(source, ["config", "--get", `branch.${result.branch}.remote`]);
    result.remoteRef = localGit(source, ["config", "--get-all", `branch.${result.branch}.merge`]);
    result.upstream = localGit(source, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
    if (result.remote) {
      result.remoteUrls = result.remote === "." ? source : localGit(source, ["remote", "get-url", "--all", result.remote]);
      result.remoteFetch = localGit(source, ["config", "--get-all", `remote.${result.remote}.fetch`]);
    }
    clean(source);
    if (samePath(source, target) && loadActive(source)) throw new Stop("소스와 대상이 같은 저장소이며 진행 중인 작업이 있습니다. 사용자 변경을 커밋하고 작업을 마친 뒤 업데이트하세요.");
    if (!result.remote || result.remote.startsWith("-") || !result.remoteUrls || !result.remoteRef?.startsWith("refs/heads/") || result.remoteRef.includes("\n") || !result.upstream) {
      throw new Stop("소스 브랜치에 유효한 upstream 이 필요합니다. 사용할 remote/upstream 을 직접 설정하세요.");
    }
    [result.ahead, result.behind] = counts(source, result.upstream);
    if (result.ahead > 0 && result.behind > 0) throw new Stop("소스와 upstream 이 분기되었습니다 (diverged). fast-forward 업데이트를 할 수 없습니다. 이력을 직접 정리하세요.");
    if (!lockFile(source)) throw new Stop("잠금 파일(package-lock.json 또는 npm-shrinkwrap.json)이 없어 npm ci 를 실행할 수 없습니다.");
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    result.blocked = error.message;
  }
  return result;
}

function summary(value: Audit): string {
  return [
    `설치 유형: ${value.installType}`,
    `소스: ${value.source ?? "단일 실행 파일"}`,
    `대상: ${value.target}`,
    ...(value.branch ? [`브랜치: ${value.branch}`] : []),
    ...(value.remote ? [`remote: ${value.remote}`] : []),
    ...(value.upstream ? [`upstream: ${value.upstream} (로컬 기록: ahead ${value.ahead ?? "?"}, behind ${value.behind ?? "?"})`] : []),
    ...(value.head ? [`현재 커밋: ${value.head}`] : []),
    `소스 확인값: ${fingerprint(value)}`,
    value.blocked ? `업데이트 중단: ${value.blocked}` : "실행: upstream fetch → fast-forward 전용 pull → 필요 시 npm ci --include=dev → npm run build → 새 CLI update --templates-only → doctor",
    "미리보기는 로컬 검사만 수행합니다. 동의 후 fetch/pull 및 필요 시 npm 다운로드와 저장소의 설치·빌드 스크립트(prepare 포함)가 실행됩니다.",
  ].join("\n");
}

/** Read-only, network-free summary suitable for a consent prompt. */
export function previewSourceUpdate(repoRoot: string, options: SourceUpdateOptions = {}): string {
  return summary(audit(repoRoot, options));
}

function fingerprint(value: Audit): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Include this in the consent snapshot even when target and source differ. */
export function sourceUpdateSnapshot(repoRoot: string, options: SourceUpdateOptions = {}): string {
  return fingerprint(audit(repoRoot, options));
}

function lockFile(source: string): string | undefined {
  return ["npm-shrinkwrap.json", "package-lock.json"].find(file => existsSync(join(source, file)));
}

function dependencyInputs(source: string): string {
  return ["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc"].map(file => {
    const path = join(source, file);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }).join("\0");
}

/** npm's hidden lock describes the installed tree, including dev dependencies. */
function dependenciesPresent(source: string): boolean {
  try {
    const wanted = JSON.parse(readFileSync(join(source, lockFile(source)!), "utf8"));
    const installed = JSON.parse(readFileSync(join(source, "node_modules", ".package-lock.json"), "utf8"));
    if (!wanted.packages || !installed.packages) return false;
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const declared = manifest[group] ?? {};
      const locked = wanted.packages[""]?.[group] ?? {};
      if (Object.keys(declared).length !== Object.keys(locked).length || Object.entries(declared).some(([name, spec]) => locked[name] !== spec)) return false;
    }
    return Object.entries(wanted.packages).every(([path, value]) => {
      if (!path) return true;
      const entry = value as { version?: string; integrity?: string; resolved?: string };
      const actual = installed.packages[path];
      return actual && actual.version === entry.version && actual.integrity === entry.integrity && actual.resolved === entry.resolved && existsSync(join(source, path));
    });
  } catch { return false; }
}

function npm(args: readonly string[], cwd: string): string {
  // npm.cmd needs cmd.exe on Windows. Only the two fixed argument lists below
  // reach this shell; paths and caller-provided strings never become shell text.
  return process.platform === "win32"
    ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], cwd, `npm ${args.join(" ")}`, 900_000)
    : run("npm", args, cwd, `npm ${args.join(" ")}`, 900_000);
}

/** Call only after user consent. Re-audit before the first write/network operation. */
export function updateFromSource(repoRoot: string, options: SourceUpdateOptions = {}): string {
  const initial = audit(repoRoot, options);
  if (initial.blocked) throw new Stop(summary(initial));
  if (options.expectedSourceSnapshot !== undefined && options.expectedSourceSnapshot !== fingerprint(initial)) {
    throw new Stop("동의 미리보기 이후 소스 상태/HEAD/remote/upstream 이 바뀌었습니다. 업데이트를 다시 확인하세요. fetch 는 실행하지 않았습니다.");
  }
  const source = initial.source!;
  const output: string[] = [summary(initial)];
  const inputs = dependencyInputs(source);
  let stage = "fetch";
  try {
    // Explicit source ref, no forced refspec, no tags/submodules or other remotes.
    output.push(git(source, ["fetch", "--no-tags", "--no-recurse-submodules", "--", initial.remote!, initial.remoteRef!]));
    const fetched = git(source, ["rev-parse", "FETCH_HEAD"]);
    const afterFetch = audit(repoRoot, options);
    if (afterFetch.blocked) throw new Stop(afterFetch.blocked);
    if (afterFetch.head !== initial.head || afterFetch.branch !== initial.branch || afterFetch.remote !== initial.remote || afterFetch.remoteRef !== initial.remoteRef || afterFetch.upstream !== initial.upstream || afterFetch.remoteUrls !== initial.remoteUrls || afterFetch.remoteFetch !== initial.remoteFetch) {
      throw new Stop("검사 중 소스 HEAD/브랜치/upstream 이 바뀌었습니다. 다시 확인하고 실행하세요.");
    }
    const [ahead, behind] = counts(source, fetched);
    if (ahead > 0 && behind > 0) throw new Stop("fetch 결과 소스와 upstream 이 분기되었습니다 (diverged). fast-forward 업데이트를 중단합니다.");
    stage = "fast-forward pull";
    // Explicit flags override pull.rebase/merge.autoStash configuration. A remote
    // change between fetch and pull still cannot create a merge commit or rebase.
    output.push(git(source, ["-c", "merge.autoStash=false", "-c", "rebase.autoStash=false", "pull", "--ff-only", "--no-rebase", "--no-autostash", "--no-tags", "--no-recurse-submodules", "--", initial.remote!, initial.remoteRef!]));
    clean(source);
    if (!lockFile(source)) throw new Stop("업데이트된 소스에 npm 잠금 파일이 없습니다. 의존성 설치와 빌드를 중단합니다.");
    const runNpm = options.runNpm ?? npm;
    if (inputs !== dependencyInputs(source) || !dependenciesPresent(source)) {
      stage = "npm ci --include=dev";
      output.push(stage, runNpm(["ci", "--include=dev"], source) ?? "");
    } else output.push("잠금 의존성이 설치되어 있어 npm ci 생략");
    stage = "npm run build";
    output.push(stage, runNpm(["run", "build"], source) ?? "");
    const cli = join(source, "dist", "agent", "cli.js");
    if (!existsSync(cli)) throw new Stop(`빌드된 CLI가 없습니다: ${cli}`);
    stage = "새 CLI 템플릿 적용";
    output.push(run(process.execPath, [cli, "update", "--templates-only", "--cli", options.cli ? resolve(initial.target, options.cli) : cli], initial.target, stage));
    stage = "doctor (템플릿 적용 완료 후 점검)";
    output.push(run(process.execPath, [cli, "doctor"], initial.target, stage));
    output.push(`소스 업데이트 완료: ${initial.head} → ${git(source, ["rev-parse", "HEAD"])}`);
    return output.filter(Boolean).join("\n\n");
  } catch (error) {
    throw new Stop([...output.filter(Boolean), `${stage} 단계에서 중단했습니다. 이미 완료된 단계는 유지됩니다.`, error instanceof Error ? error.message : String(error)].join("\n\n"));
  }
}
