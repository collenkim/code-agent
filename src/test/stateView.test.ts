/**
 * 기계 판독용 상태 조회(stateView.ts, `code-agent status --json`) — 읽기 전용이고, 기존 판정을 고정 코드로 낸다.
 * 승인 변경·실행 소유권 충돌·관측 불가·오래된 재개 요청을 구분하고, 조회 전후로 승인·작업·재시도 카운터가 그대로다.
 * 두 호스트의 hook 이 조회를 임대 밖 읽기로, 발견 보고를 임대 안 쓰기로 다룬다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { requireValidatable, status } from "../agent/commands";
import { codexHook } from "../agent/codexHook";
import { decide } from "../agent/hook";
import { hostAssets } from "../agent/hosts";
import { ACTIVE_FILE, loadActive, saveActive } from "../agent/layout";
import { LEASE_FILE, type Lease } from "../agent/lease";
import { retrySummary } from "../agent/retryPolicy";
import { stateView } from "../agent/stateView";
import { publishNativeInteraction } from "../agent/interactionNative";
import { mutateInteractions } from "../agent/interactions";
import { check } from "../agent/validate";
import { approvalOf, loadWork } from "../agent/work";
import { start } from "./confirmedStart";
import { createStageRepo, removeStageRepo, repo, toCheck, write } from "./stageFixture";

const CLI = join(__dirname, "../agent/cli.js");
const A = "AAAAAAAA-session", B = "BBBBBBBB-session";
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function cli(...args: string[]): { code: number | null; out: string } {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
  return { code: run.status, out: run.stdout };
}
function setLease(over: Partial<Lease> = {}): void {
  const lease: Lease = { version: 1, id: "ORD-1", target: "order", host: "claude", session: A, claimedAt: ago(0), seenAt: ago(0), ...over };
  writeFileSync(join(repo, LEASE_FILE), `${JSON.stringify(lease, null, 2)}\n`);
}
/** .git 밖 모든 파일의 내용 해시와 수정 시각 */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(full);
      else out[relative(repo, full).replace(/\\/g, "/")] = `${createHash("sha256").update(readFileSync(full)).digest("hex")}@${statSync(full).mtimeMs}`;
    }
  };
  walk(repo);
  return out;
}
function counters(): string {
  const work = loadWork(repo)!;
  const read = (path: string) => { try { return JSON.parse(readFileSync(join(repo, path), "utf8")); } catch { return undefined; } };
  return JSON.stringify({ approval: approvalOf(work).status, active: loadActive(repo), retry: retrySummary({ evidence: read(".code-agent/work/ORD-1/order.verify.json") }) });
}

beforeEach(() => createStageRepo("ca-state-"));
afterEach(() => removeStageRepo());

describe("읽기 전용 — 조회 전후로 파일·승인·커서·재시도 카운터가 그대로다", () => {
  test("임대·열린 동의·발견·증거가 있는 작업에서 함수와 CLI 로 여러 번 조회해도 아무것도 쓰지 않는다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    setLease({ session: B, seenAt: ago(5 * MIN) });
    const consent = randomUUID();
    write(".code-agent/consents/index.json", JSON.stringify({ version: 1, open: { [consent]: { action: "plan", status: "pending", createdAt: ago(MIN) } }, recent: {} }));
    write(".code-agent/work/ORD-1/findings.json", JSON.stringify({ version: 1, id: "ORD-1", findings: [] }));
    const files = snapshot(), state = counters();
    const first = stateView(repo);
    for (const args of [["status", "--json"], ["status", "--json", "--expect-state", "sha256:old"], ["status", "--json", "--session", B, "--run-id", "master-7"]]) cli(...args);
    assert.deepEqual(snapshot(), files);
    assert.equal(counters(), state);
    assert.equal(stateView(repo).stateVersion, first.stateVersion, "같은 상태면 같은 판본");
    assert.equal(first.schema, "code-agent.state");
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.ownership.process, "unverified");
    assert.match(first.unknown[0], /OS 프로세스 생존·실제 종료는 확인하지 않는다\(실행 러너의 책임\)/);
  });
});

