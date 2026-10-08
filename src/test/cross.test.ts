import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { crossFlags, crossInvocation, crossInvocationArgs, crossSandboxSuspect, crossSectionText, normalizeCrossBody } from "../agent/crossCheck";
import {
  attemptLabel, crossAttemptsOf, crossStopStreak, effectiveReviewer, findingDetailHash, legacyPlanningAttempts, orphanView, planningCrossAttemptsOf,
  planningCrossView, pointHost, pointLabel, reviewersOf, reviewerState, reviewResultProblems, stopBody, syncLegacyPlanning, syncLegacyRound, waiveVerdict,
  type CrossAttempt, type PlanningCrossAttempt, type ReviewerRun,
} from "../agent/crossRecord";
import type { PlanningState } from "../agent/planningState";
import { classifyCrossFailure, crossPointDecision, crossPointState, guidance, recordedVariant, TIMING } from "../agent/retryPolicy";
import { renderRoundsBlock, staleWaiver, waived, type Finding, type ReviewLog, type ReviewRound } from "../agent/review";
import { deadPid } from "./deadPid";

const F = /^F\d+$/, X = /^X\d+$/;
const PLANNED = ["src/a.ts", "src/b.ts"];
const round = (extra: Partial<ReviewRound> = {}): ReviewRound => ({ round: 1, at: "2026-10-07T00:00:00.000Z", treeHash: "sha256:t1", baseCommit: "b", planHash: "p", manifestHash: "m", ...extra });
const ended = (n: number, cls: CrossAttempt["class"], extra: Partial<CrossAttempt> = {}): CrossAttempt =>
  ({ n, host: "codex", mode: "review", startedAt: "2026-10-07T00:00:00.000Z", endedAt: "2026-10-07T00:01:00.000Z", class: cls, ...extra });

// ---- 리뷰 결과 표 규칙 ----

test("reviewResultProblems — 표 모양·id·다섯 칸·중복·상태·경로·범위를 기록 전에 본다", () => {
  assert.deepEqual(reviewResultProblems("- 없음", PLANNED, F), []);
  const header = "| id | 계획 파일 | 범위 | 상태 | 지적 |\n|---|---|---|---|---|";
  assert.deepEqual(reviewResultProblems(`${header}\n| F1 | src/a.ts | 계획 안 | 열림 | 근거 src/a.ts:3 |`, PLANNED, F), []);
  assert.deepEqual(reviewResultProblems("검토 완료", PLANNED, F), ["지적 표 또는 '- 없음' 이 아닙니다"]);
  assert.deepEqual(reviewResultProblems("| X1 | src/a.ts | 계획 안 | 열림 | x |", PLANNED, F), ["지적 표 또는 '- 없음' 이 아닙니다"], "다른 출처의 id 만 있는 표");
  const three = reviewResultProblems("| F1 | src/x.ts:12 | 계획 안 | 열림(경미) | x |", PLANNED, F);
  assert.equal(three.length, 3);
  assert.match(three.join("\n"), /F1 상태 칸은 열림 · 해결 둘뿐입니다\(열림\(경미\)\)/);
  assert.match(three.join("\n"), /F1 계획 파일 칸은 저장소 기준 경로만 씁니다\(src\/x\.ts:12\)/);
  assert.match(three.join("\n"), /F1 범위 칸이 계획과 다릅니다\(계획 안 → 계획 밖\)/);
  assert.match(reviewResultProblems("| F1 | `src/a.ts` | 계획 밖 | 열림 | x |", PLANNED, F).join("\n"), /계획 파일 칸은 저장소 기준 경로만/);
  assert.deepEqual(reviewResultProblems("| F1 | src/a.ts | 계획 안 | 열림 |", PLANNED, F), ["F1 줄은 id · 계획 파일 · 범위 · 상태 · 지적 다섯 칸입니다"]);
  assert.match(reviewResultProblems("| F1 | src/a.ts | 계획 안 | 열림 | x |\n| 1 | src/b.ts | 계획 안 | 열림 | y |", PLANNED, F).join("\n"), /표의 줄은 지적 id\(F<번호>\)로 시작합니다: 1/);
  assert.match(reviewResultProblems("| F1 | src/a.ts | 계획 안 | 열림 | x |\n| F1 | src/b.ts | 계획 안 | 열림 | y |", PLANNED, F).join("\n"), /F1 가 여러 줄입니다/);
  assert.match(reviewResultProblems("| X1 | src/other.ts | 계획 안 | 열림 | x |", PLANNED, X).join("\n"), /X1 범위 칸이 계획과 다릅니다\(계획 안 → 계획 밖\)/);
  assert.deepEqual(reviewResultProblems("| X1 | src/other.ts | 계획 밖 | 해결 | x |", PLANNED, X), []);
});

