import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inspectSquash, squashDelivery } from "../agent/cycleGit";
import { cycleRepo } from "./cycleGitFixture";
import { removeRepo } from "./repoFixture";

test("commit.gpgSign: 임시 SSH 키로 실제 서명하고 verify-commit으로 검증한다", context => {
  try { execFileSync("ssh-keygen", ["-?"], { stdio: "pipe" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { context.skip("ssh-keygen 없음 — 실제 서명 미확인"); return; } }
  const { root, git, active, commit } = cycleRepo();
  try {
    const key = join(root, ".git", "signing-key"), allowed = join(root, ".git", "allowed-signers");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { stdio: "pipe" });
    writeFileSync(allowed, `t@t ${readFileSync(`${key}.pub`, "utf8")}`);
    git("config", "gpg.format", "ssh"); git("config", "user.signingkey", key);
    git("config", "gpg.ssh.allowedSignersFile", allowed); git("config", "commit.gpgSign", "true");
    const preview = inspectSquash(root, active), delivered = commit(2);
    const result = squashDelivery(root, active, preview, delivered, "[CYCLE-1] 서명 반영");
    assert.match(result.note, /커밋 하나로/);
    assert.match(git("cat-file", "commit", result.commit), /gpgsig -----BEGIN SSH SIGNATURE-----/);
    git("verify-commit", result.commit);
    assert.equal(git("log", "-1", "--format=%G?", result.commit), "G");
  } finally { removeRepo(root); }
});
test("bare 원격에 push되어 원격 추적 ref에 포함된 반영은 합치지 않는다", () => {
  const { root, git, active } = cycleRepo();
  try {
    const remote = join(root, ".git", "remote.git"); mkdirSync(remote);
    execFileSync("git", ["init", "--bare", "-q", remote], { stdio: "pipe" });
    git("remote", "add", "origin", remote); git("push", "-u", "origin", active.branch!);
    assert.match(inspectSquash(root, active).reason!, /다른 로컬 브랜치/);
  } finally { removeRepo(root); }
});
