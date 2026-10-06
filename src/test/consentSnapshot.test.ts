import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { applyConsent, consentSnapshot, loadConsent, observeConsent, prepareConsent } from "../agent/consent";
import { readDocLedger } from "../agent/docs";
import { decide } from "../agent/hook";
import { requestBegin } from "../agent/request";
import { consentEvent, gitFixture, nativeResponse, observeConsentFixture, prepareConsentFixture, setupConsentProject, writeFixture } from "./consentFixture";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-snapshot-")));
  setupConsentProject(root);
  appendFileSync(join(root, ".gitignore"), "\naidlc/.aidlc-sessions/\n.gradle/\nlogs/\ndoc/\ncode-agent.json\n.claude/\nCLAUDE.md\nAGENTS.md\ncustom/\nREADME.md\n");
  writeFixture(root, "existing.txt", "existing\n");
  gitFixture(root, "add", "existing.txt"); gitFixture(root, "commit", "-qm", "existing repository");
});
afterEach(() => {
  const target = resolve(root), temp = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temp + sep) && target.slice(temp.length + 1).startsWith("ca-snapshot-"));
  rmSync(target, { recursive: true, force: true });
});

test("setup: ignored external hook writes between prepare, question, response and apply do not invalidate consent", () => {
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "aidlc engine hook fold-usage" }] }] } });
  writeFixture(root, ".claude/settings.json", settings);
  const noise = (cursor: number) => {
    for (const file of ["aidlc/.aidlc-sessions/usage-ledger.json", ".gradle/cache.bin", "logs/app.log"]) writeFixture(root, file, JSON.stringify({ cursor }));
  };
  noise(0);
  const fixture = prepareConsentFixture(root, { action: "setup" });
  const before = gitFixture(root, "status", "--short");
  const policy = readFileSync(join(root, "doc/architecture.md"));
  noise(1); observeConsent(consentEvent(fixture, "PreToolUse"));
  noise(2); observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
  noise(3);
  assert.equal(gitFixture(root, "status", "--short"), before);
  assert.deepEqual(readFileSync(join(root, "doc/architecture.md")), policy);
  assert.match(applyConsent(root, fixture.id), /도입.*커밋/);
  assert.equal(loadConsent(root, fixture.id).status, "applied");
  assert.equal(readDocLedger(root).length, 4);
  assert.equal(gitFixture(root, "rev-list", "--count", "HEAD"), "2");
  const committed = gitFixture(root, "ls-tree", "-r", "--name-only", "HEAD");
  for (const file of ["code-agent.json", ".claude/settings.json", "doc/architecture.md"]) assert.ok(committed.split("\n").includes(file));
  assert.doesNotMatch(committed, /usage-ledger|cache.bin|app.log|consents\//);
  assert.equal(readFileSync(join(root, ".claude/settings.json"), "utf8"), settings);
  noise(4); applyConsent(root, fixture.id);
  assert.equal(gitFixture(root, "rev-list", "--count", "HEAD"), "2");
});

for (const file of ["code-agent.json", "doc/architecture.md", ".claude/settings.json", "CLAUDE.md", "AGENTS.md", ".code-agent/log/stages.jsonl", "src/new.ts", "existing.txt"]) {
  test(`snapshot: changed ${file} remains protected and is named in the error`, () => {
    if (!["code-agent.json", "doc/architecture.md", "existing.txt"].includes(file)) writeFixture(root, file, "original\n");
    const fixture = prepareConsentFixture(root, { action: "docs" });
    observeConsentFixture(fixture);
    appendFileSync(join(root, file), "\n");
    assert.throws(() => applyConsent(root, fixture.id), error => {
      assert.ok(error instanceof Error && error.message.includes(file)); return true;
    });
    assert.equal(readDocLedger(root).length, 0);
  });
}

test("snapshot: ignored custom POLICY, KNOWLEDGE, stage template and spec paths remain protected", () => {
  const manifest = JSON.parse(readFileSync(join(root, "code-agent.json"), "utf8"));
  const files = ["custom/architecture.md", "custom/knowledge.md", "custom/stage.md", "custom/spec.md"];
  manifest.docs.architecture = files[0]; manifest.docs.knowledge = { dataDictionary: files[1] };
  manifest.stages[0].template = files[2];
  writeFixture(root, "code-agent.json", JSON.stringify(manifest));
  for (const file of files) writeFixture(root, file, "original");
  const action = { action: "abort" as const, decision: "accept" as const, sendsCode: false, spec: files[3] };
  for (const file of files) {
    const before = consentSnapshot(root, action);
    appendFileSync(join(root, file), "changed");
    assert.notEqual(consentSnapshot(root, action), before, file);
  }
});

test("setup: ignored preparation document is included in consent before the question", () => {
  const fixture = prepareConsentFixture(root, { action: "setup" });
  appendFileSync(join(root, "doc/architecture.md"), "changed\n");
  assert.throws(() => observeConsent(consentEvent(fixture, "PreToolUse")), /doc\/architecture\.md/);
  assert.equal(loadConsent(root, fixture.id).status, "pending");
});