describe("재개 코드 — 기존 판정을 고정 코드로", () => {
  test("3-3 영속 질문은 임대·실행 대기보다 먼저 보이고 관측 불가를 덮지 않는다", () => {
    toCheck(); setLease({ session: A });
    const question = publishNativeInteraction(repo, [{ title: "범위를 정할까요?", options: ["유지", "확장"] }], { sessionId: A, host: "claude" });
    const view = stateView(repo);
    assert.equal(view.resume.code, "needs-human");
    assert.equal(view.resume.next.action, "human-input");
    assert.ok(view.resume.reasons.some(reason => reason.code === "lease-held"));
    assert.ok(view.interactions!.pending.includes(question.requestId));
    assert.match(status(repo), /다음: 사람 응답 대기/);
    assert.match(decide({ cwd: repo, session_id: B, tool_name: "Bash", tool_input: { command: "code-agent next" } }) ?? "", /다른 세션/);
    writeFileSync(join(repo, LEASE_FILE), "{broken");
    assert.equal(stateView(repo).resume.code, "unobservable");
  });
  test("작업이 없으면 no-work, check 의 증거·한도·묶임은 사실로 낸다", async () => {
    assert.equal(stateView(repo).resume.code, "no-work");
    toCheck();
    await check(requireValidatable(repo, "check"));
    const view = stateView(repo);
    assert.equal(view.resume.code, "ready");
    assert.deepEqual(view.resume.next.action, "verify");
    assert.deepEqual(view.attempt, { id: "verify:r1:1", kind: "verify" });
    assert.deepEqual(view.verification, { rounds: 1, bound: { valid: true, problems: [] }, phases: { check: { round: 1, runs: 1, passed: true } } });
    assert.deepEqual(view.retry?.budgets?.fix, { used: 0, limit: 2, left: 2, exhausted: false });
    assert.equal(view.repo.uncommitted.known, true);
    assert.ok((view.repo.uncommitted.count ?? 0) > 0, "계획 파일이 아직 커밋되지 않았다");
  });

  test("승인 변경 — 근거 문서가 바뀌면 reapproval-required, 검증 묶임도 어긋난 항목을 코드로 낸다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    write("doc/architecture.md", `${readFileSync(join(repo, "doc/architecture.md"), "utf8")}\n- 새 규칙\n`);
    const view = stateView(repo);
    assert.equal(view.approval?.status, "stale-docs");
    assert.equal(view.resume.code, "reapproval-required");
    assert.deepEqual(view.resume.reasons.map((reason) => reason.code), ["approval-stale-docs"]);
    write("src/main/java/com/acme/app/application/order/domain/Order.java", "class Order { int fixed; }\n");
    assert.deepEqual(stateView(repo).verification?.bound, { valid: false, problems: ["tree"] });
  });

  test("승인 변경 — 낡은 계획 작업이 있으면 replan-required 와 되감을 단계", () => {
    toCheck();
    saveActive(repo, { ...loadActive(repo)!, planningVersion: 1 });
    write(".code-agent/work/ORD-1/order.planning.json", JSON.stringify({ version: 1, id: "ORD-1", target: "order", maxParallel: 3, agents: [],
      tasks: [{ task: { id: "analysis", role: "analysis", inputs: ["doc/work/ORD-1.md"], outputs: ["doc/work/ORD-1/01-requirements.md"], dependsOn: [], scopes: [], requirements: [] },
        attempts: [{ dispatchId: randomUUID(), inputHash: "old", at: ago(MIN), status: "completed" }] }] }));
    const view = stateView(repo);
    assert.equal(view.resume.code, "replan-required");
    assert.equal(view.approval?.staleFrom, "analysis");
  });

  test("실행 소유권 — 다른 세션의 신선한 임대는 ownership-conflict, 자기 세션이면 아니고, 30분 쉰 임대는 기존 규칙대로 넘겨받을 수 있다", () => {
    toCheck();
    setLease({ session: A, seenAt: ago(5 * MIN) });
    const view = stateView(repo);
    assert.equal(view.resume.code, "ownership-conflict");
    assert.equal(view.ownership.lease.state, "held");
    assert.match(view.resume.reasons[0].detail, /그 실행이 끝났는지는 러너가 확인합니다/);
    assert.equal(stateView(repo, { session: A }).resume.code, "ready");
    setLease({ session: A, seenAt: ago(31 * MIN) });
    const idle = stateView(repo);
    assert.equal(idle.resume.code, "ready");
    assert.ok(idle.resume.reasons.some((reason) => reason.code === "lease-idle"));
  });

  test("관측 불가 — 깨진 커서·지원하지 않는 버전·깨진 임대·손상된 승인 원장은 unobservable 이고 파일을 고치지 않는다", () => {
    toCheck();
    const ledgerPath = join(repo, ".code-agent/approvals/ORD-1.jsonl");
    const ledger = readFileSync(ledgerPath, "utf8");
    writeFileSync(ledgerPath, `${ledger}{ 깨진 줄\n`);
    let view = stateView(repo);
    assert.equal(view.resume.code, "unobservable");
    assert.ok(view.resume.reasons.some((reason) => reason.code === "approval-unreadable"));
    assert.equal(readFileSync(ledgerPath, "utf8"), `${ledger}{ 깨진 줄\n`);
    writeFileSync(ledgerPath, ledger);

    writeFileSync(join(repo, LEASE_FILE), "{ 깨짐");
    assert.equal(stateView(repo).resume.code, "unobservable");
    assert.equal(readFileSync(join(repo, LEASE_FILE), "utf8"), "{ 깨짐");
    writeFileSync(join(repo, LEASE_FILE), "");

    const active = readFileSync(join(repo, ACTIVE_FILE), "utf8");
    writeFileSync(join(repo, ACTIVE_FILE), JSON.stringify({ ...JSON.parse(active), planningVersion: 2 }));
    view = stateView(repo);
    assert.deepEqual([view.resume.code, view.resume.reasons[0].code], ["unobservable", "unsupported-version"]);
    writeFileSync(join(repo, ACTIVE_FILE), "{ 깨짐");
    view = stateView(repo);
    assert.deepEqual([view.resume.code, view.resume.reasons[0].code], ["unobservable", "active-unreadable"]);
    assert.equal(readFileSync(join(repo, ACTIVE_FILE), "utf8"), "{ 깨짐", "손상된 상태를 새 상태로 덮지 않는다");
    assert.equal(cli("status", "--json").code, 0);
  });

  test("동의 적용이 잠금 없이 applying 이면 끝났다고도 실패했다고도 하지 않고 unobservable — 다시 적용하지 않는다", () => {
    toCheck();
    const index = JSON.stringify({ version: 1, open: { [randomUUID()]: { action: "deliver", status: "applying", createdAt: ago(MIN) } }, recent: {} });
    write(".code-agent/consents/index.json", index);
    const view = stateView(repo);
    assert.deepEqual([view.resume.code, view.resume.next.action, view.resume.reasons[0].code], ["unobservable", "inspect", "consent-apply-interrupted"]);
    assert.match(view.resume.reasons[0].detail, /git status·증거로 확인해야 합니다/);
    assert.equal(readFileSync(join(repo, ".code-agent/consents/index.json"), "utf8"), index);
  });

  test("대기·사람 판단 — 실행 중으로 기록된 배정은 wait, 기한을 넘긴 배정은 기존 흐름에 넘기고, 열린 질문은 needs-human", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"), { planning: true });
    const planning = (at: string) => write(".code-agent/work/ORD-1/order.planning.json", JSON.stringify({ version: 1, id: "ORD-1", target: "order", maxParallel: 3, agents: [],
      tasks: [{ task: { id: "analysis", role: "analysis" }, attempts: [{ dispatchId: "d-1", inputHash: "h", at, status: "running" }] }] }));
    planning(ago(MIN));
    let view = stateView(repo);
    assert.deepEqual([view.resume.code, view.resume.reasons[0].code, view.attempt?.id], ["wait", "attempt-running", "analysis:analysis:d-1"]);
    const pending = publishNativeInteraction(repo, [{ title: "조사 범위를 정할까요?", options: ["유지", "확장"] }], { sessionId: A, host: "claude" });
    view = stateView(repo);
    assert.equal(view.resume.next.action, "human-input");
    assert.ok(view.resume.reasons.some(reason => reason.code === "attempt-running"));
    mutateInteractions(repo, ledger => { ledger.requests[pending.requestId].status = "cancelled"; });
    planning(ago(15 * MIN));
    view = stateView(repo);
    assert.equal(view.resume.code, "ready");
    assert.ok(view.resume.reasons.some((reason) => reason.code === "attempt-suspect"));
    write("doc/work/ORD-1/questions.md", "## Q1 범위\n어디까지?\n[Answer]:\n");
    view = stateView(repo);
    assert.deepEqual([view.resume.code, view.resume.next.by, view.questions?.unanswered], ["needs-human", "human", ["Q1"]]);
  });
});

