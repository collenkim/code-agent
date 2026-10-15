/**
 * master 연동 — 통신 계약·인증·세대·멱등·이벤트·위임 판단·인계 상태 전이·hook 가드(모의 시험).
 * 사람의 TTY 확인(enable·grant)은 withInteraction 으로 흉내낸다 — 실제 사람의 입력이 아니다. 실행(감독·호스트)은 masterRuns.test.ts 가 본다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { answerSources } from "../agent/answers";
import { CONSENT_ACTIONS, loadConsent, observeConsent, prepareConsent } from "../agent/consent";
import { consentReceipts } from "../agent/consentReceipts";
import { decide as guardTool } from "../agent/hook";
import { questionsFile } from "../agent/layout";
import { LEASE_FILE } from "../agent/lease";
import { masterEnable, masterGrant, masterRevoke, grantOf } from "../agent/master/admin";
import { call } from "../agent/master/control";
import { advanceHandover } from "../agent/master/handover";
import { COMMAND_TYPES, DEFAULT_POLICY, DELEGABLE_ACTIONS, ERROR_CODES, HUMAN_ONLY_ACTIONS, RUN_STATES } from "../agent/master/protocol";
import { MASTER_RUN_ENV, masterRunGuard } from "../agent/master/runGuard";
import { emit, readBinding, readOwner, writeBinding, writeOwner, writeRunRecord, writeWorkBinding, type RunRecord } from "../agent/master/store";
import { parseQuestions } from "../agent/questions";
import { stateView } from "../agent/stateView";
import { withInteraction } from "../agent/tty";
import { approvalOf, loadWork } from "../agent/work";
import { readLedger } from "../core/approval";
import { CONSENT_WORK_ID, gitFixture, preparePlanFixture, setupConsentProject, writeFixture } from "./consentFixture";

let root: string;
let outside: string;
/** 모의 TTY — 사람이 확인 단어를 입력한 것으로 둔다(시험 전용) */
const tty = <T>(run: () => T): T => withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "모의 TTY(시험)" }), ask: () => "n" }, run);

