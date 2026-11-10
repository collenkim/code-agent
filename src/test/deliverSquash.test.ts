import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { answerSources } from "../agent/answers";
import { upsertBlock } from "../agent/blocks";
import { start as startWork } from "../agent/commands";
import { recordDeliveredCycle } from "../agent/cycles";
import { deliver, prDocFile, renderTraceBlock, squashCommitMessage } from "../agent/deliver";
import { loadEvidence } from "../agent/evidence";
import { loadActive, type ActiveWork } from "../agent/layout";
import { writeWorkBinding } from "../agent/master/store";
import { budgetEpoch } from "../agent/planning";
import { parseQuestions } from "../agent/questions";
import { textHash } from "../agent/requirementRevisions";
import { withInteraction } from "../agent/tty";
import { applyConsent } from "../agent/consent";
import { confirmationText, observeConsentFixture, prepareConsentFixture } from "./consentFixture";
import { loadWork } from "../agent/work";
import { confirmForTest } from "./confirmedStart";
import { createStageRepo, git, removeStageRepo, repo, toDeliver, write, writePr } from "./stageFixture";

beforeEach(() => createStageRepo("ca-deliver-squash-"));
afterEach(() => removeStageRepo());
const spec = "doc/work/ORD-1/requirement.md";
function previousCycle(): string {
  write(".gitignore", "build/\n.code-agent/consents/\n");
  git("add", ".gitignore"); git("commit", "--amend", "--no-edit", "-q");
  git("switch", "-qc", "feature/ORD-1");
  write(spec, readFileSync(join(repo, "doc/work/ORD-1.md"), "utf8"));
  const active: ActiveWork = { id: "ORD-1", spec, target: "order", phase: "deliver", branch: "feature/ORD-1", baseCommit: git("rev-parse", "HEAD") };
  recordDeliveredCycle(repo, active, { requestHash: textHash(readFileSync(join(repo, spec), "utf8")), baseCommit: active.baseCommit!, treeHash: "fixture" });
  write("doc/work/ORD-1/questions.md", "## Q1 · 분석\n범위?\n[Answer]: 주문 도메인\n");
  git("add", "-f", "--", ".code-agent/work/ORD-1/cycles.json", "doc/work/ORD-1/questions.md", spec);
  git("commit", "-qm", "[ORD-1] 이전 회차\n\nCo-authored-by: Helper <helper@example.com>");
  const first = git("rev-parse", "HEAD");
  write(spec, readFileSync(join(repo, spec), "utf8").replace("title: 주문 도메인 추가", "title: 주문 도메인 보완"));
  return first;
}
function apply(onConfirm: (shown: string) => void = () => {}, approvedLine?: string): string {
  return withInteraction({ confirm(shown) { onConfirm(shown); return { channel: "tty", verified: true, detail: "자동 시험 fixture — 사람 승인 아님" }; }, ask() { return "n"; } }, () => deliver(loadWork(repo)!, approvedLine));
}
test("실제 deliver: 문서와 squash 메시지가 같고 회차 3 재시작·답·예산 구간을 잇는다", async () => {
  previousCycle(); await toDeliver(spec); writePr();
  const base = git("rev-parse", "master");
  const work = loadWork(repo)!, expected = squashCommitMessage(work, loadEvidence(repo, "ORD-1", "order")!);
  assert.match(expected, /회차 2 · 개정 .* · 이번 반영/);
  const result = apply(shown => assert.match(shown, /합칩니다 — 2개/));
  assert.match(result, /이전 회차 커밋 1개와 합쳐/);
  const combined = git("rev-parse", "HEAD");
  assert.equal(git("show", "-s", "--format=%P", combined), base);
  const document = git("show", `HEAD:${prDocFile("ORD-1")}`);
  assert.equal(/## squash 커밋 메시지\n\n```text\n([\s\S]*?)\n```/.exec(document)?.[1], expected);
  assert.equal(git("show", "-s", "--format=%B", "HEAD"), expected);
  assert.throws(() => startWork(repo, join(repo, spec)), /이 요구로 이미 반영했습니다 \(회차 2/);
  write(spec, readFileSync(join(repo, spec), "utf8").replace("title: 주문 도메인 보완", "title: 주문 도메인 추가 보완"));
  confirmForTest(repo, join(repo, spec));
  assert.match(startWork(repo, join(repo, spec)), /실행 회차 3/);
  assert.equal(loadActive(repo)?.cycle?.delivered, combined);
  assert.equal(loadActive(repo)?.baseCommit, combined);
  const questions = parseQuestions(readFileSync(join(repo, "doc/work/ORD-1/questions.md"), "utf8"));
  assert.equal(answerSources(repo, "ORD-1", questions).get("Q1"), "delivered");
  assert.match(budgetEpoch(loadWork(repo)!).key, /^c3-/);
});
test("master 연결 작업은 실제 반영을 성공시키고 합치지 않는다", async () => {
  previousCycle(); await toDeliver(spec); writePr();
  writeWorkBinding(repo, { workId: "ORD-1", links: {}, boundAt: new Date().toISOString(), runId: "fixture", controller: "fixture", runs: [] });
  assert.match(apply(), /합치지 않았습니다 — master 관리 작업/);
  assert.equal(git("rev-list", "--count", "master..HEAD"), "2");
});
test("동의 화면을 본 뒤 참조가 달라지면 정상 반영 커밋을 유지한다", async () => {
  const first = previousCycle(); await toDeliver(spec); writePr();
  assert.match(apply(() => git("update-ref", "refs/tags/late", first)), /합치지 않았습니다/);
  assert.equal(git("rev-list", "--count", "master..HEAD"), "2");
});
test("동의 준비 뒤 ref 변경은 합치기만 생략하고 이전 코드 구역은 손 수정으로 보지 않는다", async () => {
  const first = previousCycle(); await toDeliver(spec); writePr();
  assert.throws(() => apply(() => { throw new Error("capture"); }), /capture/);
  const work = loadWork(repo)!, path = prDocFile("ORD-1"), evidence = loadEvidence(repo, "ORD-1", "order");
  write(path, upsertBlock(readFileSync(join(repo, path), "utf8"), "trace", renderTraceBlock(work, evidence, { noSquash: true })));
  const consent = prepareConsentFixture(repo, { action: "deliver" });
  assert.doesNotMatch(confirmationText(consent), /손으로 고쳐져/);
  observeConsentFixture(consent);
  git("update-ref", "refs/tags/published", first);
  const result = applyConsent(repo, consent.id);
  assert.match(result, /동의 준비 후 합치기 판정 또는 참조 상태가 바뀌었습니다/);
  assert.equal(git("rev-list", "--count", "master..HEAD"), "2");
});
