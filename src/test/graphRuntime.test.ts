import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { withGraphRun } from "../agent/graph/runtime";
import { graphView } from "../agent/graph/view";

test("SQLite 재개: wait 뒤 최신 외부 상태를 관찰하고 실행 잠금을 해제한다", async () => {
  const root = mkdtempSync(join(tmpdir(), "ca-graph-"));
  const State = Annotation.Root({ done: Annotation<boolean>() });
  let approved = false, effects = 0;
  const execute = () => withGraphRun(root, "test", "one", async run => {
    const graph = new StateGraph(State)
      .addNode("observe", () => { run.event("observe", "running"); return { done: approved }; })
      .addNode("wait", () => { interrupt({ reason: "approval" }); return {}; })
      .addNode("finish", () => { effects++; return {}; })
      .addEdge(START, "observe")
      .addConditionalEdges("observe", state => state.done ? "finish" : "wait", ["finish", "wait"])
      .addEdge("wait", "observe").addEdge("finish", END)
      .compile({ checkpointer: run.saver });
    return run.invoke<typeof State.State>(graph, { done: false }, true);
  });
  try {
    assert.equal(graphView(root), undefined);
    await execute();
    assert.equal(effects, 0);
    assert.equal(graphView(root)?.latest?.status, "waiting");
    assert.equal(existsSync(join(root, ".code-agent/graph/run.lock")), false);
    const snapshot = () => readdirSync(join(root, ".code-agent/graph")).map(name => [name, statSync(join(root, ".code-agent/graph", name)).mtimeMs]);
    const before = snapshot();
    graphView(root); graphView(root);
    assert.deepEqual(snapshot(), before, "조회는 WAL 보조 파일도 만들거나 고치지 않는다");
    await execute();
    assert.equal(effects, 0, "재개 신호는 승인 대신 쓰이지 않는다");
    approved = true;
    await execute();
    assert.equal(effects, 1);
    assert.equal(graphView(root)?.latest?.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("master 정지·소유 세대 변경은 다음 효과 노드 실행 전에 차단한다", async () => {
  const root = mkdtempSync(join(tmpdir(), "ca-graph-master-"));
  const old = process.env.CODE_AGENT_MASTER_RUN;
  const dir = join(root, ".code-agent/master");
  mkdirSync(join(dir, "runs"), { recursive: true });
  const saveOwner = (generation: number) => writeFileSync(join(dir, "owner.json"), JSON.stringify({ controller: "master", generation }));
  const saveRun = (stop = false) => writeFileSync(join(dir, "runs/run-test.json"), JSON.stringify({ runId: "run-test", controller: "master", generation: 1, state: "running", ...(stop ? { stop: { mode: "pause" } } : {}) }));
  process.env.CODE_AGENT_MASTER_RUN = "run-test";
  let effects = 0;
  try {
    saveOwner(1); saveRun();
    await assert.rejects(withGraphRun(root, "control", "one", async run => {
      run.event("first", "running"); effects++;
      saveRun(true);
      run.event("second", "running"); effects++;
    }), /일시 정지/);
    assert.equal(effects, 1);
    saveRun(); saveOwner(2);
    await assert.rejects(withGraphRun(root, "control", "two", async () => { effects++; }), /소유 세대/);
    assert.equal(effects, 1);
    assert.equal(existsSync(join(root, ".code-agent/graph/run.lock")), false);
  } finally {
    if (old === undefined) delete process.env.CODE_AGENT_MASTER_RUN; else process.env.CODE_AGENT_MASTER_RUN = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("같은 프로젝트의 동시 그래프 실행을 거부하고 실패 뒤 잠금을 해제한다", async () => {
  const root = mkdtempSync(join(tmpdir(), "ca-graph-lock-"));
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = withGraphRun(root, "test", "one", async () => { entered(); await hold; });
    await ready;
    await assert.rejects(withGraphRun(root, "test", "two", async () => {}), /잠금/);
    release(); await first;
    await assert.rejects(withGraphRun(root, "test", "three", async () => { throw new Error("실행 실패"); }), /실행 실패/);
    assert.equal(graphView(root)?.latest?.status, "failed");
    assert.equal(existsSync(join(root, ".code-agent/graph/run.lock")), false);
  } finally { release?.(); rmSync(root, { recursive: true, force: true }); }
});

test("모르는 DB 형식은 실행·덮어쓰기 없이 거부한다", async () => {
  const root = mkdtempSync(join(tmpdir(), "ca-graph-version-"));
  const dir = join(root, ".code-agent/graph");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  db.exec("CREATE TABLE graph_meta(key TEXT PRIMARY KEY,value INTEGER); INSERT INTO graph_meta VALUES('version',999)");
  db.close();
  let effects = 0;
  try {
    await assert.rejects(withGraphRun(root, "test", "one", async () => { effects++; }), /지원하지 않습니다/);
    assert.equal(effects, 0);
    const check = new DatabaseSync(join(dir, "state.sqlite"));
    try {
      assert.equal(check.prepare("SELECT value FROM graph_meta WHERE key='version'").get()?.value, 999);
      assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='graph_runs'").get(), undefined);
    } finally { check.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