function enable(controller = "m1", policy?: Record<string, unknown>): string {
  const tokenFile = join(outside, `${controller}.token`);
  const policyFile = policy ? join(outside, `${controller}.policy.json`) : undefined;
  if (policyFile) writeFileSync(policyFile, JSON.stringify(policy));
  tty(() => masterEnable(root, { controller, tokenOut: tokenFile, ...(policyFile ? { policy: policyFile } : {}) }));
  return readFileSync(tokenFile, "utf8").trim();
}
function grant(body: Record<string, unknown>): string {
  const file = join(outside, `grant-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(body));
  return tty(() => masterGrant(root, file));
}
type Res = ReturnType<typeof call> & { result?: any };
function send(token: string, type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Res {
  return call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type, controller: "m1", generation: 1, token, payload, ...extra })) as Res;
}
let commandSeq = 0;
const cid = (): string => `cmd-${++commandSeq}-${Date.now()}`;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-master-")));
  outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-master-out-")));
  gitFixture(root, "init", "-q", "-b", "master");
  gitFixture(root, "config", "user.name", "t");
  gitFixture(root, "config", "user.email", "t@t");
  writeFixture(root, "README.md", "x\n");
  gitFixture(root, "add", "-A");
  gitFixture(root, "commit", "-qm", "init");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("기능 협상·인증·연동 조건", () => {
  test("연동하지 않은 프로젝트: hello 는 enabled false, 나머지 요청은 not-enabled, 상태 조회(status --json)는 그대로", () => {
    const before = stateView(root);
    const hello = call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type: "hello" })) as Res;
    assert.equal(hello.ok, true);
    assert.equal(hello.result.project.enabled, false);
    assert.equal(hello.result.hosts.find((host: { kind: string }) => host.kind === "codex").supported, false);
    assert.ok(hello.result.unsupported.some((item: { feature: string }) => item.feature === "host:codex"));
    const snap = call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type: "snapshot", controller: "m1", token: "x" })) as Res;
    assert.equal(snap.error?.code, "not-enabled");
    assert.equal(stateView(root).stateVersion, before.stateVersion);
    assert.equal(stateView(root).schemaVersion, 1);
  });

  test("프로토콜·버전·명령 꼴 검사와 미지원 명시", () => {
    assert.equal(call(root, "{").error?.code, "invalid-request");
    assert.equal(call(root, JSON.stringify({ protocol: "x", version: 1, type: "hello" })).error?.code, "unsupported-protocol");
    assert.equal(call(root, JSON.stringify({ protocol: "code-agent.master", version: 9, type: "hello" })).error?.code, "unsupported-protocol");
    assert.equal(call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type: "teleport" })).error?.code, "unsupported");
    assert.equal(call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type: "submit", controller: "m1", token: "t" })).error?.code, "invalid-request", "상태를 바꾸는 요청은 commandId 가 필요하다");
  });

  test("동의 동작은 빠짐없이 위임 가능·사람만으로 나뉘고, 계약 문서가 코드의 목록과 같다", () => {
    for (const action of CONSENT_ACTIONS) {
      assert.ok([...DELEGABLE_ACTIONS, ...HUMAN_ONLY_ACTIONS].includes(action as never), `동의 동작 ${action} 을 위임 가능·사람만 중 하나로 정한다`);
    }
    assert.deepEqual(DELEGABLE_ACTIONS.filter((action) => (HUMAN_ONLY_ACTIONS as readonly string[]).includes(action)), []);
    const doc = readFileSync(join(__dirname, "..", "..", "doc", "master-control.md"), "utf8");
    const listed = (heading: string) => [...doc.split(heading)[1].split("\n## ")[0].matchAll(/^\| `([A-Za-z-]+)`/gm)].map((match) => match[1]);
    for (const code of ERROR_CODES) assert.ok(doc.includes(`\`${code}\``), `오류 코드 ${code} 가 계약 문서에 있다`);
    for (const type of COMMAND_TYPES) assert.ok(doc.includes(`\`${type}\``), `명령 ${type} 이 계약 문서에 있다`);
    assert.deepEqual(listed("정책(`--policy`").sort(), Object.keys(DEFAULT_POLICY).sort(), "정책 표의 키");
    for (const action of [...DELEGABLE_ACTIONS, ...HUMAN_ONLY_ACTIONS]) assert.ok(doc.includes(`\`${action}\``), `동작 ${action} 이 계약 문서에 있다`);
    for (const state of RUN_STATES) assert.ok(doc.includes(state), `실행 상태 ${state} 가 계약 문서에 있다`);
  });

  test("토큰·제어자·세대 — 틀린 토큰 unauthorized, 다른 세대 fenced", () => {
    const token = enable();
    assert.equal(send("wrong", "snapshot").error?.code, "unauthorized");
    assert.equal(send(token, "snapshot").ok, true);
    const fenced = send(token, "policy", { patch: { heartbeatMs: 5000 } }, { generation: 2, commandId: cid() });
    assert.equal(fenced.error?.code, "fenced");
    const hello = send(token, "hello");
    assert.equal(hello.result.project.enabled, true);
    assert.equal(hello.result.approvals.delegationAvailable, true);
    assert.deepEqual(hello.result.approvals.delegated.actions, ["request", "plan", "deliver", "answer"]);
  });

  test("연결만으로는 위임 권한이 없다 — 권한(grant) 없이 decide·answer 는 grant-missing", () => {
    const token = enable();
    writeWorkBinding(root, { workId: "W-1", links: {}, boundAt: new Date().toISOString(), runId: "run-x", controller: "m1", runs: ["run-x"] });
    mkdirSync(join(root, "doc/work/W-1"), { recursive: true });
    writeFileSync(join(root, questionsFile("W-1")), "## Q1 · 범위\n무엇?\n[Answer]:\n");
    const res = send(token, "answer", { workId: "W-1", decisionId: "d-1", grantId: "grant-none", actor: "ai", category: "routine", reason: "r", evidence: ["e"], questionsHash: "x", answers: [{ q: "Q1", answer: "A" }] }, { commandId: cid() });
    assert.equal(res.error?.code, "grant-missing");
  });

  test("권한 문서 — 넓은 권한·사람만 하는 동작·만료 없음·와일드카드는 받지 않는다", () => {
    enable();
    const binding = readBinding(root)!;
    const base = { controller: "m1", works: ["W-1"], actions: ["plan"], paths: ["src/**"], ttlHours: 1, maxUses: 3 };
    assert.ok(grantOf(base, binding));
    assert.throws(() => grantOf({ ...base, works: [], missions: [] }, binding), /works/);
    assert.throws(() => grantOf({ ...base, works: ["*"] }, binding), /와일드카드/);
    assert.throws(() => grantOf({ ...base, actions: ["setup"] }, binding), /사람만/);
    assert.throws(() => grantOf({ ...base, paths: ["**"] }, binding), /저장소 전체/);
    assert.throws(() => grantOf({ ...base, paths: ["../x/**"] }, binding), /저장소 전체/);
    assert.throws(() => grantOf({ ...base, ttlHours: 24 * 30 }, binding), /최대/);
    assert.throws(() => grantOf({ ...base, maxUses: 0 }, binding), /maxUses/);
    assert.throws(() => grantOf({ ...base, controller: "other" }, binding), /등록한 제어자/);
  });
});

