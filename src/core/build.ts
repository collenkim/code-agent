import { spawn } from "child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { delimiter, isAbsolute, join, resolve } from "path";

import type { Manifest } from "./manifest";
import type { BuildResult, JobRefs, StageResult } from "./types";

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 한 스트림에서 받아 둘 최대 바이트. `spawnSync` 의 maxBuffer 가 하던 몫이다 —
 * 폭주하는 빌드가 메모리를 통째로 가져가지 않게 앞쪽을 버리고 꼬리를 남긴다.
 * 꼬리인 것은 로그에서 원인이 대개 끝에 있기 때문이다.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 검증 명령 한 번의 결과. spawnSync 의 반환 중 실제로 읽는 것만 남겼다. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  /** 명령이 **돌지 못한** 이유. 실패(status≠0)와 구분된다 */
  error?: Error;
}

/**
 * 자식 프로세스를 돌리고 기다린다. **이벤트 루프를 잡지 않는다.**
 *
 * `spawnSync` 였을 때는 gradle 이 도는 몇 분 동안 프로세스가 통째로 멈춰, 그 사이 아무것도
 * 응답하지 못했다. 검증 한 번이 프로세스 전체를 세우지 않게 하는 것이 이 함수가 비동기인
 * 유일한 이유다.
 */
function spawnAsync(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean },
): Promise<CommandResult> {
  return new Promise((settle) => {
    const child = spawn(file, args, { ...options, windowsHide: true });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const collect = (text: string, chunk: string): string => {
      const joined = text + chunk;
      if (joined.length <= MAX_OUTPUT_BYTES) {
        return joined;
      }
      truncated = true;
      return joined.slice(joined.length - MAX_OUTPUT_BYTES);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BUILD_TIMEOUT_MS);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = collect(stderr, chunk);
    });

    const note = (): string =>
      truncated ? `(출력이 상한을 넘겨 앞부분을 버렸습니다 — 아래는 끝부분입니다)\n` : "";

    // error 와 close 가 둘 다 오는 경우가 있다. Promise 는 첫 것만 받으므로 그대로 둔다.
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ stdout: note() + stdout, stderr, status: null, signal: null, error });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      settle({
        stdout: note() + stdout,
        stderr,
        status,
        signal,
        error: timedOut
          ? new Error(`제한 시간 ${BUILD_TIMEOUT_MS / 1000}초를 넘겨 중단했습니다`)
          : undefined,
      });
    });
  });
}

function git(args: string[], cwd: string): Promise<CommandResult> {
  return spawnAsync("git", args, { cwd, env: process.env });
}

// ---- ref 굳히기 ----

/**
 * 그 디렉토리가 git 작업트리 안인가.
 *
 * 거짓이라고 해서 작업을 막지 않는다. 굳힐 것이 없을 뿐이다.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], dir);
  return inside.status === 0 && inside.stdout.trim() === "true";
}

/**
 * ref 하나를 **그 순간의 커밋으로 굳힌다.** 없는 ref 면 undefined.
 *
 * 브랜치 이름은 움직인다. 이름만 들고 있으면 같은 작업이 언제 검증하느냐에 따라 다른 코드를
 * 보게 되므로, 작업을 만들 때 한 번 커밋으로 바꿔 두고 그 뒤로는 커밋만 쓴다.
 */
export async function resolveCommit(dir: string, ref: string): Promise<string | undefined> {
  const found = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dir);
  return found.status === 0 && found.stdout.trim() !== "" ? found.stdout.trim() : undefined;
}

/** 비교 브랜치를 안 적었을 때 찾아보는 순서. master 가 먼저다 */
const BASE_FALLBACKS = ["master", "main"];

/**
 * 작업·비교 브랜치를 그 순간의 커밋으로 굳힌다. 굳힐 것이 없으면 undefined.
 *
 * **git 저장소가 아니거나 커밋이 하나도 없으면 굳히지 않는다** — 굳힐 커밋이 없다.
 * 다만 **사람이 이름을 적었는데 굳힐 수 없으면** 그것은
 * 오타이므로 그대로 알린다 — 조용히 무시하면 엉뚱한 자리에서 검증이 돌아도 아무도 모른다.
 */
