/**
 * 계획 배정 예산 구간 — 작업 총 배정은 실행 회차·확정 요구 항목이 정한 구간마다 센다. 이전 구간의 배정은 기록·집계에만 남고,
 * 같은 입력 실패는 구간과 무관하게 막힌다. 사람 허용은 그 구간에만 쓰이고, 구간 표기 없는 이전 허용은 이행한 첫 구간에서만 쓰인다.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadActive, saveActive } from "../agent/layout";
import { budgetEpoch, cancelPlanning, grantPlanningRetry, planningBudget, planningStatus, preparePlanning } from "../agent/planning";
import { loadPlanning, type PlanningState, type TaskAttempt } from "../agent/planningState";
import { budgetReport } from "../agent/retryGrant";
import { epochLabel, grantScopeLabel, planningDispatchDecision, type RetryGrant } from "../agent/retryPolicy";
import { loadWork } from "../agent/work";
import { confirmForTest } from "./confirmedStart";
import { ago, dispatch, editPlanning, root, SPEC, write } from "./planningFixture";

const revised = (lines: string[], title = "값 반환") => `---\nkind: feature\nid: PLAN-1\ntitle: ${title}\ntarget: value\n---\n\n${lines.join("\n")}\n`;
const state = (): PlanningState => loadPlanning(loadWork(root)!);
const analysis = (value: PlanningState) => value.tasks.find((record) => record.task.id === "analysis")!;
const totalOf = () => JSON.parse(planningStatus(root)).tasks.find((task: { id: string }) => task.id === "analysis").budget.taskTotal;
/** 지금 구간 안의 지난 배정 n 건(정상 완료) — 구간 시작을 그보다 앞으로 당긴다 */
function chargeCurrent(count: number, status: TaskAttempt["status"] = "completed"): void {
  editPlanning((value) => {
    value.retry!.since = ago(120);
    value.retry!.epoch!.since = ago(120);
    analysis(value).attempts.push(...Array.from({ length: count }, (_, index) => ({ dispatchId: `past-${index}`, inputHash: `past-${index}`, at: ago(60 - index), status })));
  });
}
const confirm = (lines: string[], title?: string) => { write(SPEC, revised(lines, title)); confirmForTest(root, join(root, SPEC)); };

describe("예산 구간", () => {
  test("같은 구간에서는 정상 완료까지 세어 막고, 머리말만 바뀐 개정도 같은 구간이다. 확정한 요구 항목이 바뀌면 새 구간에서 다시 세고 이전 배정은 집계에만 남는다", () => {
    preparePlanning(root);
    chargeCurrent(6);
    assert.throws(() => dispatch("analysis"), /이 예산 구간에서 총 6회에 닿았습니다/);
    const first = totalOf();
    assert.deepEqual([first.used, first.limit], [6, 6]);
    assert.match(first.epoch, /^실행 회차 1 · 요구 항목 [0-9a-f]{8}$/);
    write(SPEC, readFileSync(join(root, SPEC), "utf8").replace("title: 값 반환", "title: 값 반환 — 제목만 고침"));
    confirmForTest(root, join(root, SPEC));
    preparePlanning(root);
    assert.throws(() => dispatch("analysis"), /이 예산 구간에서 총 6회/, "머리말만 바뀐 개정은 요구 항목이 같아 같은 구간이다");
    assert.equal(state().retry!.epochs, undefined);
    confirm(["값을 반환한다.", "추가 값을 반환한다."]);
    preparePlanning(root);
    const item = dispatch("analysis");
    assert.ok(item.resultShape.dispatchId, "새 구간은 과거 성공 횟수로 허용을 묻지 않는다");
    const second = totalOf();
    assert.deepEqual([second.used, second.limit, second.earlier], [1, 6, 6]);
    assert.notEqual(second.epoch, first.epoch);
    const { epoch, epochs } = state().retry!;
    assert.equal(epochs!.length, 1);
    assert.equal(epochs![0].migrated, undefined, "새 계획 기록의 첫 구간은 이행 구간이 아니다");
    assert.ok(Date.parse(epochs![0].until) <= Date.parse(epoch!.since));
    assert.equal(epoch!.key, budgetEpoch(loadWork(root)!).key);
    assert.equal(analysis(state()).attempts.length, 7, "이전 구간의 배정 기록은 지우지 않는다");
  });

  test("준비 반복·작업 정의 변경·입력 파일 변경은 구간을 바꾸지 않는다", () => {
    preparePlanning(root);
    const key = state().retry!.epoch!.key;
    chargeCurrent(6);
    for (let index = 0; index < 3; index += 1) {
      preparePlanning(root, { tasks: [{ ...analysis(state()).task, title: `다시 준비 ${index}` }] });
      write("src/current.ts", `export const current = ${index + 2};\n`);
      assert.throws(() => dispatch("analysis"), /이 예산 구간에서 총 6회/);
    }
    assert.equal(state().retry!.epoch!.key, key);
    assert.equal(state().retry!.epochs, undefined);
  });

  test("새 실행 회차는 새 구간이다. 요구 항목 기록 전(legacy) 구간은 같은 회차에서 항목을 기록해도 다시 세지 않는다", () => {
    preparePlanning(root);
    chargeCurrent(6);
    editPlanning((value) => { value.retry!.epoch = { key: "c1-legacy", since: ago(120), cycle: 1, migrated: true }; });
    preparePlanning(root);
    assert.match(state().retry!.epoch!.key, /^c1-[0-9a-f]{12}$/);
    assert.equal(state().retry!.epochs, undefined, "legacy → 항목 기록은 같은 구간이다");
    assert.throws(() => dispatch("analysis"), /이 예산 구간에서 총 6회/);
    saveActive(root, { ...loadActive(root)!, cycle: { number: 2, delivered: "0123456789abcdef" } });
    preparePlanning(root);
    assert.match(state().retry!.epoch!.key, /^c2-/);
    assert.ok(dispatch("analysis").resultShape.dispatchId);
    assert.match(totalOf().epoch, /^실행 회차 2 · /);
  });
});