describe("멱등·이벤트", () => {
  test("같은 commandId 재전송은 한 번만 실행되고, 같은 ID 다른 내용은 conflict", () => {
    const token = enable();
    const id = cid();
    const first = send(token, "policy", { patch: { heartbeatMs: 4000 } }, { commandId: id });
    assert.equal(first.ok, true);
    const again = send(token, "policy", { patch: { heartbeatMs: 4000 } }, { commandId: id });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    const changed = send(token, "policy", { patch: { heartbeatMs: 6000 } }, { commandId: id });
    assert.equal(changed.error?.code, "conflict");
    assert.equal(readBinding(root)!.policy.heartbeatMs, 4000);
    const events = send(token, "events", { after: 0 }).result;
    assert.equal(events.events.filter((event: { type: string }) => event.type === "policy.changed").length, 1, "재전송이 이벤트를 다시 만들지 않는다");
    const lookup = send(token, "command", { commandId: id }).result;
    assert.equal(lookup.known, true);
    assert.equal(lookup.status, "accepted");
  });

  test("처리 도중 끊긴 명령(received)은 다시 실행하지 않는다", () => {
    const token = enable();
    const id = cid();
    const request = { protocol: "code-agent.master", version: 1, type: "policy", controller: "m1", generation: 1, token, commandId: id, payload: { patch: { heartbeatMs: 7000 } } };
    const { requestHash } = require("../agent/master/protocol") as typeof import("../agent/master/protocol");
    const { writeCommand } = require("../agent/master/store") as typeof import("../agent/master/store");
    writeCommand(root, { commandId: id, type: "policy", controller: "m1", generation: 1, requestHash: requestHash(request as never), receivedAt: new Date().toISOString(), status: "received", response: null });
    const res = call(root, JSON.stringify(request));
    assert.equal(res.ok, false);
    assert.equal(res.replayed, true);
    assert.match(res.error!.message, /다시 실행하지 않습니다/);
    assert.notEqual(readBinding(root)!.policy.heartbeatMs, 7000);
  });

  test("이벤트 순번 — after 이후만, 기록 ID 가 다르거나 순번이 앞서면 gap(스냅샷으로 다시 맞춘다)", () => {
    const token = enable();
    for (let index = 0; index < 5; index += 1) emit(root, "policy.changed", { data: { index } });
    const all = send(token, "events", { after: 0 }).result;
    assert.ok(all.latestSeq >= 6);
    const page = send(token, "events", { after: 2, limit: 2, logId: all.logId }).result;
    assert.deepEqual(page.events.map((event: { seq: number }) => event.seq), [3, 4]);
    assert.equal(page.gap, false);
    assert.equal(send(token, "events", { after: 2, logId: "log-other" }).result.gap, true);
    assert.equal(send(token, "events", { after: all.latestSeq + 10, logId: all.logId }).result.gap, true);
    const seqs = all.events.map((event: { seq: number }) => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b));
    assert.equal(new Set(seqs).size, seqs.length, "순번은 겹치지 않는다");
  });
});

