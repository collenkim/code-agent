import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanCycleArchives, cycleCoauthors, cycleMessageLines, inspectSquash, squashDelivery } from "../agent/cycleGit";
import { deliveredCycle } from "../agent/cycles";
import { cycleRepo } from "./cycleGitFixture";
import { removeRepo, writeFixture } from "./repoFixture";

let fixture: ReturnType<typeof cycleRepo>;
afterEach(() => { if (fixture) removeRepo(fixture.root); });
test("첫 회차는 합치지 않고 2·3회차는 트리·부모·보관·공동 작성자를 유지한다", () => {
  fixture = cycleRepo();
  const { root, git, base, active, commit } = fixture;
  assert.match(inspectSquash(root, { ...active, cycle: undefined }).reason!, /첫 실행/);
  git("commit", "--amend", "-qm", "[CYCLE-1] 값\n\nCo-authored-by: Earlier <earlier@example.com>", "--author=First <first@example.com>");
  active.cycle!.delivered = git("rev-parse", "HEAD");
  for (const cycle of [2, 3]) {
    const preview = inspectSquash(root, active);
    assert.equal(preview.reason, undefined);
    const authors = cycleCoauthors(root, active);
    assert.deepEqual(authors, ["Co-authored-by: Earlier <earlier@example.com>", "Co-authored-by: First <first@example.com>"]);
    const message = ["[CYCLE-1] 값", "", ...cycleMessageLines(root, active), "", ...authors].join("\n");
    assert.match(message, new RegExp(`회차 ${cycle} · 개정 미기록 · 이번 반영`));
    const delivered = commit(cycle, message);
    const tree = git("rev-parse", "HEAD^{tree}");
    writeFixture(root, "staged.txt", "stage"); git("add", "staged.txt");
    writeFixture(root, "staged.txt", "worktree");
    const index = readFileSync(join(root, ".git/index"));
    const result = squashDelivery(root, active, preview, delivered, message);
    assert.match(result.note, /커밋 하나로/);
    assert.equal(git("rev-parse", "HEAD^{tree}"), tree);
    assert.equal(git("show", "-s", "--format=%P", "HEAD"), base);
    assert.equal(git("rev-list", "--count", "master..HEAD"), "1");
    assert.equal(git("rev-parse", `refs/code-agent/archive/CYCLE-1/${cycle}`), delivered);
    assert.equal(git("show", "-s", "--format=%B", "HEAD"), message);
    assert.deepEqual(readFileSync(join(root, ".git/index")), index);
    assert.equal(readFileSync(join(root, "staged.txt"), "utf8"), "worktree");
    assert.equal(deliveredCycle(root, active.id, active.spec, "HEAD")?.commit, result.commit);
    assert.equal(deliveredCycle(root, active.id, active.spec, "HEAD")?.cycle, cycle);
    active.cycle = { number: cycle + 1, delivered: result.commit };
  }
});

for (const ref of ["refs/heads/other", "refs/tags/published", "refs/remotes/origin/feature/CYCLE-1"]) {
  test(`${ref}에 포함된 이전 반영은 합치지 않는다`, () => {
    fixture = cycleRepo(); const { root, git, active, first } = fixture;
    git("update-ref", ref, first);
    assert.match(inspectSquash(root, active).reason!, /다른 로컬 브랜치/);
  });
}
test("upstream ref가 없으면 합치지 않고 사람 커밋·merge도 제외한다", () => {
  fixture = cycleRepo(); const { root, git, active } = fixture;
  git("config", "branch.feature/CYCLE-1.remote", "origin");
  git("config", "branch.feature/CYCLE-1.merge", "refs/heads/feature/CYCLE-1");
  assert.match(inspectSquash(root, active).reason!, /upstream/);
  git("config", "--remove-section", "branch.feature/CYCLE-1");
  git("commit", "--allow-empty", "-qm", "human");
  assert.match(inspectSquash(root, active).reason!, /사람의 커밋/);
  git("switch", "-qc", "side", "master");
  git("commit", "--allow-empty", "-qm", "side");
  git("switch", "feature/CYCLE-1"); git("merge", "--no-ff", "-m", "merge", "side");
  assert.match(inspectSquash(root, active).reason!, /merge/);
});
test("보관 ref 충돌은 새 이름으로 보존하고 브랜치가 없어진 보관 ref만 정리한다", () => {
  fixture = cycleRepo(); const { root, git, active, first, commit } = fixture;
  const preview = inspectSquash(root, active), delivered = commit(2);
  git("update-ref", "refs/code-agent/archive/CYCLE-1/2", first);
  const result = squashDelivery(root, active, preview, delivered, "[CYCLE-1] 값");
  assert.match(result.note, /CYCLE-1\/2-1/);
  assert.equal(git("rev-parse", "refs/code-agent/archive/CYCLE-1/2"), first);
  assert.deepEqual(cleanCycleArchives(root), []);
  git("switch", "master"); git("branch", "-D", active.branch!);
  assert.match(cleanCycleArchives(root).join("\n"), /2개/);
  assert.equal(git("for-each-ref", "--format=%(refname)", "refs/code-agent/archive/"), "");
});

test("보관이 없는 과거 회차도 목록에 남기고 확인한 이전 반영 SHA를 우선한다", () => {
  fixture = cycleRepo(); const { root, git, active, commit } = fixture;
  const preview = inspectSquash(root, active), delivered = commit(2);
  const result = squashDelivery(root, active, preview, delivered, "[CYCLE-1] 값");
  assert.match(result.note, /커밋 하나로/);
  active.cycle = { number: 3, delivered: result.commit };
  assert.match(cycleMessageLines(root, active).join("\n"), new RegExp(`회차 2 .*${result.commit.slice(0, 12)}`));
  git("update-ref", "-d", "refs/code-agent/archive/CYCLE-1/2", delivered);
  const lines = cycleMessageLines(root, active).join("\n");
  assert.match(lines, /회차 1 · 개정 미기록 · 커밋 미확인/);
  assert.match(lines, new RegExp(`회차 2 .*${result.commit.slice(0, 12)}`));
  assert.match(lines, /회차 3 .*이번 반영/);
});
