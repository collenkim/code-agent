import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { next, requireValidatable } from "../agent/commands";
import { loadEvidence, runsOf, saveEvidence } from "../agent/evidence";
import { loadActive, saveActive } from "../agent/layout";
import { check } from "../agent/validate";
import { verify, verificationFlowFile } from "../agent/verificationFlow";
import type { VerificationHistory } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { grantScope } from "../agent/retryPolicy";
import { readRuntime, selectRuntime } from "../agent/runtimeSelect";
import { ORDER, TEST_FILE, PASS, FAIL, NOT_INSTALLED, FAIL_UNTIL_FIXED, DESIGN, repo, write, hook, writeFileHook, useManifest, toCheck, createStageRepo, removeStageRepo } from "./stageFixture";

beforeEach(() => createStageRepo());
afterEach(() => removeStageRepo());

describe("검증 workflow 노드·재개", () => {
  test("한 번 호출로 check·test·게이트를 실행하고 리뷰에 인계한다", async () => {
    toCheck();
    // 상태 세대는 릴리스 적용의 내림을 막는다. 고정 없는 이전 작업의 읽기를 막지는 않는다.
    assert.equal(readRuntime(repo), undefined);
    assert.equal(loadActive(repo)!.planningVersion, undefined);
    assert.equal(selectRuntime("hook", [], true, () => JSON.stringify({ cwd: repo }), {}).kind, "self");
    assert.equal(hook("Bash", { command: "code-agent verify --json" }), undefined);
    const result = await verify(repo);
    assert.equal(result.node, "review");
    assert.equal(loadActive(repo)!.phase, "review");
    assert.equal(result.executor, "agent");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1);
    const history = JSON.parse(readFileSync(verificationFlowFile(loadWork(repo)!), "utf8")) as VerificationHistory;
    assert.deepEqual(history.attempts[0].events.filter((event) => event.status === "completed").map((event) => event.node),
      ["check.execute", "check.assess", "test.select", "test.execute", "test.assess"]);
    assert.equal(history.attempts[0].result?.node, "review");
    await verify(repo);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1, "통과 후 재개는 재실행하지 않는다");
  });

  test("테스트 실패는 수정 요청으로, 수정 후에는 check부터 재검증한다", async () => {
    useManifest({ test: FAIL_UNTIL_FIXED });
    toCheck();
    assert.equal((await verify(repo)).node, "repair");
    assert.equal(loadActive(repo)!.phase, "test");
    assert.equal((await verify(repo)).node, "repair");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1, "변경 없는 실패를 자동 반복하지 않는다");
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는/);
    write(`${ORDER}/domain/Order.java`, "class Order {} // fixed\n");
    assert.equal((await verify(repo)).node, "review");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.rounds, 2);
    assert.equal(runsOf(evidence, "check")[0].round, 2);
    assert.equal(runsOf(evidence, "test")[0].round, 2);
  });

  test("선언된 환경 오류는 수정이 아니라 진단으로 가고, 코드 그대로의 재실행은 회차를 쓰지 않는다 — 재실행은 회차당 2회", async () => {
    const DOCKER = "Could not find a valid Docker environment";
    // 환경(여기서는 환경 변수)이 준비될 때까지 같은 문구로 실패하는 테스트
    useManifest({
      test: ["node", "-e", `if(!process.env.CA_FAKE_DOCKER){console.error('${DOCKER}');process.exit(1)}console.log('ok 1 - TC-1\\nok 2 - TC-2')`],
      environmentErrors: [DOCKER],
    });
    toCheck();
    try {
      const first = await verify(repo);
      assert.equal(first.node, "diagnose");
      assert.equal(first.failure?.class, "environment");
      const failed = runsOf(loadEvidence(repo, "ORD-1", "order")!, "test")[0];
      assert.equal(failed.outcome, "error");
      assert.equal(failed.environment, DOCKER);
      assert.equal(failed.cause, "environment");
      assert.match(failed.tail, /환경 오류: 출력에 선언된 문구/);
      // 1회째 재실행은 진단, 2회째 재실행도 실패하면 사람 판단 — 고쳐 쓰기 회차는 쓰지 않는다
      assert.equal((await verify(repo, { retry: true })).node, "diagnose");
      assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry!.reruns["1"], 1);
      const second = await verify(repo, { retry: true });
      assert.equal(second.node, "decision");
      assert.equal(second.failure?.counter?.key, "rerun");
      assert.equal(second.failure?.origin, "environment");
      assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry!.reruns["1"], 2);
      // 3회째는 check() 가 실행 전에 거부한다 — 실행 기록이 그대로다
      const at = runsOf(loadEvidence(repo, "ORD-1", "order")!, "test")[0].at;
      const third = await verify(repo, { retry: true });
      assert.equal(third.node, "decision");
      assert.match(third.problems.join("\n"), /같은 코드 재실행 한도 2회를 모두 썼습니다/);
      const refused = loadEvidence(repo, "ORD-1", "order")!;
      assert.equal(runsOf(refused, "test")[0].at, at, "거부는 실행하지 않는다");
      assert.equal(refused.retry!.reruns["1"], 2);
      assert.equal(refused.rounds, 1, "코드 그대로의 재실행은 회차를 쓰지 않는다");
      // 사람이 한 번 더 허용한다(judgment 동의 모사) — 그 회차의 재실행 한도가 하나 는다
      saveEvidence(repo, { ...refused, retry: { ...refused.retry!, grants: [{ key: "rerun", scope: grantScope({ file: "verify", key: "rerun", round: 1 }), step: 1, consent: "fixture", at: new Date().toISOString(), reason: "환경 확인" }] } });
      process.env.CA_FAKE_DOCKER = "1";
      assert.equal((await verify(repo, { retry: true })).node, "review");
      const evidence = loadEvidence(repo, "ORD-1", "order")!;
      assert.equal(evidence.rounds, 1);
      assert.equal(evidence.retry!.reruns["1"], 3);
      assert.deepEqual(runsOf(evidence, "test").map((run) => run.outcome), ["passed"], "환경 오류 회차의 옛 기록은 남지 않는다");
    } finally {
      delete process.env.CA_FAKE_DOCKER;
    }
  });

  test("선언되지 않은 실패나 패턴과 다른 출력은 지금처럼 수정 요청이다", async () => {
    useManifest({ test: FAIL_UNTIL_FIXED, environmentErrors: ["Could not find a valid Docker environment"] });
    toCheck();
    assert.equal((await verify(repo)).node, "repair");
    assert.equal(runsOf(loadEvidence(repo, "ORD-1", "order")!, "test")[0].environment, undefined);
  });

  test("check 실패 시 테스트를 실행하지 않는다", async () => {
    useManifest({ build: FAIL });
    toCheck();
    assert.equal((await verify(repo)).node, "repair");
    assert.equal(loadActive(repo)!.phase, "check");
    assert.equal(runsOf(loadEvidence(repo, "ORD-1", "order")!, "test").length, 0);
  });

  test("실행 오류·명령 미선언·TC 결과 미확인은 진단 요청이며 통과가 아니다", async () => {
    useManifest({ build: NOT_INSTALLED });
    toCheck();
    const result = await verify(repo);
    assert.equal(result.node, "diagnose");
    assert.equal(result.resume, "code-agent verify --retry");
    assert.match(result.problems.join("\n"), /error/);
  });

  test("TC 미확인 재실행은 회차를 쓰지 않고 재실행 2회 뒤 사람 판단으로 간다", async () => {
    useManifest({ test: PASS, fixRounds: 1 });
    toCheck();
    const first = await verify(repo);
    assert.equal(first.node, "diagnose");
    assert.equal(first.failure?.class, "result-unconfirmed");
    assert.match(first.task, /수집 수정 회차라 고쳐 쓰기 회차를 쓰지 않고/);
    assert.equal((await verify(repo, { retry: true })).node, "diagnose");
    assert.equal((await verify(repo, { retry: true })).node, "diagnose", "수집 수정이 남아 있어 재실행이 소진돼도 진단이다");
    const result = await verify(repo, { retry: true });
    assert.equal(result.node, "decision");
    assert.equal(result.executor, "human");
    assert.equal(result.resume, "/ca-answer");
    assert.equal(result.failure?.origin, "result-unconfirmed");
    assert.match(result.problems.join("\n"), /같은 코드 재실행 한도 2회/);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1);
    // 결과 수집을 고치는 길(수집 수정 회차)은 남아 있다
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
  });

  test("수정 한도를 사용한 뒤 트리가 바뀌어도 더 실행하지 않는다", async () => {
    useManifest({ test: FAIL_UNTIL_FIXED, fixRounds: 1 });
    toCheck();
    assert.equal((await verify(repo)).node, "repair");
    assert.equal((await verify(repo, { retry: true })).node, "decision");
    write(`${ORDER}/domain/Order.java`, "class Order {} // fixed\n");
    assert.equal((await verify(repo)).node, "decision");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 2);
  });

  test("check 완료 직후 중단돼도 같은 회차로 test부터 이어간다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.equal((await verify(repo)).node, "review");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1);
  });

  test("이전 회차 test 통과로 현재 회차 test를 건너뛰지 않는다", async () => {
    toCheck();
    await verify(repo);
    await check(requireValidatable(repo, "check"));
    assert.equal((await verify(repo)).node, "review");
    // 통과한 같은 트리의 check 는 그 회차를 다시 쓰며 그 회차의 test 기록을 비운다 — test 가 다시 돈다
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1);
    const history = JSON.parse(readFileSync(verificationFlowFile(loadWork(repo)!), "utf8")) as VerificationHistory;
    assert.ok(history.attempts[1].events.some((event) => event.node === "test.execute" && event.status === "completed"));
  });

  test("명시적 retry는 변경 없는 환경 문제도 check부터 다시 실행한다", async () => {
    useManifest({ test: PASS });
    toCheck();
    assert.equal((await verify(repo)).node, "diagnose");
    assert.equal((await verify(repo, { retry: true })).node, "diagnose");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.rounds, 1, "같은 코드 재실행은 회차를 다시 쓴다");
    assert.equal(evidence.retry!.reruns["1"], 1);
    const history = JSON.parse(readFileSync(verificationFlowFile(loadWork(repo)!), "utf8")) as VerificationHistory;
    assert.ok(history.attempts[1].events.some((event) => event.node === "check.execute" && event.status === "completed"));
  });

  test("H8: 실행 기록 없이 끊긴 회차는 계획 파일이 그대로면 같은 회차로 다시 돈다 — 한도만 줄지 않는다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    const before = loadEvidence(repo, "ORD-1", "order")!;
    // 도구 타임아웃으로 check 가 회차만 올리고 끊긴 자리
    saveEvidence(repo, { ...before, rounds: before.rounds + 1 });
    await check(requireValidatable(repo, "check"));
    const after = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(after.rounds, before.rounds + 1);
    assert.ok(runsOf(after, "check").some((run) => run.round === after.rounds));
    // 기록이 남은 통과 회차 뒤의 같은 트리 재실행은 그 회차를 다시 쓴다
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, before.rounds + 1);
  });

  test("계획 밖 변경과 오래된 승인을 자동 실행기로 우회하지 못한다", async () => {
    toCheck();
    write("outside.txt", "unexpected");
    await assert.rejects(verify(repo), /계획.*어긋나/);
    assert.equal(loadEvidence(repo, "ORD-1", "order"), undefined);
    const history = JSON.parse(readFileSync(verificationFlowFile(loadWork(repo)!), "utf8")) as VerificationHistory;
    assert.equal(history.attempts[0].events.at(-1)?.status, "error");
    write("doc/work/ORD-1/03-design.md", `${DESIGN}\n변경\n`);
    await assert.rejects(verify(repo), /승인되지 않았습니다/);
  });

  test("미응답 질문이 있으면 실행하지 않는다", async () => {
    toCheck();
    write("doc/work/ORD-1/questions.md", "## Q1\n질문: 범위?\n");
    await assert.rejects(verify(repo), /질문/);
    assert.equal(loadEvidence(repo, "ORD-1", "order"), undefined);
  });

  test("손상된 노드 이력은 통과나 재실행 근거로 사용하지 않는다", async () => {
    toCheck();
    writeFileSync(verificationFlowFile(loadWork(repo)!), "{");
    await assert.rejects(verify(repo), /노드 이력/);
    assert.equal(loadEvidence(repo, "ORD-1", "order"), undefined);
  });

  test("실패한 단계의 next 거부는 단계 명령이 아니라 status 와 같은 재개(verify --json)를 안내한다", async () => {
    useManifest({ test: FAIL_UNTIL_FIXED });
    toCheck();
    assert.equal((await verify(repo)).node, "repair");
    saveActive(repo, { ...loadActive(repo)!, phase: "test" });
    assert.throws(() => next(repo), (error: Error) => /\n다음: .*code-agent verify --json/.test(error.message) && !/code-agent test 로 다시 돌리세요/.test(error.message), "next");
  });

  test("CLI JSON과 종료 코드는 통과·수정 요청을 구분한다", () => {
    useManifest({ test: FAIL_UNTIL_FIXED });
    toCheck();
    const cli = join(__dirname, "../agent/cli.js");
    const failed = spawnSync(process.execPath, [cli, "verify", "--json"], { cwd: repo, encoding: "utf8" });
    assert.equal(failed.status, 1, failed.stderr);
    const repair = JSON.parse(failed.stdout);
    assert.equal(repair.node, "repair");
    // 원인과 남은 회차가 결과 JSON 에 실린다
    assert.equal(repair.failure.class, "code-defect");
    // 남은 회차는 budget 문장 한 곳이다 — task·summaries(단계 출력의 다음 할 일 줄)에 되풀이하지 않는다
    assert.match(repair.budget, /^남은 고쳐 쓰기 \d+회/);
    assert.equal(failed.stdout.split("남은 고쳐 쓰기").length - 1, 1, failed.stdout);
    assert.ok(!repair.summaries.some((text: string) => text.includes("code-agent verify 로 다시 검증하세요")), repair.summaries.join("\n"));
    write(`${ORDER}/domain/Order.java`, "class Order {} // fixed\n");
    const passed = spawnSync(process.execPath, [cli, "verify", "--json"], { cwd: repo, encoding: "utf8" });
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).node, "review");
    const invalid = spawnSync(process.execPath, [cli, "verify", "--force"], { cwd: repo, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /사용법/);
  });
});
