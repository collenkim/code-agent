import { strict as assert } from "node:assert";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { context, next, requireRepairable, requireValidatable } from "../agent/commands";
import { loadEvidence, stageProblems } from "../agent/evidence";
import { decide } from "../agent/hook";
import { openRound } from "../agent/review";
import { repairFileStats, repairProblems, type TestRepair } from "../agent/testRepair";
import { openTestRepair, parseRepairArgs } from "../agent/testRepairCommand";
import { check, integrate } from "../agent/validate";
import { verify } from "../agent/verificationFlow";
import { approvalOf, loadWork } from "../agent/work";
import { readTimeline } from "../agent/timeline";
import { TEST_FILE, repo, write, writeFileHook, writeFindings, useManifest, toCheck, createStageRepo, removeStageRepo } from "./stageFixture";

/**
 * 테스트 수정 창 — 동결된 kind:test 파일의 테스트 구현 오류를 지정 테스트 담당이 제한 범위에서 고치는 길(testRepair.ts·testRepairCommand.ts).
 * 임시 git 저장소의 실제 check·test·hook 을 그대로 부른다. 러너는 테스트 파일에 `isNull` 단언이 있어야 TC-2 를 통과로 찍는다 —
 * 원인 없는 예외에 `getCause()` 타입을 단언한 테스트를 고치는 자리다.
 */
const RUNNER = ["node", "-e",
  `const t=require('fs').readFileSync('${TEST_FILE}','utf-8');console.log('ok 1 - TC-1');const ok=t.includes('isNull');console.log((ok?'ok':'not ok')+' 2 - TC-2');process.exit(ok?0:3)`];
const BROKEN = "// TC-1 · TC-2\nclass OrderTest { void tc2() { assertThat(e.getCause()).isNotInstanceOf(X.class); } }\n";
const FIXED = "// TC-1 · TC-2\nclass OrderTest { void tc2() { assertThat(e.getCause()).isNull(); } }\n";
const REASON = "TC-2 실패 로그: NullPointerException — 원인 없는 예외의 getCause() 에 타입 단언(OrderTest.java:1)";

/**
 * 작업 트리에서는 통과하고 통합 검증의 깨끗한 worktree 에서만 실패하는 러너 — git 이 무시하는 `local-only/` 는 worktree 로 옮겨지지 않는다.
 * 계획의 삭제가 파일만 지워 빈 디렉터리가 worktree 에만 남은 자리와 같은 꼴이다. 단언이 '파일 없음'(isEmpty)이면 어디서나 통과한다.
 */
const WORKTREE_RUNNER = ["node", "-e",
  `const fs=require('fs');const t=fs.readFileSync('${TEST_FILE}','utf-8');console.log('ok 1 - TC-1');const ok=fs.existsSync('local-only')||t.includes('isEmpty');console.log((ok?'ok':'not ok')+' 2 - TC-2');process.exit(ok?0:3)`];

const agentWrite = (file: string, agentType?: string): string | undefined =>
  decide({ cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, file) }, ...(agentType ? { agent_type: agentType, agent_id: `agent-${agentType}` } : {}) });

/** 테스트가 TC-2 로 실패해 동결된 자리(수정 노드) */
async function frozenFailure(): Promise<void> {
  useManifest({ test: RUNNER });
  toCheck();
  write(TEST_FILE, BROKEN);
  assert.equal((await verify(repo)).node, "repair");
  assert.ok(loadEvidence(repo, "ORD-1", "order")!.testFreeze);
}

beforeEach(() => createStageRepo("ca-repair-"));
afterEach(() => removeStageRepo());

