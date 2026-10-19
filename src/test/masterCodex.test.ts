import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexProject } from "./masterCodexFixture";
import { hostArgs, hostEnv } from "../agent/master/supervisor";
import { hostProfileOf } from "../agent/master/protocol";
import { listRuns, readBinding, writeBinding } from "../agent/master/store";
import { codexHook } from "../agent/codexHook";
import { execution } from "../agent/executionCommands";
import { withInteraction } from "../agent/tty";
import { CODEX_MARKERS } from "../agent/crossEnv";
import { PublishInteraction } from "../agent/interactionSchema";
import { publishInteraction, interactionContext, currentInteractions } from "../agent/interactions";
import { pendingHostHandoff } from "../agent/master/hostHandoff";

test("Codex 권한 옵션을 제한하고 부모 호스트 표지를 제거한다", () => {
  assert.throws(() => hostProfileOf({ kind: "codex", sandbox: "danger-full-access" }));
  assert.throws(() => hostProfileOf({ kind: "codex", command: ["codex", "--dangerously-bypass-hook-trust"] }));
  const profile = hostProfileOf({ kind: "codex", command: ["fixture"] });
  const args = hostArgs(profile, { mode: "continue", sessionId: "thread-id", runId: "run-marker" }).args;
  assert.ok(args.includes('approval_policy="never"')); assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.equal(args[args.indexOf("resume") + 1], "thread-id"); assert.ok(args.some(a => a.includes("run-marker")));
  assert.ok(!args.includes("--last"));
  const env = hostEnv({ CLAUDECODE: "1", CODEX_THREAD_ID: "parent", CODEX_CI: "1" }, "run-marker", "codex");
  assert.equal(env.CLAUDECODE, undefined); assert.equal(env.CODEX_THREAD_ID, undefined); assert.equal(env.CODEX_CI, undefined);
});
test("실제 감독이 Codex thread를 확정하고 접수 별칭으로 같은 세션을 한 번 재개한다", async () => {
  const f = codexProject();
  try {
    const id = randomUUID(), first = f.send("submit", { prompt: "MODE=complete" }, id);
    assert.equal(first.ok, true, JSON.stringify(first));
    const run = await f.wait(first.result.runId);
    assert.equal(run.state, "completed", JSON.stringify(run.outcome)); assert.equal(run.sessionConfirmed, true);
    assert.notEqual(run.sessionId, first.result.sessionId); assert.equal(run.sessionAlias, first.result.sessionId);
    assert.equal(f.send("submit", { prompt: "MODE=complete" }, id).result.runId, run.runId);
    const next = f.send("submit", { mode: "continue", sessionId: first.result.sessionId, prompt: "MODE=complete" });
    assert.equal(next.ok, true, JSON.stringify(next));
    const resumed = await f.wait(next.result.runId); assert.equal(resumed.sessionId, run.sessionId); assert.equal(resumed.state, "completed");
    assert.equal(listRuns(f.root).length, 2);
    assert.equal((resumed.result as any).host.finalMessage, "모의 Codex 결과");
  } finally { f.close(); }
});
test("Codex 실패·thread 누락은 성공 처리하지 않고 신뢰 없는 실행은 접수하지 않는다", async () => {
  const f = codexProject();
  try {
    for (const mode of ["fail", "missing", "changed-thread"]) {
      const result = f.send("submit", { prompt: `MODE=${mode}` }); assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await f.wait(result.result.runId)).state, "failed");
    }
    const missing = listRuns(f.root).find(r => !r.sessionConfirmed)!;
    assert.equal(f.send("submit", { mode: "continue", sessionId: missing.sessionId, prompt: "resume" }).ok, false);
    writeFileSync(join(f.home, "config.toml"), "");
    assert.equal(f.send("submit", { prompt: "start" }).ok, false); assert.equal(listRuns(f.root).length, 3);
  } finally { f.close(); }
});
test("다른 thread로 재개되면 실패하고 Codex 프로세스 표지로 강제 취소한다", async () => {
  const f = codexProject();
  try {
    const first = f.send("submit", { prompt: "MODE=complete" }); const original = await f.wait(first.result.runId);
    const mismatch = f.send("submit", { mode: "continue", sessionId: original.sessionId, prompt: "MODE=mismatch" });
    const failed = await f.wait(mismatch.result.runId); assert.equal(failed.state, "failed"); assert.match(failed.outcome!.reason, /thread ID/);
    const hanging = f.send("submit", { prompt: "MODE=hang" }); const live = await f.wait(hanging.result.runId, r => !!r.sessionConfirmed);
    assert.equal(live.host?.marker, live.runId);
    assert.equal(f.send("cancel", { runId: live.runId, force: true }).ok, true);
    const cancelled = await f.wait(live.runId); assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.outcome?.forced, true);
  } finally { f.close(); }
});
test("Codex pause는 실제 hook에서 멈추고 질문·MCP 승인 도구를 직접 열지 않는다", async () => {
  const f = codexProject(), saved = process.env.CODE_AGENT_MASTER_RUN;
  try {
    const first = f.send("submit", { prompt: "MODE=loop" }); assert.equal(first.ok, true, JSON.stringify(first));
    const run = await f.wait(first.result.runId, r => !!r.sessionConfirmed);
    process.env.CODE_AGENT_MASTER_RUN = run.runId;
    for (const tool_name of ["request_user_input", "mcp__code_agent__ask", "mcp__code_agent__confirm"]) {
      assert.match(JSON.stringify(codexHook({ cwd: f.root, session_id: run.sessionId, hook_event_name: "PreToolUse", tool_name, tool_input: {} })), /deny/);
    }
    assert.equal(f.send("pause", { runId: run.runId, reason: "시험 정지" }).ok, true);
    const done = await f.wait(run.runId); assert.equal(done.state, "paused"); assert.equal(done.outcome?.cooperative, true);
  } finally { if (saved === undefined) delete process.env.CODE_AGENT_MASTER_RUN; else process.env.CODE_AGENT_MASTER_RUN = saved; f.close(); }
});
test("TTY 인계 뒤 새 호스트가 같은 연결에서 시작하고 이전 thread와 인계 ID를 재사용하지 않는다", async () => {
  const f = codexProject(), saved = { ...process.env };
  try {
    const first = f.send("submit", { prompt: "MODE=complete", links: { missionId: "M1", taskId: "T1" } }); const old = await f.wait(first.result.runId);
    const q = publishInteraction(f.root, PublishInteraction.parse({ key: "handoff", stage: "setup", title: "구성", questions: [{ questionId: "q", title: "설정", mode: "text", recommendationReason: "사용자 입력", input: { required: true, minLength: 1, maxLength: 100, description: "값" } }] }), interactionContext(f.root, old.sessionId, "codex", old.runId));
    const binding = readBinding(f.root)!;
    const claude = hostProfileOf({ kind: "claude", command: [process.execPath, join(__dirname, "masterFakeHost.js")] });
    binding.hostProfiles = { ...binding.hostProfiles, claude }; writeBinding(f.root, binding);
    delete process.env.CLAUDECODE; for (const key of CODEX_MARKERS) delete process.env[key];
    withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "fixture" }), ask: () => "" }, () => execution(f.root, "claude", { handoff: true }));
    assert.equal(currentInteractions(f.root).requests.find(r => r.requestId === q.requestId)?.status, "cancelled");
    assert.equal(f.send("resume", { runId: old.runId }).ok, false);
    const id = randomUUID(), next = f.send("submit", { prompt: "MODE=complete", links: old.links }, id); assert.equal(next.ok, true, JSON.stringify(next));
    const fresh = await f.wait(next.result.runId); assert.equal(fresh.hostProfile?.kind, "claude"); assert.ok(fresh.handoffId); assert.deepEqual(fresh.links, old.links);
    assert.notEqual(fresh.sessionId, old.sessionId); assert.equal(pendingHostHandoff(f.root, claude), undefined);
    assert.equal(f.send("submit", { prompt: "MODE=complete", links: old.links }, id).result.runId, fresh.runId); assert.equal(listRuns(f.root).length, 2);
  } finally { process.env = saved; f.close(); }
});
