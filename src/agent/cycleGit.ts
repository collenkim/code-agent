import { execFileSync } from "node:child_process";
import { cyclesFile, type CycleRecord } from "./cycles";
import type { ActiveWork } from "./layout";
import { readWorkBinding } from "./master/store";

/** Git 조회 실패를 빈 목록으로 취급하지 않는다. 선택적인 합치기만 포기한다. */
function git(root: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", input, env }).trim();
}
function config(root: string, key: string): string {
  try { return git(root, ["config", "--get", key]); }
  catch (error) { if ((error as { status?: number }).status === 1) return ""; throw error; }
}
function refs(root: string): string {
  return git(root, ["for-each-ref", "--sort=refname", "--format=%(refname) %(objectname) %(symref)", "refs/heads/", "refs/remotes/", "refs/tags/"]);
}
function upstream(root: string, branch: string): string {
  const merge = config(root, `branch.${branch}.merge`), remote = config(root, `branch.${branch}.remote`);
  if (!merge && !remote) return "";
  const ref = git(root, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]);
  if (!ref) throw new Error("설정된 upstream의 대응 ref가 없습니다");
  git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return `${remote}\n${merge}\n${ref}`;
}
export const SQUASH_LIMIT = "로컬 브랜치·원격 추적 ref·태그 기준입니다. 추적 정보 없는 직접 push 여부는 알 수 없습니다. 자동 fetch·강제 push는 하지 않습니다.";
export interface SquashPlan {
  reason?: string;
  head?: string;
  refs?: string;
  upstream?: string;
  candidates?: string[];
  parent?: string;
}

/** pending=true는 이번 반영 커밋이 하나 추가될 것을 전제로 하는 확인 화면 판정이다. */
export function inspectSquash(root: string, active: ActiveWork, pending = true): SquashPlan {
  try {
    if (!active.cycle || active.cycle.number < 2) return { reason: "첫 실행 회차입니다" };
    if (readWorkBinding(root, active.id)) return { reason: "master 관리 작업입니다" };
    if (!active.branch) return { reason: "작업 브랜치가 없습니다" };
    const branch = `refs/heads/${active.branch}`;
    if (git(root, ["symbolic-ref", "HEAD"]) !== branch) return { reason: "현재 작업 브랜치가 달라졌습니다" };
    const head = git(root, ["rev-parse", "HEAD"]), referenceState = refs(root), tracking = upstream(root, active.branch);
    // --exclude는 바로 뒤 --branches에만 적용하며 refs/heads/ 접두를 쓰지 않는다.
    const candidates = git(root, ["rev-list", "--topo-order", head, "--not", `--exclude=${active.branch}`, "--branches", "--remotes", "--tags"]).split("\n").filter(Boolean);
    if (!candidates.includes(active.cycle.delivered)) return { reason: "이전 반영이 다른 로컬 브랜치·원격 추적 ref·태그에 포함되어 있습니다" };
    if (candidates.length + Number(pending) < 2) return { reason: "합칠 반영 커밋이 부족합니다" };
    let parent = "";
    for (let i = 0; i < candidates.length; i++) {
      const commit = candidates[i];
      const parents = git(root, ["show", "-s", "--format=%P", commit]).split(" ").filter(Boolean);
      const subject = git(root, ["show", "-s", "--format=%s", commit]);
      const paths = git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit, "--", cyclesFile(active.id)]);
      if (parents.length !== 1 || !subject.startsWith(`[${active.id}] `) || paths !== cyclesFile(active.id)) {
        return { reason: "후보에 다른 작업·사람의 커밋 또는 merge 커밋이 있습니다" };
      }
      if (i + 1 < candidates.length && parents[0] !== candidates[i + 1]) return { reason: "후보 커밋이 연속하지 않습니다" };
      parent = parents[0];
    }
    if (refs(root) !== referenceState) return { reason: "조회 중 참조 상태가 바뀌었습니다" };
    return { head, refs: referenceState, upstream: tracking, candidates, parent };
  } catch { return { reason: "필요한 Git 조회에 실패했거나 upstream ref가 없습니다" }; }
}
export function squashPreview(plan: SquashPlan): string {
  return plan.reason ? `합치지 않습니다 — ${plan.reason}` : `합칩니다 — ${(plan.candidates?.length ?? 0) + 1}개`;
}
function otherRefs(plan: SquashPlan, branch: string): string {
  return (plan.refs ?? "").split("\n").filter(line => !line.startsWith(`refs/heads/${branch} `)).join("\n");
}