export async function pinRefs(
  repoRoot: string,
  workRef?: string,
  baseRef?: string,
): Promise<JobRefs | undefined> {
  const work = workRef?.trim() || undefined;
  const base = baseRef?.trim() || undefined;

  if (!(await isGitRepo(repoRoot))) {
    if (work ?? base) {
      throw new Error(
        `브랜치를 적었는데 대상 저장소가 git 저장소가 아닙니다: ${repoRoot}\n` +
          "  git 저장소가 아니면 브랜치를 비우세요 — 굳힐 커밋이 없습니다.",
      );
    }
    return undefined;
  }

  const commit = await resolveCommit(repoRoot, work ?? "HEAD");
  if (!commit) {
    if (work) {
      throw new Error(
        `작업 브랜치를 찾을 수 없습니다: ${work}\n` +
          `  대상 저장소(${repoRoot})에 있는 이름인지 보세요.`,
      );
    }
    // 커밋이 하나도 없는 저장소. 굳힐 것이 없으니 예전처럼 검증할 때의 HEAD 를 쓴다.
    return undefined;
  }
  const pinned = { ref: work ?? "HEAD", commit };

  if (base) {
    const baseCommit = await resolveCommit(repoRoot, base);
    if (!baseCommit) {
      throw new Error(
        `비교 브랜치를 찾을 수 없습니다: ${base}\n` +
          `  대상 저장소(${repoRoot})에 있는 이름인지 보세요.`,
      );
    }
    return { work: pinned, base: { ref: base, commit: baseCommit } };
  }

  for (const candidate of BASE_FALLBACKS) {
    const baseCommit = await resolveCommit(repoRoot, candidate);
    if (baseCommit) {
      return { work: pinned, base: { ref: candidate, commit: baseCommit } };
    }
  }
  // 기본 브랜치 이름이 다른 저장소다. 짐작해서 적느니 비워 둔다 — 비교 대상은 기록이고,
  // 검증이 딛는 자리(work)는 이미 굳었다. 필요하면 사람이 이름을 적어 주면 된다.
  return { work: pinned };
}

// ---- 실행 파일 해석 ----

/**
 * Windows 에서 실행 파일로 인정되는 확장자. PATHEXT 가 정하고, 없으면 cmd.exe 의 기본값을 쓴다.
 * 다른 플랫폼은 확장자 개념이 없어 빈 목록이다.
 */
function executableExtensions(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [];
  }
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
}

/**
 * 이름 하나가 가리킬 수 있는 파일들.
 *
 * Windows 에서는 **확장자 없는 파일을 후보로 삼지 않는다.** nodejs 설치 디렉토리에는 `npm`
 * (POSIX 셸 스크립트)과 `npm.cmd` 가 나란히 있는데, 앞의 것은 Windows 가 실행할 수 없다 —
 * 그것을 먼저 집으면 `.cmd` 가 바로 옆에 있어도 ENOENT 로 죽는다. 이름에 이미 실행 확장자가
 * 붙어 있으면(`foo.exe`) 그 이름 그대로만 본다.
 */
function candidatesOf(base: string, env: NodeJS.ProcessEnv): string[] {
  const extensions = executableExtensions(env);
  if (extensions.length === 0) {
    return [base];
  }
  const lower = base.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension))) {
    return [base];
  }
  return extensions.map((extension) => `${base}${extension}`);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** 후보 중 실재하는 첫 파일. 없으면 undefined */
function findExecutable(base: string, env: NodeJS.ProcessEnv): string | undefined {
  return candidatesOf(base, env).find(isFile);
}

/**
 * 명령 이름을 실제 파일로 해석한다.
 *
 * 순서가 곧 규칙이다. **저장소 안의 래퍼가 먼저다** — gradlew·mvnw 처럼 프로젝트가 버전을 고정해
 * 둔 것이 PATH 의 것보다 그 프로젝트에 맞기 때문이다. 없으면 PATH 를 코드가 직접 순회한다.
 * Node 의 spawnSync 에 이름만 넘기면 Windows 에서 `.exe` 만 찾아 `npm`(npm.cmd) 이 ENOENT 로
 * 죽는데, 그것을 "테스트 실패"와 구분할 길이 없어진다. 여기서 못 찾으면 못 찾았다고 말한다.
 */
export function resolveExecutable(
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // 경로를 적었으면(./gradlew, scripts/test.sh, 절대경로) 그 자리에서만 본다.
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    return findExecutable(resolve(cwd, command), env);
  }

  const local = findExecutable(join(cwd, command), env);
  if (local) {
    return local;
  }

  const pathDirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const found = findExecutable(join(dir, command), env);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** cmd.exe 에 넘길 인자 하나. 공백·따옴표가 있으면 감싼다 — 감싸지 않으면 갈라진다. */
