import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { Manifest } from "./manifest";
import type { BuildResult, StageResult } from "./types";

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: "utf-8", timeout: BUILD_TIMEOUT_MS });
}

/**
 * 검증 명령의 실행 파일을 정한다.
 * 저장소가 자체 래퍼(gradlew, mvnw, 프로젝트 스크립트 등)를 갖고 있으면 그 경로로 실행하고,
 * 없으면 PATH에 있는 명령으로 본다 (npm, pytest, go 등).
 */
function resolveExecutable(cwd: string, command: string): string {
  const candidates = process.platform === "win32" ? [`${command}.bat`, `${command}.cmd`, command] : [command];
  for (const candidate of candidates) {
    if (existsSync(join(cwd, candidate))) {
      return join(cwd, candidate);
    }
  }
  return command;
}

/**
 * 프로젝트가 선언한 명령으로 생성물을 검증한다.
 *
 * staging 디렉토리의 파일만으로는 빌드할 수 없고(의존 코드가 저장소에 있다), 그렇다고 대상
 * 저장소 작업트리에 직접 쓰면 "저장소 무변경" 약속이 깨진다. 그래서 임시 git worktree를 만들어
 * 거기에만 파일을 얹고 실행한 뒤 통째로 지운다 — 원본 작업트리는 그대로 남는다.
 */
export function verifyByBuild(
  repoRoot: string,
  manifest: Manifest,
  outDir: string,
  stages: StageResult[],
  kind: "build" | "test" = "build",
): BuildResult {
  const command = kind === "test" ? manifest.test : manifest.build;
  if (!command?.length) {
    return { passed: true, log: `code-agent.json 에 ${kind} 명령이 없어 검증을 건너뜁니다.` };
  }
  if (!stages.some((stage) => stage.files.length > 0)) {
    return { passed: true, log: "생성된 파일이 없어 검증을 건너뜁니다." };
  }

  const worktree = mkdtempSync(join(tmpdir(), "code-agent-build-"));
  // mkdtemp가 만든 빈 디렉토리를 git이 거부하므로, 경로만 쓰고 실제 생성은 git에 맡긴다.
  rmSync(worktree, { recursive: true, force: true });

  const added = run("git", ["worktree", "add", "--detach", worktree, "HEAD"], repoRoot);
  if (added.status !== 0) {
    return {
      passed: false,
      log: `임시 worktree 생성 실패 (exit ${added.status}): ${added.stderr || added.stdout}`,
    };
  }

  try {
    // outDir은 저장소 루트 기준 상대경로 구조를 그대로 갖고 있어 통째로 덮어쓰면 된다.
    cpSync(outDir, worktree, { recursive: true });

    const [executable, ...args] = command;
    const executed = run(resolveExecutable(worktree, executable), args, worktree);
    const log = [executed.stdout, executed.stderr].filter(Boolean).join("\n").trim();

    if (executed.error) {
      return { passed: false, log: `검증 명령 실행 실패: ${executed.error.message}` };
    }
    return {
      passed: executed.status === 0,
      log: log || (executed.status === 0 ? "검증 통과" : `검증 실패 (exit ${executed.status})`),
    };
  } finally {
    run("git", ["worktree", "remove", "--force", worktree], repoRoot);
  }
}
