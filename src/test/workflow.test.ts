import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runWorkflow } from "../core/workflow";
import type { NodeEvent } from "../core/workflow";

test("program 연속 실행 후 agent 경계에서 요청만 반환한다", async () => {
  const events: NodeEvent[] = [];
  const context = { count: 0 };
  const result = await runWorkflow({
    first: { executor: "program", run: (c: typeof context) => { c.count++; return "ok"; }, edges: { ok: "second" } },
    second: { executor: "program", run: async (c: typeof context) => { c.count++; return "fail"; }, edges: { fail: "repair" } },
    repair: { executor: "agent", task: "수정" },
  }, "first", context, (event) => events.push(event));
  assert.equal(context.count, 2);
  assert.deepEqual(result, { node: "repair", executor: "agent", task: "수정" });
  assert.deepEqual(events.map((event) => event.status), ["running", "completed", "running", "completed", "waiting"]);
});

test("정의되지 않은 전이와 실행 오류는 기록하고 중단한다", async () => {
  const events: NodeEvent[] = [];
  await assert.rejects(runWorkflow({
    execute: { executor: "program", run: () => "unexpected", edges: {} },
  }, "execute", {}, (event) => events.push(event)), /정의되지 않은 workflow 전이/);
  assert.equal(events.at(-1)?.status, "error");
  assert.match(events.at(-1)?.detail ?? "", /unexpected/);
});

test("human 경계는 실행하지 않고 대기하며 program 무한 루프는 차단한다", async () => {
  assert.equal((await runWorkflow({ decision: { executor: "human", task: "판단" } }, "decision", {}, () => {})).executor, "human");
  await assert.rejects(runWorkflow({ loop: { executor: "program", run: () => "again", edges: { again: "loop" } } }, "loop", {}, () => {}), /전이 한도/);
});