describe("같은 입력 실패", () => {
  test("같은 입력의 실패는 구간과 무관하게 막고, 이전 구간의 허용은 새 구간에서 쓰지 않는다", () => {
    const attempts = Array.from({ length: 3 }, (_, index) => ({ dispatchId: `f-${index}`, inputHash: "same", at: ago(90 - index), status: "failed" }));
    const decide = (grants: RetryGrant[]) => planningDispatchDecision({ attempts, inputHash: "same", since: ago(10), epoch: "c1-newitems000", grants, taskId: "analysis" });
    const refused = decide([]);
    assert.equal(refused.allow, false);
    assert.equal(!refused.allow && refused.failure.class, "same-input-repeat");
    const grant = (scope: string): RetryGrant => ({ key: "sameInput", scope, step: 1, consent: "c", at: ago(50), reason: "사람 허용" });
    assert.equal(decide([grant("planning:analysis:same@c1-olditems000")]).allow, false, "이전 구간의 허용");
    assert.equal(decide([grant("planning:analysis:same")]).allow, false, "구간 표기 없는 이전 형식 허용은 판정 함수가 직접 쓰지 않는다");
    assert.equal(decide([grant("planning:analysis:same@c1-newitems000")]).allow, true);
    assert.equal(planningDispatchDecision({ attempts, inputHash: "other", since: ago(10), epoch: "c1-newitems000", taskId: "analysis" }).allow, true, "입력이 다르면 새로 센다");
  });
});

describe("이행과 사람 허용", () => {
  test("구간 기록이 없는 이전 기록은 이행 시각부터 지금 구간으로 이어받아 사용량이 같고, 구간 표기 없는 이전 허용은 그 구간에서만 쓴다. 새 허용은 지금 구간에 묶인다", () => {
    preparePlanning(root);
    editPlanning((value) => {
      delete value.retry!.epoch;
      value.retry!.since = ago(120);
      analysis(value).attempts.push(...Array.from({ length: 6 }, (_, index) => ({ dispatchId: `old-${index}`, inputHash: `old-${index}`, at: ago(60 - index), status: "completed" as const })));
      value.retry!.grants = [{ key: "taskTotal", scope: "planning:analysis", step: 3, consent: "legacy-consent", at: ago(30), reason: "이전 허용" }];
    });
    const migrated = totalOf();
    assert.deepEqual([migrated.used, migrated.limit, migrated.earlier ?? 0], [6, 9, 0], "이행 전과 같은 사용량·한도");
    assert.ok(dispatch("analysis").resultShape.dispatchId);
    const epoch = state().retry!.epoch!;
    assert.deepEqual([epoch.migrated, epoch.since], [true, state().retry!.since]);
    cancelPlanning(root, "analysis");
    confirm(["값을 반환한다.", "추가 값을 반환한다."]);
    preparePlanning(root);
    editPlanning((value) => { value.retry!.epoch!.since = ago(100); analysis(value).attempts.splice(0, analysis(value).attempts.length,
      ...Array.from({ length: 6 }, (_, index) => ({ dispatchId: `new-${index}`, inputHash: `new-${index}`, at: ago(50 - index), status: "cancelled" as const }))); });
    assert.deepEqual([totalOf().used, totalOf().limit], [6, 6], "이전 형식 허용은 이행한 첫 구간 밖에서 쓰지 않는다");
    assert.match(budgetReport(root, "taskTotal", "analysis"), /지점: 계획 작업 analysis · 실행 회차 1 · 요구 항목 [0-9a-f]{8}/);
    assert.match(grantPlanningRetry(root, "taskTotal", "analysis", "new-consent", "사람 허용"), /6→9회로 늘렸습니다\(실행 회차 1 · 요구 항목 [0-9a-f]{8} 안에서만/);
    const granted = state().retry!.grants.at(-1)!;
    assert.match(granted.scope, /^planning:analysis@c1-[0-9a-f]{12}$/);
    assert.match(grantScopeLabel(granted.scope), /^계획 작업 analysis · 실행 회차 1 · 요구 항목 /);
    assert.equal(planningBudget(root, "analysis").taskTotal.limit, 9);
    confirm(["값을 반환한다.", "추가 값을 반환한다.", "세 번째 값을 반환한다."]);
    preparePlanning(root);
    assert.equal(planningBudget(root, "analysis").taskTotal.limit, 6, "이전 구간의 허용은 새 구간에서 쓰지 않는다");
    assert.equal(epochLabel("c3-legacy"), "실행 회차 3");
  });
});
