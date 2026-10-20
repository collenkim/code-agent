import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import interactions = require("../agent/interactions");
import { root, question, request, choose, send } from "./dashboardFixture";
import { CODEX_MARKERS } from "../agent/crossEnv";
import { interactionContext, publishInteraction, readInteractions } from "../agent/interactions";
import { PublishInteraction } from "../agent/interactionSchema";
import { recoverSession } from "../agent/master/recovery";
import { nativeSession } from "../agent/master/nativeSession";
import { listRuns, readOwner, writeOwner, readBinding, writeBinding, readWorkBinding } from "../agent/master/store";
import { initialize } from "../agent/init";
import { hostProfileOf } from "../agent/master/protocol";
import { requestBegin, loadRequestSession } from "../agent/request";
import { drainInteraction } from "../agent/interactionService";
import { withInteraction } from "../agent/tty";

let saved: NodeJS.ProcessEnv, session: string, file: string;
beforeEach(() => {
  saved = { ...process.env };
  for (const key of [...CODEX_MARKERS, "CLAUDECODE"]) delete process.env[key];
  process.env.CLAUDE_CONFIG_DIR = join(root, "native-claude");
  process.env.CODEX_HOME = join(root, "native-codex");
  session = randomUUID();
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "project"); mkdirSync(dir, { recursive: true });
  file = join(dir, `${session}.jsonl`);
  writeFileSync(file, JSON.stringify({ sessionId: session, cwd: root, type: "user", message: { content: "fixture native conversation" } }) + "\n");
});
afterEach(() => { process.env = saved; });
function publish(key = "recover") {
  return publishInteraction(root, PublishInteraction.parse({ key, stage: "setup", title: "복원 질문", questions: [question()] }), interactionContext(root, session, "claude"));
}
function recover(id: string, confirm?: () => void) {
  return JSON.parse(withInteraction({ ask: () => "n", confirm: () => { confirm?.(); return { channel: "tty", verified: true, detail: "automated fixture; not human" }; } }, () => recoverSession(root, id)));
}
test("원본 대조·TTY 복원은 서명 대상과 실제 답을 보존하고 같은 세션 재개를 한 번만 예약한다", () => {
  const r = publish(); assert.equal(send(request(r, choose())).ok, true);
  const before = structuredClone(readInteractions(root)!.requests[r.requestId]);
  assert.equal(JSON.parse(recoverSession(root, r.requestId, { json: true })).source.file, file);
  assert.equal(listRuns(root).length, 0);
  const result = recover(r.requestId); assert.equal(result.started, false);
  const event = JSON.parse(readFileSync(join(root, ".code-agent/master/events.jsonl"), "utf8").trim().split(/\r?\n/).at(-1)!);
  assert.equal(event.type, "interaction.changed"); assert.equal(event.data.cursor, readInteractions(root)!.seq);
  const after = readInteractions(root)!.requests[r.requestId];
  for (const key of ["context", "contentHash", "challenge", "response"] as const) assert.deepEqual(after[key], before[key]);
  assert.equal(after.recoveredRunId, result.runId);
  assert.equal(recover(r.requestId).alreadyRecovered, true);
  drainInteraction(root, r.requestId); drainInteraction(root, r.requestId);
  const runs = listRuns(root); assert.equal(runs.length, 2);
  const resumed = runs.find(run => !run.recovery)!;
  assert.equal(resumed.resumeOf, session); assert.equal(resumed.sessionId, session);
  assert.equal(after.context.runId, undefined);
});
test("미응답 복원은 실행하지 않고 모든 같은 세션 질문의 실제 답을 기다린다", () => {
  const a = publish("a"), b = publish("b"); recover(a.requestId);
  assert.equal(listRuns(root).length, 1);
  const fresh = (id: string) => readInteractions(root)!.requests[id];
  assert.equal(send(request(fresh(a.requestId), choose())).ok, true); drainInteraction(root, a.requestId);
  assert.equal(listRuns(root).length, 1);
  assert.equal(send(request(fresh(b.requestId), choose())).ok, true); drainInteraction(root, b.requestId);
  assert.equal(listRuns(root).length, 2);
});
test("모델 셸은 복원할 수 없고 확인 중 원본 변경도 기록을 만들지 않는다", () => {
  const r = publish(); process.env.CODEX_CI = "1";
  assert.throws(() => recover(r.requestId), /호스트 밖/); delete process.env.CODEX_CI;
  assert.throws(() => recover(r.requestId, () => writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ type: "assistant" }) + "\n")), /확인 중/);
  assert.equal(listRuns(root).length, 0);
});
test("원본이 없거나 소유 세대가 바뀌면 재복원을 거부한다", () => {
  const r = publish(); recover(r.requestId);
  const owner = readOwner(root)!; owner.generation++; writeOwner(root, owner);
  assert.throws(() => recover(r.requestId), /다른 소유 세대/);
  assert.throws(() => nativeSession(root, "claude", randomUUID()), /하나로 확인/);
});
test("다른 프로젝트·하위 세션·손상 기록·외부 파일을 원본으로 인정하지 않는다", () => {
  for (const row of [{ sessionId: session, cwd: join(root, "native-claude"), type: "user" }, { sessionId: session, cwd: root, isSidechain: true, type: "user" }]) {
    writeFileSync(file, JSON.stringify(row)); assert.throws(() => nativeSession(root, "claude", session), /주 세션/);
  }
  writeFileSync(file, "null\n"); assert.throws(() => nativeSession(root, "claude", session), /손상/);
  writeFileSync(file, "{"); assert.throws(() => nativeSession(root, "claude", session), /손상/);
  const outside = join(root, `${session}.jsonl`); writeFileSync(outside, "{}");
  assert.throws(() => nativeSession(root, "claude", session, outside), /원본만/);
});
test("Codex는 최초 session_meta의 명시적 thread와 프로젝트를 대조한다", () => {
  const dir = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "20"); mkdirSync(dir, { recursive: true });
  const codex = join(dir, `rollout-2026-10-20-${session}.jsonl`);
  const rows = [{ type: "session_meta", payload: { id: session, cwd: root, source: "exec" } }, { type: "response_item", payload: { type: "message" } }];
  writeFileSync(codex, rows.map(r => JSON.stringify(r)).join("\n"));
  assert.equal(nativeSession(root, "codex", session).file, codex);
  rows[0].payload.source = "subagent"; writeFileSync(codex, rows.map(r => JSON.stringify(r)).join("\n"));
  assert.throws(() => nativeSession(root, "codex", session), /주 세션/);
});
test("Codex 원본 복원도 설치·신뢰와 동일 thread를 요구하고 실제 서명 답을 한 번만 재개한다", () => {
  initialize(root);
  const binding = readBinding(root)!; binding.host = hostProfileOf({ kind: "codex", command: ["fixture"] }); writeBinding(root, binding);
  const dir = join(process.env.CODEX_HOME!, "sessions"); mkdirSync(dir, { recursive: true });
  const native = join(dir, `rollout-2026-10-20-${session}.jsonl`);
  writeFileSync(native, JSON.stringify({ type: "session_meta", payload: { id: session, cwd: root, source: "exec" } }) + "\n" + JSON.stringify({ type: "event_msg" }));
  const q = publishInteraction(root, PublishInteraction.parse({ key: "codex", stage: "setup", title: "복원", questions: [question()] }), interactionContext(root, session, "codex"));
  assert.throws(() => recover(q.requestId), /신뢰/);
  writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n[hooks.state.${JSON.stringify(root + "/.codex/hooks.json")} ]\ntrusted_hash = "synthetic fixture"\n`);
  recover(q.requestId);
  assert.equal(send(request(readInteractions(root)!.requests[q.requestId], choose())).ok, true);
  drainInteraction(root, q.requestId); drainInteraction(root, q.requestId);
  const runs = listRuns(root); assert.equal(runs.length, 2);
  const next = runs.find(r => !r.recovery)!; assert.equal(next.sessionId, session); assert.equal(next.resumeOf, session); assert.equal(next.sessionConfirmed, true);
});
test("독립 접수의 ID·종류를 바꾸거나 새 작업을 만들지 않는다", () => {
  requestBegin(root, "FEATURE-9", "feature");
  const before = loadRequestSession(root), q = publish(); recover(q.requestId);
  assert.deepEqual(loadRequestSession(root), before);
  assert.equal(readWorkBinding(root, "FEATURE-9")?.workId, "FEATURE-9");
  assert.equal(listRuns(root)[0].workId, "FEATURE-9");
});
test("실행 저장 뒤 질문 연결 전에 중단돼도 원래 복원 ID로 이어 붙인다", () => {
  const q = publish();
  const fault = mock.method(interactions, "mutateInteractions", () => { throw Error("injected ledger write failure"); });
  assert.throws(() => recover(q.requestId), /injected/); fault.mock.restore();
  const runId = listRuns(root)[0].runId;
  assert.equal(readInteractions(root)!.requests[q.requestId].recoveredRunId, undefined);
  assert.equal(recover(q.requestId).runId, runId);
  assert.equal(listRuns(root).length, 1); assert.equal(readInteractions(root)!.requests[q.requestId].recoveredRunId, runId);
});
test("미응답 질문은 상태 동기화 전이라도 만료 시각을 넘기면 복원하지 않는다", () => {
  const q = publish();
  interactions.mutateInteractions(root, state => { state.requests[q.requestId].expiresAt = new Date(0).toISOString(); });
  assert.throws(() => recover(q.requestId), /만료/); assert.equal(listRuns(root).length, 0);
});
