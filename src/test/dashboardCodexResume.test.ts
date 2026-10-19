import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { root, question, request, choose, send, previousRun } from "./dashboardFixture";
import { initialize } from "../agent/init";
import { readBinding, writeBinding, writeRunRecord, listRuns } from "../agent/master/store";
import { publishInteraction, interactionContext, currentInteractions } from "../agent/interactions";
import { PublishInteraction } from "../agent/interactionSchema";
import { drainInteraction } from "../agent/interactionService";
import { hostProfileOf } from "../agent/master/protocol";

test("대시보드 실제 서명 응답은 확인된 Codex thread를 중복 없이 재개 예약한다", () => {
  initialize(root);
  const home = join(root, "test-home"); mkdirSync(home);
  writeFileSync(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n[hooks.state.${JSON.stringify(root + "/.codex/hooks.json")} ]\ntrusted_hash = "synthetic"\n`);
  const saved = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  try {
    const binding = readBinding(root)!; binding.host = hostProfileOf({ kind: "codex", command: ["fixture"] }); writeBinding(root, binding);
    const run = { ...previousRun(), hostProfile: binding.host, sessionId: randomUUID(), sessionConfirmed: true }; writeRunRecord(root, run);
    const q = publishInteraction(root, PublishInteraction.parse({ key: "codex-restart", stage: "setup", title: "구성", questions: [question()] }), interactionContext(root, run.sessionId, "codex", run.runId));
    assert.equal(send(request(q, choose())).ok, true); drainInteraction(root, q.requestId); drainInteraction(root, q.requestId);
    const runs = listRuns(root); assert.equal(runs.length, 2);
    const next = runs.find(r => r.runId !== run.runId)!; assert.equal(next.sessionId, run.sessionId); assert.equal(next.hostProfile?.kind, "codex"); assert.equal(next.resumeOf, run.sessionId);
  } finally { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; }
});
test("호스트가 바뀌었거나 thread가 미확인인 응답은 다른 호스트로 자동 재개하지 않는다", () => {
  const binding = readBinding(root)!; binding.host = hostProfileOf({ kind: "codex", command: ["fixture"] }); writeBinding(root, binding);
  const run = { ...previousRun(), hostProfile: binding.host, sessionConfirmed: false }; writeRunRecord(root, run);
  const q = publishInteraction(root, PublishInteraction.parse({ key: "unconfirmed", stage: "setup", title: "구성", questions: [question()] }), interactionContext(root, run.sessionId, "codex", run.runId));
  assert.equal(send(request(q, choose())).ok, true); drainInteraction(root, q.requestId);
  assert.equal(listRuns(root).length, 1); assert.equal(currentInteractions(root).requests[0].continuation?.state, "blocked");
});
