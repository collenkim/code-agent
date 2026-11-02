import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { createRepo, removeRepo, writeFixture, gitFixture, repoTools } from "./repoFixture";
import { setupConsentProject } from "./consentFixture";
import { pendingBaselineFiles } from "../agent/bootstrap";
import { withInteraction } from "../agent/tty";

const fixtures = require("../../scripts/full-flow-fixtures.cjs") as {
  prepareBaseline(root: string): boolean; progressKey(root: string): string;
  stalledProgress(previous: string, current: string, count?: number): number;
};
test("평가 준비는 HEAD 뒤 바뀐 실행 정책도 실제 준비 커밋에 넣으며 같은 준비를 반복하지 않는다", () => {
  const root = createRepo("ca-eval-baseline-");
  try {
    setupConsentProject(root);
    repoTools(() => root).confirmDocs();
    gitFixture(root, "add", "-A"); gitFixture(root, "commit", "-qm", "baseline");
    writeFixture(root, ".code-agent/execution.json", '{"version":1,"mode":"codex"}\n');
    assert.ok(pendingBaselineFiles(root).includes(".code-agent/execution.json"));
    withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "automated evaluation fixture; not human" }), ask: () => "n" }, () => {
      assert.equal(fixtures.prepareBaseline(root), true);
      assert.equal(fixtures.prepareBaseline(root), false);
    });
    assert.deepEqual(pendingBaselineFiles(root), []);
  } finally { removeRepo(root); }
});
test("평가 진척은 조회 로그를 제외하고 작업 파일·승인·HEAD 변경을 센다", () => {
  const root = createRepo("ca-eval-progress-");
  try {
    const first = fixtures.progressKey(root);
    writeFixture(root, ".code-agent/log/hook.jsonl", "status\n");
    writeFixture(root, ".code-agent/lease.json", "heartbeat\n");
    assert.equal(fixtures.progressKey(root), first);
    writeFixture(root, "doc/architecture.md", "프로젝트 구조");
    const docs = fixtures.progressKey(root);
    assert.notEqual(docs, first, "공통 문서 준비도 진척이다");
    writeFixture(root, "doc/work/W/request.json", "request");
    const changed = fixtures.progressKey(root);
    assert.notEqual(changed, docs);
    assert.equal(fixtures.stalledProgress(first, first), 1);
    assert.equal(fixtures.stalledProgress(first, first, 1), 2);
    assert.equal(fixtures.stalledProgress(first, changed, 1), 0);
    writeFixture(root, ".code-agent/approvals/docs.jsonl", "fixture\n");
    assert.notEqual(fixtures.progressKey(root), changed);
    writeFixture(root, "code-agent.json", "{");
    assert.doesNotThrow(() => fixtures.progressKey(root), "준비 중인 설정 초안 때문에 진척 집계를 중단하지 않는다");
  } finally { removeRepo(root); }
});
test("권한 응답 경로 없는 Codex 전체 평가는 호스트 호출 전에 명시적으로 거부한다", () => {
  for (const extra of [[], ["--hosts", "both", "--vetted-hooks"]]) {
    const result = spawnSync(process.execPath, [join(__dirname, "../../scripts/evaluate-full-flow.cjs"), "run", "enhance", "--main", "codex", ...extra],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, CODE_AGENT_LIVE_EVAL: "1", CLAUDE_EVALUATION_BIN: "must-not-start-host" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Git 쓰기 권한 응답 경로.*유료 호스트는 호출하지 않았습니다/s);
  }
});
