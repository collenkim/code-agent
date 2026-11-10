import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cycleBranchNotice } from "../agent/cycleBranch";
import { cycleRepo } from "./cycleGitFixture";
import { removeRepo } from "./repoFixture";
let fixture: ReturnType<typeof cycleRepo>;
afterEach(() => { if (fixture) removeRepo(fixture.root); });
for (const mode of ["fast-forward", "merge", "squash", "remote"]) {
  test(`${mode}로 병합된 기준을 찾아 조회만 하고 SHA 기준은 제외한다`, () => {
    fixture = cycleRepo(); const { root, git, active, first, base } = fixture;
    git("switch", "master");
    if (mode === "merge") { git("commit", "--allow-empty", "-qm", "other"); git("merge", "--no-ff", "-qm", "merge", active.branch!); }
    else if (mode === "squash") { git("merge", "--squash", active.branch!); git("commit", "-qm", "squash on base"); }
    else if (mode === "remote") git("update-ref", "refs/remotes/origin/master", first);
    else git("merge", "--ff-only", active.branch!);
    const before = git("symbolic-ref", "HEAD");
    const notice = cycleBranchNotice(root, active.id, active.branch!, "master", active.spec);
    assert.match(notice.blocked!, /병합된 기록[\s\S]*git branch -m[\s\S]*git branch -D/);
    assert.equal(git("symbolic-ref", "HEAD"), before);
    assert.equal(cycleBranchNotice(root, active.id, active.branch!, base, active.spec).blocked, undefined);
  });
}
test("upstream 누락은 시작 차단 대신 안내한다", () => {
  fixture = cycleRepo(); const { root, git, active } = fixture;
  git("config", "branch.feature/CYCLE-1.remote", "origin"); git("config", "branch.feature/CYCLE-1.merge", "refs/heads/feature/CYCLE-1");
  const notice = cycleBranchNotice(root, active.id, active.branch!, "master", active.spec);
  assert.equal(notice.blocked, undefined); assert.match(notice.warning!, /upstream ref가 없습니다/);
});
