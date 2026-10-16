import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { advanceFlow } from "../agent/graph/lifecycle";
import { advancePhase } from "../agent/graph/transition";
import { graphView } from "../agent/graph/view";
import { loadActive, saveActive } from "../agent/layout";
import { loadEvidence } from "../agent/evidence";
import { stateView } from "../agent/stateView";
import { useNotation } from "../agent/hostText";
import { integrate } from "../agent/validate";
import { requireValidatable } from "../agent/commands";
import { ORDER, createStageRepo, removeStageRepo, repo, toCheck, toIntegrate, useManifest, FAIL_UNTIL_FIXED, write } from "./stageFixture";

beforeEach(() => createStageRepo("ca-graph-flow-"));
afterEach(() => { useNotation("claude"); removeStageRepo(); });

for (const host of ["claude", "codex"] as const) test(`${host}: 같은 그래프로 검증을 실행하고 리뷰에 인계하며 재개 시 통과 증거를 재사용한다`, async () => {
  toCheck(); useNotation(host);
  const first = await advanceFlow(repo);
  assert.equal(first.node, "review");
  assert.equal(first.kind, "agent");
  assert.match(first.procedure!, host === "claude" ? /^\.claude\/skills\// : /^\.agents\/skills\//);
  assert.equal(loadActive(repo)!.phase, "review");
  assert.equal(graphView(repo)?.latest?.status, "waiting");
  assert.equal(existsSync(join(repo, ".code-agent/graph/run.lock")), false);
  const rounds = loadEvidence(repo, "ORD-1", "order")!.rounds;
  assert.equal((await advanceFlow(repo)).node, "review");
  assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, rounds);
});

test("수정 인계는 파일 변경 뒤 검증으로 돌아간다", async () => {
  useManifest({ test: FAIL_UNTIL_FIXED }); toCheck();
  assert.equal((await advanceFlow(repo)).node, "repair");
  const failedRound = loadEvidence(repo, "ORD-1", "order")!.rounds;
  assert.equal((await advanceFlow(repo)).node, "repair");
  assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, failedRound);
  write(`${ORDER}/domain/Order.java`, "class Order {} // fixed\n");
  assert.equal((await advanceFlow(repo)).node, "review");
});

test("열린 작업이 없으면 완료로 반환하고 새 접수를 스스로 만들지 않는다", async () => {
  const result = await advanceFlow(repo);
  assert.equal(result.kind, "done");
  assert.equal(result.action, "no-work");
  assert.equal(loadActive(repo), undefined);
  assert.equal(existsSync(join(repo, ".code-agent/request-session.json")), false);
});

test("통합은 그래프가 실행하고 반영은 사람 확인을 거치며 조회·대기는 승인 상태 해시를 바꾸지 않는다", async () => {
  await toIntegrate();
  const result = await advanceFlow(repo);
  assert.equal(result.node, "deliver"); assert.equal(result.kind, "human");
  const before = stateView(repo);
  await advanceFlow(repo);
  const after = stateView(repo);
  assert.equal(before.stateVersion, after.stateVersion);
  assert.ok(after.graph?.latestSeq);
});

test("통합 증거 저장 뒤 커서 이동 전에 끊긴 실행은 통합을 다시 실행하지 않는다", async () => {
  await toIntegrate();
  await integrate(requireValidatable(repo, "integrate"));
  const evidence = loadEvidence(repo, "ORD-1", "order")!;
  const before = JSON.stringify(evidence);
  assert.equal(loadActive(repo)!.phase, "integrate");
  assert.equal((await advanceFlow(repo)).node, "deliver");
  assert.equal(JSON.stringify(loadEvidence(repo, "ORD-1", "order")), before);
});

test("단계 전이 그래프는 누락된 증거로 넘어가지 않고 기대 상태가 낡으면 실행 전 거부한다", async () => {
  toCheck();
  await assert.rejects(advancePhase(repo), /검증|실행|증거/);
  assert.equal(loadActive(repo)!.phase, "check");
  const before = readFileSync(join(repo, ".code-agent/graph/state.sqlite"));
  await assert.rejects(advanceFlow(repo, { expectState: "stale" }), /다시 조회/);
  assert.deepEqual(readFileSync(join(repo, ".code-agent/graph/state.sqlite")), before);
});

test("승인 무효로 재계획할 때는 낡아진 첫 단계의 절차를 인계한다", async () => {
  toCheck();
  saveActive(repo, { ...loadActive(repo)!, planningVersion: 1 });
  write(".code-agent/work/ORD-1/order.planning.json", JSON.stringify({ version: 1, id: "ORD-1", target: "order", maxParallel: 3, agents: [],
    tasks: [{ task: { id: "analysis", role: "analysis", inputs: ["doc/work/ORD-1.md"], outputs: ["doc/work/ORD-1/01-requirements.md"], dependsOn: [], scopes: [], requirements: [] },
      attempts: [{ dispatchId: randomUUID(), inputHash: "old", at: new Date().toISOString(), status: "completed" }] }] }));
  const result = await advanceFlow(repo);
  assert.equal(result.node, "replan");
  assert.match(result.procedure!, /ca-analyze\/SKILL\.md$/);
  assert.match(result.instruction, /back analysis/);
  assert.equal(loadActive(repo)!.phase, "check", "인계만으로 커서를 바꾸지 않는다");
});