test("waiveVerdict — 게이트를 막는 지적만 기각할 수 있고, 종류는 상태·범위로 정한다", () => {
  assert.equal(waiveVerdict({ status: "미해결", written: "계획 안", scope: "계획 안" }), "형식 문제 기각");
  assert.equal(waiveVerdict({ status: "열림", written: "계획 안", scope: "계획 밖" }), "형식 문제 기각");
  assert.equal(waiveVerdict({ status: "열림", written: "계획 밖", scope: "계획 밖" }), "범위 밖 확인");
  assert.equal(waiveVerdict({ status: "해결", written: "계획 밖", scope: "계획 밖" }), "범위 밖 확인");
  assert.equal(waiveVerdict({ status: "열림", written: "계획 안", scope: "계획 안" }), "기각");
  assert.equal(waiveVerdict({ status: "해결", written: "계획 안", scope: "계획 안" }), undefined);
});

test("waived·staleWaiver — 기각은 기록한 회차에만, 다음 회차는 범위·지적 내용까지 같을 때만 이어진다", () => {
  const finding = (extra: Partial<Finding> = {}): Finding => ({ id: "X1", path: "src/a.ts", written: "계획 안", scope: "계획 안", status: "열림", detail: "경계값 누락", ...extra });
  const log: ReviewLog = { id: "W", target: "t", rounds: [round()], waivers: [{ source: "cross", id: "X1", path: "src/a.ts", scope: "계획 안", verdict: "기각",
    detailHash: findingDetailHash("경계값 누락"), detail: "경계값 누락", round: 1, reason: "범위 밖", consent: "c-1", at: "2026-10-07T00:00:00.000Z" }] };
  assert.equal(waived(log, finding(), 1), true);
  assert.equal(waived(log, finding({ detail: "  경계값   누락 " }), 2), true, "공백만 다르면 이어진다");
  assert.equal(waived(log, finding({ detail: "오류 메시지 오타" }), 2), false);
  assert.equal(staleWaiver(log, finding({ detail: "오류 메시지 오타" }), 2)?.round, 1);
  assert.equal(waived(log, finding({ path: "src/b.ts" }), 2), false);
  assert.equal(staleWaiver(log, finding({ path: "src/b.ts" }), 2), undefined, "다른 경로는 다른 지적이다");
  assert.equal(waived(log, finding({ id: "F1" }), 1), false, "출처(F·X)가 다르면 적용하지 않는다");
});

// ---- 옛 기록 추정 ----

