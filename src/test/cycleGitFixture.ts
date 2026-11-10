import { cyclesFile, recordDeliveredCycle } from "../agent/cycles";
import type { ActiveWork } from "../agent/layout";
import { createRepo, gitFixture, writeFixture } from "./repoFixture";

export function cycleRepo() {
  const root = createRepo("ca-cycle-git-");
  const git = (...args: string[]) => gitFixture(root, ...args);
  writeFixture(root, "base.txt", "base\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "feature/CYCLE-1");
  const active: ActiveWork = { id: "CYCLE-1", spec: "doc/work/CYCLE-1/requirement.md", target: "value", phase: "deliver", branch: "feature/CYCLE-1", base: "master", baseCommit: base };
  function commit(cycle: number, message = "[CYCLE-1] 값") {
    active.cycle = cycle > 1 ? { number: cycle, delivered: git("rev-parse", "HEAD") } : undefined;
    writeFixture(root, active.spec, `회차 ${cycle}\n`);
    recordDeliveredCycle(root, active, { requestHash: `hash${cycle}`, baseCommit: base, treeHash: `tree${cycle}` });
    git("add", "--", cyclesFile(active.id), active.spec);
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  }
  const first = commit(1);
  active.cycle = { number: 2, delivered: first };
  return { root, git, base, first, active, commit };
}
