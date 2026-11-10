import { execFileSync } from "node:child_process";
import { cyclesFile, deliveredCycle } from "./cycles";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}
export interface CycleBranchNotice { blocked?: string; warning?: string }
/** 조회 전용. SHA 기준(master의 고정 커밋)은 병합 판정 대상이 아니다. */
export function cycleBranchNotice(root: string, id: string, branch: string, base: string, spec: string): CycleBranchNotice {
  const result: CycleBranchNotice = {};
  try {
    const tip = git(root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    const delivered = deliveredCycle(root, id, spec, tip);
    if (!delivered) return result;
    const upstream = git(root, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]);
    let configured = false;
    try { configured = Boolean(git(root, ["config", "--get", `branch.${branch}.merge`])); } catch { /* 설정 없음 */ }
    if (configured) {
      try { if (!upstream) throw new Error(); git(root, ["rev-parse", "--verify", `${upstream}^{commit}`]); }
      catch { result.warning = `작업 브랜치 ${branch}의 upstream ref가 없습니다 — 병합 후 원격 브랜치가 삭제됐을 수 있습니다. 로컬·원격 추적 기준을 확인하세요.`; }
    }
    const resolved = git(root, ["rev-parse", "--symbolic-full-name", "--verify", base]);
    if (!resolved.startsWith("refs/heads/") && !resolved.startsWith("refs/remotes/")) return result;
    const name = resolved.startsWith("refs/heads/") ? resolved.slice(11) : resolved.slice(13).split("/").slice(1).join("/");
    const bases = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"]).split("\n")
      .filter(ref => ref === `refs/heads/${name}` || (ref.startsWith("refs/remotes/") && ref.slice(13).split("/").slice(1).join("/") === name));
    for (const ref of bases) {
      let merged = false;
      try { git(root, ["merge-base", "--is-ancestor", tip, ref]); merged = true; }
      catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
      if (!merged) {
        const path = cyclesFile(id);
        if (git(root, ["ls-tree", "--name-only", ref, "--", path]) === path) {
          const log = JSON.parse(git(root, ["show", `${ref}:${path}`])) as { cycles?: { cycle: number }[] };
          merged = (log.cycles?.at(-1)?.cycle ?? 0) >= delivered.cycle;
        }
      }
      if (merged) {
        result.blocked = `작업 브랜치 ${branch}는 ${ref}에 병합된 기록이 있습니다. 브랜치는 바꾸지 않았습니다.\n` +
          `사람이 git branch -m ${branch} ${branch}-merged 또는 git branch -D ${branch}로 정리한 뒤 같은 시작 명령을 다시 실행하세요. ` +
          `기준 브랜치에서 새로 만들고 이전 실행 회차는 기준의 기록으로 이어갑니다. 모델은 브랜치를 정리하지 않습니다.`;
        return result;
      }
    }
  } catch { /* start의 기존 기준·준비 검사가 유효하지 않은 저장소를 거부한다. */ }
  return result;
}
