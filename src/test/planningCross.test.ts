import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { start } from "./confirmedStart";
import { observeQuestionAnswers, prepareConsentFixture } from "./consentFixture";
import { back, next, status, submitPlan, decide as approveCommand } from "../agent/commands";
import { decide as hook } from "../agent/hook";
import { contextHandoff, handoffPlanning } from "../agent/handoff";
import { crossCritic, CrossCriticSchema, planningCrossBudgets } from "../agent/crossCheck";
import { previewCrossStop, previewWaiveFinding, recordCrossStop, waiveFinding } from "../agent/reviewJudgment";
import { withCaller } from "./reviewFixture";
import { sessionAnchor } from "../agent/sessionHook";
import { planningAdvanceCli, planningNextLine } from "../agent/planningChain";
import { context } from "../agent/commands";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { loadActive, saveActive } from "../agent/layout";
import { init, installedHook, unmatchedTools } from "../agent/init";
import { cancelPlanning, dispatchPlanning, grantPlanningRetry, planningBudget, preparePlanning, planningStatus, advancePlanning, repairPlanning, planningResult } from "../agent/planning";
import { codexHook, runCodexHook } from "../agent/codexHook";
import { withNotation } from "../agent/hostText";
import { hostAssets } from "../agent/hosts";
import { readProjectFile } from "../agent/read";
import { observePlanner, runPlanningHook } from "../agent/planningHook";
import { fileHash, hashedQuestion, inputFiles, invalidatePlanningCache, loadPlanning, planningProblems, taskCurrent, taskHash, TaskSchema, ResultSchema, withPlanningCache, type PlanningResult, type PlanningState } from "../agent/planningState";
import { planningDocumentProblems, planRuleProblems } from "../agent/planningValidation";
import { planFormatFor } from "../core/plan";
import { parseQuestions, type Question } from "../agent/questions";
import { acquireLock } from "../agent/lock";
import { orphanState, RetryRefused } from "../agent/retryPolicy";
import { sha } from "../agent/docs";
import { writeAtomic } from "../core/atomic";
import { approvalDocsHash, approvalOf, loadWork } from "../agent/work";
import { hashManifest, recordDecision } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { sequenceProblems } from "../core/plan";
import { withInteraction } from "../agent/tty";
import { deadPid } from "./deadPid";

import { ID, REQUIREMENTS, IMPACT, DESIGN, FUNCTIONAL, TESTS, PLAN, root, advance, write, phase, dispatch, finish, handed, analysis, throughDesign, throughPlan, malformed, crossPlanningSetup, crossProblems, planningJson, editPlanning, ago, answer, quiet, quietAsync, captured, startAgent, stopEvent, completed, toDesign, DUPLICATED_AC, chain, chainedWithoutGate, DIR, SPEC } from "./planningFixture";

test("두 호스트 설치에서 critic 뒤 교차 검토가 남으면 advance 의 next 와 status 다음: 이 planning cross 를 안내한다(E5)", async () => {
  const cross = crossPlanningSetup();
  try {
    const out = JSON.parse((await planningAdvanceCli(root, { chain: false })).text) as { action: string; blocked?: unknown[]; next: string };
    assert.deepEqual([out.action, out.blocked], ["blocked", undefined], "CLI 출력은 빈 배열(막힌 작업 없음)을 싣지 않는다");
    assert.match(out.next, /^교차 검토: [\s\S]*code-agent planning cross --by \S+ [\s\S]* — 그다음 code-agent planning advance$/);
    assert.doesNotMatch(out.next, /그대로 전하고 멈춘다/);
    const line = status(root).split("\n").find((entry) => entry.startsWith("다음: "))!;
    assert.match(line, /교차 검토: [\s\S]*code-agent planning cross --by \S+[\s\S]*그다음 code-agent planning advance/);
  } finally { cross.cleanup(); }
});