describe("테스트 수정 창", () => {
  test("null 원인 단언 하나를 지정 테스트 담당이 고치고 check 가 받아들인다. 계획 승인·계획 작업은 그대로이고 다음 리뷰 회차가 고친 테스트를 본다", async () => {
    await frozenFailure();
    assert.match(writeFileHook(TEST_FILE) ?? "", /code-agent test-repair/, "동결 거부가 창을 안내한다");

    const output = openTestRepair(requireRepairable(repo), parseRepairArgs(["TC-2", "--cause", "assertion", "--reason", REASON]));
    assert.match(output, /테스트 수정 창 #1 을 열었습니다 — TC-2 · 단언 형식·null 처리/);
    assert.match(output, /- 담당: /);
    const handoff = /- 전문: (\S+test-repair-1\.md)/.exec(output)?.[1];
    assert.ok(handoff, output);
    const text = readFileSync(join(repo, handoff), "utf-8");
    assert.match(text, /\| TC-2 \| failed[^|]*\| AC-R2-1 \| 없는 주문 조회 → ORDER_NOT_FOUND \|/);
    assert.match(text, /건너뛰기·조건부 실행 표지/);
    assert.ok(readTimeline(repo).some((event) => event.type === "agent.assigned" && event.detail?.mode === "test-repair"));

    // 창의 파일은 지정 테스트 담당만 — 메인·구현 담당은 막는다
    assert.match(writeFileHook(TEST_FILE) ?? "", /테스트 수정 창 #1 의 파일은 지정 테스트 담당/);
    assert.match(agentWrite(TEST_FILE, "ca-implementer") ?? "", /지정 테스트 담당/);
    assert.equal(agentWrite(TEST_FILE, "ca-tester"), undefined);
    assert.match(context(repo), /테스트 수정 창 #1 — 지정 테스트 담당만/);

    write(TEST_FILE, FIXED);
    assert.equal((await verify(repo)).node, "review");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    const [repair] = evidence.testRepairs!;
    assert.equal(repair.accepted?.round, 2);
    assert.deepEqual(evidence.testFreeze!.rebased!.at(-1), { ...evidence.testFreeze!.rebased!.at(-1)!, by: "repair", files: [TEST_FILE], repair: 1 });
    assert.equal(approvalOf(loadWork(repo)!).status, "approved", "계획 재승인 없이 이어간다");
    assert.match(agentWrite(TEST_FILE, "ca-tester") ?? "", /얼어 있는 파일입니다/, "받아들인 창은 닫힌다");

    // 고친 테스트는 다음 리뷰 회차가 다시 본다(verify 가 통과한 게이트마다 커서를 옮겨 review 에 서 있다)
    openRound(requireValidatable(repo, "review"));
    assert.match(context(repo), /받아들인 테스트 수정 창[\s\S]*창 #1 · 단언 형식·null 처리 · TC-2 — 근거: TC-2 실패 로그[\s\S]*단언 꼴 1 → 1/);
  });

  test("통합 검증 — 깨끗한 worktree 에서만 실패한 빈 디렉터리 단언을 계획을 되감지 않고 고쳐 반영 자리까지 간다", async () => {
    useManifest({ test: WORKTREE_RUNNER });
    appendFileSync(join(repo, ".git/info/exclude"), "\nlocal-only/\n");
    write("local-only/marker", "작업 트리에만 있다\n");
    toCheck();
    write(TEST_FILE, "// TC-1 · TC-2\nclass OrderTest { void tc2() { assertThat(migration).doesNotExist(); } }\n");
    assert.equal((await verify(repo)).node, "review");
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    next(repo);
    assert.match(await integrate(requireValidatable(repo, "integrate")), /TC-2/);
    assert.ok(stageProblems(loadWork(repo)!, "integrate").length > 0, "통합 검증이 막힌다");

    const output = openTestRepair(requireRepairable(repo), parseRepairArgs(["TC-2", "--cause", "filesystem", "--reason",
      "통합 worktree 의 TC-2 실패: 계획의 삭제가 파일만 지워 빈 디렉터리가 남는다 — 단언을 '디렉터리가 없다'에서 '아래에 파일이 없다'로(OrderTest.java:2)"]));
    assert.match(output, /테스트 수정 창 #1 을 열었습니다 — TC-2 · 파일·디렉터리 판정/);
    assert.match(readFileSync(join(repo, /- 전문: (\S+)/.exec(output)![1]), "utf-8"), /\| TC-2 \| passed[^|]*failed[^|]*\|/, "작업 트리 통과와 통합 실패를 함께 싣는다");
    assert.equal(agentWrite(TEST_FILE, "ca-tester"), undefined);
    write(TEST_FILE, "// TC-1 · TC-2\nclass OrderTest { void tc2() { assertThat(filesUnder(migration)).isEmpty(); } }\n");

    // verify 가 통합 검증 자리에서 check 로 되감아 창을 받아들이고 review 까지 — 계획 작업·승인은 그대로다
    assert.equal((await verify(repo)).node, "review");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.testRepairs![0].accepted?.round, 2);
    assert.equal(approvalOf(loadWork(repo)!).status, "approved");
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    next(repo);
    await integrate(requireValidatable(repo, "integrate"));
    assert.deepEqual(stageProblems(loadWork(repo)!, "integrate"), []);
  });

  test("TC 를 끄는 수정(건너뛰기 표지)은 받아들이지 않고 창을 열어 둔다 — 같은 담당이 다시 고치면 받아들인다", async () => {
    await frozenFailure();
    openTestRepair(requireRepairable(repo), parseRepairArgs(["TC-2", "--cause", "assertion", "--reason", REASON]));
    write(TEST_FILE, "// TC-1 · TC-2\nclass OrderTest { @Disabled void tc2() { assertThat(1).isNull(); } }\n");
    await assert.rejects(() => verify(repo), /테스트 수정 창 #1 을 받아들이지 않았습니다\(2회차\): [^\n]*건너뛰기·조건부 실행 표지가 0 → 1개로 늘었습니다/);
    const rejected = loadEvidence(repo, "ORD-1", "order")!.testRepairs![0];
    assert.equal(rejected.rejections?.length, 1);
    assert.equal(rejected.accepted, undefined);
    assert.ok(stageProblems(loadWork(repo)!, "test").some((problem) => /테스트 동결 뒤 바뀐 kind:test 파일/.test(problem)));
    assert.equal(agentWrite(TEST_FILE, "ca-tester"), undefined, "창은 열린 채다");
    assert.throws(() => openTestRepair(requireRepairable(repo), parseRepairArgs(["TC-2", "--cause", "assertion", "--reason", REASON])), /파일이 바뀐 채 열려 있습니다/);

    write(TEST_FILE, FIXED);
    assert.equal((await verify(repo)).node, "review");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.testRepairs![0].accepted?.round, 3);
  });

  test("여는 조건 — 동결 전·⑦ 에 없는 TC·통과한 TC·잘못된 원인은 열지 않고, 고친 것 없는 창은 새 창이 대신한다", async () => {
    useManifest({ test: RUNNER });
    toCheck();
    write(TEST_FILE, BROKEN);
    await check(requireValidatable(repo, "check"));
    assert.throws(() => openTestRepair(requireRepairable(repo), parseRepairArgs(["TC-2", "--cause", "assertion", "--reason", REASON])), /테스트가 아직 얼지 않았습니다/);
    assert.throws(() => parseRepairArgs(["TC-2", "--cause", "expected", "--reason", REASON]), /원인 분류는 assertion\(단언 형식·null 처리\)/);
    assert.throws(() => parseRepairArgs(["TC-2", "--cause", "assertion"]), /사용법: code-agent test-repair/);

    assert.equal((await verify(repo)).node, "repair");
    assert.throws(() => openTestRepair(requireRepairable(repo), parseRepairArgs(["TC-1", "TC-9", "--cause", "assertion", "--reason", REASON])),
      /TC-1: 마지막 실행에서 실패하지 않았습니다\(passed\)[\s\S]*TC-9: ⑦ 에 없는 TC 입니다/);
    openTestRepair(requireRepairable(repo), parseRepairArgs(["TC-2", "--cause", "assertion", "--reason", REASON]));
    openTestRepair(requireRepairable(repo), parseRepairArgs(["TC-2", "--cause", "fixture", "--reason", REASON]));
    const repairs = loadEvidence(repo, "ORD-1", "order")!.testRepairs!;
    assert.deepEqual(repairs.map((repair) => [repair.n, repair.cause, repair.withdrawn?.by]), [[1, "assertion", 2], [2, "fixture", undefined]]);
  });
});

describe("창의 기계 검사", () => {
  const repair = (text: string, cases = ["TC-127"]): TestRepair => ({
    n: 1, at: "2026-10-30T00:00:00.000Z", round: 1, cause: "assertion", reason: "근거", cases, files: ["A.java"], baseline: { "A.java": repairFileStats(text) },
  });
  const BASE = "@Test @DisplayName(\"TC-127\") void a() { assertThat(x).isNotNull(); }\n@Test @DisplayName(\"TC-150\") void b() { assertTrue(List.of(1, null).contains(null)); }\n";

  test("TC 토큰 유지·창의 TC 인식·건너뛰기 표지·파일 삭제를 본다 — 단언을 고쳐 쓴 것은 받아들인다", () => {
    const opened = repair(BASE);
    assert.deepEqual(opened.baseline["A.java"], { tcs: ["TC-127", "TC-150"], skips: 0, asserts: 2 });
    assert.deepEqual(repairProblems(opened, { "A.java": BASE.replace("isNotNull()", "isNull()").replace("List.of(1, null)", "Arrays.asList(1, null)") }), []);
    assert.match(repairProblems(opened, { "A.java": BASE.replace("\"TC-150\"", "\"b\"") }).join("\n"), /TC 토큰이 사라졌습니다\(TC-150\)/);
    assert.match(repairProblems(opened, { "A.java": BASE.replace("@Test @DisplayName(\"TC-127\")", "@Disabled @Test @DisplayName(\"TC-127\")") }).join("\n"), /건너뛰기·조건부 실행 표지가 0 → 1개/);
    assert.match(repairProblems(opened, { "A.java": BASE.replace("void a() {", "void a() { assumeTrue(false);") }).join("\n"), /건너뛰기/);
    assert.match(repairProblems(opened, { "A.java": undefined }).join("\n"), /파일이 없습니다/);
    // 표기 원인 — 창의 TC 가 인식되는 꼴이 되어야 받아들인다
    const notation = repair(BASE.replace("\"TC-127\"", "\"TC_127\""), ["TC-127"]);
    assert.match(repairProblems(notation, { "A.java": BASE.replace("\"TC-127\"", "\"TC_127\"") }).join("\n"), /TC-127: 창의 파일 어디에도 결과 인식 꼴/);
    assert.deepEqual(repairProblems(notation, { "A.java": BASE }), []);
  });
});
