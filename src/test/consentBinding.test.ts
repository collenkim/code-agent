import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyConsent, loadConsent } from "../agent/consent";
import { consentCommandOf, takeTicket, terminalCaller } from "../agent/consentTicket";
import { readDocLedger } from "../agent/docs";
import { decide } from "../agent/hook";
import { findRepoRoot } from "../agent/layout";
import { acquireLock } from "../agent/lock";
import { DEFER_CONSENT, prepareConsentFixture, writeFixture } from "./consentFixture";
import { root, bash, ticketFile, runCli, answerAs, codexReply, prepared, touchDoc } from "./consentBindingFixture";

import "./consentBindingFixture";
test("2-9 실행 중인 그래프 잠금이 실제 응답의 동의 적용을 막지 않는다", () => {
  touchDoc();
  const { id } = prepared({ action: "docs" }, { id: "MAIN", host: "claude" });
  answerAs(id, "MAIN");
  assert.equal(bash(`code-agent consent finish ${id}`, "MAIN"), undefined);
  const dir = join(root, ".code-agent/graph"); mkdirSync(dir, { recursive: true });
  const release = acquireLock(join(dir, "run.lock"), { waitMs: 0, ageReclaim: false, label: "검증" });
  try {
    const result = runCli(["consent", "finish", id]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(loadConsent(root, id).status, "applied");
  } finally { release(); }
});

// ---- 준비 티켓 ----

test("Windows .cmd 동의 명령도 준비 티켓과 적용 세션 결속을 거친다", () => {
  assert.equal(bash("code-agent.cmd consent prepare --action docs --for claude"), undefined);
  const ticket = takeTicket(root, "prepare");
  assert.equal(ticket?.sessionId, "S1");
  const { id } = prepared({ action: "docs" }, { id: "S1", host: "claude" });
  assert.match(decide({ cwd: root, session_id: "OTHER", tool_name: "Bash", tool_input: { command: `code-agent.cmd consent finish ${id}` } }) ?? "", /현재 세션/);
  assert.equal(takeTicket(root, "apply", id), undefined);
  assert.equal(bash(`code-agent.cmd consent finish ${id}`), undefined);
  assert.equal(takeTicket(root, "apply", id)?.sessionId, "S1");
  bash("code-agent.cmd consent prepare --action docs; echo x");
  assert.equal(takeTicket(root, "prepare"), undefined);
});

test("T-1-1 준비 티켓 — hook 이 허용한 정확한 꼴의 준비 명령만 저장소당 하나의 티켓을 낸다", () => {
  assert.equal(bash("code-agent consent prepare doc/x.json"), undefined);
  assert.ok(existsSync(ticketFile()));
  const ticket = takeTicket(root, "prepare");
  assert.equal(ticket?.sessionId, "S1");
  assert.equal(ticket?.host, "claude");
  assert.equal(takeTicket(root, "prepare"), undefined, "한 번만 가져간다");
  assert.equal(bash("code-agent consent prepare --action plan --for claude"), undefined);
  assert.ok(takeTicket(root, "prepare"), "인자 글자와 무관하다");
  for (const command of ["code-agent consent prepare doc/x.json && echo y", "code-agent consent prepare doc/x.json; echo y"]) {
    bash(command);
    assert.equal(takeTicket(root, "prepare"), undefined, command);
  }
  assert.deepEqual(consentCommandOf("code-agent consent finish 12345678-1234-1234-1234-123456789abc"), { kind: "apply", id: "12345678-1234-1234-1234-123456789abc" });
  assert.equal(consentCommandOf("code-agent consent  apply 12345678-1234-1234-1234-123456789abc"), undefined);
});

test("T-1-2 만료된 티켓은 가져가지 못하고 지워진다", () => {
  bash("code-agent consent prepare doc/x.json");
  const ticket = JSON.parse(readFileSync(ticketFile(), "utf8"));
  writeFileSync(ticketFile(), JSON.stringify({ ...ticket, at: new Date(Date.now() - 16 * 60_000).toISOString() }));
  assert.equal(takeTicket(root, "prepare"), undefined);
  assert.equal(existsSync(ticketFile()), false);
});

test("T-1-3·T-2-2 CLI 준비·적용은 티켓이 있어야 한다 — 기록에 준비 세션이 남는다", () => {
  writeFixture(root, "doc/x.json", JSON.stringify({ action: "docs" }));
  const refused = runCli(["consent", "prepare", "doc/x.json"]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /hook 이 관찰하지 못했습니다/);
  bash("code-agent consent prepare doc/x.json", "MAIN");
  const ok = runCli(["consent", "prepare", "x.json"], join(root, "doc"));
  assert.equal(ok.status, 0, ok.stderr);
  const id = JSON.parse(ok.stdout).id as string;
  assert.equal(loadConsent(root, id).preparedSession?.id, "MAIN");
  assert.equal(loadConsent(root, id).format, 2);
  answerAs(id, "MAIN");
  for (const args of [["consent", "apply", id], ["consent", "finish", id]]) {
    const apply = runCli(args);
    assert.equal(apply.status, 1, apply.stderr);
    assert.match(apply.stderr, /hook 이 관찰하지 못했습니다/);
  }
  bash(`code-agent consent  apply ${id}`, "MAIN");
  assert.equal(runCli(["consent", "apply", id]).status, 1, "공백 두 칸 꼴은 티켓을 내지 않는다");
  assert.equal(loadConsent(root, id).status, "approved");
  bash(`code-agent consent finish ${id}`, "MAIN");
  const finished = runCli(["consent", "finish", id]);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(JSON.parse(finished.stdout).status, "applied");
});

test("T-1-4·T-1-5 준비 세션 결속 — 다른 codex exec 세션·다른 채널의 응답은 받지 않는다", () => {
  const { id } = prepared({ action: "docs" }, { id: "MAIN", host: "codex" });
  assert.throws(() => codexReply(id, "EXEC"), /준비한 세션의 응답이 아닙니다/);
  assert.equal(loadConsent(root, id).status, "pending");
  assert.throws(() => answerAs(id, "MAIN"), /준비한 세션의 응답이 아닙니다/, "Codex 에서 준비한 동의에 Claude 질문 응답은 받지 않는다");
  assert.equal(loadConsent(root, id).status, "pending");
  codexReply(id, "MAIN");
  assert.equal(loadConsent(root, id).status, "approved");
});

test("T-1-6 하위 폴더에서 연 세션도 저장소 루트에 티켓을 낸다", () => {
  const sub = join(root, "sub");
  mkdirSync(sub);
  assert.equal(decide({ cwd: sub, session_id: "S1", tool_name: "Bash", tool_input: { command: "code-agent consent prepare ../doc/x.json" } }, sub), undefined);
  assert.equal(existsSync(join(sub, ".code-agent")), false);
  assert.equal(takeTicket(findRepoRoot(sub), "prepare")?.sessionId, "S1");
});

test("T-1-6b 하위 폴더에서 연 세션의 적용 명령도 저장소 루트의 동의 기록으로 결속을 확인하고 적용 티켓을 낸다", () => {
  const sub = join(root, "doc");
  const inSub = (command: string, session = "S1") => decide({ cwd: sub, session_id: session, tool_name: "Bash", tool_input: { command } }, sub);
  assert.equal(inSub("code-agent consent prepare consent-action.json"), undefined);
  writeFixture(root, "doc/consent-action.json", JSON.stringify({ action: "docs" }));
  const ready = runCli(["consent", "prepare", "consent-action.json"], sub);
  assert.equal(ready.status, 0, ready.stderr);
  const id = JSON.parse(ready.stdout).id as string;
  answerAs(id, "S1");
  assert.equal(loadConsent(root, id).status, "approved");
  assert.match(inSub(`code-agent consent finish ${id}`, "OTHER") ?? "", /현재 세션에서 확인한 요청만/, "다른 세션은 그대로 거부한다");
  assert.equal(inSub(`code-agent consent finish ${id}`), undefined, "하위 폴더 세션도 기록을 읽는다");
  assert.equal(existsSync(join(sub, ".code-agent")), false);
  const finished = runCli(["consent", "finish", id], sub);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(JSON.parse(finished.stdout).status, "applied");
});

test("검토 #1 hook·consent-event 진입은 judgment 소유 모듈(retryGrant·reviewJudgment)을 읽지 않는다", () => {
  const probe = (entry: string) => {
    const script = `require(${JSON.stringify(join(__dirname, "../agent", entry))});` +
      "process.stdout.write(JSON.stringify(Object.keys(require.cache).map((file) => file.split(String.fromCharCode(92)).join('/'))));";
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as string[];
  };
  for (const entry of ["hook.js", "consent.js"]) {
    const loaded = probe(entry);
    // hook 은 consent.ts 를 적용 명령 꼴에서만 지연 로드한다(hookLoad.test가 실행 경로를 확인한다)
    assert.equal(loaded.some((file) => file.endsWith("/agent/consent.js")), entry === "consent.js", entry);
    for (const name of ["retryGrant.js", "reviewJudgment.js", "crossCheck.js", "verificationFlow.js"]) {
      assert.equal(loaded.some((file) => file.endsWith(`/agent/${name}`)), false, `${entry} → ${name}`);
    }
  }
});

test("T-1-7 동시 준비는 결속이 어긋나 거부된다(fail-closed)", () => {
  bash("code-agent consent prepare doc/x.json", "S1");
  bash("code-agent consent prepare doc/x.json", "S2");
  const ticket = takeTicket(root, "prepare");
  assert.equal(ticket?.sessionId, "S2");
  assert.equal(takeTicket(root, "prepare"), undefined);
  const { id } = prepared({ action: "docs" }, { id: ticket!.sessionId, host: ticket!.host });
  assert.throws(() => answerAs(id, "S1"), /준비한 세션의 응답이 아닙니다/);
  assert.equal(loadConsent(root, id).status, "pending");
});

test("T-1-8 세션 검사는 스냅샷 대조보다 먼저다 — 남의 세션이 동의를 폐기하지 못한다", () => {
  const { id } = prepared({ action: "docs" }, { id: "S1", host: "claude" });
  touchDoc();
  assert.throws(() => answerAs(id, "S2"), /준비한 세션의 응답이 아닙니다/);
  assert.equal(loadConsent(root, id).status, "pending");
  assert.equal(loadConsent(root, id).failure, undefined);
  assert.throws(() => answerAs(id, "S1"), /확인 대상이 바뀌었습니다/);
  assert.equal(loadConsent(root, id).failure?.kind, "target");
  const second = prepared({ action: "docs" }, { id: "S1", host: "claude" });
  answerAs(second.id, "S1");
  touchDoc();
  assert.throws(() => applyConsent(root, second.id, { sessionId: "OTHER" }), /hook 이 확인한 적용 명령만/);
  assert.equal(loadConsent(root, second.id).status, "approved");
});

// ---- 적용 티켓·열린 동의 창 ----

test("T-2-1 준비 세션이 있는 동의는 응답을 관찰한 세션의 적용만 받는다", () => {
  const { id } = prepared({ action: "docs" }, { id: "S1", host: "claude" });
  answerAs(id, "S1");
  assert.throws(() => applyConsent(root, id), /hook 이 확인한 적용 명령만/);
  assert.throws(() => applyConsent(root, id, { tty: true }), /hook 이 확인한 적용 명령만/);
  assert.equal(loadConsent(root, id).status, "approved");
  assert.match(applyConsent(root, id, { sessionId: "S1" }), /확정/);
  assert.equal(loadConsent(root, id).status, "applied");
  assert.match(readDocLedger(root)[0].presence.detail, /준비 세션 일치/);
  // 이전 형식 기록(준비 세션 없음)은 이전 규칙 — caller 없는 프로세스 안 적용이 그대로 돈다
  const legacy = prepareConsentFixture(root, { action: "docs", kind: "architecture" });
  assert.equal(loadConsent(root, legacy.id).preparedSession, undefined);
});

test("T-2-3 세션 밖에서 응답을 기다리는 동의가 있으면 셸을 code-agent 명령과 읽기용 git 으로 좁힌다", () => {
  const { id } = prepared({ action: "docs" }, { id: "S1", host: "claude" });
  assert.match(bash("node -e 1") ?? "", /응답·적용을 기다리는 동안/);
  assert.match(bash("codex exec x") ?? "", /응답·적용을 기다리는 동안/);
  // 그 동의에 답할 수 없는 다른 세션은 좁히지 않는다(E27 — 그 세션의 쓰기는 동의 스냅샷 대조가 폐기로 잡는다)
  assert.equal(bash("node -e 1", "S9-unrelated"), undefined);
  assert.equal(JSON.parse(readFileSync(join(root, ".code-agent/consents/index.json"), "utf8")).open[id].session, "S1");
  assert.equal(bash(`code-agent consent finish ${id}`), undefined);
  assert.equal(bash("git status"), undefined);
  const index = join(root, ".code-agent/consents/index.json");
  const saved = readFileSync(index, "utf8");
  const value = JSON.parse(saved);
  value.open[id].createdAt = new Date(Date.now() - 31 * 60_000).toISOString();
  writeFileSync(index, JSON.stringify(value));
  assert.equal(bash("node -e 1"), undefined, "30분이 지나면 풀린다");
  writeFileSync(index, saved);
  answerAs(id, "S1", DEFER_CONSENT);
  assert.equal(loadConsent(root, id).status, "deferred");
  assert.equal(bash("node -e 1"), undefined, "보류된 동의는 창을 닫는다");
});

test("T-2-4 TTY 경로는 호스트 표지가 없을 때만 열린다", () => {
  assert.deepEqual(terminalCaller(true, {}), { tty: true });
  assert.equal(terminalCaller(true, { CLAUDECODE: "1" }), undefined);
  assert.equal(terminalCaller(true, { CODEX_THREAD_ID: "x" }), undefined);
  assert.equal(terminalCaller(false, {}), undefined);
});

// ---- 동의 쪽 재시도 규약 ----