test("옛 reviewer·cross 필드는 읽을 때 배열로 추정한다 — 판정은 배열만 본다", () => {
  const completed = round({ reviewer: { sessionId: "s", agentId: "a", startedAt: "2026-10-07T00:00:00.000Z", completedAt: "2026-10-07T00:01:00.000Z", result: "- 없음" } });
  assert.equal(reviewersOf(completed).length, 1);
  assert.equal(effectiveReviewer(completed, PLANNED)?.agentId, "a");
  // 옛 완료 결과가 새 표 규칙에 걸리면 유효 결과가 아니다 — 호출 1회로 세고 다시 부를 수 있다
  const legacyBad = round({ reviewer: { sessionId: "s", agentId: "a", startedAt: "2026-10-07T00:00:00.000Z", completedAt: "2026-10-07T00:01:00.000Z", result: "| F1 | src/a.ts | 계획 안 | 미해결 | x |" } });
  assert.equal(effectiveReviewer(legacyBad, PLANNED), undefined);
  const state = reviewerState(legacyBad, PLANNED);
  assert.deepEqual([state.runs, state.failures], [1, 1]);
  assert.match(state.invalid!.join("\n"), /상태 칸/);

  const unavailable = crossAttemptsOf(round({ cross: { host: "codex", model: "", startedAt: "2026-10-07T00:00:00.000Z", unavailable: "spend cap" } }), PLANNED);
  assert.deepEqual(unavailable.map((attempt) => [attempt.n, attempt.class, attempt.detail]), [[1, "cross-unavailable", "spend cap"]]);
  assert.equal(crossPointState(unavailable).state, "stopped");
  const done = crossAttemptsOf(round({ cross: { host: "codex", model: "m", startedAt: "2026-10-07T00:00:00.000Z", completedAt: "2026-10-07T00:01:00.000Z", result: "- 없음" } }), PLANNED);
  assert.equal(crossPointState(done).state, "completed");
  const shape = crossAttemptsOf(round({ cross: { host: "codex", model: "m", startedAt: "2026-10-07T00:00:00.000Z", error: "결과가 지적 표 또는 '- 없음' 이 아닙니다" } }), PLANNED);
  assert.deepEqual([shape[0].class, shape[0].rawPath], ["cross-result-invalid", undefined]);
  assert.equal(crossPointDecision({ attempts: shape, scope: "round:1" }).action, "run", "원문이 없는 옛 형식 오류는 처음부터 다시 실행한다");
  const config = crossAttemptsOf(round({ cross: { host: "codex", model: "m", startedAt: "2026-10-07T00:00:00.000Z", error: "종료 코드 2 — unexpected argument" } }), PLANNED);
  assert.deepEqual([config[0].class, config[0].kind], ["cross-config-error", "unclassified"]);
  const mislabeled = crossAttemptsOf(round({ cross: { host: "codex", model: "m", startedAt: "2026-10-07T00:00:00.000Z", completedAt: "2026-10-07T00:01:00.000Z", result: "| X1 | src/zz.ts | 계획 안 | 열림 | x |" } }), PLANNED);
  assert.deepEqual([mislabeled[0].class, mislabeled[0].kind, mislabeled[0].result], ["cross-result-invalid", "content", "| X1 | src/zz.ts | 계획 안 | 열림 | x |"],
    "표 규칙에 걸린 옛 완료 결과는 원문을 남긴다 — 교차 명령이 handoff 로 옮겨 형식만 교정한다");
  assert.equal(crossPointState(mislabeled).completed, undefined, "원문이 남아도 완료가 아니다");

  const planning = { version: 1, id: "W", target: "t", maxParallel: 3, tasks: [], agents: [],
    cross: { host: "claude", model: "", at: "2026-10-07T00:00:00.000Z", criticDispatchId: "d-1", status: "unavailable", summary: "Not logged in", findings: [], questions: 0 } } as PlanningState;
  assert.deepEqual(planningCrossAttemptsOf(planning, "d-1").map((attempt) => [attempt.class, attempt.detail]), [["cross-unavailable", "Not logged in"]]);
  assert.deepEqual(planningCrossAttemptsOf(planning, "d-2"), [], "다른 critic 지점의 옛 기록은 그 지점에 들지 않는다");
});

test("파생 사본 — 배열이 저장된 회차는 옛 필드를 배열에서 다시 쓴다", () => {
  const runs: ReviewerRun[] = [
    { sessionId: "s", agentId: "a", startedAt: "t0", failure: { class: "agent-format-error", at: "t1", detail: "x" } },
    { sessionId: "s", agentId: "b", startedAt: "t2", completedAt: "t3", result: "- 없음" },
  ];
  const stored = round({ reviewers: runs, crossAttempts: [ended(1, "cross-config-error", { detail: "unexpected argument" })] });
  syncLegacyRound(stored);
  assert.deepEqual(stored.reviewer, { sessionId: "s", agentId: "b", startedAt: "t2", completedAt: "t3", result: "- 없음" });
  assert.match(stored.cross!.error!, /unexpected argument/);
  stored.crossAttempts!.push(ended(2, "completed", { result: "- 없음" }));
  syncLegacyRound(stored);
  assert.equal(stored.cross!.result, "- 없음");
  const stopped = round({ crossAttempts: [ended(1, "cross-unavailable", { detail: "사용 한도(quota): spend cap" })] });
  syncLegacyRound(stopped);
  assert.match(stopped.cross!.unavailable!, /spend cap/);
  const legacy = round({ reviewer: { sessionId: "s", agentId: "a", startedAt: "t0" } });
  syncLegacyRound(legacy);
  assert.deepEqual(legacy.reviewer, { sessionId: "s", agentId: "a", startedAt: "t0" }, "배열이 없는 옛 회차는 건드리지 않는다");
});

// ---- ⑨ 회차 구역 ----