/** 이미 성공한 경로 제한 git commit 뒤의 선택적 작업. index·작업 트리에는 쓰지 않는다. */
export function squashDelivery(root: string, active: ActiveWork, preview: SquashPlan, delivered: string, message: string): { commit: string; note: string } {
  const skip = (reason: string) => ({ commit: delivered, note: `커밋을 합치지 않았습니다 — ${reason}. PR 을 squash merge 로 병합하세요` });
  if (preview.reason) return skip(preview.reason);
  try {
    const plan = inspectSquash(root, active, false);
    if (plan.reason) return skip(plan.reason);
    if (plan.head !== delivered || plan.candidates?.[1] !== preview.head || plan.parent !== preview.parent ||
        JSON.stringify(plan.candidates?.slice(1)) !== JSON.stringify(preview.candidates) ||
        otherRefs(plan, active.branch!) !== otherRefs(preview, active.branch!) || plan.upstream !== preview.upstream) {
      return skip("확인 후 참조·후보가 바뀌었습니다");
    }
    const tree = git(root, ["rev-parse", `${delivered}^{tree}`]);
    if (!cycleCoauthors(root, active, true).every(trailer => message.split("\n").includes(trailer))) return skip("공동 작성자 정보를 확인할 수 없습니다");
    const name = config(root, "user.name"), email = config(root, "user.email");
    if (!name || !email) return skip("저장소 작성자 신원을 확인할 수 없습니다");
    const credits = git(root, ["show", "-s", "--format=%an <%ae>%n%(trailers:key=Co-authored-by,valueonly)", ...plan.candidates!])
      .split(/\r?\n/).map(line => line.trim()).filter(line => /^[^<>\r\n]+ <[^<>\r\n]+>$/.test(line) && line !== `${name} <${email}>`);
    if (!credits.every(author => message.split("\n").includes(`Co-authored-by: ${author}`))) return skip("후보의 작성자 정보가 확인한 메시지와 다릅니다");
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    delete env.GIT_AUTHOR_DATE; delete env.GIT_COMMITTER_DATE;
    let signed = false;
    try { signed = git(root, ["config", "--type=bool", "--get", "commit.gpgSign"]) === "true"; }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
    // commit-tree는 hook을 실행하지 않는다. 동일한 트리는 방금 경로 제한 git commit의 hook을 통과했다.
    const combined = git(root, ["commit-tree", tree, "-p", plan.parent!, ...(signed ? ["-S"] : []), "-F", "-"], `${message}\n`, env);
    if (git(root, ["rev-parse", `${combined}^{tree}`]) !== tree || git(root, ["show", "-s", "--format=%P", combined]) !== plan.parent) {
      return skip("새 커밋의 트리·부모 검증이 일치하지 않습니다");
    }
    const archiveBase = `refs/code-agent/archive/${active.id}/${active.cycle!.number}`;
    const existing = new Set(git(root, ["for-each-ref", "--format=%(refname)", "refs/code-agent/archive/"]).split("\n"));
    let archive = archiveBase;
    for (let suffix = 1; existing.has(archive); suffix++) archive = `${archiveBase}-${suffix}`;
    // 이름 충돌 경합도 create가 거부한다. 이미 있던 보관 ref를 덮어쓰지 않는다.
    git(root, ["update-ref", "--stdin"], `create ${archive} ${delivered}\n`);
    const latest = inspectSquash(root, active, false);
    if (JSON.stringify(latest) !== JSON.stringify(plan)) return skip("적용 직전에 참조·후보가 바뀌었습니다");
    // 조회한 기존 ref도 같은 트랜잭션에서 검증한다. 현재 브랜치는 old OID로 비교 갱신한다.
    const verifies = otherRefs(plan, active.branch!).split("\n").filter(Boolean).map(line => {
      const [ref, oid, symbolic] = line.split(" ");
      return symbolic ? "" : `verify ${ref} ${oid}`;
    }).filter(Boolean);
    git(root, ["update-ref", "--no-deref", "--stdin"], [...verifies, `update refs/heads/${active.branch} ${combined} ${delivered}`, ""].join("\n"));
    return { commit: combined, note: `이전 회차 커밋 ${preview.candidates!.length}개와 합쳐 커밋 하나로 만들었습니다 — ${combined.slice(0, 12)} (원래 커밋: ${archive})` };
  } catch { return skip("서명·보관·합치기 또는 참조 비교 갱신에 실패했습니다"); }
}

