import { strict as assert } from "node:assert";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { hashManifest } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { back, next, requireValidatable, status, submitPlan } from "../agent/commands";
import { loadEvidence, overFixLimit, saveEvidence } from "../agent/evidence";
import { loadActive, saveActive } from "../agent/layout";
import { check, integrate, runTests } from "../agent/validate";
import { verify } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { RetryRefused } from "../agent/retryPolicy";
import { deadPid } from "./deadPid";
import { ORDER, TEST_FILE, PASS, FAIL, PRINT_CASES, manifest, PLAN, repo, write, writeFileHook, approve, useManifest, toCheck, toIntegrate, createStageRepo, removeStageRepo } from "./stageFixture";

/**
 * 검증 스테이지 — 기준 커밋·check·test·증거 묶임·수정 루프·테스트 동결·검증 hook·되감기·실행별 로그.
 *
 * 임시 git 저장소에 실제 함수를 그대로 부른다.
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */

beforeEach(() => createStageRepo());

afterEach(() => removeStageRepo());

describe("code-agent test", () => {
  test("check 를 먼저 돌리지 않으면 거부한다", async () => {
    toCheck();
    saveActive(repo, { ...loadActive(repo)!, phase: "test" });
    await assert.rejects(() => runTests(requireValidatable(repo, "test")), /code-agent check/);
  });

  test("⑦ 의 TC 를 실행 출력에서 읽는다", async () => {
    useManifest({ test: PRINT_CASES });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.deepEqual(loadEvidence(repo, "ORD-1", "order")!.testCases.map((entry) => entry.source), ["출력", "출력"]);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "review");
  });

  test("테스트 파일에 TC가 있어도 실제 결과가 없으면 진행하지 않는다", async () => {
    useManifest({ test: PASS });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.deepEqual(evidence.testCases.map((entry) => entry.source), ["테스트 파일", "테스트 파일"]);
    assert.deepEqual(evidence.testCases.map((entry) => entry.where), [TEST_FILE, TEST_FILE]);
    assert.throws(() => next(repo), /확인되지 않았습니다/);
  });

  test("check 뒤 계획 파일이 바뀌었으면 test 를 돌리지 않는다 — 통과한 코드로 테스트한 것이 아니다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    await assert.rejects(() => runTests(requireValidatable(repo, "test")), /code-agent check 부터 다시/);
  });

  test("앞 회차의 test 통과로 지금 회차를 덮을 수 없다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));

    // 고쳐 쓰고 check 만 다시 돌린 뒤 test 를 건너뛰는 길
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    saveActive(repo, { ...loadActive(repo)!, phase: "check" });
    await check(requireValidatable(repo, "check"));
    next(repo);
    assert.throws(() => next(repo), /test 결과가 2회차의 것이 아닙니다/);
  });

  test("어디에도 없는 TC 가 있으면 next 가 review 를 열지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1')"] });
    toCheck();
    write(TEST_FILE, "// TC-1 만 있다\nclass OrderTest {}\n");
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.throws(() => next(repo), /확인되지 않았습니다: TC-2/);
  });

  test("명령이 성공해도 skip TC는 테스트 게이트를 열지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1\\nok 2 - TC-2 # SKIP')"] });
    toCheck();
    await check(requireValidatable(repo, "check")); next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.throws(() => next(repo), /TC-2/);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.testCases[1].status, "skipped");
  });

  test("깨끗한 통합 환경에서 생략된 TC를 이전 테스트 통과로 덮지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1\\nok 2 - TC-2'+(require('fs').statSync('.git').isFile()?' # SKIP':''))"] });
    await toIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.testCases[1].status, "passed");
    assert.equal(evidence.integrationTestCases![1].status, "skipped");
    assert.throws(() => next(repo), /TC-2/);
  });
});

// ---- 수정 루프와 동결 ----

