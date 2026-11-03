import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import * as build from "../core/build";
import { next, requireValidatable, status, Stop } from "../agent/commands";
import { loadEvidence, runsOf, saveEvidence, stageProblems, validationDocFile, verifyView } from "../agent/evidence";
import { loadActive, saveActive, verifyFile } from "../agent/layout";
import { loadReview, openRound, saveReview } from "../agent/review";
import { check, runTests, tailOf, TAIL_TOTAL_CHARS } from "../agent/validate";
import { verify, verificationFlowFile } from "../agent/verificationFlow";
import type { VerificationHistory } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { RetryRefused } from "../agent/retryPolicy";
import { deadPid } from "./deadPid";
import { ORDER, PRINT_CASES, STRATEGY, repo, write, writeFileHook, useManifest, toCheck, toReview, writeFindings, createStageRepo, removeStageRepo } from "./stageFixture";

beforeEach(() => createStageRepo());
afterEach(() => removeStageRepo());

describe("검증 workflow 회차·증거 보호", () => {
  test("리뷰 지적을 고친 통과 뒤 변경은 고쳐 쓰기가 아니라 리뷰 회차로 센다 (PVR-3)", async () => {
    toCheck();
    assert.equal((await verify(repo)).node, "review");
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${ORDER}/domain/Order.java | 계획 안 | 열림 | 필드가 public 이다 |`);
    write(`${ORDER}/domain/Order.java`, "class Order { private int id; }\n");
    const result = await verify(repo);
    assert.equal(result.node, "review");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.rounds, 2);
    assert.equal(evidence.retry!.causes["2"], "review");
    const budget = verifyView(loadWork(repo)!, evidence).budget;
    assert.equal(budget.fix.used, 0);
    assert.equal(budget.reviewRounds.used, 1);
  });

  test("리뷰 회차는 3회까지다 — 넘으면 verify 는 사람 판단, hook·check·openRound 가 같은 문구로 막는다 (FLOW-06)", async () => {
    toCheck();
    assert.equal((await verify(repo)).node, "review");
    for (let round = 1; round <= 3; round++) {
      openRound(requireValidatable(repo, "review"));
      writeFindings(`| F${round} | ${ORDER}/domain/Order.java | 계획 안 | 열림 | ${round}번째 지적 |`);
      write(`${ORDER}/domain/Order.java`, `class Order { int v = ${round}; }\n`);
      if (round < 3) assert.equal((await verify(repo)).node, "review");
    }
    const result = await verify(repo);
    assert.equal(result.node, "decision");
    assert.equal(result.failure?.counter?.key, "reviewRounds");
    assert.deepEqual([result.failure?.counter?.used, result.failure?.counter?.limit], [3, 3]);
    assert.match(result.problems.join("\n"), /리뷰 회차 한도 3회를 모두 썼습니다/);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /리뷰 회차 한도 3회를 모두 써서/);
    await assert.rejects(() => check(requireValidatable(repo, "check")),
      (error: Error) => error instanceof RetryRefused && /리뷰 회차 한도 3회/.test(error.message));
    assert.match(status(repo), /리뷰 회차 한도 3회를 모두 써서 막혔습니다/);
    // 회차를 여는 자리도 같은 판정이다 — 같은 트리 거부를 피하려고 3회차의 트리 해시를 바꿔 둔다
    write(`${ORDER}/domain/Order.java`, "class Order { int v = 2; }\n");
    saveActive(repo, { ...loadActive(repo)!, phase: "review" });
    const log = loadReview(repo, "ORD-1", "order")!;
    saveReview(repo, { ...log, rounds: log.rounds.map((round, index) => index === 2 ? { ...round, treeHash: "sha256:fake" } : round) });
    assert.throws(() => openRound(requireValidatable(repo, "review")),
      (error: Error) => error instanceof RetryRefused && /리뷰 회차 한도 3회/.test(error.message));
  });

  test("통과한 회차 뒤의 변경은 고쳐 쓰기 한도를 쓰지 않는다 — 통과 세 번 뒤의 실패도 수정 요청이다 (PVR-3)", async () => {
    useManifest({ build: ["node", "-e", `process.exit(require('fs').readFileSync('${ORDER}/domain/Order.java','utf-8').includes('broken') ? 3 : 0)`] });
    toCheck();
    assert.equal((await verify(repo)).node, "review");
    for (const version of [2, 3]) {
      write(`${ORDER}/domain/Order.java`, `class Order { int v = ${version}; }\n`);
      assert.equal((await verify(repo)).node, "review");
    }
    write(`${ORDER}/domain/Order.java`, "class Order { broken }\n");
    const result = await verify(repo);
    assert.equal(result.node, "repair");
    assert.equal(result.budget?.fix.left, 2);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 4);
  });

  test("실패한 TC 가 함께 찍힌 실행은 선언된 환경 문구가 있어도 환경이 아니다 (PVR-4)", async () => {
    useManifest({
      test: ["node", "-e", "console.log('not ok 1 - TC-1');console.log('ok 2 - TC-2');console.error('Connection refused: localhost:5432 (cache, retrying)');process.exit(1)"],
      environmentErrors: ["Connection refused: localhost:5432"],
    });
    toCheck();
    assert.equal((await verify(repo)).node, "repair");
    const run = runsOf(loadEvidence(repo, "ORD-1", "order")!, "test")[0];
    assert.equal(run.outcome, "failed");
    assert.equal(run.environment, undefined);
    assert.equal(run.cause, undefined);
  });

  test("명령 시간 초과는 원인 필드로 남고 같은 회차를 다시 쓴다 — 재실행 2회 뒤 사람 판단 (PVR-17)", async () => {
    const original = build.runCommand;
    // test 명령만 제한 시간 초과로 끝난 것처럼 돌려준다(실제 시간 초과는 최소 1분이라 느리다)
    mock.method(build, "runCommand", async (cwd: string, argv: string[], env?: NodeJS.ProcessEnv, timeout?: number): Promise<build.CommandResult> =>
      argv.join(" ") === PRINT_CASES.join(" ")
        ? { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: new Error("제한 시간 600초를 넘겨 중단했습니다 — 더 걸리는 명령이면 code-agent.json 의 commandTimeoutMinutes 를 늘리세요"), timedOut: true }
        : original(cwd, argv, env, timeout));
    try {
      toCheck();
      const first = await verify(repo);
      assert.equal(first.node, "diagnose");
      assert.equal(first.failure?.class, "interrupted");
      assert.match(first.task, /제한 시간 10분을 넘겨 중단됐습니다/);
      assert.equal(runsOf(loadEvidence(repo, "ORD-1", "order")!, "test")[0].cause, "timeout");
      assert.equal((await verify(repo, { retry: true })).node, "diagnose");
      const second = await verify(repo, { retry: true });
      assert.equal(second.node, "decision");
      assert.equal(second.failure?.counter?.key, "rerun");
      const at = runsOf(loadEvidence(repo, "ORD-1", "order")!, "test")[0].at;
      assert.equal((await verify(repo, { retry: true })).node, "decision");
      assert.equal(runsOf(loadEvidence(repo, "ORD-1", "order")!, "test")[0].at, at, "거부는 실행하지 않는다");
      assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1);
    } finally {
      mock.restoreAll();
    }
  });

  test("retry 가 없는 옛 증거는 읽을 때 추정하고 다음 check 가 기록한다 — 총 회차 유예 1회 (이행)", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    const fresh = loadEvidence(repo, "ORD-1", "order")!;
    const base = fresh.runs[0];
    const { retry: _retry, ...legacy } = {
      ...fresh, rounds: 3,
      runs: [{ ...base, round: 1, outcome: "failed" as const }, { ...base, round: 2, outcome: "failed" as const }, { ...base, round: 3 }],
    };
    saveEvidence(repo, legacy);
    const view = verifyView(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order")!);
    assert.equal(view.budget.fix.used, 2);
    assert.equal(view.budget.totalRounds.limit, 7);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry, undefined, "읽기는 기록하지 않는다");
    await check(requireValidatable(repo, "check"));
    const migrated = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(migrated.rounds, 3, "통과한 같은 트리는 그 회차를 다시 쓴다");
    assert.equal(migrated.retry!.legacyRounds, 3);
    assert.deepEqual(migrated.retry!.causes, { 1: "first", 2: "fix", 3: "fix" });
  });

  test("limit 이 없는 옛 리뷰 기록은 한 회차 유예를 받고, 회차를 열 때 한도를 고정한다 (이행)", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const log = loadReview(repo, "ORD-1", "order")!;
    const round = log.rounds[0];
    saveReview(repo, { id: log.id, target: log.target, used: [],
      rounds: [1, 2, 3, 4].map((n) => ({ ...round, round: n, treeHash: `sha256:fake${n}` })) });
    assert.match(openRound(requireValidatable(repo, "review")), /리뷰 회차 5\/5/);
    const saved = loadReview(repo, "ORD-1", "order")!;
    assert.equal(saved.rounds.length, 5);
    assert.equal(saved.limit, 5);
    saveReview(repo, { ...saved, rounds: saved.rounds.map((entry) => entry.round === 5 ? { ...entry, treeHash: "sha256:fake5" } : entry) });
    assert.throws(() => openRound(requireValidatable(repo, "review")),
      (error: Error) => error instanceof RetryRefused && /리뷰 회차 한도 5회/.test(error.message));
  });

  test("검증 명령이 계획 파일을 고쳐 대조만 어긋나면 진단이고, 다시 돌면 통과 뒤 변경으로 맞춰진다", async () => {
    // 포맷터 모사 — Order.java 끝에 표시를 붙인다. 한 번 붙으면 더 바꾸지 않는다
    useManifest({ build: ["node", "-e", `const f='${ORDER}/domain/Order.java',fs=require('fs'),t=fs.readFileSync(f,'utf-8');if(!t.includes('// fmt'))fs.writeFileSync(f,t+'// fmt\\n')`] });
    toCheck();
    const first = await verify(repo);
    assert.equal(first.node, "diagnose");
    assert.equal(first.failure?.class, "precondition");
    assert.match(first.problems.join("\n"), /검증 뒤 계획 파일이 바뀌었습니다/);
    assert.match(first.task, /다시 돌리면 맞춰집니다/);
    const second = await verify(repo);
    assert.equal(second.node, "review");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.retry!.causes["2"], "review");
    assert.equal(verifyView(loadWork(repo)!, evidence).budget.fix.used, 0);
  });

  test("다시 돌려도 남는 게이트 문제(계획 밖 변경)는 노드 없이 Stop 이다", async () => {
    useManifest({ build: ["node", "-e", "require('fs').writeFileSync('out.txt','x')"] });
    toCheck();
    await assert.rejects(verify(repo), (error: Error) => error instanceof Stop && /검증 전제가 맞지 않습니다[\s\S]*계획 밖 변경/.test(error.message));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 1);
  });

  test("check 실행 도중 중단된 회차 — 코드가 그대로면 그 회차를 다시 쓰고, 고쳤으면 새 회차로 센다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    evidence.rounds += 1; // 다음 check가 회차를 저장한 직후, 실행 결과를 남기기 전의 상태
    writeFileSync(verifyFile(repo, "ORD-1", "order"), JSON.stringify(evidence));
    assert.equal((await verify(repo)).node, "review");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 2, "끊긴 회차는 되돌리지도 늘리지도 않고 다시 쓴다");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry!.reruns["2"], 1, "같은 코드 재실행으로 센다");
    // 끊긴 뒤 코드를 고쳤으면 새 회차다 — 끊어서 카운터를 피하는 길이 없다
    const interrupted = loadEvidence(repo, "ORD-1", "order")!;
    writeFileSync(verifyFile(repo, "ORD-1", "order"), JSON.stringify({ ...interrupted, rounds: interrupted.rounds + 1 }));
    write(`${ORDER}/domain/Order.java`, "package x; class Order { int v = 2; }\n");
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 4);
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry!.causes["4"], "fix", "끊긴 뒤 고친 것은 고쳐 쓰기다");
  });

  test("명령 미선언은 진단 요청이 아니라 전제 미충족 Stop 이며 테스트 통과로 처리하지 않는다", async () => {
    write("doc/test-strategy.md", STRATEGY.replace("- `test`: 전체 테스트", "- 없음 — 실행 명령 준비 전"));
    useManifest({ test: undefined });
    toCheck();
    await assert.rejects(verify(repo), (error: Error) => error instanceof Stop && /검증 전제가 맞지 않습니다[\s\S]*not-run/.test(error.message));
    assert.equal(loadActive(repo)!.phase, "test");
  });

  test("test 실행 전 저장도 ⑧ 을 렌더한다 — 끊긴 test 뒤 verify 는 ⑧ 불일치가 아니라 끊긴 test 로 간다", async () => {
    const ENV_FAIL = ["node", "-e", "console.error('Connection refused: db');process.exit(1)"];
    useManifest({
      build: ["node", "-e", `process.exit(require('fs').readFileSync('${ORDER}/domain/Order.java','utf-8').includes('fixed') ? 0 : 3)`],
      test: ENV_FAIL, environmentErrors: ["Connection refused"],
    });
    toCheck();
    assert.equal((await verify(repo)).node, "repair");
    write(`${ORDER}/domain/Order.java`, "class Order { /* fixed */ }\n");
    assert.equal((await verify(repo)).node, "diagnose", "2회차 test 가 환경으로 실패했다");
    // 같은 코드 재실행이 명령 도중 끊긴다(셸 시간 제한 모사) — 실행 전 저장(재실행 수·시작 표지)만 남는다
    const original = build.runCommand;
    mock.method(build, "runCommand", async (cwd: string, argv: string[], env?: NodeJS.ProcessEnv, timeout?: number): Promise<build.CommandResult> => {
      if (argv.join(" ") === ENV_FAIL.join(" ")) throw new Error("끊김 모사");
      return original(cwd, argv, env, timeout);
    });
    try {
      await assert.rejects(() => runTests(requireValidatable(repo, "test")), /끊김 모사/);
    } finally {
      mock.restoreAll();
    }
    const cut = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(cut.retry!.reruns["2"], 1);
    assert.equal(cut.retry!.started?.phase, "test");
    assert.deepEqual(stageProblems(loadWork(repo)!, "check"), [], "⑧ 이 증거와 같다 — 재실행 수가 렌더돼 있다");
    // 끊긴 test 를 같은 회차로 다시 돈다 — 원인이 ⑧ 불일치(precondition)로 가려지지 않는다
    const result = await verify(repo);
    assert.equal(result.node, "decision");
    assert.equal(result.failure?.counter?.key, "rerun");
    assert.equal(result.failure?.origin, "environment");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry!.reruns["2"], 2);
    const history = JSON.parse(readFileSync(verificationFlowFile(loadWork(repo)!), "utf8")) as VerificationHistory;
    assert.ok(history.attempts.at(-1)!.events.some((event) => event.node === "test.execute" && event.status === "completed"));
  });

  test("⑧ 만 증거와 다르면 진단이고 verify --retry 가 다시 렌더한다 — 고쳐 쓰기·재실행을 쓰지 않는다", async () => {
    toCheck();
    assert.equal((await verify(repo)).node, "review");
    const doc = join(repo, validationDocFile("ORD-1"));
    writeFileSync(doc, `${readFileSync(doc, "utf-8")}\n손으로 덧붙인 줄\n`);
    // 판정부터 들어가는 plain verify 는 ⑧ 을 다시 렌더하지 않는다 — 안내는 check 부터 다시 도는 --retry 다
    const first = await verify(repo);
    assert.equal(first.node, "diagnose");
    assert.equal(first.failure?.class, "precondition");
    assert.equal(first.resume, "code-agent verify --retry");
    assert.match(first.task, /code-agent verify --retry 로 check 부터 다시 돌리면 맞춰집니다/);
    const second = await verify(repo, { retry: true });
    assert.equal(second.node, "review");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.rounds, 1, "같은 트리라 그 회차를 다시 쓴다");
    assert.equal(evidence.retry!.reruns["1"] ?? 0, 0, "통과한 회차의 재사용은 재실행을 쓰지 않는다");
    assert.deepEqual(stageProblems(loadWork(repo)!, "check"), []);
  });

  test("환경으로 실패한 test 를 같은 코드 check 로 지운 뒤 고치면 고쳐 쓰기다 — 지운 test 상태가 판정에 남는다", async () => {
    useManifest({ test: ["node", "-e", "console.error('Connection refused: db');process.exit(1)"], environmentErrors: ["Connection refused"] });
    toCheck();
    assert.equal((await verify(repo)).node, "diagnose");
    await check(requireValidatable(repo, "check"));
    const reused = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(reused.rounds, 1);
    assert.equal(reused.retry!.reruns["1"], 1);
    assert.equal(runsOf(reused, "test").length, 0, "같은 회차 재사용은 그 회차 test 기록을 비운다");
    assert.deepEqual(reused.retry!.wiped, { test: { round: 1, state: "environment" } });
    // 지운 뒤 앞 회차를 이어받으면 통과 뒤 변경(review)으로 세어 고쳐 쓰기를 피한다
    write(`${ORDER}/domain/Order.java`, "class Order { int v = 1; }\n");
    await check(requireValidatable(repo, "check"));
    const after = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(after.retry!.causes["2"], "fix");
    assert.equal(verifyView(loadWork(repo)!, after).budget.fix.used, 1);
    // test 가 다시 돌면 지운 상태는 그 실행의 기록으로 바뀐다
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry!.wiped, undefined);
  });

  test("끊긴 test 를 같은 코드 check 로 다시 쓴 뒤 고쳐도 고쳐 쓰기다 — 끊고 check 로 지워 카운터를 피하는 길이 없다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    const dead = deadPid();
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    saveEvidence(repo, { ...evidence, retry: { ...evidence.retry!, started: { phase: "test", round: 1, pid: dead, host: hostname(), at: new Date().toISOString() } } });
    await check(requireValidatable(repo, "check"));
    const reused = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(reused.retry!.started, undefined);
    assert.deepEqual(reused.retry!.wiped, { test: { round: 1, state: "interrupted" } });
    write(`${ORDER}/domain/Order.java`, "class Order { int v = 1; }\n");
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.retry!.causes["2"], "fix");
  });
});


test("실패 꼬리는 줄마다 ${TAIL_LINE_CHARS}자, 전체 ${TAIL_TOTAL_CHARS}자로 자르고 끝 줄을 남긴다 — 전문은 로그 파일", () => {
  const huge = "x".repeat(30_000);
  const one = tailOf(`앞\n${huge}\n마지막 오류`, 40);
  assert.ok(one.length < 400, String(one.length));
  assert.match(one, /… \(29700자 생략\)\n마지막 오류$/);
  const many = tailOf(Array.from({ length: 40 }, (_, index) => `${index}:${"y".repeat(250)}`).join("\n"), 40);
  assert.ok(many.length <= TAIL_TOTAL_CHARS + 40, String(many.length));
  assert.match(many, /^… \(앞 \d+줄 생략\)\n/);
  assert.ok(many.endsWith(`39:${"y".repeat(250)}`));
  assert.equal(tailOf("a\nb\nc", 2), "b\nc");
});
