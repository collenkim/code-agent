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
import { executionPolicy } from "../agent/executionMode";

test("Codex 권한 옵션을 제한하고 부모 호스트 표지를 제거한다", () => {
  assert.throws(() => hostProfileOf({ kind: "codex", sandbox: "danger-full-access" }));
  assert.throws(() => hostProfileOf({ kind: "codex", command: ["codex", "--dangerously-bypass-hook-trust"] }));
  const profile = hostProfileOf({ kind: "codex", command: ["fixture"] });
  const args = hostArgs(profile, { mode: "continue", sessionId: "thread-id", runId: "run-marker" }).args;
  assert.ok(args.includes('approval_policy="on-request"')); assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes("app-server")); assert.ok(args.includes('approvals_reviewer="user"')); assert.ok(args.some(a => a.includes("run-marker")));
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
    for (const mode of ["fail", "missing", "changed-thread", "untrusted-hooks"]) {
      const result = f.send("submit", { prompt: `MODE=${mode}` }); assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await f.wait(result.result.runId)).state, "failed");
    }
    const missing = listRuns(f.root).find(r => !r.sessionConfirmed)!;
    assert.equal(f.send("submit", { mode: "continue", sessionId: missing.sessionId, prompt: "resume" }).ok, false);
    writeFileSync(join(f.home, "config.toml"), "");
    assert.equal(f.send("submit", { prompt: "start" }).ok, false); assert.equal(listRuns(f.root).length, 4);
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
test("submit 의 execution 이 그 실행의 호스트를 정하고 프로젝트 실행 방식은 바꾸지 않는다", async () => {
  const f = codexProject();
  try {
    const binding = readBinding(f.root)!;
    binding.hostProfiles = { ...binding.hostProfiles, claude: hostProfileOf({ kind: "claude", command: [process.execPath, join(__dirname, "masterFakeHost.js")] }) }; writeBinding(f.root, binding);
    const hello = f.send("hello").result;
    assert.deepEqual(hello.managedHost.runSelection, { supported: true, modes: ["claude", "codex", "both"] });
    assert.deepEqual(Object.keys(hello.managedHost.hosts).sort(), ["claude", "codex"]); assert.equal(hello.managedHost.hosts.codex.ready, true);
    assert.equal(hello.managedHost.selected, "codex"); assert.equal(executionPolicy(f.root)?.mode, "auto");
    // 고르지 않으면 프로젝트 실행 방식(연동 기본 호스트), 고르면 그 호스트 — 실행 기록과 결과에 남는다
    const chosen = f.send("submit", { prompt: "MODE=complete", execution: { mode: "claude" } });
    assert.equal(chosen.ok, true, JSON.stringify(chosen)); assert.equal(chosen.result.hostKind, "claude"); assert.deepEqual(chosen.result.execution, { mode: "claude" });
    const run = await f.wait(chosen.result.runId); assert.equal(run.state, "completed"); assert.equal(run.hostProfile?.kind, "claude"); assert.deepEqual(run.execution, { mode: "claude" });
    assert.deepEqual(f.send("result", { runId: run.runId }).result.run.execution, { mode: "claude" });
    assert.equal(executionPolicy(f.root)?.mode, "auto");
    // 이어 실행은 이전 실행의 선택을 쓴다 — execution 을 다시 보내지 않는다
    const again = f.send("submit", { mode: "continue", sessionId: run.sessionId, prompt: "MODE=complete", execution: { mode: "codex" } });
    assert.equal(again.ok, false); assert.equal(again.error?.code, "invalid-request");
    const resumed = f.send("submit", { mode: "continue", sessionId: run.sessionId, prompt: "MODE=complete" }); assert.equal(resumed.ok, true, JSON.stringify(resumed));
    const next = await f.wait(resumed.result.runId); assert.equal(next.hostProfile?.kind, "claude"); assert.deepEqual(next.execution, { mode: "claude" });
    for (const execution of [{ mode: "both" }, { mode: "claude", main: "codex" }, { mode: "auto" }, { mode: "both", main: "codex", extra: 1 }]) {
      const rejected = f.send("submit", { prompt: "MODE=complete", execution }); assert.equal(rejected.error?.code, "invalid-request", JSON.stringify(execution));
    }
    const cross = f.send("submit", { prompt: "MODE=complete", execution: { mode: "both", main: "codex" } });
    assert.equal(cross.result.hostKind, "codex"); const crossRun = await f.wait(cross.result.runId); assert.deepEqual(crossRun.execution, { mode: "both", main: "codex" });
    // 설치 기록에 없는 호스트가 필요한 방식은 받지 않는다 — 설치는 사람이 init 으로 한다
    writeFileSync(join(f.root, ".code-agent/hosts.json"), JSON.stringify(["codex"]));
    assert.deepEqual(f.send("hello").result.managedHost.runSelection, { supported: true, modes: ["codex"] });
    const missing = f.send("submit", { prompt: "MODE=complete", execution: { mode: "both", main: "codex" } });
    assert.equal(missing.error?.code, "invalid-state"); assert.deepEqual((missing.error?.detail as { problems?: string[] } | undefined)?.problems, ["host-not-installed"]);
    assert.equal(listRuns(f.root).length, 3);
  } finally { f.close(); }
});
