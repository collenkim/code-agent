import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  applyConsent, codexReplyCode, CONSENT_ACTIONS, consentSnapshot, consentStatus, finishConsent, loadConsent, observeConsent, prepareConsent,
} from "../agent/consent";
import type { ConsentAction } from "../agent/consent";
import { consentCommandOf, takeTicket, terminalCaller } from "../agent/consentTicket";
import { codexHook } from "../agent/codexHook";
import { start } from "../agent/commands";
import { readDocLedger } from "../agent/docs";
import { decide } from "../agent/hook";
import { findRepoRoot } from "../agent/layout";
import { cancelPlanning, dispatchPlanning, planningBudget, preparePlanning } from "../agent/planning";
import { loadPlanning } from "../agent/planningState";
import { GRANT_STEP, GUIDE_VARIANTS, POLICIES } from "../agent/retryPolicy";
import { loadReview } from "../agent/review";
import { loadWork } from "../agent/work";
import {
  ACCEPT_CONSENT, CONSENT_SPEC, CONSENT_WORK_ID, DEFER_CONSENT,
  approveAndApplyFixture, consentEvent, nativeResponse, observeConsentFixture, prepareConsentFixture, prepareReviewFixture,
  setupConsentProject, submitConsentRequest, writeFixture,
} from "./consentFixture";

let root: string;
const cli = join(__dirname, "../agent/cli.js");
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-binding-")));
  setupConsentProject(root);
});
afterEach(() => {
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-binding-"));
  rmSync(target, { recursive: true, force: true });
});

const bash = (command: string, session = "S1", extra: Record<string, unknown> = {}) =>
  decide({ cwd: root, session_id: session, tool_name: "Bash", tool_input: { command }, ...extra });
const ticketFile = () => join(root, ".code-agent/consents/tickets/prepare.json");
/** CLI 를 셸 표지 없이(사람의 터미널이 아닌 비TTY 자식으로) 돌린다 */
function runCli(args: string[], cwd = root) {
  const env = { ...process.env };
  delete env.CLAUDECODE; delete env.CODE_AGENT_CROSS;
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env });
}
/** Claude 질문 도구 응답 — 준비 세션 sessionId 로 Pre/Post 를 넣는다 */
function answerAs(id: string, session: string, label = ACCEPT_CONSENT, toolId = `tool-${session}`): void {
  const status = JSON.parse(consentStatus(root, id));
  const base = { cwd: root, session_id: session, tool_use_id: toolId, tool_name: "AskUserQuestion", tool_input: structuredClone(status.toolInput) };
  observeConsent({ ...base, hook_event_name: "PreToolUse" });
  observeConsent({ ...base, hook_event_name: "PostToolUse", tool_response: { questions: status.questions,
    answers: Object.fromEntries(status.questions.map((q: { question: string }) => [q.question, label])) } });
}
const codexReply = (id: string, session: string, choice = "1", code = codexReplyCode(root, id).code) =>
  codexHook({ cwd: root, hook_event_name: "UserPromptSubmit", session_id: session, turn_id: `turn-${session}-${choice}`,
    prompt: `code-agent consent respond ${id} ${choice}${code ? ` ${code}` : ""}` });
const prepared = (action: ConsentAction, binding?: { id: string; host: "claude" | "codex" }) =>
  JSON.parse(prepareConsent(root, action, binding ? { binding } : {})) as { id: string; status: string; warning?: string; codexReply?: { format: string; questions: { question: string }[] }; toolInput: { questions: { question: string }[] } };
const touchDoc = () => writeFixture(root, "doc/architecture.md", readFileSync(join(root, "doc/architecture.md"), "utf8") + "\n바뀜\n");

// ---- CON-1 준비 티켓 ----

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
    // hook 은 consent.ts 를 적용 명령 꼴에서만 지연 로드한다(C7 OPT-15 — hookLoad.test 가 실행 경로를 본다)
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

// ---- CON-2 적용 티켓·열린 동의 창 ----

