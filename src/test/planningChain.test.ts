/**
 * 계획 advance 의 다음 행동 한 줄(`next`) — action 별 행동의 원천(C7 OPT-14). 합성 출력으로 표의 행을 하나씩 본다.
 * 실제 advance·연쇄(`--chain`)는 planning.test 의 "C7 — 연쇄" 시험이 본다.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { planningAssignmentCli, planningNextLine, type AdvanceView } from "../agent/planningChain";
import { guidance } from "../agent/retryPolicy";

const base: AdvanceView = { phase: "analysis", action: "dispatch", assignments: [], waiting: [], blocked: [], problems: [] };
const line = (view: Partial<AdvanceView>, chained = false, gate?: Parameters<typeof planningNextLine>[1]["gate"]) =>
  planningNextLine({ ...base, ...view }, { chained, gate, workDir: "doc/work/W-1" });

test("배정 — 한 개면 assignmentFile 과 advance, 여러 개면 함께 호출, 교정 배정은 형식만, 연쇄면 --chain 을 유지한다", () => {
  const one = line({ assignments: [{ taskId: "analysis", assignmentFile: "x.md" }] });
  assert.match(one, /배정 1개를 담당에게 맡긴다\. 프롬프트에는 assignmentFile 경로만 넘기고, 완료 알림을 받으면 code-agent planning advance$/);
  const two = line({ assignments: [{ taskId: "a" }, { taskId: "b", mode: "correction" }] }, true);
  assert.match(two, /한 메시지에서 함께 호출한다 \(mode:correction 배정은 형식만 고친다\)/);
  assert.match(two, /code-agent planning advance --chain$/);
});

test("대기·고아(stale) — 반복 조회 금지와 cancel, 고아 문구는 재시도 규약의 dispatch-orphan 이다", () => {
  assert.match(line({ action: "wait", waiting: ["impact"] }), /실행 중: impact — 완료 알림을 기다린다\. 상태를 반복 조회하지 않는다[\s\S]*code-agent planning cancel <ID> 뒤 code-agent planning advance$/);
  const stale = { action: "stale", stale: [{ id: "design", reason: "시작이 관찰되지 않았다" }], cancel: ["design"] };
  assert.equal(line(stale), guidance("dispatch-orphan", { id: "design", detail: "시작이 관찰되지 않았다" }));
  assert.match(line(stale, true), /planning cancel design 뒤 code-agent planning advance --chain 로 다시 배정합니다/);
  const both = line({ assignments: [{ taskId: "plan" }], stale: [{ id: "a", reason: "r1" }, { id: "b", reason: "r2" }], cancel: ["a", "b"] });
  assert.match(both, /^먼저 cancel 목록 — 배정 a, b의 결과가 기록되지 않았습니다 — a r1; b r2\./);
});

test("되감기 — auto 면 알림 한 줄 뒤 사용자 지시 없이 되감고, auto 가 아니면 보고하고 지시를 받는다", () => {
  const auto = line({ action: "rewind-required", rewind: { phase: "impact", command: "code-agent back impact", auto: true, reason: "입력 변경", notice: "기준 커밋이 바뀌었다" } });
  assert.match(auto, /^먼저 이 한 줄을 사용자에게 알린다\(답을 기다리지 않는다\): 기준 커밋이 바뀌었다 — 그다음 /);
  assert.match(auto, /code-agent back impact 를 실행하고\(같은 사유의 첫 자동 되감기라 사용자 지시 없이 한다\) ca-impact 절차로 잇는다/);
  const manual = line({ action: "rewind-required", rewind: { phase: "impact", command: "code-agent back impact", auto: false, reason: "같은 사유" } });
  assert.match(manual, /자동으로 되감지 않는다/);
  assert.doesNotMatch(manual, /code-agent back/);
});

test("막힘 — 원인이 기록된 항목은 원인의 안내, 사유 둘은 그 두 줄, precondition·class 없음은 일반 문구(연쇄 유지)", () => {
  const total = line({ action: "blocked", blocked: [{ id: "plan", reasons: ["작업 plan의 배정이 총 6회에 닿았습니다"], class: "reassign-total", counter: { key: "taskTotal", used: 6, limit: 6 } }] });
  assert.equal(total, `plan: ${guidance("reassign-total", { id: "plan", limit: 6 })}`);
  const pair = line({ action: "blocked", blocked: [{ id: "analysis", reasons: ["결과 형식 오류", "원인을 해결한 뒤 planning dispatch로 명시적으로 재배정하세요."], class: "agent-format-error" }, { id: "x", reasons: ["y"] }] });
  assert.equal(pair, "analysis: 결과 형식 오류 — 원인을 해결한 뒤 planning dispatch로 명시적으로 재배정하세요. (외 1건 — blocked 참고)");
  const content = line({ action: "blocked", blocked: [{ id: "design", reasons: ["AC 없음"], class: "agent-content-error" }] }, true);
  assert.match(content, /^design: 결과가 검사에 걸려 실패로 기록했습니다 — AC 없음\. [\s\S]*planning prepare 뒤 code-agent planning advance --chain 로 다시 배정하세요\.$/);
  const plain = line({ action: "blocked", blocked: [{ id: "plan", reasons: ["동시 실행 한도"], class: "precondition" }], problems: ["미결 질문 Q1"] }, true);
  assert.match(plain, /^막힘 — blocked·problems 사유를 해결한 뒤 code-agent planning advance --chain \(미결 질문은 ca-answer/);
});

test("막힘 — 막힌 작업 없이 교차 계획 검토만 남았으면 그 줄(명령)이 next 다(E5 — '그대로 전하고 멈춘다' 가 아니다)", () => {
  const cross = "교차 검토: 두 호스트가 설치된 프로젝트라 다른 호스트의 계획 검토가 필요합니다 — code-agent planning cross --by codex (실행할 수 없으면 중지로 기록되고 진행합니다)";
  const next = line({ action: "blocked", phase: "plan", blocked: [], problems: [cross] });
  assert.equal(next, `${cross} — 그다음 code-agent planning advance`);
  assert.doesNotMatch(next, /그대로 전하고 멈춘다/);
  // 막힌 작업이 있으면 그 작업의 안내가 먼저다
  assert.match(line({ action: "blocked", blocked: [{ id: "plan", reasons: ["동시 실행 한도"], class: "precondition" }], problems: [cross] }), /^막힘 —/);
});

test("게이트 — 연쇄 아닌 호출은 code-agent next 와 질문 거부 처리를, plan 은 제출을, 연쇄 결과는 통과·거부를 안내한다", () => {
  const gate = line({ action: "ready-for-gate" });
  assert.match(gate, /^게이트 — code-agent next\./);
  assert.match(gate, /답이 없거나 출처를 확인할 수 없는 질문으로 거부되면 ca-answer 절차로 실제 답을 받은 뒤 code-agent planning advance,/);
  assert.equal(line({ action: "ready-for-gate", phase: "plan" }), "계획 제출 — code-agent plan submit doc/work/W-1/plan.json (ca-plan 끝 절차)");
  const passed = line({ action: "ready-for-gate" }, true, { from: "analysis", gate: "passed", to: "impact" });
  assert.match(passed, /^게이트 통과\(analysis→impact\) — 스테이지는 impact다\. ca-impact 절차를 읽고 그 1항부터 잇는다/);
  const questions = line({ action: "ready-for-gate" }, true, { from: "analysis", gate: "rejected", reason: "답 없음", questions: 2 });
  assert.match(questions, /질문 2개 때문에 게이트\(analysis\)를 지나지 못했다 — ca-answer 절차로 실제 답을 받아 기록한 뒤 code-agent planning advance --chain$/);
  assert.doesNotMatch(questions, /code-agent next/);
  assert.equal(line({ action: "ready-for-gate" }, true, { from: "design", gate: "rejected", reason: "AC 없음" }), "게이트 거부(design) — chain.reason 을 그대로 전하고 멈춘다");
});

test("차단 지적은 어느 행이든 끝에 덧붙이고, 모르는 action 은 출력을 그대로 전하고 멈춘다", () => {
  const feedback = line({ action: "blocked", blocked: [], feedback: [{ from: "critic", citedTask: "design" }] });
  assert.match(feedback, / — 차단 지적 1건: 계약의 수정 피드백으로 고칠 작업을 다시 배정한다[\s\S]*사용자에게 보고하고 지시를 받는다\)$/);
  assert.doesNotMatch(feedback, /code-agent back/);
  assert.equal(line({ action: "bogus" }), "알 수 없는 action(bogus) — 출력을 그대로 전하고 멈춘다");
});

test("모든 줄이 호스트 중립이다 — 스킬 접두어·질문 도구·Bash 표기가 없다", () => {
  const views: Partial<AdvanceView>[] = [
    { assignments: [{ taskId: "a" }] }, { action: "wait", waiting: ["a"] }, { action: "stale", stale: [{ id: "a", reason: "r" }], cancel: ["a"] },
    { action: "rewind-required", rewind: { phase: "analysis", command: "code-agent back analysis", auto: true, reason: "r" } },
    { action: "blocked", blocked: [{ id: "a", reasons: ["r"], class: "same-input-repeat", counter: { limit: 3 } }] }, { action: "ready-for-gate" },
  ];
  for (const view of views) for (const chained of [false, true]) {
    const text = line(view, chained, chained && view.action === "ready-for-gate" ? { from: "analysis", gate: "passed", to: "impact" } : undefined);
    assert.doesNotMatch(text, /(?:^|[\s(])[/$]ca-|AskUserQuestion|Bash:|\{[A-Za-z]\w*\}/, text);
  }
});

test("dispatch·repair 단건 출력은 next 를 더한다 — 재사용 결과면 advance 로 돌아간다", () => {
  assert.match(JSON.parse(planningAssignmentCli(JSON.stringify({ cached: true }))).next, /^현재 입력의 결과가 이미 있다 — code-agent planning advance$/);
  assert.match(JSON.parse(planningAssignmentCli(JSON.stringify({ taskId: "a", mode: "correction", assignmentFile: "x" }))).next, /^이 배정을 담당에게 맡긴다 \(형식만 고친다\) — /);
});