function quoteForCmd(argument: string): string {
  if (argument !== "" && !/[\s"&|<>^()]/.test(argument)) {
    return argument;
  }
  return `"${argument.replace(/"/g, '""')}"`;
}

/** `.cmd`/`.bat` 은 프로그램이 아니라 cmd.exe 가 읽는 스크립트다. 직접 spawn 하면 EINVAL 이다. */
function isBatchScript(file: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/**
 * 검증 명령을 돌린다. 이름 해석부터 spawn 까지 — 플랫폼 차이는 전부 이 안에서 끝난다.
 *
 * 배치 스크립트는 `cmd.exe /d /s /c "<한 줄>"` 로 넘긴다. `shell: true` 에 인자 배열을 주는
 * 길도 있지만 Node 가 인자를 이어 붙이기만 해 공백 든 인자가 갈라지고 경고(DEP0190)도 난다.
 * 그래서 한 줄을 여기서 직접 만들고 verbatim 으로 넘긴다. `/s` 는 그 한 줄을 감싼 바깥
 * 따옴표 한 쌍을 벗겨 내라는 뜻이다.
 *
 * 못 찾은 명령은 spawn 하지 않고 `error` 로 돌린다. ENOENT 가 자연히 나기를 기다리면
 * Windows 에서는 나지 않는 경우가 있고(.cmd), 메시지에 어디를 봤는지도 실리지 않는다.
 */
export async function runCommand(
  cwd: string,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  const [name, ...args] = command;
  const file = resolveExecutable(cwd, name, env);

  if (!file) {
    return {
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: new Error(
        `실행 파일을 찾을 수 없습니다: ${name} — 저장소 안(${cwd})과 PATH 를 확인했습니다. ` +
          "code-agent.json 의 build·test 명령이 이 머신에 설치되어 있는지 보세요.",
      ),
    };
  }

  if (isBatchScript(file)) {
    const line = [quoteForCmd(file), ...args.map(quoteForCmd)].join(" ");
    return spawnAsync(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd,
      env,
      windowsVerbatimArguments: true,
    });
  }
  return spawnAsync(file, args, { cwd, env });
}

// ---- worktree 검증 ----

/**
 * 프로젝트가 선언한 명령으로 바뀐 파일을 검증한다.
 *
 * 바뀐 파일만으로는 빌드할 수 없고(의존 코드가 저장소에 있다), 사람이 보고 있는 작업트리에서
 * 그대로 돌리면 검증이 중간 상태를 밟는다. 그래서 임시 git worktree를 굳혀 둔 커밋 위에 만들어
 * 거기에만 파일을 얹고 실행한 뒤 통째로 지운다 — 원본 작업트리는 그대로 남는다.
 */
export async function verifyByBuild(
  repoRoot: string,
  manifest: Manifest,
  /** worktree 에 얹을 파일들이 저장소 루트 기준 구조 그대로 들어 있는 디렉토리 */
  filesDir: string,
  stages: StageResult[],
  kind: string = "build",
  /**
   * 어느 커밋 위에 생성물을 얹어 볼 것인가. 작업을 만들 때 굳혀 둔 커밋이 온다.
   *
   * 없으면 그때의 HEAD 다 — 굳힐 것이 없는 저장소(커밋 0개)이거나 굳히기 전에 만들어진
   * 작업이라는 뜻이고, 그 경우 같은 작업이 체크아웃에 따라 다른 것을 검증하게 된다.
   */
  ref: string = "HEAD",
): Promise<BuildResult> {
  const command =
    kind === "test" ? manifest.test : kind === "build" ? manifest.build : manifest.commands[kind];
  if (!command?.length) {
    return {
      passed: true,
      outcome: "not-run",
      skipped: true,
      log: `code-agent.json 에 ${kind} 명령이 없어 검증을 건너뜁니다.`,
    };
  }
  if (!stages.some((stage) => stage.files.length > 0)) {
    return {
      passed: true,
      outcome: "not-run",
      skipped: true,
      log: "생성된 파일이 없어 검증을 건너뜁니다. 아직 만들거나 고친 것이 없습니다.",
    };
  }

  const worktree = mkdtempSync(join(tmpdir(), "code-agent-build-"));
  // mkdtemp가 만든 빈 디렉토리를 git이 거부하므로, 경로만 쓰고 실제 생성은 git에 맡긴다.
  rmSync(worktree, { recursive: true, force: true });

  const added = await git(["worktree", "add", "--detach", worktree, ref], repoRoot);
  if (added.status !== 0) {
    // 명령이 돌지 못한 것이다. 테스트가 실패한 것과 같은 말로 알리면 재현으로 오독된다.
    return {
      passed: false,
      outcome: "error",
      log:
        `임시 worktree 생성 실패 (${ref}, exit ${added.status}): ${added.stderr || added.stdout}`.trim() +
        "\n대상 저장소가 git 저장소이고 커밋이 하나 이상 있어야 검증을 돌릴 수 있습니다.",
    };
  }

  try {
    // 저장소 루트 기준 상대경로 구조를 그대로 갖고 있어 통째로 덮어쓰면 된다.
    cpSync(filesDir, worktree, { recursive: true });

    const executed = await runCommand(worktree, command);
    const log = [executed.stdout, executed.stderr].filter(Boolean).join("\n").trim();

    if (executed.error) {
      // 원인과 함께, 죽기 전까지의 출력도 남긴다 — 그것이 없으면 왜 죽었는지 아무도 못 본다.
      return {
        passed: false,
        outcome: "error",
        log: [`검증 명령 실행 실패: ${executed.error.message}`, log].filter(Boolean).join("\n"),
      };
    }
    return {
      passed: executed.status === 0,
      outcome: executed.status === 0 ? "passed" : "failed",
      log: log || (executed.status === 0 ? "검증 통과" : `검증 실패 (exit ${executed.status})`),
    };
  } finally {
    await git(["worktree", "remove", "--force", worktree], repoRoot);
  }
}