test("T-2-1 준비 세션이 있는 동의는 응답을 관찰한 세션의 적용만 받는다", () => {
  const { id } = prepared({ action: "docs" }, { id: "S1", host: "claude" });
  answerAs(id, "S1");
  assert.throws(() => applyConsent(root, id), /hook 이 확인한 적용 명령만/);
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

test("T-RP-1·T-RP-2 대상 변경은 동의를 폐기하고 되돌려도 다시 적용하지 않는다", () => {
  const first = prepareConsentFixture(root, { action: "docs" });
  touchDoc();
  assert.throws(() => observeConsent(consentEvent(first, "PreToolUse")), /확인 대상이 바뀌었습니다/);
  const record = loadConsent(root, first.id);
  assert.equal(record.status, "failed");
  assert.deepEqual([record.failure?.class, record.failure?.kind], ["consent-target-changed", "target"]);
  assert.match(record.failure!.detail, /^확인 대상 변경:.*doc\/architecture\.md/);
  const before = readFileSync(join(root, "doc/architecture.md"), "utf8");
  const second = prepareConsentFixture(root, { action: "docs" });
  observeConsentFixture(second);
  writeFixture(root, "doc/architecture.md", before + "x");
  assert.throws(() => applyConsent(root, second.id), /확인 이후/);
  assert.equal(loadConsent(root, second.id).status, "failed");
  writeFixture(root, "doc/architecture.md", before);
  assert.throws(() => applyConsent(root, second.id), /이미 응답했거나|명시적으로 확인한 응답이 없습니다/);
  assert.equal(readDocLedger(root).length, 0);
});

test("T-RP-3 응답 갈래 — 명시적 선택 없음·선택지 밖·수정 요청·보류마다 갈래와 안내가 다르다", () => {
  const timeout = prepareConsentFixture(root, { action: "docs" });
  observeConsent(consentEvent(timeout, "PreToolUse"));
  assert.throws(() => observeConsent(consentEvent(timeout, "PostToolUse", { tool_response: { ...nativeResponse(timeout), afkTimeoutMs: 1000 } })));
  const none = JSON.parse(consentStatus(root, timeout.id)).failure;
  assert.equal(loadConsent(root, timeout.id).status, "failed");
  assert.equal(none.kind, "response-none");
  assert.match(none.detail, /^응답: 명시적 선택 없음/);
  assert.match(none.guide, /다시 묻지 않습니다/);
  const free = prepareConsentFixture(root, { action: "docs" });
  observeConsent(consentEvent(free, "PreToolUse"));
  assert.throws(() => observeConsent(consentEvent(free, "PostToolUse", { tool_response: { ...nativeResponse(free), answers: { [free.questions[0].question]: "아마도" } } })));
  assert.equal(loadConsent(root, free.id).failure?.kind, "response-invalid");
  const change = prepareConsentFixture(root, { action: "docs" });
  observeConsentFixture(change, "수정 요청");
  const changed = JSON.parse(consentStatus(root, change.id));
  assert.equal(changed.status, "changes-requested");
  assert.equal(changed.failure.kind, "response-change");
  assert.match(changed.failure.guide, /고칠지 업무 질문으로/);
  for (let index = 0; index < 2; index++) {
    const defer = prepareConsentFixture(root, { action: "docs" });
    observeConsentFixture(defer, DEFER_CONSENT);
    const deferred = JSON.parse(consentStatus(root, defer.id));
    assert.equal(deferred.status, "deferred");
    assert.equal(deferred.failure.kind, "response-defer");
    assert.match(deferred.failure.guide, /다시 묻지 않습니다/);
    assert.doesNotMatch(deferred.failure.guide, /새로 준비해 다시 확인/);
  }
  assert.equal(prepared({ action: "docs" }).warning, undefined, "보류는 외부 변경의 징후가 아니다 — 대상 변경만 센다");
});

test("T-RP-4 같은 동작이 연속 두 번 대상 변경으로 폐기되면 준비 결과에 경고가 붙는다", () => {
  const discardOnce = () => {
    const fixture = prepareConsentFixture(root, { action: "docs" });
    touchDoc();
    assert.throws(() => observeConsent(consentEvent(fixture, "PreToolUse")));
  };
  discardOnce();
  assert.equal(prepared({ action: "docs" }).warning, undefined, "한 번은 경고하지 않는다");
  discardOnce();
  discardOnce();
  const third = prepared({ action: "docs" });
  assert.match(third.warning ?? "", /연속 2회 대상 변경/);
  assert.match(third.warning ?? "", /doc\/architecture\.md/);
});

test("T-RP-5 상태 출력의 failure — 이전 기록에는 키가 없다", () => {
  const fixture = prepareConsentFixture(root, { action: "docs" });
  touchDoc();
  assert.throws(() => observeConsent(consentEvent(fixture, "PreToolUse")));
  const status = JSON.parse(consentStatus(root, fixture.id));
  assert.deepEqual([status.failure.class, status.failure.kind], ["consent-target-changed", "target"]);
  assert.match(status.failure.guide, /새로 준비해 다시 확인받으세요/);
  const legacy = prepareConsentFixture(root, { action: "docs", kind: "architecture" });
  const file = join(root, ".code-agent/consents", `${legacy.id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "failed" }));
  assert.equal("failure" in JSON.parse(consentStatus(root, legacy.id)), false);
});

test("T-RP-6 살아 있는 주인의 동의 잠금은 2초 기다린 뒤 pid 를 알린다", () => {
  const fixture = prepareConsentFixture(root, { action: "docs" });
  observeConsentFixture(fixture);
  writeFileSync(join(root, ".code-agent/consents/apply.lock"), JSON.stringify({ pid: process.pid, host: hostname(), at: "t" }));
  const started = Date.now();
  assert.throws(() => applyConsent(root, fixture.id), new RegExp(`pid ${process.pid}.*한 번 다시 실행`));
  assert.ok(Date.now() - started >= 1900);
});

test("T-RP-7 hook·CLI 로그와 작업 임대는 열린 동의를 깨지 않고, 업무 답 기록은 깬다", () => {
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  const { id } = prepared({ action: "abort" }, { id: "MAIN", host: "codex" });
  const before = consentSnapshot(root, loadConsent(root, id).action);
  for (const file of [".code-agent/log/prompts.jsonl", ".code-agent/log/codex-tools.json", ".code-agent/log/stages.jsonl", ".code-agent/lease.json"]) writeFixture(root, file, "{}\n");
  assert.equal(consentSnapshot(root, loadConsent(root, id).action), before);
  codexReply(id, "MAIN");
  assert.equal(loadConsent(root, id).status, "approved");
  const other = prepared({ action: "abort" }, { id: "MAIN", host: "codex" });
  writeFixture(root, `.code-agent/work/${CONSENT_WORK_ID}/answers.jsonl`, "{\"type\":\"ask\"}\n");
  assert.throws(() => codexReply(other.id, "MAIN"), /확인 대상이 바뀌었습니다/);
  assert.equal(loadConsent(root, other.id).failure?.kind, "target");
  assert.match(loadConsent(root, other.id).failure!.detail, /answers\.jsonl/);
});

test("T-RP-8 적용 때 확인 화면 불일치 — 첫 확인 전이면 대상 변경, 앞선 확인 뒤면 적용 실패", () => {
  const edit = (id: string, index: number) => {
    const file = join(root, ".code-agent/consents", `${id}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.confirmations[index].shown += "\n(업그레이드로 바뀐 화면)";
    writeFileSync(file, JSON.stringify(record));
  };
  const setup = prepareConsentFixture(root, { action: "setup" });
  observeConsentFixture(setup);
  edit(setup.id, 1);
  assert.throws(() => applyConsent(root, setup.id), /확인한 내용과 실행할 내용이 다릅니다/);
  assert.equal(loadConsent(root, setup.id).failure?.kind, "apply");
  assert.match(loadConsent(root, setup.id).failure!.detail, /앞선 확인 1건 통과 뒤/);
});

test("T-RP-8b 첫 확인 전 화면 불일치는 대상 변경이다(업그레이드로 바뀐 기준 커밋 확인 화면)", () => {
  const fixture = prepareConsentFixture(root, { action: "baseline" });
  observeConsentFixture(fixture);
  const file = join(root, ".code-agent/consents", `${fixture.id}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.confirmations[0].shown += "\n(업그레이드로 바뀐 화면)";
  writeFileSync(file, JSON.stringify(record));
  assert.throws(() => applyConsent(root, fixture.id), /확인한 내용과 실행할 내용이 다릅니다/);
  assert.deepEqual([loadConsent(root, fixture.id).status, loadConsent(root, fixture.id).failure?.kind, loadConsent(root, fixture.id).failure?.detail],
    ["failed", "target", "확인 대상 변경: 확인 화면"]);
});

// ---- CON-5 Codex 확인 코드 ----

test("T-5-1·T-5-2·T-5-3 Codex 응답은 확인 코드를 요구하고, 이전 형식 기록은 코드 없이도 받는다", () => {
  const record = prepared({ action: "docs" });
  assert.match(record.codexReply!.format, /<확인 코드>$/);
  assert.match(record.codexReply!.questions.at(-1)!.question, /확인 코드: [a-f0-9]{6} — /);
  assert.ok(record.toolInput.questions.every((question) => !question.question.includes("확인 코드")), "Claude 질문은 그대로다");
  assert.throws(() => codexReply(record.id, "S", "1", ""), /확인 코드가 없거나 다릅니다/);
  assert.throws(() => codexReply(record.id, "S", "1", "000000"), /확인 코드가 없거나 다릅니다/);
  assert.equal(loadConsent(root, record.id).status, "pending");
  codexReply(record.id, "S");
  assert.equal(loadConsent(root, record.id).status, "approved");
  const legacy = prepared({ action: "docs", kind: "architecture" });
  const file = join(root, ".code-agent/consents", `${legacy.id}.json`);
  const value = JSON.parse(readFileSync(file, "utf8"));
  delete value.format;
  writeFileSync(file, JSON.stringify(value));
  assert.doesNotMatch(JSON.parse(consentStatus(root, legacy.id)).codexReply.format, /확인 코드/);
  codexReply(legacy.id, "S2", "1", "");
  assert.equal(loadConsent(root, legacy.id).status, "approved");
});

// ---- judgment ----

function startWork(): void {
  approveAndApplyFixture(root, { action: "setup" });
  submitConsentRequest(root);
  approveAndApplyFixture(root, { action: "request", id: CONSENT_WORK_ID });
  start(root, join(root, CONSENT_SPEC));
}
const judgment = (extra: Partial<ConsentAction>) => ({ action: "judgment", kind: "retry-grant", comment: "사용자 판단", ...extra }) as ConsentAction;

test("T-J-1 judgment 공통 검증과 카운터 검증", () => {
  startWork();
  const refuse = (action: ConsentAction, pattern: RegExp) => assert.throws(() => prepareConsent(root, action), pattern);
  refuse({ action: "judgment", comment: "x" }, /kind 는 retry-grant/);
  refuse(judgment({ comment: undefined, name: "fix" }), /사유\(comment\)가 필요/);
  refuse(judgment({ comment: "가".repeat(501), name: "fix" }), /500자 이하/);
  refuse(judgment({ name: "collect" }), /사람 허용으로 늘리지 않습니다/);
  refuse(judgment({ name: "fix", id: "analysis" }), /id 를 빼고/);
  refuse(judgment({ name: "taskTotal" }), /계획 작업 ID/);
  // 리뷰 회차 한도 거부는 검증 쪽(check 로 되감긴 뒤)에서 나므로 검증 단계 어디서든 받는다(E14) — 계획 단계에서는 거부
  refuse(judgment({ name: "reviewRounds" }), /reviewRounds 는 check·test·review·integrate 단계에서 허용합니다\(지금: analysis\)/);
  refuse({ action: "judgment", kind: "waive-finding", comment: "x" }, /지적 번호/);
  refuse({ action: "judgment", kind: "cross-stop", name: "x", comment: "x" }, /review 또는 planning/);
  preparePlanning(root);
  refuse(judgment({ name: "taskTotal", id: "analysis" }), /한도가 남아 있어/);
});

test("T-J-2 judgment retry-grant(검증) — 소진된 고쳐 쓰기·같은 코드 재실행에 코드가 정한 범위로 한 번만 남긴다", async () => {
  await prepareReviewFixture(root);
  const file = join(root, `.code-agent/work/${CONSENT_WORK_ID}/value.verify.json`);
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  evidence.retry = { version: 1, causes: { "1": "first", "2": "fix", "3": "fix" }, reruns: { [String(evidence.rounds)]: 2 }, integrateReruns: {}, grants: [] };
  writeFileSync(file, JSON.stringify(evidence));
  const fix = approveAndApplyFixture(root, judgment({ name: "fix" }));
  assert.match(fix.result, /고쳐 쓰기 한도를 2→3회로 늘렸습니다\(사람 판단, 동의 [a-f0-9]{8}\) — code-agent verify/);
  const grants = () => JSON.parse(readFileSync(file, "utf8")).retry.grants as { key: string; scope: string; step: number; consent: string }[];
  assert.deepEqual(grants().map(({ key, scope, step, consent }) => ({ key, scope, step, consent })), [{ key: "fix", scope: "", step: 1, consent: fix.id }]);
  assert.equal(applyConsent(root, fix.id), fix.result, "같은 동의는 캐시된 결과만 돌려준다");
  assert.equal(grants().length, 1);
  assert.match(approveAndApplyFixture(root, judgment({ name: "rerun" })).result, /code-agent verify --retry/);
  assert.deepEqual(grants().map((grant) => [grant.key, grant.scope]), [["fix", ""], ["rerun", `round:${evidence.rounds}`]]);
  assert.throws(() => prepareConsent(root, judgment({ name: "fix" })), /한도가 남아 있어/, "허용 뒤에는 소진이 아니다");
});

test("T-J-4 judgment retry-grant(리뷰·계획) — 리뷰 회차는 review.json, 작업 총 배정은 planning.json 에 남고 준비 뒤 기록이 바뀌면 폐기된다", async () => {
  await prepareReviewFixture(root);
  const file = join(root, `.code-agent/work/${CONSENT_WORK_ID}/value.review.json`);
  const log = JSON.parse(readFileSync(file, "utf8"));
  const first = log.rounds[0];
  log.rounds = [first, { ...first, round: 2 }, { ...first, round: 3 }];
  log.limit = 3;
  writeFileSync(file, JSON.stringify(log));
  const stale = prepareConsentFixture(root, judgment({ name: "reviewRounds" }));
  observeConsentFixture(stale);
  writeFileSync(file, JSON.stringify({ ...log, note: "준비 뒤에 바뀐 기록" }));
  assert.throws(() => applyConsent(root, stale.id), /확인 이후/);
  assert.equal(loadConsent(root, stale.id).failure?.kind, "target");
  const granted = approveAndApplyFixture(root, judgment({ name: "reviewRounds" }));
  assert.match(granted.result, /리뷰 회차 한도를 3→4회로 늘렸습니다/);
  assert.deepEqual(loadReview(root, CONSENT_WORK_ID, "value")!.grants!.map((grant) => [grant.key, grant.scope, grant.consent]), [["reviewRounds", "", granted.id]]);
});

test("judgment retry-grant(taskTotal) 통합 — 작업 총 배정 6회 소진 → 사람 판단 적용 → 한도 9 → 다시 배정", () => {
  startWork();
  preparePlanning(root);
  for (let index = 0; index < 6; index++) { dispatchPlanning(root, "analysis"); cancelPlanning(root, "analysis"); }
  assert.throws(() => dispatchPlanning(root, "analysis"), /총 6회/);
  const report = JSON.parse(prepareConsent(root, judgment({ name: "taskTotal", id: "analysis" })));
  assert.match(report.summary, /카운터: 작업 총 배정\(taskTotal\) · 지점: 계획 작업 analysis[\s\S]*사용 6 \/ 한도 6 — 소진[\s\S]*허용하면: 한도 6 → 9 \(\+3, 사람 판단\)/);
  const applied = approveAndApplyFixture(root, judgment({ name: "taskTotal", id: "analysis" }));
  assert.match(applied.result, /작업 총 배정 한도를 6→9회로 늘렸습니다.*code-agent planning advance/);
  assert.equal(planningBudget(root, "analysis").taskTotal.limit, 9);
  assert.equal(loadPlanning(loadWork(root)!).retry!.grants[0].scope, "planning:analysis");
  assert.doesNotThrow(() => dispatchPlanning(root, "analysis"));
});

test("T-J-3 동작 목록·judgment 문구 동기화 — ca-answer 세 곳과 안내 문구가 같은 이름을 쓴다", () => {
  const files = ["template/claude/skills/ca-answer/SKILL.md", "template/claude/skills/ca-answer/appendix.md", "template/codex/ca-answer.md"]
    .map((file) => [file, readFileSync(join(__dirname, "../..", file), "utf8")] as const);
  for (const [file, text] of files) {
    for (const action of CONSENT_ACTIONS) assert.ok(text.includes(`\`${action}\``) || text.includes(`"action":"${action}"`), `${file} 에 ${action} 이 없습니다`);
  }
  const reference = files[1][1];
  for (const kind of ["retry-grant", "waive-finding", "cross-stop"]) {
    assert.ok(reference.includes(kind) && files[2][1].includes(kind), kind);
  }
  // 안내 문구·스킬이 가리키는 judgment 갈래와 카운터는 실제로 받는 값이다
  const texts = [...Object.values(POLICIES).map((policy) => policy.guide), ...Object.values(GUIDE_VARIANTS).flatMap((variants) => Object.values(variants ?? {}))];
  const skills = join(__dirname, "../../template/claude/skills");
  for (const dir of readdirSync(skills)) for (const name of readdirSync(join(skills, dir))) texts.push(readFileSync(join(skills, dir, name), "utf8"));
  texts.push(files[2][1]);
  // 코드의 거부·안내 문구(validate·commands·hook·review·crossCheck 등)도 같은 이름을 쓴다
  const sources = join(__dirname, "../../src/agent");
  for (const name of readdirSync(sources)) if (name.endsWith(".ts")) texts.push(readFileSync(join(sources, name), "utf8"));
  const all = texts.join("\n");
  const kinds = ["retry-grant", "waive-finding", "cross-stop"];
  for (const match of all.matchAll(/judgment ([a-z][a-z-]*)/g)) assert.ok(kinds.includes(match[1]), `알 수 없는 judgment 갈래: ${match[1]}`);
  let counters = 0;
  for (const match of all.matchAll(/retry-grant(?: |\(name )([a-zA-Z]+)/g)) {
    counters++;
    assert.ok(match[1] in GRANT_STEP, `사람 허용으로 늘리지 않는 카운터를 가리킵니다: ${match[1]}`);
  }
  assert.ok(counters >= 3, "안내 문구가 retry-grant 카운터를 가리킨다");
  for (const match of all.matchAll(/"action":"judgment","kind":"([a-z-]+)"/g)) assert.ok(kinds.includes(match[1]), `알 수 없는 judgment kind: ${match[1]}`);
});

test("judgment waive-finding·cross-stop 은 C1 함수로 이어진다 — 단계·지점 전제는 소유 함수가 본다", () => {
  startWork();
  assert.throws(() => prepareConsent(root, { action: "judgment", kind: "waive-finding", id: "F1", comment: "사용자 판단" }), /review 단계\(F·X 번호\)나 plan 단계/);
  assert.throws(() => prepareConsent(root, { action: "judgment", kind: "cross-stop", name: "review", comment: "사용자 판단" }), /두 호스트가 설치된 프로젝트에서만/);
});