test("setup: an existing repository's README is not a preparation file and does not invalidate consent", () => {
  writeFixture(root, "README.md", "team readme\n");
  const fixture = prepareConsentFixture(root, { action: "setup" });
  appendFileSync(join(root, "README.md"), "edited while answering\n");
  observeConsent(consentEvent(fixture, "PreToolUse"));
  assert.equal(loadConsent(root, fixture.id).status, "pending");
});

test("snapshot: added/deleted files are diagnosed with bounded output and no file contents", () => {
  writeFixture(root, "src/deleted.ts", "original");
  const fixture = prepareConsentFixture(root, { action: "docs" });
  unlinkSync(join(root, "src/deleted.ts"));
  for (let i = 0; i < 8; i++) writeFixture(root, `src/new-${i}.ts`, "PRIVATE-CONTENT-MARKER");
  assert.throws(() => observeConsent(consentEvent(fixture, "PreToolUse")), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /src\/deleted.ts/); assert.match(error.message, /외 3건/);
    assert.doesNotMatch(error.message, /PRIVATE-CONTENT-MARKER/); return true;
  });
  const entries = JSON.stringify(loadConsent(root, fixture.id).snapshotEntries);
  assert.doesNotMatch(entries, /original|PRIVATE-CONTENT-MARKER/);
});

for (const change of ["index", "branch", "config"] as const) {
  test(`snapshot: Git ${change} changes include the state name in diagnostics`, () => {
    writeFixture(root, "new.txt", "unchanged bytes");
    const fixture = prepareConsentFixture(root, { action: "docs" });
    if (change === "index") gitFixture(root, "add", "new.txt");
    if (change === "branch") gitFixture(root, "switch", "-qc", "other");
    if (change === "config") gitFixture(root, "config", "review.marker", "PRIVATE-CONFIG-MARKER");
    const label = change === "index" ? "Git index" : change === "branch" ? "Git 브랜치" : "Git 설정";
    assert.throws(() => observeConsent(consentEvent(fixture, "PreToolUse")), error => {
      assert.ok(error instanceof Error && error.message.includes(label));
      assert.doesNotMatch(error.message, /PRIVATE-CONFIG-MARKER/); return true;
    });
  });
}

test("snapshot: branch tracking written by another worktree's push -u does not invalidate consent", () => {
  const fixture = prepareConsentFixture(root, { action: "docs" });
  gitFixture(root, "config", "branch.other.remote", "origin");
  gitFixture(root, "config", "branch.other.merge", "refs/heads/other");
  observeConsent(consentEvent(fixture, "PreToolUse"));
  assert.equal(loadConsent(root, fixture.id).status, "pending");
});

test("snapshot: old records without per-path hashes still reject changed targets with reprepare guidance", () => {
  const fixture = prepareConsentFixture(root, { action: "docs" }), record = loadConsent(root, fixture.id);
  delete record.snapshotEntries;
  writeFixture(root, `.code-agent/consents/${fixture.id}.json`, JSON.stringify(record));
  observeConsent(consentEvent(fixture, "PreToolUse"));
  appendFileSync(join(root, "doc/architecture.md"), "changed");
  assert.throws(() => observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) })), /이전 동의 기록.*경로별 해시/);
});

test("snapshot: a repository without Git still notices arbitrary local file changes", () => {
  const plain = join(root, "plain"); mkdirSync(plain);
  writeFixture(plain, "logs/app.log", "before");
  const prepared = JSON.parse(prepareConsent(plain, { action: "abort" }));
  const record = loadConsent(plain, prepared.id);
  writeFixture(plain, "logs/app.log", "after");
  assert.notEqual(consentSnapshot(plain, record.action), record.snapshot);
});

test("snapshot: Git worktrees also ignore external session noise", () => {
  const worktree = join(root, "linked");
  gitFixture(root, "worktree", "add", "-qb", "linked", worktree);
  writeFixture(worktree, ".gitignore", "logs/\n");
  writeFixture(worktree, "logs/app.log", "before");
  const action = { action: "abort" as const, decision: "accept" as const, sendsCode: false };
  const before = consentSnapshot(worktree, action);
  writeFixture(worktree, "logs/app.log", "after");
  assert.equal(consentSnapshot(worktree, action), before);
});

test("intake: help and --help are allowed while appended commands remain blocked", () => {
  requestBegin(root, "HELP-1", "fix");
  for (const tool_name of ["Bash", "PowerShell"]) {
    for (const command of ["code-agent", "code-agent help", "code-agent --help"]) assert.equal(decide({ cwd: root, tool_name, tool_input: { command } }, root), undefined);
    for (const command of ["code-agent help extra", "code-agent --help && git add .", "code-agent help > help.txt"]) assert.ok(decide({ cwd: root, tool_name, tool_input: { command } }, root));
  }
});