describe("수정 루프", () => {
  /** 실패하는 build 로 회차를 원하는 만큼 태운다 */
  async function burnRounds(times: number): Promise<void> {
    for (let round = 0; round < times; round += 1) {
      await check(requireValidatable(repo, "check"));
    }
  }

  beforeEach(() => useManifest({ build: FAIL }));

  test("한도 안에서는 계획 파일을 고칠 수 있고, 남은 회차를 알려 준다", async () => {
    toCheck();
    await burnRounds(1);
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /남은 고쳐 쓰기 1회/);
  });

  test("한도를 넘기면 hook 이 계획 파일 쓰기를 전부 거부하고, 작업 폴더는 남는다", async () => {
    toCheck();
    await burnRounds(3);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 3);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);
    assert.equal(writeFileHook("doc/work/ORD-1/questions.md"), undefined);
    await assert.rejects(() => check(requireValidatable(repo, "check")), /덮지 않고 보고하는 자리/);
    assert.match(status(repo), /고쳐 쓰기 2회를 넘겨 막혔습니다/);
  });

  test("한도는 증거가 시작될 때 굳는다 — 루프 도중에 code-agent.json 으로 올릴 수 없다", async () => {
    toCheck();
    await burnRounds(3);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);

    // fixRounds 는 hashManifest 에 들어가지 않는다(경계도 검증 선언도 아니다) — 그래서 올려도
    // 승인이 그대로라, 매번 매니페스트에서 읽으면 code-agent.json 이 계획 파일인 작업에서 뚫린다
    const before = hashManifest(loadManifest(repo));
    write("code-agent.json", manifest({ build: FAIL, fixRounds: 99 }));
    assert.equal(hashManifest(loadManifest(repo)), before, "한도를 바꿔도 승인은 흔들리지 않는다");
    assert.equal(loadWork(repo)!.manifest.fixRounds, 99);

    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);
    assert.equal(overFixLimit(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order")!), true);
  });

  test("한도를 넘긴 뒤 implement 로 되감아도 계획 파일은 열리지 않는다", async () => {
    toCheck();
    await burnRounds(3);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);

    // 커서를 구현으로 빼는 것은 한도를 되사는 길이 아니다 — 막는 것은 스테이지가 아니라 증거다
    back(repo, "implement");
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);
  });

  test("마지막 고쳐 쓰기 회차의 test 가 끝 기록 없이 끊긴 뒤 고치면 고쳐 쓰기를 쓴다 — 끊어서 피하는 길이 없다", async () => {
    useManifest({ build: PASS, test: FAIL });
    toCheck();
    assert.equal((await verify(repo)).node, "repair");
    assert.equal((await verify(repo, { retry: true })).node, "repair");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 2);
    write(`${ORDER}/domain/Order.java`, "class Order { int v = 3; }\n");
    await check(requireValidatable(repo, "check"));
    // test 가 앞 명령의 로그를 남기고 끊긴 자리 — 시작 표지만 남았다
    const dead = deadPid();
    const third = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(third.rounds, 3);
    saveEvidence(repo, { ...third, retry: { ...third.retry!, started: { phase: "test", round: 3, pid: dead, host: hostname(), at: new Date().toISOString() } } });
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /고쳐 쓰기 2회를 넘겨/);
    write(`${ORDER}/domain/Order.java`, "class Order { int v = 4; }\n");
    await assert.rejects(() => check(requireValidatable(repo, "check")), /덮지 않고 보고하는 자리/);
    assert.match(status(repo), /고쳐 쓰기 2회를 넘겨 막혔습니다/);
    // 고친 것을 되돌리면 같은 코드 재실행이다 — 끊긴 test 를 같은 회차로 다시 돈다
    write(`${ORDER}/domain/Order.java`, "class Order { int v = 3; }\n");
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    const after = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(after.rounds, 3);
    assert.equal(after.retry!.reruns["3"], 1);
    assert.equal(after.retry!.started, undefined);
  });

  test("check 가 회차를 선반영하고 끊긴 뒤 고치면 고쳐 쓰기로 거부되고, 그대로면 같은 회차를 다시 쓴다", async () => {
    useManifest({ build: FAIL, fixRounds: 1 });
    toCheck();
    await check(requireValidatable(repo, "check"));
    const first = loadEvidence(repo, "ORD-1", "order")!;
    saveEvidence(repo, { ...first, rounds: 2, retry: { ...first.retry!, causes: { ...first.retry!.causes, 2: "fix" } } });
    write(`${ORDER}/domain/Order.java`, "class Order { int v = 2; }\n");
    await assert.rejects(() => check(requireValidatable(repo, "check")),
      (error: Error) => error instanceof RetryRefused && error.failure.counter?.key === "fix" && error.failure.origin === "interrupted");
    write(`${ORDER}/domain/Order.java`, "class Order {}\n");
    await check(requireValidatable(repo, "check"));
    const after = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(after.rounds, 2);
    assert.equal(after.retry!.reruns["2"], 1);
  });

  test("계획이 재승인되면 회차와 동결이 함께 풀린다 — 옛 증거는 다른 계획 위의 것이다", async () => {
    toCheck();
    await burnRounds(3);
    write("doc/work/ORD-1/plan.json", JSON.stringify({ ...PLAN, reasoning: "다시 세운 계획" }));
    saveActive(repo, { ...loadActive(repo)!, phase: "plan" });
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    approve();
    saveActive(repo, { ...loadActive(repo)!, phase: "check" });
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
  });
});