/** 끝난 master 실행 하나와 그 실행이 연 작업 — 실제 감독 없이 기록만 둔다 */
function finishedRun(sessionId: string, workId: string): RunRecord {
  const at = new Date().toISOString();
  const run: RunRecord = { version: 1, runId: `run-test-${Math.random().toString(36).slice(2, 8)}`, commandId: "c", controller: "m1", generation: 1, mode: "start", links: { missionId: "M-1", taskId: "T-1" },
    state: "blocked", acceptedAt: at, updatedAt: at, sessionId, promptHash: "x", timeoutMs: 1000, workId, baseHead: null, baseStateVersion: "x", history: [] };
  writeRunRecord(root, run);
  writeWorkBinding(root, { workId, links: run.links, boundAt: at, runId: run.runId, controller: "m1", runs: [run.runId] });
  return run;
}

describe("위임 판단 — 동의(계획 승인)", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  let token: string;
  let consentId: string;
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-master-plan-")));
    setupConsentProject(root);
    preparePlanFixture(root);
    token = enable();
    finishedRun(SESSION, CONSENT_WORK_ID);
    consentId = JSON.parse(prepareConsent(root, { action: "plan" }, { binding: { id: SESSION, host: "claude" } })).id;
  });
  const view = () => send(token, "consents").result.consents.find((item: { id: string }) => item.id === consentId);
  const decide = (extra: Record<string, unknown> = {}) => send(token, "decide", {
    consentId, decisionId: `d-${Math.random().toString(36).slice(2)}`, verdict: "approve", category: "routine", reason: "계획 파일이 요구 R1·R2 와 맞고 범위 안이다", evidence: ["plan.json files 2", "critic 통과"],
    shownHash: view().shownHash, ...extra }, { commandId: cid() });

  test("권한 범위 안의 routine 승인 — 같은 적용 함수로 승인되고, 원장·동의·영수증에 master-delegation(사람 응답 아님)으로 남는다", () => {
    grant({ id: "g-plan", controller: "m1", works: [CONSENT_WORK_ID], actions: ["plan"], paths: ["src/**", "tests/**"], ttlHours: 1, maxUses: 2 });
    const res = decide({ grantId: "g-plan" });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.result.status, "applied");
    const work = loadWork(root)!;
    assert.equal(approvalOf(work).status, "approved");
    const last = readLedger(root, CONSENT_WORK_ID).at(-1)!;
    assert.equal(last.presence?.channel, "master-delegation");
    assert.equal(last.presence?.verified, false);
    assert.match(last.presence!.detail, new RegExp(consentId));
    const record = loadConsent(root, consentId);
    assert.equal(record.delegation?.grantId, "g-plan");
    assert.equal(record.observed, undefined, "사람의 응답 기록을 만들지 않는다");
    const receipt = consentReceipts(root, CONSENT_WORK_ID).find((item) => item.id === consentId)!;
    assert.equal(receipt.channel, "master-delegation");
    assert.equal(receipt.delegation?.grantId, "g-plan");
    assert.deepEqual(receipt.observed, []);
    const decisions = readFileSync(join(root, ".code-agent/master/decisions.jsonl"), "utf8");
    assert.match(decisions, /"type":"decision".*"reason":"계획 파일이/);
  });

  test("거부되는 위임 — 범위 밖 경로·동작 없음·critical·ambiguous 승인·중복 판단·내용 해시 불일치·회수·사람만 하는 동작", () => {
    grant({ id: "g-narrow", controller: "m1", works: [CONSENT_WORK_ID], actions: ["plan"], paths: ["src/**"], ttlHours: 1, maxUses: 5 });
    grant({ id: "g-request", controller: "m1", works: [CONSENT_WORK_ID], actions: ["request"], paths: [], ttlHours: 1, maxUses: 5 });
    grant({ id: "g-ok", controller: "m1", works: [CONSENT_WORK_ID], actions: ["plan"], paths: ["src/**", "tests/**"], ttlHours: 1, maxUses: 5 });
    assert.equal(decide({ grantId: "g-narrow" }).error?.code, "scope-exceeded", "tests/value.test.js 가 paths 밖");
    assert.equal(decide({ grantId: "g-request" }).error?.code, "scope-exceeded", "plan 동작이 없다");
    assert.equal(decide({ grantId: "g-ok", category: "critical" }).error?.code, "human-required");
    assert.equal(decide({ grantId: "g-ok", category: "ambiguous" }).error?.code, "policy-forbids");
    assert.equal(decide({ grantId: "g-ok", shownHash: "sha256:stale" }).error?.code, "stale-state");
    assert.equal(decide({ grantId: "g-ok", reason: "" }).error?.code, "invalid-request");
    assert.equal(decide({ grantId: "g-ok", evidence: [] }).error?.code, "invalid-request");
    assert.equal(loadConsent(root, consentId).status, "pending", "거부된 위임은 동의를 바꾸지 않는다");
    const ok = decide({ grantId: "g-ok", decisionId: "d-fixed" });
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    const second = JSON.parse(prepareConsent(root, { action: "plan", decision: "reject", comment: "다시" }, { binding: { id: SESSION, host: "claude" } })).id as string;
    consentId = second;
    assert.equal(decide({ grantId: "g-ok", decisionId: "d-fixed" }).error?.code, "duplicate-decision");
    tty(() => masterRevoke(root, "g-ok", "시험"));
    assert.equal(decide({ grantId: "g-ok" }).error?.code, "grant-revoked");
  });

  test("master 실행이 준비하지 않은 동의(사람 세션)는 위임하지 않는다 — 사람의 응답 경로로 남는다", () => {
    grant({ id: "g-ok", controller: "m1", works: [CONSENT_WORK_ID], actions: ["plan"], paths: ["src/**", "tests/**"], ttlHours: 1, maxUses: 5 });
    consentId = JSON.parse(prepareConsent(root, { action: "plan" }, { binding: { id: "99999999-2222-4333-8444-555555555555", host: "claude" } })).id;
    const res = decide({ grantId: "g-ok" });
    assert.equal(res.error?.code, "human-required");
    assert.equal(loadConsent(root, consentId).status, "pending");
  });

  test("requireVerifiedApproval 프로젝트는 위임을 받지 않는다", () => {
    grant({ id: "g-ok", controller: "m1", works: [CONSENT_WORK_ID], actions: ["plan"], paths: ["src/**", "tests/**"], ttlHours: 1, maxUses: 5 });
    const manifest = JSON.parse(readFileSync(join(root, "code-agent.json"), "utf8"));
    manifest.workOrder = { ...(manifest.workOrder ?? {}), requireVerifiedApproval: true };
    writeFileSync(join(root, "code-agent.json"), JSON.stringify(manifest, null, 2));
    assert.equal(decide({ grantId: "g-ok" }).error?.code, "policy-forbids");
  });

  test("수정 요청 위임은 사람의 '수정 요청' 응답과 같은 상태로 남고 적용하지 않는다 — 수정 지시 전문을 동의 기록에 남긴다", () => {
    grant({ id: "g-ok", controller: "m1", works: [CONSENT_WORK_ID], actions: ["plan"], paths: ["src/**", "tests/**"], ttlHours: 1, maxUses: 5 });
    const reason = `R2 의 오류 메시지 형식이 정해지지 않았다. ${"근거 문장. ".repeat(60)}수정 지시: 03 의 가정 문구를 고치고 다시 확인을 요청하세요`;
    const res = decide({ grantId: "g-ok", verdict: "request-changes", category: "ambiguous", reason });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.result.status, "changes-requested");
    assert.equal(approvalOf(loadWork(root)!).status, "none");
    assert.ok(loadConsent(root, consentId).failure?.detail.endsWith("수정 지시: 03 의 가정 문구를 고치고 다시 확인을 요청하세요"), "앞부분만 남기지 않는다");
  });

  test("위임 수정 요청으로 닫힌 확인 요청은 그 동의를 준비한 세션의 이어 실행만 받는다 — 다른 세션·사람의 수정 요청은 사람 경로로 남는다", async () => {
    // 가짜 호스트(masterFakeHost — 실제 모델 실행이 아니다)
    const binding = readBinding(root)!;
    writeBinding(root, { ...binding, host: { ...binding.host, command: [process.execPath, join(__dirname, "masterFakeHost.js")] } });
    grant({ id: "g-ok", controller: "m1", works: [CONSENT_WORK_ID], actions: ["plan"], paths: ["src/**", "tests/**"], ttlHours: 1, maxUses: 5 });
    const resume = (sessionId: string) => send(token, "submit", { mode: "continue", sessionId, prompt: "MODE=complete 수정 지시대로 고쳐 다시 준비한다" }, { commandId: cid() });
    assert.equal(resume(SESSION).error?.code, "invalid-state", "응답을 기다리는 동의가 있으면 시작하지 않는다");
    assert.equal(decide({ grantId: "g-ok", verdict: "request-changes", category: "ambiguous", reason: "가정 문구를 고치고 다시 확인을 요청하세요" }).ok, true);
    const OTHER = "22222222-2222-4333-8444-555555555555";
    finishedRun(OTHER, CONSENT_WORK_ID);
    assert.equal(resume(OTHER).error?.code, "invalid-state", "동의를 준비하지 않은 세션은 이어 가지 않는다");
    const accepted = resume(SESSION);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    const end = Date.now() + 30_000;
    while (!send(token, "result", { runId: accepted.result.runId }).result?.final) {
      assert.ok(Date.now() < end, "가짜 호스트 실행이 끝나지 않았다");
      await new Promise((done) => setTimeout(done, 200));
    }
    // 사람이 낸 수정 요청(위임 기록 없음)은 이 길을 열지 않는다
    const prepared = JSON.parse(prepareConsent(root, { action: "plan" }, { binding: { id: SESSION, host: "claude" } }));
    const fixture = { root, ...prepared, sessionId: SESSION, toolUseId: "tool-human-change" };
    observeConsent({ cwd: root, hook_event_name: "PreToolUse", session_id: SESSION, tool_use_id: fixture.toolUseId, tool_name: "AskUserQuestion", tool_input: structuredClone(fixture.toolInput) });
    observeConsent({ cwd: root, hook_event_name: "PostToolUse", session_id: SESSION, tool_use_id: fixture.toolUseId, tool_name: "AskUserQuestion", tool_input: structuredClone(fixture.toolInput),
      tool_response: { questions: structuredClone(fixture.questions), answers: Object.fromEntries(fixture.questions.map((question: { question: string }) => [question.question, "수정 요청"])) } });
    assert.equal(loadConsent(root, prepared.id).status, "changes-requested");
    assert.equal(resume(SESSION).error?.code, "invalid-state");
  });
});