describe("오래된 재개 요청 — 조회 뒤 실행 전에 바뀐 상태를 가린다", () => {
  test("기대 상태·작업·시도가 지금과 다르면 stale-request(종료 코드 3), 같으면 그대로다", async () => {
    toCheck();
    const seen = stateView(repo);
    assert.deepEqual(stateView(repo, { expectState: seen.stateVersion, expectWork: "ORD-1", expectAttempt: seen.attempt!.id }).expect, {
      state: seen.stateVersion, work: "ORD-1", attempt: seen.attempt!.id, matches: true, mismatches: [] });
    await check(requireValidatable(repo, "check"));
    const later = stateView(repo, { expectState: seen.stateVersion, expectAttempt: seen.attempt!.id });
    assert.equal(later.resume.code, "stale-request");
    assert.equal(later.resume.observed, "ready");
    assert.deepEqual(later.expect?.mismatches.map((item) => item.split(":")[0]), ["attempt", "state"]);
    assert.equal(stateView(repo, { expectWork: "ORD-2" }).resume.code, "stale-request");
    const run = cli("status", "--json", "--expect-state", seen.stateVersion);
    assert.equal(run.code, 3);
    assert.equal(JSON.parse(run.out).resume.code, "stale-request");
    assert.equal(cli("status", "--json", "--expect-state", stateView(repo).stateVersion).code, 0);
  });

  test("외부 실행 ID 는 상관관계로 되돌려 줄 뿐 판정·판본에 들어가지 않는다", () => {
    toCheck();
    const plain = stateView(repo), tagged = stateView(repo, { runId: "master-run-42" });
    assert.deepEqual(tagged.correlation, { runId: "master-run-42" });
    assert.equal(tagged.stateVersion, plain.stateVersion);
    assert.equal(tagged.resume.code, plain.resume.code);
  });
});

