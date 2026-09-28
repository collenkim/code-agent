import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function exists(repoRoot: string, ref: string): boolean {
  try {
    git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function isGitRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".git"));
}

/**
 * 작업 브랜치로 옮긴다. 없으면 기준 브랜치에서 따고, 있으면(중단 뒤 재시작) 그리로 전환만 한다.
 *
 * 전환이 실패하면(작업 트리 충돌 등) git 의 메시지를 그대로 올린다 — 무엇을 치워야 하는지는 git 이 가장 정확히 안다.
 */
export function switchToWorkBranch(repoRoot: string, branch: string, base: string): "created" | "switched" | "already" {
  if (git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) === branch) {
    return "already";
  }
  if (exists(repoRoot, branch)) {
    git(repoRoot, ["switch", branch]);
    return "switched";
  }
  if (!exists(repoRoot, base)) {
    throw new Error(`기준 브랜치가 없습니다: ${base}. start --base <브랜치> 로 지정하거나 code-agent.json 의 git.base 를 고치세요.`);
  }
  git(repoRoot, ["switch", "-c", branch, base]);
  return "created";
}
