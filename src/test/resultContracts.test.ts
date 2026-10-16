import { strict as assert } from "node:assert";
import { test } from "node:test";
import { root, DIR, SPEC, REQUIREMENTS, PLAN, TESTS, ID, write, dispatch } from "./planningFixture";
import { preparePlanning } from "../agent/planning";
import { observePlanner } from "../agent/planningHook";
import { loadPlanning } from "../agent/planningState";
import { loadWork } from "../agent/work";
import { normalizeReviewTable, reviewResultProblems } from "../agent/crossRecord";
import { planDraftProblems } from "../agent/planningValidation";
import { testSpecProblems } from "../agent/workDocs";
import { normalizeFindings } from "../agent/review";

function pointerResult() {
  preparePlanning(root); const item = dispatch("analysis");
  const event = { cwd: root, session_id: "pointer", agent_id: "writer", agent_type: item.agent };
  observePlanner({ ...event, hook_event_name: "SubagentStart" });
  const value = { ...item.resultShape, status: "completed", summary: "완료", evidence: [{ path: SPEC, line: 1 }], facts: [], questions: [], findings: [], artifacts: [{ path: `${DIR}/01-requirements.md`, content: REQUIREMENTS }] };
  write(item.resultFile, JSON.stringify(value));
  return { item, event, value };
}

test("설명 뒤 단일 결과 포인터는 소유권과 JSON 검사를 거쳐 첫 시도에 완료한다", () => {
  const { item, event } = pointerResult();
  observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: `설계 결과를 기록했습니다\n결과: ${item.resultFile}\n세부 근거는 결과 JSON에 있습니다` });
  const state = loadPlanning(loadWork(root)!);
  assert.equal(state.tasks[0].attempts.at(-1)?.status, "completed");
  assert.equal(state.agents[0].returns ?? 0, 0);
});

for (const kind of ["wrong-path", "multiple", "broken", "schema", "owner", "hash", "size"]) test(`결과 포인터 반례를 성공으로 처리하지 않는다 ${kind}`, () => {
  const { item, event, value } = pointerResult();
  let response = `결과: ${item.resultFile}\n설명`;
  if (kind === "wrong-path") response = `결과: ${SPEC}\n설명`;
  if (kind === "multiple") response += `\n결과: ${item.resultFile}`;
  if (kind === "broken") write(item.resultFile, "{");
  if (kind === "schema") write(item.resultFile, JSON.stringify({ ...value, summary: 5 }));
  if (kind === "owner") write(item.resultFile, JSON.stringify({ ...value, dispatchId: "other" }));
  if (kind === "hash") write(item.resultFile, JSON.stringify({ ...value, inputHash: "0".repeat(64) }));
  if (kind === "size") write(item.resultFile, " ".repeat(500001));
  assert.throws(() => observePlanner({ ...event, hook_event_name: "SubagentStop", last_assistant_message: response }));
  assert.notEqual(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)?.status, "completed");
});

test("리뷰의 검토 위치는 구조화된 설명으로 분리하고 실제 지적은 보존한다", () => {
  const checked = [{ path: "src/a.ts", acceptance: ["AC-R1-1"] }];
  for (const findings of ["- 없음", "| F1 | src/a.ts | 계획 안 | 열림 | 입력 오류를 누락함 |"] ) {
    const result = normalizeReviewTable(JSON.stringify({ findings, checked }), ["src/a.ts"], /^F\d+$/);
    assert.equal(result.body, findings);
    assert.deepEqual(reviewResultProblems(result.body, ["src/a.ts"], /^F\d+$/), []);
  }
});

test("없음과 상충하는 지적과 자유 설명을 버려 성공시키지 않는다", () => {
  const conflict = "- 없음\n| F1 | src/a.ts | 계획 안 | 열림 | 입력 오류 누락 |";
  for (const response of [conflict, "- 없음\n하지만 입력 검증이 누락됐습니다", JSON.stringify({ findings: conflict, checked: [] }),
    JSON.stringify({ findings: "- 없음<!-- 입력 검증 누락 -->", checked: [] }),
    JSON.stringify({ findings: "- 없음", checked: [], explanation: "F1 입력 검증 누락" }),
    JSON.stringify({ findings: "- 없음", checked: [{ path: "src/a.ts", acceptance: ["입력 검증 누락"] }] }),
    JSON.stringify({ findings: "- 없음", checked: [{ path: "outside.ts", acceptance: [] }] })]) {
    const normalized = normalizeReviewTable(normalizeFindings(response), ["src/a.ts"], /^F\d+$/);
    assert.ok(reviewResultProblems(normalized.body, ["src/a.ts"], /^F\d+$/).length);
  }
});

test("실행 가능한 TC와 요구 AC 연결은 통과하고 자기참조 TC와 T2의 AC 누락은 사전 거부한다", () => {
  const work = loadWork(root)!;
  const check = (text: string) => testSpecProblems(root, ID, ["AC-R1-1"], work.manifest, "feature", SPEC, new Map([[`${DIR}/07-test-spec.md`, text]])).problems;
  assert.deepEqual(check(TESTS), []);
  assert.match(check(TESTS.replace("| 호출 | 숫자 반환 |", "| 전체 테스트 통과 | 모든 테스트가 통과한다 |" )).join("\n"), /기능 TC가 아닙니다/);
  assert.match(check(TESTS.replace("| AC-R1-1 | 호출", "| 없음 | 호출")).join("\n"), /연결된 AC가 없습니다/);
  assert.deepEqual(planDraftProblems(work, JSON.stringify(PLAN), ["AC-R1-1"], ["R1"]), []);
  const bad = structuredClone(PLAN); bad.tasks[1].acceptance = ["AC-R2-1"];
  assert.match(planDraftProblems(work, JSON.stringify(bad), ["AC-R1-1"], ["R1"]).join("\n"), /PLN-SEQ.*T2: 담당 요구의 완료 기준이 없습니다/);
});