describe("위임 판단 — 업무 질문 답", () => {
  test("routine 위임 답은 delegated, 사람 답 전달은 relayed 로 가르고, 답 칸만 채운다(사람 응답·승인 기록 없음)", () => {
    const token = enable();
    finishedRun("aaaaaaaa-2222-4333-8444-555555555555", "W-9");
    mkdirSync(join(root, "doc/work/W-9"), { recursive: true });
    mkdirSync(join(root, ".code-agent/work/W-9"), { recursive: true });
    writeFileSync(join(root, ".code-agent/work/W-9/answers.jsonl"), `${JSON.stringify({ type: "start", at: new Date().toISOString(), version: 1, intake: [] })}\n`);
    writeFileSync(join(root, questionsFile("W-9")), "## Q1 · 형식\n날짜 형식?\nA. ISO\nB. 로컬\n[Answer]:\n[Status]: pending\n\n## Q2 · 범위\n삭제도 하나?\n[Answer]:\n");
    grant({ id: "g-ans", controller: "m1", works: ["W-9"], actions: ["answer"], paths: [], ttlHours: 1, maxUses: 5 });
    const questions = send(token, "questions", { workId: "W-9" }).result;
    assert.equal(questions.questions.length, 2);
    const critical = send(token, "answer", { workId: "W-9", decisionId: "a-0", grantId: "g-ans", actor: "ai", category: "critical", reason: "r", evidence: ["e"], questionsHash: questions.questionsHash, answers: [{ q: "Q2", answer: "예" }] }, { commandId: cid() });
    assert.equal(critical.error?.code, "human-required");
    const ai = send(token, "answer", { workId: "W-9", decisionId: "a-1", grantId: "g-ans", actor: "ai", category: "routine", reason: "기존 API 가 ISO 를 쓴다", evidence: ["src/api.ts:12"],
      questionsHash: questions.questionsHash, answers: [{ q: "Q1", answer: "A" }] }, { commandId: cid() });
    assert.equal(ai.ok, true, JSON.stringify(ai.error));
    assert.equal(ai.result.questions[0].source, "delegated");
    const stale = send(token, "answer", { workId: "W-9", decisionId: "a-2", grantId: "g-ans", actor: "human", reason: "사람이 master 에서 답했다", questionsHash: questions.questionsHash, answers: [{ q: "Q2", answer: "아니오" }] }, { commandId: cid() });
    assert.equal(stale.error?.code, "stale-state", "질문 문서가 바뀌었다");
    const fresh = send(token, "questions", { workId: "W-9" }).result;
    const human = send(token, "answer", { workId: "W-9", decisionId: "a-3", grantId: "g-ans", actor: "human", reason: "사람이 master 에서 답했다", questionsHash: fresh.questionsHash, answers: [{ q: "Q2", answer: "아니오" }] }, { commandId: cid() });
    assert.equal(human.ok, true, JSON.stringify(human.error));
    const text = readFileSync(join(root, questionsFile("W-9")), "utf8");
    const parsed = parseQuestions(text);
    assert.equal(parsed.find((q) => q.id === "Q1")?.answer, "A");
    assert.equal(parsed.find((q) => q.id === "Q1")?.status, "answered");
    const sources = answerSources(root, "W-9", parsed);
    assert.equal(sources.get("Q1"), "delegated");
    assert.equal(sources.get("Q2"), "relayed");
    assert.equal(send(token, "answer", { workId: "W-9", decisionId: "a-4", grantId: "g-ans", actor: "ai", category: "routine", reason: "r", evidence: ["e"],
      questionsHash: send(token, "questions", { workId: "W-9" }).result.questionsHash, answers: [{ q: "Q1", answer: "B" }] }, { commandId: cid() }).error?.code, "conflict", "이미 답한 질문은 고치지 않는다");
  });
});