test("renderRoundsBlock — 옛 기록은 이전 판과 바이트가 같고, 실행 기록·사람 판단 절은 있을 때만 붙는다", () => {
  const old: ReviewLog = { id: "ORD-1", target: "order", rounds: [round(), round({ round: 2, at: "2026-10-07T01:00:00.000Z", treeHash: "sha256:t2" })] };
  assert.equal(renderRoundsBlock(old), [
    "## 회차", "",
    "<!-- 이 구역은 code-agent review 가 .code-agent/work/ORD-1/order.review.json 에서 렌더한다. 손으로 고치면 게이트가 거부한다. -->", "",
    "| 회차 | 시각 | 기준 트리 해시 (계획 파일) |", "|---|---|---|",
    "| 1 | 2026-10-07T00:00:00.000Z | sha256:t1 |", "| 2 | 2026-10-07T01:00:00.000Z | sha256:t2 |",
  ].join("\n"));
  const single: ReviewLog = { ...old, rounds: [round({ reviewers: [{ sessionId: "s", agentId: "a", startedAt: "t", completedAt: "t", result: "- 없음" }], crossAttempts: [ended(1, "completed")] })] };
  assert.doesNotMatch(renderRoundsBlock(single), /###/, "재호출·실패가 없으면 절을 붙이지 않는다");
  const two: ReviewLog = { ...old, rounds: [round({ reviewers: [
    { sessionId: "s", agentId: "a", startedAt: "t", completedAt: "t", result: "- 없음" },
    { sessionId: "s", agentId: "b", startedAt: "t", ignored: { at: "t", reason: "completed-round" } },
  ] })] };
  assert.match(renderRoundsBlock(two), /### 실행 기록\n\n- 1회차 리뷰어: 2회 호출 — 완료, 완료 뒤 재호출 무시/);
  const judged: ReviewLog = { ...old, waivers: [{ source: "cross", id: "X1", path: "src/a.ts", scope: "계획 안", verdict: "범위 밖 확인", detailHash: "h", detail: "d",
    round: 1, reason: "이번 작업\n범위 밖", consent: "12345678-abcd", at: "t" }] };
  assert.match(renderRoundsBlock(judged), /### 사람 판단\n\n- X1 \(src\/a\.ts\) 범위 밖 확인 — 이번 작업 범위 밖 · 1회차 · 동의 12345678$/);
});

// ---- 계획 지점·고아 보기 ----

test("planningCrossView — 질문을 모두 답한(또는 질문 없는) needs-input 은 완료가 아니라 끝난 실행 한 번이다", () => {
  const needs = (questionIds?: string[]): PlanningCrossAttempt => ({ ...ended(1, "completed"), criticDispatchId: "d",
    outcome: { status: "needs-input", summary: "s", findings: [], questions: questionIds?.length ?? 1, ...(questionIds ? { questionIds } : {}) } });
  const q = (id: string, answered: boolean, title = `${id} · 교차 계획 검토(claude)`) => ({ id, title, answered });
  const waiting = planningCrossView([needs(["Q5"])], [q("Q5", false)]);
  assert.equal(crossPointState(waiting.view).state, "completed");
  assert.deepEqual(waiting.awaiting, ["Q5"]);
  assert.equal(pointLabel(waiting.view, waiting.awaiting), "질문 대기");
  const answered = planningCrossView([needs(["Q5"])], [q("Q5", true)]);
  assert.equal(answered.view[0].class, "answered-input");
  assert.equal(crossPointState(answered.view).state, "open");
  assert.equal(pointLabel(answered.view), "질문 답함(재검토 대기)");
  // 옛 기록(questionIds 없음)은 머리가 `· 교차 계획 검토(` 인 질문 전부를 본다
  assert.equal(planningCrossView([needs()], [q("Q5", true), q("Q6", true), q("Q1", false, "Q1 · 요구사항 분석")]).view[0].class, "answered-input");
  assert.equal(planningCrossView([needs()], [q("Q5", true), q("Q6", false)]).view[0].class, "completed");
  assert.equal(planningCrossView([needs([])], []).view[0].class, "answered-input", "질문이 없는 needs-input 은 막다른 길이 되지 않는다");
  assert.equal(crossPointDecision({ attempts: answered.view, scope: "critic:d" }).action, "run");
});

test("syncLegacyPlanning — 파생 사본 cross 는 게이트와 같은 보기의 첫 completed 다(질문을 답한 옛 needs-input 뒤의 재실행, 동시에 늦게 끝난 완료는 고르지 않는다)", () => {
  const finding = { id: "C1", severity: "blocking" as const, detail: "TC 없음", source: { path: "doc/a.md", line: 1 } };
  const attempt = (n: number, status: "needs-input" | "completed", summary: string, findings = [finding]): PlanningCrossAttempt =>
    ({ ...ended(n, "completed"), host: "claude", criticDispatchId: "d", outcome: { status, summary, findings: status === "needs-input" ? [] : findings, questions: status === "needs-input" ? 1 : 0 } });
  const state = (crossAttempts: PlanningCrossAttempt[]) => ({ version: 1, id: "W", target: "t", maxParallel: 3, tasks: [], agents: [], crossAttempts }) as unknown as PlanningState;
  const answered = [{ id: "Q5", title: "Q5 · 교차 계획 검토(claude)", answered: true }];
  const resumed = state([attempt(1, "needs-input", "옛 질문"), attempt(2, "completed", "다시 실행")]);
  syncLegacyPlanning(resumed, "d", answered);
  assert.deepEqual([resumed.cross!.status, resumed.cross!.summary, resumed.cross!.findings.map((item) => item.id)], ["completed", "다시 실행", ["C1"]]);
  const waiting = state([attempt(1, "needs-input", "옛 질문")]);
  syncLegacyPlanning(waiting, "d", [{ ...answered[0], answered: false }]);
  assert.equal(waiting.cross!.status, "needs-input", "답이 없는 동안은 그 needs-input 이 완료다");
  const raced = state([attempt(1, "completed", "먼저 완료"), attempt(2, "completed", "늦게 완료", [])]);
  syncLegacyPlanning(raced, "d", []);
  assert.equal(raced.cross!.summary, "먼저 완료");
});

test("pointHost·crossSandboxSuspect(D2) — 지점 호스트는 실제로 띄운 첫 시도가 정하고, Codex 가 부른 claude 의 네트워크 오류는 몇 번째든 샌드박스로 의심한다", () => {
  const preflight = { ...ended(1, "host-sandbox-denied"), host: "claude" as const, mode: "preflight" as const, kind: "preflight" };
  assert.equal(pointHost([preflight]), undefined);
  assert.equal(pointHost([preflight, ended(2, "completed")]), "codex");
  assert.equal(pointHost([{ ...ended(1, "cross-stop"), mode: "human" }]), undefined);
  assert.equal(crossSandboxSuspect("claude", "codex"), true, "같은 지점의 두 번째 이후도 실행 불가로 넘기지 않는다(D2)");
  assert.equal(crossSandboxSuspect("claude", undefined), false, "사람의 터미널(표지 없음)");
  assert.equal(crossSandboxSuspect("codex", "claude"), false, "Claude 메인이 부른 codex 의 네트워크 오류는 실행 불가 — 중지 기록 후 진행");
});

test("D2 classifyCrossFailure·recordedVariant — 샌드박스 의심은 네트워크 오류만 막힘으로 바꾸고(미설치·인증·사용 한도·서비스 장애는 실행 불가 그대로), 같은 지점의 두 번째 이후 네트워크 차단은 사람에게 넘기는 변형을 고른다", () => {
  const run = (stderr: string, sandboxed: boolean) => classifyCrossFailure({ host: "claude", status: 1, stderr, stdout: "", sandboxed });
  const NETWORK = "Error: getaddrinfo ENOTFOUND api.anthropic.com";
  assert.deepEqual([run(NETWORK, true).class, run(NETWORK, true).kind], ["host-sandbox-denied", "sandbox-network"]);
  assert.deepEqual([run(NETWORK, false).class, run(NETWORK, false).kind], ["cross-unavailable", "network"], "Claude 메인이 부른 codex(의심 없음) — 실행 불가");
  for (const [stderr, kind] of [["Not logged in · Please run /login", "auth"], ["Claude AI usage limit reached", "quota"], ["API Error: 529 Overloaded", "outage"]] as const) {
    assert.deepEqual([run(stderr, true).class, run(stderr, true).kind], ["cross-unavailable", kind], stderr);
  }
  const missing = classifyCrossFailure({ host: "claude", unresolved: "claude 실행 파일을 PATH 에서 찾지 못했습니다", unresolvedConfig: false });
  assert.deepEqual([missing.class, missing.kind], ["cross-unavailable", "missing"], "미설치는 Codex 가 불러도 실행 불가 — 중지 기록 후 진행");
  const net = (n: number) => ({ n, kind: "sandbox-network", endedAt: "2026-10-08T00:00:00.000Z" });
  const record = { class: "host-sandbox-denied", kind: "sandbox-network" };
  assert.equal(recordedVariant(record, { attempts: [net(1)], left: 2 }), undefined, "첫 번째 — 권한 상승해 같은 명령(기본 문구)");
  assert.equal(recordedVariant(record, { attempts: [net(1), net(2)], left: 1 }), "network-repeat");
  assert.equal(recordedVariant(record, { attempts: [net(1), net(2), net(3)], left: 0 }), "network-exhausted");
  assert.equal(recordedVariant(record, { attempts: [{ n: 1, kind: "preflight", endedAt: "x" }, net(2)], left: 2 }), undefined, "사전 판정 거부는 네트워크 오류 시도로 세지 않는다");
  assert.equal(recordedVariant({ class: "host-sandbox-denied", kind: "sandbox" }, { attempts: [net(1), net(2)], left: 1 }), undefined, "EPERM 등 샌드박스 거부는 기본 문구");
  assert.equal(recordedVariant(record), undefined, "지점 시도를 모르면 기본 문구");
  assert.match(guidance("host-sandbox-denied", { host: "claude", detail: "d", left: 1 }, "network-repeat"), /실제 네트워크 문제일 수 있습니다[\s\S]*남은 지점 시도 1회[\s\S]*judgment cross-stop[\s\S]*사용자 확인 없이 중지를 기록하지 않습니다/);
  assert.doesNotMatch(guidance("host-sandbox-denied", { host: "claude", detail: "d" }, "network-exhausted"), /남은 지점 시도/);
});

test("orphanView — 같은 PC 의 죽은 pid 와 제한 + 5분이 지난 시도만 끊긴 실행으로 본다(원 배열은 그대로)", () => {
  const dead = deadPid();
  const now = Date.now(), recent = new Date(now - 1_000).toISOString(), old = new Date(now - TIMING.crossTimeoutMin * 60_000 - 6 * 60_000).toISOString();
  const open = (extra: Partial<CrossAttempt>): CrossAttempt => ({ n: 1, host: "codex", mode: "review", startedAt: recent, ...extra });
  const attempts = [open({ pid: dead, machine: hostname() }), open({ pid: process.pid, machine: hostname() }), open({ pid: dead, machine: "other-pc" }), open({ startedAt: old, machine: "other-pc" })];
  const view = orphanView(attempts, now);
  assert.deepEqual(view.map((attempt) => [attempt.class, attempt.kind]), [["cross-timeout", "interrupted"], [undefined, undefined], [undefined, undefined], ["cross-timeout", "interrupted"]]);
  assert.match(view[0].detail!, new RegExp(`기록 없이 끊긴 실행\\(pid ${dead}\\)`));
  assert.equal(attempts[0].endedAt, undefined, "원 배열은 바뀌지 않는다");
  assert.equal(attemptLabel(view[0]), "끊긴 실행");
  // 사람이 아닌 중지 뒤 끊긴 재실행 — 보기에서 끊긴 실행이 되면 지점은 중지 그대로다(게이트가 실행 중으로 막지 않는다)
  assert.equal(crossPointState(orphanView([ended(1, "cross-unavailable"), { ...open({ pid: dead, machine: hostname() }), n: 2 }], now)).state, "stopped");
  assert.equal(pointLabel(orphanView([ended(1, "cross-config-error"), { ...open({ pid: dead, machine: hostname() }), n: 2 }], now)), "막힘(끊긴 실행)");
});

// ---- 교차 결과·실행 인자 ----

test("normalizeCrossBody — F 줄을 X 로 다시 매긴다(X 가 없으면 같은 번호, 있으면 최대 + 1 부터)", () => {
  const onlyF = normalizeCrossBody("| id | 계획 파일 | 범위 | 상태 | 지적 |\n|---|---|---|---|---|\n| F1 | a | 계획 안 | 열림 | x |\n| F2 | b | 계획 안 | 열림 | y |");
  assert.equal(onlyF.renamed, 2);
  assert.match(onlyF.body, /^\| X1 \| a [\s\S]*^\| X2 \| b /m);
  assert.match(onlyF.body, /^\| id \|/m, "표 머리는 그대로다");
  const mixed = normalizeCrossBody("| X1 | a | 계획 안 | 열림 | x |\n| F1 | b | 계획 안 | 열림 | y |");
  assert.deepEqual([mixed.renamed, mixed.body.split("\n")[1].slice(0, 6)], [1, "| X2 |"]);
  assert.deepEqual(normalizeCrossBody("- 없음"), { body: "- 없음", renamed: 0 });
});

test("crossSectionText — ⑨ 의 ## 교차 지적 절만 다시 쓰고, 없으면 끝에 붙인다", () => {
  const text = "# W 코드 리뷰\n\n## 지적\n\n- 없음\n\n## 교차 지적\n\n옛 내용\n";
  assert.match(crossSectionText(text, "codex", "- 없음"), /## 지적\n\n- 없음\n\n## 교차 지적\n\n<!-- codex 교차 리뷰 결과를[^\n]*-->\n\n- 없음\n/);
  assert.doesNotMatch(crossSectionText(text, "codex", "- 없음"), /옛 내용/);
  assert.match(crossSectionText("# W\n\n## 지적\n\n- 없음\n", "claude", stopBody({ host: "claude", class: "cross-unavailable", detail: "Not logged in" })),
    /## 교차 지적[\s\S]*- 교차 검증 중지 — claude 를 실행할 수 없습니다: Not logged in/);
});

test("stopBody — 실행 불가·두 번째 제한 시간·사람 판단의 중지 줄", () => {
  assert.equal(stopBody({ host: "codex", class: "cross-unavailable", detail: "사용 한도(quota):  spend\ncap" }), "- 교차 검증 중지 — codex 를 실행할 수 없습니다: 사용 한도(quota): spend cap");
  assert.equal(stopBody({ host: "codex", class: "cross-timeout", detail: "두 번 연속 9분 제한을 넘겼습니다(CODE_AGENT_CROSS_TIMEOUT_MIN)" }), "- 교차 검증 중지 — codex 가 두 번 연속 9분 제한을 넘겼습니다(CODE_AGENT_CROSS_TIMEOUT_MIN)");
  assert.equal(stopBody({ host: "codex", class: "cross-stop", detail: "설정을 고칠 수 없음", consent: "abcdef12-3456" }), "- 교차 검증 중지 — 사람 판단(동의 abcdef12): 설정을 고칠 수 없음");
});

function withModels<T>(models: object | undefined, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ca-cross-args-"));
  try {
    if (models) { mkdirSync(join(root, ".code-agent"), { recursive: true }); writeFileSync(join(root, ".code-agent/models.json"), JSON.stringify(models)); }
    return run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("교차 실행 인자 — 역할 정책의 모델·강도(--model·--effort / -m·-c)를 넘기고, doctor 점검 목록은 인자에서 만든다", () => {
  withModels(undefined, (root) => {
    const claude = crossInvocationArgs(root, "claude", "ca-critic", "검토하라", "");
    assert.match(claude.args.join(" "), /--agent ca-critic --model opus --effort high --output-format json/);
    assert.equal(claude.model, "opus/high");
    assert.equal(claude.sentPrompt, "검토하라");
    const codex = crossInvocationArgs(root, "codex", "ca-reviewer", "리뷰하라", "out.txt");
    assert.deepEqual(codex.args.slice(0, 11), ["exec", "-s", "read-only", "-C", root, "--ephemeral", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=\"high\"", "-o"]);
    assert.equal(codex.model, "gpt-6.1-sol/high");
    assert.match(codex.sentPrompt, /\n\n---\n\n리뷰하라$/, "Codex 는 역할 지침 + 프롬프트를 보낸다");
    const flags = crossFlags(root, "claude");
    for (const flag of ["--print", "--agent", "--model", "--effort", "--output-format", "--setting-sources", "--permission-prompts", "--allowedTools"]) assert.ok(flags.includes(flag), flag);
    for (const value of ["json", "project", "Read,Grep,Glob", "-p"]) assert.ok(!flags.includes(value), value);
    assert.deepEqual(crossFlags(root, "codex"), ["--sandbox", "--cd", "--ephemeral", "--model", "--config", "--output-last-message"]);
  });
  withModels({ critic: "sonnet", effort: { critic: "max" } }, (root) => {
    assert.match(crossInvocationArgs(root, "claude", "ca-critic", "x", "").args.join(" "), /--model sonnet --effort max/);
  });
  withModels({ critic: "haiku" }, (root) => {
    const args = crossInvocationArgs(root, "claude", "ca-critic", "x", "");
    assert.match(args.args.join(" "), /--model haiku --output-format/);
    assert.ok(!args.args.includes("--effort"), "강도를 받지 않는 모델에는 --effort 를 넘기지 않는다");
    assert.equal(args.model, "haiku");
  });
});

test("crossInvocation — 자식 환경은 교차 표지를 넣고 부른 쪽 호스트 표지를 지운다. 실행 파일이 없으면 실행하지 않는다", () => {
  withModels(undefined, (root) => {
    const bin = join(root, "claude.cjs");
    writeFileSync(bin, "");
    const saved = { bin: process.env.CODE_AGENT_CLAUDE_BIN, claude: process.env.CLAUDECODE };
    process.env.CODE_AGENT_CLAUDE_BIN = bin; process.env.CLAUDECODE = "1";
    try {
      const invocation = crossInvocation(root, "claude", "ca-reviewer", "x");
      assert.ok(!("unresolved" in invocation));
      if ("unresolved" in invocation) return;
      assert.equal(invocation.env.CODE_AGENT_CROSS, "claude");
      assert.equal(invocation.env.CLAUDECODE, undefined);
      assert.equal(invocation.file, process.execPath);
      process.env.CODE_AGENT_CLAUDE_BIN = join(root, "none.cjs");
      assert.match((crossInvocation(root, "claude", "ca-reviewer", "x") as { unresolved: string }).unresolved, /가리키는 파일이 없습니다/);
    } finally {
      if (saved.bin === undefined) delete process.env.CODE_AGENT_CLAUDE_BIN; else process.env.CODE_AGENT_CLAUDE_BIN = saved.bin;
      if (saved.claude === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved.claude;
    }
  });
});

test("crossStopStreak — 최근 지점부터 이어진 사람이 아닌 중지 수(완료에서 멈추고 사람 중지는 건너뛴다)", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-cross-streak-"));
  try {
    const dir = join(root, ".code-agent/work/W-1");
    mkdirSync(dir, { recursive: true });
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 0, minute)).toISOString();
    const point = (minute: number, cls: CrossAttempt["class"], detail = "spend cap"): ReviewRound =>
      round({ round: minute, crossAttempts: [{ ...ended(1, cls, { detail }), startedAt: at(minute), endedAt: at(minute) }] });
    const log: ReviewLog = { id: "W-1", target: "t", rounds: [point(1, "cross-unavailable"), point(2, "completed"), point(3, "cross-unavailable"), point(4, "cross-stop", "사람"), point(5, "cross-unavailable", "Not logged in")] };
    writeFileSync(join(dir, "t.review.json"), JSON.stringify(log));
    const planning = { version: 1, id: "W-1", target: "t", maxParallel: 3, tasks: [], agents: [], crossAttempts: [{ ...ended(1, "cross-unavailable", { detail: "quota" }), criticDispatchId: "d", startedAt: at(0), endedAt: at(0) }] };
    writeFileSync(join(dir, "t.planning.json"), JSON.stringify(planning));
    const streak = crossStopStreak(root);
    assert.equal(streak.count, 2, "5분(중지) · 4분(사람 — 건너뜀) · 3분(중지) · 2분(완료 — 멈춤)");
    assert.deepEqual(streak.last, { host: "codex", detail: "Not logged in" });
    writeFileSync(join(dir, "broken.review.json"), "{");
    utimesSync(join(dir, "broken.review.json"), new Date(), new Date());
    assert.equal(crossStopStreak(root).count, 2, "깨진 기록은 건너뛴다");
    assert.deepEqual(legacyPlanningAttempts(undefined), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reviewerState — 받아들인 실행은 많아야 하나이고, 고아는 호출 한 번으로 센다", () => {
  const now = Date.now(), old = new Date(now - TIMING.reviewerOrphanMs - 60_000).toISOString();
  const runs: ReviewerRun[] = [
    { sessionId: "s", agentId: "a", startedAt: old, ignored: { at: "t", reason: "orphaned" } },
    { sessionId: "s", agentId: "b", startedAt: old },
    { sessionId: "s", agentId: "c", startedAt: old, ignored: { at: "t", reason: "concurrent" } },
  ];
  const state = reviewerState(round({ reviewers: runs }), PLANNED, now);
  assert.equal(state.running?.agentId, "b");
  assert.equal(state.orphanable, true);
  assert.equal(state.runs, 2, "고아 1 + 받아들인 실행 1 — 동시 호출 무시는 세지 않는다");
  assert.equal(state.effective, undefined);
});