test("계획 승인 화면에 critic·교차 계획 검토 결과와 그 사람 판단이 실린다(E12 — 반영 때 ⑩ 에 나오는 줄을 승인 때도 본다)", () => {
  const cross = crossPlanningSetup();
  try {
    cross.answer({ status: "completed", summary: "AC 하나가 TC에 걸리지 않는다", findings: [{ id: "C1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: SPEC, line: 1 } }] });
    waiveFinding(root, "C1", "consent-0001-0000-0000-000000000000", "경계값은 범위 밖");
    submitPlan(root, join(root, DIR, "plan.json"));
    let shown = "";
    withInteraction({ confirm: (text) => { shown = text; return { channel: "tty", verified: true, detail: "테스트" }; }, ask: () => "" }, () => approveCommand(root, "approved"));
    assert.match(shown, /## 계획 검토\n\n- 계획 검토\(critic\): completed · 차단 지적 0\n- 교차 계획 검토: [^\n]*\(차단 1 · 질문 0\) · critic [\w-]{8}\n- 사람 판단: C1\(교차 계획 검토\) 기각 — 경계값은 범위 밖 · 동의 consent-/);
  } finally { cross.cleanup(); }
});

test("두 호스트가 설치되면 critic 뒤 교차 검토가 계획 제출 조건이고, 완료된 지점은 다시 실행하지 않으며 차단 지적은 사람 판단으로 기각한다 (PVR-1·PVR-6)", () => {
  const cross = crossPlanningSetup();
  try {
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토/);
    // 역할 정책(critic 은 판단 역할 opus/high)이 교차 Claude 인자와 결과 줄까지 이어진다
    assert.match(cross.answer({ status: "completed", summary: "AC 하나가 TC에 걸리지 않는다", findings: [{ id: "C1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: SPEC, line: 1 } }] }),
      /^claude\(opus\/high\) 교차 계획 검토: completed · 차단 지적 1개/);
    assert.match(cross.argv().join(" "), /--agent ca-critic --model opus --effort high --output-format json --setting-sources project --permission-prompts none --allowedTools Read,Grep,Glob/);
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토: 차단 지적이 남아 있습니다\(C1\)/);
    // 같은 critic 결과로 다시 실행해 지적을 지우는 길은 없다
    assert.throws(() => cross.answer({ status: "completed", summary: "문제 없음", findings: [] }), /이미 기록했습니다/);
    assert.equal(cross.calls(), 1);
    assert.match(previewWaiveFinding(root, "C1"), /대상: C1 · 교차 계획 검토\(claude\) · critic [\w-]{8} · doc\/work\/PLAN-1\/requirement\.md:1/);
    assert.throws(() => previewWaiveFinding(root, "C9"), /교차 계획 검토 결과에 C9 가 없습니다/);
    assert.match(waiveFinding(root, "C1", "consent-0001", "경계값은 범위 밖"), /C1 를 사람 판단으로 기록했습니다/);
    assert.deepEqual(crossProblems(), []);
    assert.equal(loadPlanning(loadWork(root)!).crossWaivers!.length, 1);
    assert.throws(() => waiveFinding(root, "C1", "consent-0002", "다시"), /이미 사람 판단으로 기록했습니다/);
    assert.throws(() => crossCritic(root, "gemini"), /--by claude 또는 --by codex/);
  } finally { cross.cleanup(); }
});

test("교차 검토 결과의 근거가 입력 밖이면 원문을 보존하고, 같은 명령이 원문의 형식만 교정한다 (HP-13)", () => {
  const cross = crossPlanningSetup();
  try {
    assert.throws(() => cross.answer({ status: "completed", summary: "x", findings: [{ id: "C1", severity: "advisory", detail: "x", source: { path: "../outside.md", line: 1 } }] }),
      (error: Error) => error instanceof RetryRefused && /형식이 맞지 않습니다[\s\S]*입력 밖[\s\S]*원문/.test(error.message));
    const first = loadPlanning(loadWork(root)!).crossAttempts![0];
    assert.deepEqual([first.class, first.kind], ["cross-result-invalid", "reference"]);
    assert.ok(existsSync(join(root, first.rawPath!)), "원문을 handoff 에 보존한다");
    // 계획 게이트도 리뷰 게이트와 같은 안내(남은 횟수·다음 행동)를 붙인다
    assert.match(crossProblems().join("\n"), /직전 실행: 막힘\(형식 오류\)[\s\S]*원문을 [^ ]*cross-critic-[\w-]{8}-1-raw\.md 에 보존했습니다\. 같은 명령을 한 번 더 실행하면 원문의 형식만 교정합니다\(남은 1회\)/);
    assert.match(cross.answer({ status: "completed", summary: "문제 없음", findings: [] }), /completed[\s\S]*형식 교정/);
    assert.match(cross.prompt(), new RegExp(`${first.rawPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 는 직전 교차 계획 검토의 원문 응답이다[\\s\\S]*형식 오류: 근거가 입력 밖`));
    const attempts = loadPlanning(loadWork(root)!).crossAttempts!;
    assert.deepEqual(attempts.map((attempt) => [attempt.mode, attempt.class]), [["review", "cross-result-invalid"], ["correct", "completed"]]);
    assert.deepEqual(crossProblems(), []);
  } finally { cross.cleanup(); }
});

test("교차 검토 질문은 원래 요구와 출처를 남기고, 답하면 critic 이 다시 배정돼 새 지점에서 교차 검토를 받는다", () => {
  const cross = crossPlanningSetup();
  try {
    assert.match(cross.answer({ status: "needs-input", summary: "범위를 정해야 한다", questions: [{ id: "Q1", question: "R9 경계값도 포함할까요?", requirements: ["R9"] }] }), /질문 1개/);
    const questions = readFileSync(join(root, DIR, "questions.md"), "utf8");
    assert.match(questions, /## Q5 · 교차 계획 검토\(claude\)\nR9 경계값도 포함할까요\?\n\[Requirements\]: R9\n\[Origin\]: critic\n\[Answer\]:/, "기존 Q4 다음 번호를 코드가 매기고 원래 요구를 지우지 않는다");
    assert.deepEqual(loadPlanning(loadWork(root)!).crossAttempts![0].outcome!.questionIds, ["Q5"]);
    assert.match(crossProblems().join("\n"), /질문에 답하세요\(Q5\)/);
    // 출처가 기록된 질문의 답은 critic 을 낡게 한다 — 교차 검토는 새 critic 결과의 새 지점에서 다시 돈다
    write(`${DIR}/questions.md`, questions.replace(/(## Q5[\s\S]*?\[Answer\]:)/, "$1 포함한다"));
    assert.ok(planningProblems(loadWork(root)!, "plan").some((problem) => /critic: 현재 입력/.test(problem)));
    assert.equal(JSON.parse(planningResult(root, "plan")).current, true, "plan 결과는 그대로 재사용한다");
    assert.throws(() => cross.answer({ status: "completed", summary: "x", findings: [] }), /critic 완료 결과가 먼저/);
    finish(dispatch("critic"));
    assert.match(cross.answer({ status: "completed", summary: "문제 없음", findings: [] }), /completed/);
    assert.deepEqual(crossProblems(), []);
  } finally { cross.cleanup(); }
});

test("옛 needs-input 교차 기록은 질문에 답한 뒤 같은 critic 결과로 한 번 더 실행할 수 있다 — 하위 호환", async () => {
  const cross = crossPlanningSetup();
  try {
    const critic = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "critic")!.attempts.at(-1)!;
    editPlanning((state) => {
      state.cross = { host: "claude", model: "", at: new Date().toISOString(), criticDispatchId: critic.dispatchId, status: "needs-input", summary: "범위 확인", findings: [], questions: 1 };
    });
    write(`${DIR}/questions.md`, "# 질문\n\n## Q4 · 기존\n앞선 질문\n[Answer]: 예\n\n## Q5 · 교차 계획 검토(claude)\n경계값도 포함할까요?\n[Requirements]: R9\n[Answer]:\n");
    assert.match(crossProblems().join("\n"), /질문에 답하세요\(Q5\)/);
    // 옛 질문(출처 기록 없음, 요구 R9)의 답은 critic 입력을 바꾸지 않는다 — 같은 critic 결과로 다시 실행하는 길이 열린다
    write(`${DIR}/questions.md`, readFileSync(join(root, DIR, "questions.md"), "utf8").replace(/(## Q5[\s\S]*?\[Answer\]:)/, "$1 포함한다"));
    assert.match(crossProblems().join("\n"), /질문에 답했습니다 — 같은 critic 결과로 교차 검토를 한 번 더/);
    assert.match(previewCrossStop(root, "planning"), /지점: 계획 검토 critic/);
    const blocking = { id: "C1", severity: "blocking", detail: "R9 경계값 TC 없음", source: { path: SPEC, line: 1 } };
    assert.match(cross.answer({ status: "completed", summary: "답을 반영했다", findings: [blocking] }), /completed · 차단 지적 1개/);
    assert.equal(cross.calls(), 1);
    const brief = readFileSync(join(root, ".code-agent/work", ID, "handoff/cross-critic.md"), "utf8");
    assert.match(brief, /## 이전 교차 검토의 질문과 답[\s\S]*Q5 · 교차 계획 검토[\s\S]*\[Answer\]: 포함한다/);
    const state = loadPlanning(loadWork(root)!);
    assert.equal(state.crossAttempts!.length, 2, "옛 기록에서 추정한 시도 1 + 새 시도 1");
    // 파생 사본은 게이트와 같은 보기 — 답한 옛 needs-input 이 아니라 다시 실행한 결과다(이전 판 CLI 도 같은 결과를 읽는다)
    assert.deepEqual([state.cross!.status, state.cross!.summary, state.cross!.findings.map((finding) => finding.id)], ["completed", "답을 반영했다", ["C1"]]);
    assert.match(crossProblems().join("\n"), /교차 검토: 차단 지적이 남아 있습니다\(C1\)/);
    // 수정 피드백 목록도 게이트가 막는 지적을 싣는다 — 파생 사본이 아니라 시도 배열을 본다(사본이 낡아도 같다)
    assert.ok(((await advance()).feedback ?? []).some((item: { from: string; finding: string }) => item.from === "cross" && item.finding === "C1"), "advance feedback 에 교차 차단 지적 C1");
    editPlanning((stale) => { stale.cross = { ...stale.cross!, summary: "낡은 사본", findings: [] }; });
    assert.ok(((await advance()).feedback ?? []).some((item: { from: string; finding: string }) => item.from === "cross" && item.finding === "C1"), "파생 사본이 낡아도 배열의 C1");
    waiveFinding(root, "C1", "consent-legacy-1", "경계값은 범위 밖");
    assert.deepEqual(crossProblems(), []);
    assert.equal(((await advance()).feedback ?? []).filter((item: { from: string }) => item.from === "cross").length, 0, "기각한 지적은 피드백에서 뺀다");
  } finally { cross.cleanup(); }
});

test("planningCrossBudgets — 현재 critic 지점(scope critic:<배정>)의 교차 예산: 질문을 답한 needs-input 도 지점 시도로 세고 사람 허용을 더한다. critic 완료가 없으면 빈 목록", () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  assert.deepEqual(planningCrossBudgets(loadWork(root)!), [], "critic 완료 결과가 없으면 지점이 없다");
  finish(dispatch("critic"));
  const critic = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "critic")!.attempts.at(-1)!;
  const scope = `critic:${critic.dispatchId}`, point = `critic ${critic.dispatchId.slice(0, 8)}`;
  const rows = () => planningCrossBudgets(loadWork(root)!).map((row) => [row.key, row.used, row.limit, row.exhausted, row.scope, row.point]);
  assert.deepEqual(rows(), [["crossPoint", 0, 3, false, scope, point], ["crossError", 0, 1, false, scope, point], ["crossFormat", 0, 1, false, scope, point]]);
  // 옛 needs-input(질문 답함 → answered-input)도 끝난 실행 한 번이고, 설정 오류 두 번은 첫 오류 뒤 재실행 1회다
  editPlanning((state) => {
    state.cross = { host: "claude", model: "", at: new Date().toISOString(), criticDispatchId: critic.dispatchId, status: "needs-input", summary: "범위 확인", findings: [], questions: 1 };
    state.retry = { ...state.retry!, grants: [{ key: "crossPoint", scope, step: 1, consent: "c1", at: "t", reason: "r" }, { key: "crossPoint", scope: "critic:other", step: 1, consent: "c2", at: "t", reason: "다른 지점" }] };
  });
  write(`${DIR}/questions.md`, "# 질문\n\n## Q5 · 교차 계획 검토(claude)\n경계값도 포함할까요?\n[Requirements]: R9\n[Answer]: 포함한다\n");
  assert.deepEqual(rows()[0], ["crossPoint", 1, 4, false, scope, point]);
  editPlanning((state) => {
    const base = { host: "claude" as const, mode: "review" as const, startedAt: "2026-10-07T00:00:00.000Z", endedAt: "2026-10-07T00:01:00.000Z", criticDispatchId: critic.dispatchId };
    state.crossAttempts = [{ ...base, n: 1, class: "cross-config-error", kind: "config", detail: "x" }, { ...base, n: 2, class: "cross-config-error", kind: "config", detail: "x" }];
  });
  assert.deepEqual(rows().map((row) => row.slice(0, 4)), [["crossPoint", 2, 4, false], ["crossError", 1, 1, true], ["crossFormat", 0, 1, false]]);
  // 한도를 다 쓴 지점의 게이트 줄은 거부될 명령을 앞세우지 않고 사람 판단만 낸다(E4 — 리뷰 게이트와 같다)
  const line = crossProblems().find((problem) => /계획 검토가 필요합니다/.test(problem))!;
  assert.doesNotMatch(line, /planning cross --by claude \(실행할 수 없으면/);
  assert.match(line, /^교차 검토: 교차 검증을 선택한 프로젝트라 다른 호스트의 계획 검토가 필요합니다 — 직전 실행: [\s\S]*한도 1회를 썼습니다[\s\S]*retry-grant crossError/);
});

test("critic 이 차단 지적을 낸 계획은 교차 계획 검토를 먼저 요구하지 않고 수정 재배정을 안내한다 — 고친 계획의 교차에는 직전 교차 지적을 싣는다", async () => {
  writeFileSync(join(root, ".code-agent/hosts.json"), JSON.stringify(["claude", "codex"]));
  throughDesign(); preparePlanning(root);
  finish(dispatch("plan"), { [`${DIR}/plan.json`]: JSON.stringify(PLAN), [`${DIR}/07-test-spec.md`]: TESTS });
  const line = FUNCTIONAL.split("\n").findIndex((row) => row.startsWith("- AC-R1-1")) + 1;
  finish(dispatch("critic"), {}, { findings: [{ id: "F1", severity: "blocking", detail: "AC-R1-1 경계값 TC 없음", source: { path: `${DIR}/04-functional.md`, line } }] });
  assert.deepEqual(crossProblems(), [], "critic 이 막은 지점의 교차는 헛 실행이다");
  assert.ok(planningProblems(loadWork(root)!, "plan").includes("critic: 차단 지적이 남아 있습니다"), "게이트는 critic 차단 지적이 막는다");
  const next = (await chain(false)).view.next as string;
  assert.match(next, /^차단 지적 1건 — 계약의 수정 피드백으로/);
  assert.doesNotMatch(next, /planning cross/);
  // 이미 돈 교차(완료)는 그대로 보인다 — 차단 지적이 있으면 게이트 줄에 남는다
  const critic = loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "critic")!.attempts.at(-1)!;
  editPlanning((state) => {
    state.crossAttempts = [{ n: 1, host: "codex", mode: "review", startedAt: ago(5), endedAt: ago(4), criticDispatchId: critic.dispatchId, class: "completed",
      outcome: { status: "completed", summary: "s", findings: [{ id: "C1", severity: "blocking", detail: "회귀 TC 없음", source: { path: `${DIR}/plan.json`, line: 1 } }], questions: 0, questionIds: [] } }];
  });
  assert.match(crossProblems()[0] ?? "", /^교차 검토: 차단 지적이 남아 있습니다\(C1\)/);
});

test("needs-input 인데 질문이 없는 교차 결과는 형식 오류로 보존하고 형식 교정으로 다시 돈다", () => {
  const cross = crossPlanningSetup();
  try {
    assert.throws(() => cross.answer({ status: "needs-input", summary: "물어볼 것이 있다" }), /형식이 맞지 않습니다/);
    const first = loadPlanning(loadWork(root)!).crossAttempts![0];
    assert.deepEqual([first.class, first.kind], ["cross-result-invalid", "needs-input-empty"]);
    assert.ok(existsSync(join(root, first.rawPath!)));
    cross.answer({ status: "failed", summary: "질문 없이 판단할 수 없었다" });
    assert.match(cross.prompt(), /needs-input 이면 질문이 하나 이상이어야 한다/);
    assert.match(crossProblems().join("\n"), /교차 검토가 실패로 끝났습니다[\s\S]*judgment cross-stop/);
    // 차단 지적 없는 실패 완료는 사람이 중지를 고를 수 있다
    assert.match(previewCrossStop(root, "planning"), /이 지점의 교차 검증을 사람이 중지로 기록합니다/);
    assert.match(recordCrossStop(root, "planning", "consent-stop-1", "다른 호스트가 판단하지 못함"), /사람 판단으로 중지했습니다/);
    assert.deepEqual(crossProblems(), []);
  } finally { cross.cleanup(); }
});

test("D2(E16): Codex 에서 부른 계획 교차 검토(--by claude)의 네트워크 오류도 몇 번째든 막힘이고 두 번째부터 사람에게 넘긴다 — 사람이 중지를 기록하면 계획을 제출할 수 있다", () => {
  const cross = crossPlanningSetup();
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-claude-net-")), script = join(fake, "claude.cjs"), calls = join(fake, "calls.txt");
  writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(calls)}, 'x'); process.stderr.write('Error: getaddrinfo ENOTFOUND api.anthropic.com'); process.exit(1);\n`);
  process.env.CODE_AGENT_CLAUDE_BIN = script;
  try {
    const run = () => withCaller("codex", () => crossCritic(root, "claude"));
    const rejects = (pattern: RegExp, absent: RegExp) => (error: Error) => error instanceof RetryRefused && pattern.test(error.message) && !absent.test(error.message);
    assert.throws(run, rejects(/샌드박스 표지는 없지만[\s\S]*권한 상승/, /교차 검증 중지/));
    assert.throws(run, rejects(/다시 네트워크 오류로 끝났습니다[\s\S]*남은 지점 시도 1회[\s\S]*judgment cross-stop/, /교차 검증 중지/));
    assert.match(crossProblems().join("\n"), /막힘\(샌드박스\)[\s\S]*다시 네트워크 오류로 끝났습니다[\s\S]*남은 지점 시도 1회/);
    assert.throws(run, rejects(/교차 실행 한도를 다 써서[\s\S]*retry-grant crossPoint/, /남은 지점 시도|교차 검증 중지/));
    assert.throws(run, /한도 3회/);
    assert.equal(readFileSync(calls, "utf8").length, 3);
    assert.deepEqual(loadPlanning(loadWork(root)!).crossAttempts!.map((attempt) => [attempt.class, attempt.kind]),
      Array.from({ length: 3 }, () => ["host-sandbox-denied", "sandbox-network"]));
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토/, "모델이 혼자 중지를 기록하지 않는다 — 게이트가 막혀 있다");
    assert.match(previewCrossStop(root, "planning"), /이 지점의 교차 검증을 사람이 중지로 기록합니다/);
    assert.match(recordCrossStop(root, "planning", "consent-net-1", "사용자가 네트워크를 확인했지만 claude 에 닿지 않음"), /사람 판단으로 중지했습니다/);
    assert.deepEqual(crossProblems(), []);
    submitPlan(root, join(root, DIR, "plan.json"));
  } finally {
    cross.cleanup();
    rmSync(fake, { recursive: true, force: true });
  }
});

test("D2(E16) 반박 검증: 계획 교차 검토도 Codex 에서 부른 적이 있는 지점이면 표지 없는 셸의 재실행 네트워크 오류를 막힘으로 두고, 사람에게 넘긴 지점의 게이트 줄은 재실행 명령을 안내 뒤에 싣는다", () => {
  const cross = crossPlanningSetup();
  const fake = mkdtempSync(join(tmpdir(), "ca-fake-claude-net2-")), script = join(fake, "claude.cjs");
  writeFileSync(script, "process.stderr.write('Error: getaddrinfo ENOTFOUND api.anthropic.com'); process.exit(1);\n");
  process.env.CODE_AGENT_CLAUDE_BIN = script;
  try {
    const line = () => crossProblems().find((problem) => /계획 검토가 필요합니다/.test(problem)) ?? "";
    assert.throws(() => withCaller("codex", () => crossCritic(root, "claude")), RetryRefused);
    assert.match(line(), /^교차 검토: 교차 검증을 선택한 프로젝트라 다른 호스트의 계획 검토가 필요합니다 — code-agent planning cross --by claude — 직전 실행: /, "첫 번째(권한 상승 안내)는 명령을 앞세운다");
    assert.throws(() => withCaller(undefined, () => crossCritic(root, "claude")),
      (error: Error) => error instanceof RetryRefused && /다시 네트워크 오류로 끝났습니다[\s\S]*Codex 에서 부른 claude 지점의 네트워크 오류라[\s\S]*남은 지점 시도 1회/.test(error.message) && !/교차 검증 중지/.test(error.message));
    assert.deepEqual(loadPlanning(loadWork(root)!).crossAttempts!.map((attempt) => [attempt.class, attempt.kind, attempt.caller ?? "-"]),
      [["host-sandbox-denied", "sandbox-network", "codex"], ["host-sandbox-denied", "sandbox-network", "-"]]);
    assert.match(line(), /^교차 검토: 교차 검증을 선택한 프로젝트라 다른 호스트의 계획 검토가 필요합니다 — 직전 실행: 막힘\(샌드박스\)/);
    assert.match(line(), /\(사용자가 네트워크를 확인한 뒤 다시 실행할 명령: code-agent planning cross --by claude\)$/);
    assert.throws(() => submitPlan(root, join(root, DIR, "plan.json")), /교차 검토/, "사람 판단 없이 중지를 기록하지 않는다 — 게이트가 막혀 있다");
  } finally {
    cross.cleanup();
    rmSync(fake, { recursive: true, force: true });
  }
});