describe("인계 상태 전이(실행 없음)", () => {
  test("요청 → 이전 → 인수, 이전 제어자는 fenced, 인수 전 새 제어자는 handover-unaccepted, 세대는 오른다", () => {
    const a = enable("m1");
    const b = enable("m2");
    const asB = (type: string, payload: Record<string, unknown>, generation: number) =>
      call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type, controller: "m2", generation, token: b, commandId: cid(), payload })) as Res;
    assert.equal(asB("policy", { patch: { heartbeatMs: 3000 } }, 1).error?.code, "fenced", "소유자가 아니다");
    const requested = send(a, "handover", { action: "request", to: "m2" }, { commandId: cid() });
    assert.equal(requested.ok, true, JSON.stringify(requested.error));
    const owner = readOwner(root)!;
    assert.equal(owner.controller, "m2");
    assert.equal(owner.generation, 2);
    assert.equal(owner.handover?.state, "transferred");
    assert.equal(send(a, "policy", { patch: { heartbeatMs: 3000 } }, { commandId: cid() }).error?.code, "fenced");
    assert.equal(asB("policy", { patch: { heartbeatMs: 3000 } }, 2).error?.code, "handover-unaccepted");
    assert.equal(asB("handover", { action: "accept", handoverId: owner.handover!.id }, 2).ok, true);
    assert.equal(asB("policy", { patch: { heartbeatMs: 3000 } }, 2).ok, true);
    assert.equal(readOwner(root)!.handover, undefined);
  });

  test("인계 도중 끊김 — stopping 으로 남은 기록은 실행이 끝난 것이 확인되면 같은 단계부터 이어서 넘긴다(소유 충돌 없음)", () => {
    enable("m1");
    enable("m2");
    const run = finishedRun("bbbbbbbb-2222-4333-8444-555555555555", "W-2");
    const owner = readOwner(root)!;
    writeOwner(root, { ...owner, handover: { id: "ho-crash", from: "m1", to: "m2", mode: "cooperative", by: "controller", state: "stopping", requestedAt: new Date().toISOString(), runs: [run.runId] } });
    const next = advanceHandover(root, readBinding(root)!.policy)!;
    assert.equal(next.handover?.state, "transferred");
    assert.equal(next.controller, "m2");
    assert.equal(next.generation, owner.generation + 1);
    assert.equal(advanceHandover(root, readBinding(root)!.policy)!.generation, owner.generation + 1, "다시 불러도 세대가 두 번 오르지 않는다");
  });
});