/** 원장은 SHA를 자기 파일에 적지 않는다. 커밋된 각 원장의 마지막 회차로 과거 SHA를 확인한다. */
export function cycleMessageLines(root: string, active: ActiveWork): string[] {
  const current = active.cycle?.number ?? 1;
  const records = new Map<number, { revision?: number; commit?: string }>();
  if (active.cycle?.delivered) {
    try {
      const previous = JSON.parse(git(root, ["show", `${active.cycle.delivered}:${cyclesFile(active.id)}`])) as { cycles: CycleRecord[] };
      for (const record of previous.cycles) {
        if (record.cycle < current) records.set(record.cycle, { revision: record.revision });
      }
      const archives = git(root, ["for-each-ref", "--format=%(objectname)", `refs/code-agent/archive/${active.id}/`]).split("\n").filter(Boolean);
      const commits = git(root, ["log", "--format=%H", active.cycle.delivered, ...archives, "--", cyclesFile(active.id)]).split("\n").filter(Boolean);
      for (const commit of [active.cycle.delivered, ...commits]) {
        const log = JSON.parse(git(root, ["show", `${commit}:${cyclesFile(active.id)}`])) as { cycles: CycleRecord[] };
        const record = log.cycles.at(-1);
        if (record && record.cycle < current && !records.get(record.cycle)?.commit) records.set(record.cycle, { revision: record.revision, commit });
      }
    } catch { /* 조회하지 못한 이전 회차의 SHA는 추정하지 않는다. */ }
  }
  return [...[...records].sort(([a], [b]) => a - b).map(([cycle, record]) => `- 회차 ${cycle} · 개정 ${record.revision ?? "미기록"} · ${record.commit?.slice(0, 12) ?? "커밋 미확인"}`),
    `- 회차 ${current} · 개정 ${active.request?.revision ?? "미기록"} · 이번 반영`];
}

export function cycleCoauthors(root: string, active: ActiveWork, strict = false): string[] {
  if (!active.cycle?.delivered) return [];
  try {
    const own = `${config(root, "user.name")} <${config(root, "user.email")}>`;
    const text = git(root, ["log", "--format=%an <%ae>%n%(trailers:key=Co-authored-by,valueonly)", active.cycle.delivered, "--", cyclesFile(active.id)]);
    return [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(line => /^[^<>\r\n]+ <[^<>\r\n]+>$/.test(line) && line !== own))].sort().map(author => `Co-authored-by: ${author}`);
  } catch (error) { if (strict) throw error; return []; }
}

/** 기본 push refspec에 포함되지 않는 로컬 보관 ref. 브랜치가 없어진 작업만 CAS 삭제한다. */
export function cleanCycleArchives(root: string): string[] {
  let count = 0;
  try {
    const branches = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n");
    const archives = git(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/code-agent/archive/"]).split("\n").filter(Boolean);
    for (const entry of archives) {
      const [ref, oid] = entry.split(" "), id = ref.split("/")[3];
      if (branches.some(branch => /refs\/heads\/(feature|fix|refactor)\//.test(branch) && branch.split("/").slice(3).join("/") === id)) continue;
      // 삭제 직전에 작업 브랜치를 다시 읽는다.
      if (git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n").some(branch => branch.endsWith(`/${id}`))) continue;
      git(root, ["update-ref", "-d", ref, oid]); count++;
    }
  } catch { return [...(count ? [`작업 브랜치가 없어진 보관 ref ${count}개를 정리했습니다.`] : []), "보관 ref 정리를 완료하지 못했습니다. 남은 ref는 유지했습니다."]; }
  return count ? [`작업 브랜치가 없어진 보관 ref ${count}개를 정리했습니다.`] : [];
}
