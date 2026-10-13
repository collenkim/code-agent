/**
 * 작업 임대(lease.ts, FLOW-16) — 같은 작업의 상태를 두 세션(호스트)이 동시에 바꾸지 않게 한다.
 *
 * 다른 세션의 진행 명령·쓰기는 거부하고(기존 거부가 먼저), Claude SessionStart 는 같은 호스트 임대를 넘겨받으며,
 * 다른 호스트 임대는 takeover·30분 무활동으로만 넘어간다. 교차 실행 자식은 임대를 보지 않는다. 기록 실패는 막지 않는다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { status } from "../agent/commands";
import { applyConsent, consentStatus, prepareConsent } from "../agent/consent";
import { codexHook } from "../agent/codexHook";
import { decide } from "../agent/hook";
import { LEASE_FILE, LEASE_IDLE_MS, leaseDecision, leaseGuard, readLease, releaseLease, sessionStartLease, type Lease } from "../agent/lease";
import { sessionAnchor } from "../agent/sessionHook";
import { loadWork } from "../agent/work";
import { consentEvent, nativeResponse, type PreparedConsentFixture } from "./consentFixture";
import { observeConsent } from "../agent/consent";
import { createStageRepo, ORDER, removeStageRepo, repo, toCheck } from "./stageFixture";

const A = "AAAAAAAA-session", B = "BBBBBBBB-session", C = "CCCCCCCC-codex";
const MIN = 60_000;

function bash(command: string, session?: string): string | undefined {
  return decide({ cwd: repo, session_id: session, tool_name: "Bash", tool_input: { command } });
}
function writeTool(path: string, session?: string): string | undefined {
  return decide({ cwd: repo, session_id: session, tool_name: "Write", tool_input: { file_path: join(repo, path) } });
}
function leaseText(): string { return readFileSync(join(repo, LEASE_FILE), "utf8"); }
function setLease(lease: Partial<Lease>): void {
  const base: Lease = { version: 1, id: "ORD-1", target: "order", host: "claude", session: A, claimedAt: new Date().toISOString(), seenAt: new Date().toISOString() };
  writeFileSync(join(repo, LEASE_FILE), `${JSON.stringify({ ...base, ...lease }, null, 2)}\n`);
}
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

describe("leaseDecision — 진리표", () => {
  const now = Date.parse("2026-10-08T10:00:00.000Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  const lease = (over: Partial<Lease> = {}): Lease => ({ version: 1, id: "W", target: "t", host: "claude", session: "A", claimedAt: at(0), seenAt: at(0), ...over });
  const decideAt = (input: Partial<Parameters<typeof leaseDecision>[0]>) =>
    leaseDecision({ id: "W", target: "t", host: "claude", session: "A", now, ...input });

  test("위에서부터 판정한다", () => {
    assert.deepEqual(decideAt({ session: undefined, lease: lease() }), { action: "skip" }, "세션이 없으면 막지 않는다");
    assert.deepEqual(decideAt({}), { action: "claim", why: "none" });
    assert.deepEqual(decideAt({ lease: lease({ id: "X" }) }), { action: "claim", why: "other-work" });
    assert.deepEqual(decideAt({ lease: lease({ released: { at: at(0) } }) }), { action: "claim", why: "released" });
    assert.deepEqual(decideAt({ lease: lease({ seenAt: at(30_000) }) }), { action: "keep" });
    assert.deepEqual(decideAt({ lease: lease({ seenAt: at(2 * MIN) }) }), { action: "touch" });
    assert.equal(decideAt({ session: "B", lease: lease({ seenAt: at(5 * MIN) }) }).action, "deny");
    assert.deepEqual(decideAt({ session: "B", lease: lease({ seenAt: at(31 * MIN) }) }), { action: "claim", why: "idle" });
    // H4 Codex 도 세션까지 본다 — 한 대화의 hook(하위 에이전트·resume 포함)은 같은 session_id 다(codex-cli 0.161.0 실측)
    assert.deepEqual(decideAt({ host: "codex", session: "A", lease: lease({ host: "codex", seenAt: at(2 * MIN) }) }), { action: "touch" });
    assert.equal(decideAt({ host: "codex", session: "B", lease: lease({ host: "codex", seenAt: at(2 * MIN) }) }).action, "deny", "H4 Codex 두 세션");
    assert.deepEqual(decideAt({ host: "codex", session: "B", sessionStart: true, lease: lease({ host: "codex" }) }), { action: "claim", why: "session-start" });
    assert.equal(decideAt({ session: "B", lease: lease({ host: "codex" }) }).action, "deny", "다른 호스트의 신선한 임대");
    assert.deepEqual(decideAt({ session: "B", sessionStart: true, lease: lease() }), { action: "claim", why: "session-start" });
    assert.equal(decideAt({ session: "B", sessionStart: true, lease: lease({ host: "codex" }) }).action, "deny", "다른 호스트 임대는 세션 시작으로 넘어가지 않는다");
    assert.equal(LEASE_IDLE_MS, 30 * MIN);
  });
});

describe("작업 임대 — hook·SessionStart·takeover", () => {
  beforeEach(() => {
    createStageRepo("ca-lease-");
    toCheck();
  });
  afterEach(() => {
    delete process.env.CODE_AGENT_CROSS;
    removeStageRepo();
  });

  test("다른 세션의 진행 명령·쓰기는 거부하고 읽기·조회는 연다", () => {
    assert.equal(bash("code-agent next", A), undefined);
    const lease = readLease(repo)!;
    assert.equal(lease.host, "claude");
    assert.equal(lease.session, A);
    const denied = bash("code-agent next", B) ?? "";
    assert.match(denied, /code-agent takeover/);
    assert.match(denied, /Claude Code 세션 AAAAAAAA/);
    assert.match(denied, /같은 명령을 다시 실행해도 결과는 같습니다/);
    assert.equal(bash("code-agent status", B), undefined);
    assert.equal(bash("code-agent doctor --cross", B), undefined);
    assert.equal(decide({ cwd: repo, session_id: B, tool_name: "Read", tool_input: { file_path: join(repo, "doc/architecture.md") } }), undefined);
    assert.equal(writeTool(`${ORDER}/domain/Order.java`, A), undefined, "주인은 계획 파일을 쓴다");
    assert.match(writeTool(`${ORDER}/domain/Order.java`, B) ?? "", /다른 세션이 이 작업을 진행 중입니다/);
  });

  test("기존 거부가 먼저다 — 임대 문구로 바꾸지 않는다", () => {
    assert.equal(bash("code-agent next", A), undefined);
    assert.match(bash("code-agent abort", B) ?? "", /현재 세션의 ca-answer 동의 절차/);
  });

  test("Codex 세션의 진행 명령도 Claude 의 신선한 임대에 막힌다", () => {
    assert.equal(bash("code-agent next", A), undefined);
    const out = codexHook({ cwd: repo, hook_event_name: "PreToolUse", session_id: C, tool_name: "Bash", tool_input: { command: "code-agent next" } }) as
      { hookSpecificOutput?: { permissionDecisionReason?: string } };
    assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? "", /다른 세션이 이 작업을 진행 중입니다: Claude Code 세션 AAAAAAAA/);
  });

  test("H4 Codex 두 세션 — 다른 Codex 세션의 진행은 막고, 하위 에이전트(부모 session_id)는 막지 않으며, 새 세션의 SessionStart 가 넘겨받는다", () => {
    const D = "DDDDDDDD-codex";
    const codexBash = (session: string, extra: Record<string, string> = {}) => ((codexHook({ cwd: repo, hook_event_name: "PreToolUse", session_id: session,
      tool_name: "Bash", tool_input: { command: "code-agent next" }, ...extra }) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? "");
    assert.equal(codexBash(C), "");
    assert.deepEqual([readLease(repo)!.host, readLease(repo)!.session], ["codex", C]);
    assert.match(codexBash(D), /다른 세션이 이 작업을 진행 중입니다: Codex 세션 CCCCCCCC/);
    assert.equal(codexBash(C, { agent_id: "sub-1", agent_type: "ca_explorer" }), "", "하위 에이전트는 부모 세션과 같다");
    // resume 은 같은 session_id 라 그대로, 새 세션의 SessionStart 는 넘겨받는다(압축 compact 은 넘겨받지 않는다).
    // 진행 상태와 임대 줄은 Claude 와 같은 sessionAnchor 를 additionalContext 로 붙인다
    const started = (session: string, source: string): string => {
      const out = codexHook({ cwd: repo, hook_event_name: "SessionStart", session_id: session, source }) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
      assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart");
      return out.hookSpecificOutput?.additionalContext ?? "";
    };
    const resumed = started(C, "resume");
    assert.match(resumed, /^code-agent 진행 상태/);
    assert.doesNotMatch(resumed, /넘겨받았습니다|쥐고 있습니다/, "같은 세션이면 임대 줄이 없다");
    assert.equal(readLease(repo)!.session, C);
    assert.match(started(D, "compact"), /진행 기록은 다른 세션\(Codex 세션 CCCCCCCC\)이 0분 전까지 쥐고 있습니다/);
    assert.equal(readLease(repo)!.session, C);
    assert.match(started(D, "startup"), /이 세션이 작업 진행 기록을 넘겨받았습니다\(이전: Codex 세션 CCCCCCCC/);
    assert.deepEqual([readLease(repo)!.session, readLease(repo)!.previous?.why], [D, "session-start"]);
    // 이미 쥔 임대를 1분 뒤 압축·재개에서 갱신(touch)할 때는 넘겨받았다는 줄을 다시 붙이지 않는다(previous 는 남는다)
    for (const source of ["compact", "resume"]) {
      setLease({ ...readLease(repo)!, seenAt: ago(2 * MIN) });
      assert.doesNotMatch(started(D, source), /넘겨받았습니다/, source);
      assert.deepEqual([readLease(repo)!.session, readLease(repo)!.previous?.session], [D, C], source);
      assert.ok(Date.now() - Date.parse(readLease(repo)!.seenAt) < MIN, `${source}: 갱신은 했다`);
    }
    assert.match(codexBash(C), /다른 세션이 이 작업을 진행 중입니다: Codex 세션 DDDDDDDD/, "아직 열린 이전 세션은 다음 진행 명령이 거부된다");
    // 다른 호스트(Claude)의 신선한 임대는 Codex 세션 시작으로 넘어가지 않는다
    assert.equal(bash("code-agent next", A) !== undefined, true);
    setLease({ host: "claude", session: A });
    codexHook({ cwd: repo, hook_event_name: "SessionStart", session_id: C, source: "startup" });
    assert.deepEqual([readLease(repo)!.host, readLease(repo)!.session], ["claude", A]);
  });

  test("takeover 는 released 만 남기고 다음 진행 세션이 이어받는다", () => {
    assert.equal(bash("code-agent next", A), undefined);
    assert.match(status(repo), /진행 세션: Claude Code 세션 AAAAAAAA · 마지막 활동 0분 전/);
    assert.equal(bash("code-agent takeover", B), undefined, "takeover 는 임대를 보지 않는다");
    assert.match(releaseLease(repo), /진행 세션 기록을 풀었습니다: Claude Code 세션 AAAAAAAA/);
    assert.ok(readLease(repo)!.released);
    assert.ok(existsSync(join(repo, LEASE_FILE)), "파일은 지우지 않는다");
    assert.equal(existsSync(join(repo, ".code-agent/log/lease.jsonl")), false, "별도 로그를 남기지 않는다");
    assert.match(status(repo), /진행 세션: 없음 — Claude Code 세션 AAAAAAAA 의 기록을 0분 전에 풀었습니다/);
    assert.equal(bash("code-agent next", B), undefined);
    const lease = readLease(repo)!;
    assert.equal(lease.session, B);
    assert.equal(lease.previous?.why, "takeover");
    assert.equal(lease.previous?.session, A);
    assert.match(status(repo), /진행 세션: Claude Code 세션 BBBBBBBB/);
    assert.match(releaseLease(repo), /진행 세션 기록을 풀었습니다/);
    assert.match(releaseLease(repo), /진행 세션 기록이 없습니다/);
  });

  test("compact 는 다른 세션의 임대를 넘겨받지 않는다 — 새로 연 세션의 임대를 이전 세션이 압축만으로 되찾지 못한다", () => {
    assert.equal(bash("code-agent next", A), undefined);
    assert.match(sessionAnchor(repo, "startup", B), /넘겨받았습니다\(이전: Claude Code 세션 AAAAAAAA/);
    assert.match(bash("code-agent next", A) ?? "", /다른 세션이 이 작업을 진행 중입니다/);
    const before = leaseText();
    const anchor = sessionAnchor(repo, "compact", A);
    assert.doesNotMatch(anchor, /넘겨받았습니다/);
    assert.match(anchor, /- 이 작업의 진행 기록은 다른 세션\(Claude Code 세션 BBBBBBBB\)이 0분 전까지 쥐고 있습니다 — 대화 압축은 진행 기록을 넘겨받지 않으므로 이 세션의 진행 명령은 거부됩니다\./);
    assert.equal(leaseText(), before, "임대는 그대로 B 다");
    assert.match(bash("code-agent next", A) ?? "", /다른 세션이 이 작업을 진행 중입니다/, "압축된 이전 세션은 여전히 거부된다");
    assert.equal(bash("code-agent next", B), undefined, "사용자가 지금 쓰는 세션은 계속 진행한다");
    // 같은 세션의 압축은 넘겨받기 줄 없이 그대로 잇는다. 저쪽이 30분 넘게 쉬었으면 무활동 규칙대로 잡고 알린다
    assert.equal(sessionStartLease(loadWork(repo)!, B, "compact"), undefined);
    setLease({ session: B, seenAt: ago(31 * MIN) });
    assert.match(sessionStartLease(loadWork(repo)!, A, "compact") ?? "", /넘겨받았습니다\(이전: Claude Code 세션 BBBBBBBB, 마지막 활동 31분 전\)/);
    assert.equal(readLease(repo)!.session, A);
    assert.equal(readLease(repo)!.previous?.why, "idle");
  });

  test("Claude SessionStart 는 압축 말고는 source 와 무관하게 같은 호스트 임대를 넘겨받는다", () => {
    assert.equal(bash("code-agent next", A), undefined);
    assert.match(sessionAnchor(repo, "clear", B), /이 세션이 작업 진행 기록을 넘겨받았습니다\(이전: Claude Code 세션 AAAAAAAA/);
    assert.equal(readLease(repo)!.session, B);
    // 재시작(startup)도 같다 — 새 세션은 거부·takeover 왕복 없이 진행하고 이전 세션은 거부된다
    assert.match(sessionAnchor(repo, "startup", A), /넘겨받았습니다\(이전: Claude Code 세션 BBBBBBBB/);
    assert.equal(bash("code-agent next", A), undefined);
    assert.match(bash("code-agent next", B) ?? "", /다른 세션이 이 작업을 진행 중입니다/);
    // 같은 세션의 압축은 임대를 바꾸지 않고 줄도 없다
    const before = leaseText();
    assert.doesNotMatch(sessionAnchor(repo, "compact", A), /넘겨받았습니다/);
    assert.equal(leaseText(), before);
    // 다른 호스트(Codex)의 신선한 임대는 넘겨받지 않는다
    setLease({ host: "codex", session: C });
    const codexLease = leaseText();
    assert.match(sessionAnchor(repo, "startup", B), /다른 호스트 세션\(Codex CCCCCCCC\)/);
    assert.equal(leaseText(), codexLease);
    // 30분이 지난 다른 호스트 임대는 무활동으로 넘어간다
    setLease({ host: "codex", session: C, seenAt: ago(31 * MIN) });
    assert.equal(bash("code-agent next", B), undefined);
    assert.equal(readLease(repo)!.previous?.why, "idle");
  });

  test("임대 잠금을 살아 있는 주인이 쥐고 있으면 쓰지 않고 처음 판정만 한다", () => {
    setLease({ session: A, seenAt: ago(2 * MIN) });
    const before = leaseText();
    writeFileSync(join(repo, `${LEASE_FILE}.lock`), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce: "x" }));
    const work = loadWork(repo)!;
    assert.match(leaseGuard(work, "claude", B, Date.now(), 50) ?? "", /다른 세션이 이 작업을 진행 중입니다/);
    assert.equal(leaseGuard(work, "claude", A, Date.now(), 50), undefined, "touch 를 못 해도 막지 않는다");
    assert.equal(leaseText(), before);
    rmSync(join(repo, `${LEASE_FILE}.lock`));
  });

  test("임대 기록이 실패해도 도구를 막지 않고, 다음 호출이 다시 claim 한다", () => {
    mkdirSync(join(repo, LEASE_FILE), { recursive: true });
    assert.equal(bash("code-agent next", A), undefined);
    assert.equal(bash("code-agent next", B), undefined, "기록하지 못한 claim 은 다음 호출이 다시 한다");
    rmSync(join(repo, LEASE_FILE), { recursive: true, force: true });
    assert.equal(bash("code-agent next", A), undefined);
    assert.equal(readLease(repo)?.session, A);
  });

  test("교차 실행 자식은 임대를 읽지도 쓰지도 않고 진행 명령·쓰기를 거부한다", () => {
    setLease({ session: B, seenAt: ago(2 * MIN) });
    const before = leaseText();
    process.env.CODE_AGENT_CROSS = "codex";
    const pre = (tool: string, input: Record<string, string>) => (codexHook({ cwd: repo, hook_event_name: "PreToolUse", session_id: C, tool_name: tool, tool_input: input }) as
      { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason;
    assert.match(pre("Bash", { command: "code-agent check" }) ?? "", /교차 실행\(CODE_AGENT_CROSS\) 안에서는/);
    assert.equal(pre("Bash", { command: "code-agent read src/value.js" }), undefined);
    assert.match(pre("apply_patch", { command: `*** Begin Patch\n*** Update File: ${ORDER}/domain/Order.java\n*** End Patch` }) ?? "", /교차 실행\(CODE_AGENT_CROSS\) 안에서는/);
    assert.equal(sessionStartLease(loadWork(repo)!, A), undefined);
    assert.match(leaseGuard(loadWork(repo)!, "codex", C) ?? "", /교차 실행\(CODE_AGENT_CROSS\) 안에서는/);
    assert.equal(leaseText(), before, "lease.json 바이트 불변");
    delete process.env.CODE_AGENT_CROSS;
  });

  test("임대로 거부된 동의 준비 명령에는 티켓이 생기지 않는다", () => {
    assert.equal(bash("code-agent next", A), undefined);
    const tickets = join(repo, ".code-agent/consents/tickets");
    const before = existsSync(tickets) ? readdirSync(tickets) : [];
    assert.match(bash("code-agent consent prepare x.json", B) ?? "", /다른 세션이 이 작업을 진행 중입니다/);
    assert.deepEqual(existsSync(tickets) ? readdirSync(tickets) : [], before);
  });

  test("응답을 기다리는 동의는 임대 touch·해제에 깨지지 않는다(스냅샷 제외)", () => {
    const run = (release: boolean) => {
      const prepared = JSON.parse(prepareConsent(repo, { action: "abort" }));
      const fixture: PreparedConsentFixture = { root: repo, ...prepared, sessionId: A, toolUseId: `tool-${release}` };
      observeConsent(consentEvent(fixture, "PreToolUse"));
      observeConsent(consentEvent(fixture, "PostToolUse", { tool_response: nativeResponse(fixture) }));
      assert.equal(JSON.parse(consentStatus(repo, fixture.id)).status, "approved");
      if (release) releaseLease(repo);
      else {
        setLease({ session: A, seenAt: ago(2 * MIN) });
        const seen = readLease(repo)!.seenAt;
        assert.equal(bash(`code-agent consent finish ${fixture.id}`, A), undefined);
        assert.notEqual(readLease(repo)!.seenAt, seen, "같은 세션의 적용 명령이 임대를 touch 했다");
      }
      applyConsent(repo, fixture.id, { sessionId: A });
      assert.equal(JSON.parse(consentStatus(repo, fixture.id)).status, "applied");
    };
    run(false);
    // abort 로 작업이 끝났다 — 다시 세워 해제 경우를 본다
    removeStageRepo();
    createStageRepo("ca-lease-");
    toCheck();
    assert.equal(bash("code-agent next", A), undefined);
    run(true);
  });
});