describe("hook — master 실행 세션 가드", () => {
  test("실행 표지가 없는 세션은 가드가 아무것도 하지 않고, 표지가 있으면 질문 도구·임대·제어 명령을 막고 정지 요청 뒤에는 모든 도구를 막는다", () => {
    const at = new Date().toISOString();
    const run: RunRecord = { version: 1, runId: "run-guard-1", commandId: "c", controller: "m1", generation: 1, mode: "start", links: {}, state: "running", acceptedAt: at, updatedAt: at,
      sessionId: "s-1", promptHash: "x", timeoutMs: 1000, workId: null, baseHead: null, baseStateVersion: "x", history: [] };
    writeRunRecord(root, run);
    const input = (tool: string, command?: string) => ({ tool_name: tool, session_id: "s-1", tool_input: command ? { command } : {} });
    assert.equal(masterRunGuard(input("AskUserQuestion"), root, {}), undefined);
    const env = { [MASTER_RUN_ENV]: "run-guard-1" };
    assert.match(masterRunGuard(input("AskUserQuestion"), root, env)!, /master 실행/);
    assert.match(masterRunGuard(input("Bash", "code-agent takeover"), root, env)!, /takeover/);
    assert.match(masterRunGuard(input("Bash", "code-agent master call"), root, env)!, /master/);
    assert.equal(masterRunGuard(input("Bash", "code-agent status"), root, env), undefined);
    assert.equal(masterRunGuard({ ...input("Bash", "code-agent status"), session_id: "other" }, root, env), undefined, "다른 세션의 도구 호출은 판단하지 않는다");
    writeRunRecord(root, { ...run, stop: { mode: "cancel", requestedAt: at, reason: "시험", by: "t", graceMs: 0 } });
    assert.match(masterRunGuard(input("Read"), root, env)!, /취소를 요청/);
  });

  test("master 실행 세션 안의 status --json 은 그 실행의 세션으로 임대를 본다(자기 임대 self) — 표지가 없으면 기존 그대로", () => {
    const at = new Date().toISOString();
    writeRunRecord(root, { version: 1, runId: "run-status-1", commandId: "c", controller: "m1", generation: 1, mode: "continue", links: {}, state: "running", acceptedAt: at, updatedAt: at,
      sessionId: "s-own", promptHash: "x", timeoutMs: 1000, workId: null, baseHead: null, baseStateVersion: "x", history: [] });
    writeFixture(root, LEASE_FILE, JSON.stringify({ version: 1, id: "MA-x", target: "t", host: "claude", session: "s-own", claimedAt: at, seenAt: at }));
    const lease = (env: Record<string, string>, ...extra: string[]) => {
      const out = spawnSync(process.execPath, [join(__dirname, "../agent/cli.js"), "status", "--json", ...extra],
        { cwd: root, encoding: "utf8", env: { ...process.env, [MASTER_RUN_ENV]: "", ...env } });
      return JSON.parse(out.stdout).ownership.lease as { session: string; self?: boolean };
    };
    assert.equal(lease({}).self, undefined, "실행 표지가 없으면 세션을 모른다(기존 출력)");
    assert.equal(lease({ [MASTER_RUN_ENV]: "run-status-1" }).self, true);
    assert.equal(lease({ [MASTER_RUN_ENV]: "run-status-1" }, "--session", "s-other").self, false, "명시한 --session 이 앞선다");
  });

  test("호스트 세션의 셸에서 code-agent master 는 막는다(작업이 없는 세션 포함) — 다른 명령의 판정은 그대로", () => {
    const denied = guardTool({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent master call" } });
    assert.match(denied ?? "", /master 제어 명령/);
    assert.equal(guardTool({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent status" } }), undefined);
  });
});