describe("호환 — 기존 작업·두 호스트", () => {
  test("발견·경험이 없는 옛 작업의 사람용 status 는 줄이 늘지 않고, --json 없는 옵션은 사용법이다", () => {
    toCheck();
    assert.doesNotMatch(status(repo), /^(발견|작업 경험):/m);
    assert.equal(stateView(repo).planning, null);
    const run = spawnSync(process.execPath, [CLI, "status", "--expect-state", "x"], { cwd: repo, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr + run.stdout, /대조·식별 옵션은 --json 과 함께 씁니다/);
  });

  test("두 호스트 hook — 조회·목록은 다른 세션이 진행 중이어도 열고, 발견 보고·경험 기록은 임대를 본다", () => {
    toCheck();
    setLease({ session: A, seenAt: ago(MIN) });
    const claude = (command: string) => decide({ cwd: repo, session_id: B, tool_name: "Bash", tool_input: { command } });
    const codex = (command: string) => ((codexHook({ cwd: repo, hook_event_name: "PreToolUse", session_id: B, tool_name: "Bash", tool_input: { command } }) as
      { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? "");
    for (const command of ["code-agent status --json", "code-agent status --json --expect-state sha256:abc --expect-work ORD-1 --run-id r-1",
      "code-agent experience list --all", "code-agent experience show EXP-ORD-1-1", "code-agent finding list --json --work ORD-1"]) {
      assert.equal(claude(command), undefined, command);
      assert.equal(codex(command), "", command);
    }
    for (const command of ["code-agent finding report doc/work/ORD-1/finding.draft.json", "code-agent experience add doc/work/ORD-1/experience.draft.json"]) {
      assert.match(claude(command) ?? "", /다른 세션이 이 작업을 진행 중입니다/, command);
      assert.match(codex(command), /다른 세션이 이 작업을 진행 중입니다/, command);
    }
  });

  test("두 호스트 템플릿이 발견 보고·작업 경험을 같은 명령으로 안내한다", () => {
    const codex = hostAssets("codex");
    const claude = (path: string) => readFileSync(join(__dirname, "../../template/claude/skills", path), "utf8");
    for (const text of [claude("ca-check/SKILL.md"), codex.get(".agents/skills/ca-check/SKILL.md")!]) {
      assert.match(text, /`code-agent finding report doc\/work\/<ID>\/finding\.draft\.json`/);
      assert.match(text, /보고는 권한이 아니다/);
    }
    for (const text of [claude("ca-integrate/SKILL.md"), codex.get(".agents/skills/ca-integrate/SKILL.md")!]) {
      assert.match(text, /작업 경험\(선택\)[^\n]*`code-agent experience add doc\/work\/<ID>\/experience\.draft\.json`/);
    }
  });
});
