import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { inspectSquash, squashDelivery } from "../agent/cycleGit";
import { cycleRepo } from "./cycleGitFixture";
import { removeRepo, writeFixture } from "./repoFixture";
const cp = require("node:child_process") as typeof import("node:child_process");
let fixture: ReturnType<typeof cycleRepo>;
afterEach(() => { mock.restoreAll(); if (fixture) removeRepo(fixture.root); });

for (const point of ["query", "after-preview", "after-commit-tree", "cas", "signing", "tree", "archive-collision"]) {
  test(`${point} 실패·경합은 기존 반영·다른 프로세스 끝·index·작업 트리를 보존한다`, () => {
    fixture = cycleRepo(); const { root, git, active, first, commit, base } = fixture;
    const preview = inspectSquash(root, active), delivered = commit(2);
    writeFixture(root, "stage.txt", "stage"); git("add", "stage.txt"); writeFixture(root, "stage.txt", "dirty");
    const index = readFileSync(join(root, ".git/index"));
    let expected = delivered;
    const real = cp.execFileSync;
    if (point === "after-preview") git("update-ref", "refs/tags/late", first);
    mock.method(cp, "execFileSync", ((file: string, args: string[], options: object) => {
      if (file !== "git") return real(file, args, options);
      if (point === "query" && args[0] === "rev-list") throw new Error("query unavailable");
      if (point === "signing" && args[0] === "commit-tree") throw new Error("signing failed");
      if (point === "archive-collision" && args[0] === "update-ref" && String((options as { input?: string }).input).startsWith("create ")) {
        real("git", ["update-ref", "refs/code-agent/archive/CYCLE-1/2", base], { cwd: root, stdio: "pipe" });
      }
      if (point === "cas" && args[0] === "update-ref" && String((options as { input?: string }).input).includes("update refs/heads/")) {
        expected = real("git", ["commit-tree", `${delivered}^{tree}`, "-p", delivered, "-m", "other process"], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
        real("git", ["update-ref", `refs/heads/${active.branch}`, expected, delivered], { cwd: root, stdio: "pipe" });
      }
      const result = real(file, args, options);
      if (args[0] === "commit-tree" && point === "after-commit-tree") real("git", ["update-ref", "refs/tags/late", first], { cwd: root, stdio: "pipe" });
      if (args[0] === "commit-tree" && point === "tree") return `${base}\n`;
      return result;
    }) as typeof cp.execFileSync);
    const result = squashDelivery(root, active, preview, delivered, "[CYCLE-1] 값");
    mock.restoreAll();
    assert.match(result.note, /합치지 않았습니다/);
    assert.equal(git("rev-parse", "HEAD"), expected);
    assert.deepEqual(readFileSync(join(root, ".git/index")), index);
    assert.equal(readFileSync(join(root, "stage.txt"), "utf8"), "dirty");
    if (point === "archive-collision") assert.equal(git("rev-parse", "refs/code-agent/archive/CYCLE-1/2"), base);
  });
}
