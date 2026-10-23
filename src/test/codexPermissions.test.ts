import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexProject } from "./masterCodexFixture";
import { readBinding, writeBinding, listRuns, writeRunRecord, updateRun, type RunRecord } from "../agent/master/store";
import { currentInteractions, needInteraction, readInteractions, mutateInteractions, type InteractionRecord } from "../agent/interactions";
import { humanSigningMessage } from "../agent/interactionHuman";
import { drainInteraction } from "../agent/interactionService";
import { closeCodexPermissions, forwardCodexPermission, gitOperationCommand, publishCodexPermission } from "../agent/master/codexPermissions";

function fixture() {
  const f = codexProject(), key = generateKeyPairSync("ed25519"), binding = readBinding(f.root)!;
  binding.humanChannel = { id: randomUUID(), controller: "test", generation: 1, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
  writeBinding(f.root, binding);
  const respond = (r: InteractionRecord, submission: object, commandId = randomUUID(), signed = true) => {
    const payload: Record<string, unknown> = { requestId: r.requestId, expectedRevision: r.revision, contentHash: r.contentHash, challenge: r.challenge, channelId: binding.humanChannel!.id, submission };
    payload.signature = signed ? sign(null, Buffer.from(humanSigningMessage(binding.projectId, { controller: "test", generation: 1, commandId, payload })), key.privateKey).toString("base64") : "invalid";
    return f.send("interaction.respond", payload, commandId);
  };
  const at = new Date().toISOString();
  const run: RunRecord = { version: 1, runId: `run-${randomUUID()}`, commandId: randomUUID(), controller: "test", generation: 1, mode: "start", links: {}, state: "running", acceptedAt: at, updatedAt: at,
    sessionId: randomUUID(), sessionConfirmed: true, hostProfile: binding.host, promptHash: "fixture", timeoutMs: 60000, workId: null, baseHead: null, baseStateVersion: "fixture", history: [] };
  const connection = randomUUID();
  const publish = (extra: object = {}, rpcId: string | number = 100) => {
    writeRunRecord(f.root, run);
    return publishCodexPermission(f.root, run, connection, rpcId, { threadId: run.sessionId, turnId: "turn", itemId: "item", command: "code-agent start doc/work/WORK-0001/requirement.md", cwd: f.root, ...extra });
  };
  const latest = (id: string) => needInteraction(readInteractions(f.root), id);
  return { ...f, respond, run, connection, publish, latest };
}
const accept = { intent: "submit", explicit: true, permissionDecision: "accept" };

test("Git 승인 범위는 기존 게이트 명령 하나이며 셸 확장·복합·직접 Git 변경은 거부한다", () => {
  for (const c of ["code-agent start doc/work/WORK-0001/requirement.md", 'powershell.exe -NoProfile -Command "code-agent.cmd verify test"', "bash -lc 'code-agent repro run'"]) assert.equal(gitOperationCommand(c), true, c);
  for (const c of ["git switch -c bad", "code-agent master enable", "code-agent verify test; whoami", "code-agent verify $(whoami)", 'code-agent start "$env:SECRET"', "bash -c 'code-agent verify test && whoami'", "code-agent start ../x && git reset --hard", 'powershell.exe -EncodedCommand xxx', "node cli.js start req.md", "code-agent verify test | cat"]) assert.equal(gitOperationCommand(c), false, c);
});
test("cmd 단순 래퍼를 받고, 래퍼 셸은 맨 이름이나 시스템 경로만 받는다", () => {
  for (const c of ['cmd.exe /c "code-agent verify test"', "cmd /d /s /c 'code-agent.cmd start doc/work/WORK-0001/requirement.md'"]) assert.equal(gitOperationCommand(c), true, c);
  for (const c of ['cmd.exe /c "code-agent verify test & whoami"', 'cmd.exe /c "code-agent start x.md^"', 'cmd.exe /c "code-agent start %CD%"', 'cmd.exe /k "code-agent verify test"',
    'cmd.exe /c "code-agent start x.md" /c "code-agent verify y"', 'cmd.exe /v:on /c "code-agent verify test"', "code-agent start x.md^",
    String.raw`.\powershell.exe -Command "code-agent start x.md"`, 'tools/bash -lc "code-agent start x.md"', String.raw`tools\cmd.exe /c "code-agent start x.md"`]) assert.equal(gitOperationCommand(c), false, c);
  // 이 검사는 토큰으로 나누지만 cmd 는 명령 이름의 일부로 읽는 공백·제어 문자
  for (const c of ["code-agent\u3000start x.md", "code-agent start\u00a0x.md", "code-agent\u000bstart x.md", "code-agent start x\u0007.md", "cmd.exe /c 'code-agent\u2003start x.md'"]) assert.equal(gitOperationCommand(c), false, JSON.stringify(c));
});
test("Codex 가 보내는 절대 경로 래퍼는 알려진 셸 설치 경로만 받는다", { skip: process.platform !== "win32" }, () => {
  // Codex 는 큰따옴표 안 역슬래시를 겹쳐 보낸다 — 2026-10-20·10-23 실제 Codex(0.163.0) 승인 요청의 꼴
  const shown = (...parts: string[]) => `"${join(process.env.SystemRoot!, ...parts).replace(/\\/g, "\\\\")}"`;
  for (const c of [`${shown("System32", "WindowsPowerShell", "v1.0", "powershell.exe")} -Command 'code-agent.cmd start doc/work/CONSENT-1/requirement.md'`,
    `${shown("system32", "cmd.exe")} /c 'code-agent start doc/work/CONSENT-1/requirement.md'`]) assert.equal(gitOperationCommand(c), true, c);
  // 저장소·임시 폴더, 일반 사용자가 쓸 수 있는 시스템 하위 폴더, UNC 의 같은 이름 파일
  for (const c of [String.raw`"C:\repo\tools\cmd.exe" /c 'code-agent start x.md'`, String.raw`"C:\repo\tools\powershell.exe" -Command 'code-agent start x.md'`,
    String.raw`"C:\Users\me\AppData\Local\Temp\pwsh.exe" -Command 'code-agent start x.md'`, `${shown("Tasks", "cmd.exe")} /c 'code-agent start x.md'`,
    `${shown("tracing", "powershell.exe")} -Command 'code-agent start x.md'`, String.raw`"\\server\share\cmd.exe" /c 'code-agent start x.md'`]) assert.equal(gitOperationCommand(c), false, c);
});
test("원래 thread·프로젝트·쓰기 프로필에 결속하고 같은 RPC 내용 변경을 거부한다", () => {
  const f = fixture();
  try {
    const r = f.publish({ environmentId: "local" }); assert.equal(f.publish({ environmentId: "local" }).requestId, r.requestId);
    assert.throws(() => f.publish({ command: "code-agent verify test" }), /달라졌/);
    for (const params of [{ threadId: randomUUID() }, { cwd: f.dir }, { networkApprovalContext: { host: "example.com" } }, { command: "git push" }, { kind: "stdin" }, { environmentId: "remote" }]) assert.throws(() => f.publish(params, randomUUID()));
    f.run.hostProfile = { kind: "codex", command: ["codex"], sandbox: "read-only" };
    assert.throws(() => f.publish({}, 101));
  } finally { f.close(); }
});
test("서명된 단건 권한만 전달하며 일반 답·업무 승인·위조 응답을 거부한다", () => {
  const f = fixture();
  try {
    const r = f.publish();
    assert.equal(f.respond(r, accept, randomUUID(), false).ok, false);
    assert.equal(f.respond(r, { intent: "submit", explicit: true, answers: [] }).ok, false);
    assert.equal(f.respond(r, { intent: "submit", explicit: true, verdict: "approve", shownHash: r.contentHash }).ok, false);
    assert.equal(f.respond(r, { ...accept, permissionDecision: "acceptForSession" }).ok, false);
    const id = randomUUID(); assert.equal(f.respond(r, accept, id).ok, true); assert.equal(f.respond(r, accept, id).result.replayed, true);
    const decisions: string[] = [];
    assert.throws(() => forwardCodexPermission(f.root, r.requestId, "other", d => decisions.push(d)));
    assert.equal(forwardCodexPermission(f.root, r.requestId, f.connection, d => decisions.push(d)), true);
    assert.deepEqual(decisions, ["accept"]);
    assert.throws(() => forwardCodexPermission(f.root, r.requestId, f.connection, d => decisions.push(d)));
    assert.equal((f.latest(r.requestId).application!.result as any).executionConfirmed, false);
    drainInteraction(f.root, r.requestId); assert.equal(listRuns(f.root).length, 1);
  } finally { f.close(); }
});
test("미응답·보류는 실행하지 않고 명시적 거절만 원래 호출에 전달한다", () => {
  const f = fixture();
  try {
    let r = f.publish(), decisions: string[] = [];
    assert.equal(forwardCodexPermission(f.root, r.requestId, f.connection, d => decisions.push(d)), false);
    assert.equal(f.respond(r, { intent: "defer", explicit: true }).ok, true);
    assert.equal(forwardCodexPermission(f.root, r.requestId, f.connection, d => decisions.push(d)), false);
    assert.equal(f.respond(f.latest(r.requestId), { intent: "reopen", explicit: true }).ok, true);
    r = f.latest(r.requestId); assert.equal(f.respond(r, { ...accept, permissionDecision: "decline" }).ok, true);
    forwardCodexPermission(f.root, r.requestId, f.connection, d => decisions.push(d)); assert.deepEqual(decisions, ["decline"]);
  } finally { f.close(); }
});
test("응답 뒤 문맥 변경·사람 채널 회수·정지·만료는 accept를 전달하지 않는다", () => {
  for (const change of ["branch", "channel", "stop", "expire"]) {
    const f = fixture();
    try {
      const r = f.publish(); assert.equal(f.respond(r, accept).ok, true);
      if (change === "branch") execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/other"], { cwd: f.root });
      if (change === "channel") { const b = readBinding(f.root)!; delete b.humanChannel; writeBinding(f.root, b); }
      if (change === "stop") updateRun(f.root, f.run.runId, run => { run.stop = { mode: "pause", requestedAt: new Date().toISOString(), reason: "fixture", by: "test", graceMs: 0 }; });
      if (change === "expire") mutateInteractions(f.root, state => { state.requests[r.requestId].expiresAt = new Date(0).toISOString(); });
      const decisions: string[] = []; forwardCodexPermission(f.root, r.requestId, f.connection, d => decisions.push(d));
      assert.deepEqual(decisions, ["cancel"], change);
    } finally { f.close(); }
  }
});
test("저장소 루트의 code-agent·node·git 실행 파일이 명령을 가리면 받지도 전달하지도 않는다", { skip: process.platform !== "win32" }, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "code-agent.json"), "{}"); writeFileSync(join(f.root, "node.md"), "");
    const r = f.publish(); assert.equal(f.respond(r, accept).ok, true);
    writeFileSync(join(f.root, "code-agent.cmd"), "@echo shadow\r\n");
    const decisions: string[] = []; forwardCodexPermission(f.root, r.requestId, f.connection, d => decisions.push(d));
    assert.deepEqual(decisions, ["cancel"]); assert.match(f.latest(r.requestId).unavailableReason ?? "", /code-agent\.cmd/);
    assert.throws(() => f.publish({}, 102), /code-agent\.cmd/);
    rmSync(join(f.root, "code-agent.cmd"));
    // npm 의 code-agent.cmd 가 찾는 node, code-agent 가 부르는 git
    let rpc = 103;
    for (const name of ["Code-Agent.BAT", "node.cmd", "git.exe"]) {
      writeFileSync(join(f.root, name), "");
      assert.throws(() => f.publish({}, rpc++), new RegExp(name.replace(".", "\\.")));
      rmSync(join(f.root, name));
    }
  } finally { f.close(); }
});
test("전달 중 연결 종료·기록 없는 종료에도 같은 승인을 재전송하지 않는다", () => {
  const f = fixture();
  try {
    const r = f.publish(); assert.equal(f.respond(r, accept).ok, true);
    assert.throws(() => forwardCodexPermission(f.root, r.requestId, f.connection, () => { throw new Error("closed"); }), /closed/);
    assert.equal(f.latest(r.requestId).application!.state, "applying");
    assert.throws(() => forwardCodexPermission(f.root, r.requestId, f.connection, () => assert.fail("재전송")));
    closeCodexPermissions(f.root, f.run.runId, "연결 종료"); assert.equal(f.latest(r.requestId).status, "failed");
    assert.equal(f.respond(f.latest(r.requestId), accept).ok, false);
    drainInteraction(f.root, r.requestId); assert.equal(listRuns(f.root).length, 1);
  } finally { f.close(); }
});
test("감독→대시보드 서명→실제 RPC 응답 뒤 Git 쓰기와 같은 실행 완료를 확인한다", async () => {
  const f = fixture();
  try {
    const started = f.send("submit", { prompt: "MODE=permission" }); assert.equal(started.ok, true, JSON.stringify(started));
    await f.wait(started.result.runId, () => currentInteractions(f.root).requests.some(r => r.kind === "host-permission"));
    const r = currentInteractions(f.root).requests[0];
    assert.equal(existsSync(join(f.root, ".code-agent/fixture-permission.json")), false);
    assert.equal(f.respond(r, accept).ok, true);
    const done = await f.wait(started.result.runId); assert.equal(done.state, "completed", JSON.stringify(done.outcome));
    assert.equal(done.sessionId, r.context.sessionId); assert.equal(listRuns(f.root).length, 1);
    assert.equal(JSON.parse(readFileSync(join(f.root, ".code-agent/fixture-permission.json"), "utf8")).decision, "accept");
    assert.equal(execFileSync("git", ["config", "--local", "code-agent.permissionFixture"], { cwd: f.root, encoding: "utf8" }).trim(), "accepted");
    assert.equal((f.latest(r.requestId).application!.result as any).executionConfirmed, true);
  } finally { f.close(); }
});
test("감독이 받지 않은 권한 요청은 사람의 거절과 구분해 명령과 받는 꼴을 결과에 남긴다", async () => {
  const f = fixture();
  try {
    const started = f.send("submit", { prompt: "MODE=permission-unsupported" }); assert.equal(started.ok, true, JSON.stringify(started));
    const done = await f.wait(started.result.runId); assert.equal(done.state, "blocked");
    assert.match(done.outcome!.reason, /^감독이 호스트 권한 요청을 받지 않았습니다: 지원 범위 밖 .*code-agent\.cmd/);
    const denial = (done.result as any).host.permissionDenials[0];
    assert.equal(denial.automatic, true); assert.match(denial.command, /& whoami/);
    assert.equal(JSON.parse(readFileSync(join(f.root, ".code-agent/fixture-permission.json"), "utf8")).decision, "decline");
    assert.equal(currentInteractions(f.root).requests.length, 0);
  } finally { f.close(); }
});
test("대기 중 정지는 원래 RPC를 취소하며 새 작업·재개 실행을 만들지 않는다", async () => {
  const f = fixture();
  try {
    const started = f.send("submit", { prompt: "MODE=permission" });
    await f.wait(started.result.runId, () => currentInteractions(f.root).requests.length > 0);
    assert.equal(f.send("pause", { runId: started.result.runId }).ok, true);
    const done = await f.wait(started.result.runId); assert.equal(done.state, "paused");
    const r = currentInteractions(f.root).requests[0]; assert.equal(r.status, "cancelled");
    assert.equal(JSON.parse(readFileSync(join(f.root, ".code-agent/fixture-permission.json"), "utf8")).decision, "cancel");
    assert.equal(listRuns(f.root).length, 1);
  } finally { f.close(); }
});
