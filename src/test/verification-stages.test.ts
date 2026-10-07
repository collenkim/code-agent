import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { hashManifest } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { back, context, next, requireValidatable, status, Stop, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { loadEvidence, overFixLimit, saveEvidence, stageProblems, validationDocFile, verifyView } from "../agent/evidence";
import { loadActive, saveActive } from "../agent/layout";
import { loadReview, openRound, reviewDocFile } from "../agent/review";
import { observeReviewer } from "../agent/reviewHook";
import { changedPaths, commitOf, partialTreeHash } from "../agent/tree";
import { check, integrate, runTests } from "../agent/validate";
import { verify } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { RetryRefused } from "../agent/retryPolicy";

/**
 * 검증 스테이지 — 기준 커밋·check·test·증거 묶임·수정 루프·테스트 동결·검증 hook·되감기.
 *
 * p5.test 에서 describe 단위로 옮겼다(이름·본문 그대로 — 이력 추적용). 임시 git 저장소에 실제 함수를 그대로 부른다.
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */
import {
  ORDER, TEST_FILE, PASS, FAIL, NOT_INSTALLED, PRINT_CASES, FAIL_UNTIL_FIXED, PRINT_ROUNDS, manifest, PLAN, QUALITY, repo, write, git, hook, writeFileHook, approve, useManifest, toCheck, toReview, writeFindingsDoc, writeFindings, forgeReviewDoc, toIntegrate, toDeliver, createStageRepo, removeStageRepo,
} from "./stageFixture";

beforeEach(() => createStageRepo());

afterEach(() => removeStageRepo());

// ---- 기준 커밋 ----

describe("기준 커밋을 굳힌다", () => {
  test("start 가 기준 브랜치를 커밋으로 박고, 그 뒤 기준 브랜치가 움직여도 대조가 흔들리지 않는다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    const pinned = loadActive(repo)!.baseCommit!;
    assert.equal(pinned, git("rev-parse", "master"));

    // 기준 브랜치가 한 커밋 더 나간다
    git("switch", "-q", "master");
    write("other.txt", "x\n");
    git("add", "other.txt");
    git("commit", "-qm", "move");
    git("switch", "-q", "feature/ORD-1");

    assert.notEqual(pinned, git("rev-parse", "master"));
    assert.equal(loadActive(repo)!.baseCommit, pinned);
    // 굳혀 둔 커밋과의 차이는 그대로다 — master 가 더한 파일은 이 작업의 변경이 아니다
    assert.equal(changedPaths(repo, pinned).some((change) => change.path === "other.txt"), false);
    assert.equal(changedPaths(repo, "master").some((change) => change.path === "other.txt"), true);
  });

  test("P5 이전에 시작된 커서(기준 커밋 없음)는 진행하지 않고 다시 시작하게 한다", () => {
    start(repo, join(repo, "doc/work/ORD-1.md"));
    const { baseCommit, ...legacy } = loadActive(repo)!;
    assert.ok(baseCommit);
    saveActive(repo, legacy);
    assert.throws(() => next(repo), (error: Error) => error instanceof Stop && /굳혀 둔 기준 커밋이 없습니다/.test(error.message));
  });
});

describe("changedPaths · partialTreeHash", () => {
  test("추가·수정·삭제·이름변경·추적되지 않은 새 파일을 잡고 .gitignore 된 것은 잡지 않는다", () => {
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    write("gone.txt", "gone\n");
    write("old.txt", "same\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = commitOf(repo, "HEAD")!;

    write("a.txt", "changed\n");
    rmSync(join(repo, "gone.txt"));
    git("mv", "old.txt", "renamed.txt");
    write("new.txt", "new\n");
    write("build/artifact.jar", "junk\n");

    const changes = new Map(changedPaths(repo, base).map((change) => [change.path, change.status]));
    assert.equal(changes.get("a.txt"), "M");
    assert.equal(changes.get("gone.txt"), "D");
    assert.equal(changes.get("old.txt"), "D");
    assert.equal(changes.get("renamed.txt"), "R");
    assert.equal(changes.get("new.txt"), "A");
    assert.equal(changes.has("b.txt"), false);
    assert.equal(changes.has("build/artifact.jar"), false);
  });

  test("core.quotePath 기본값에서도 한글·공백 경로를 원문 그대로 잡는다", () => {
    git("config", "core.quotePath", "true");
    write("문서/기존 안내.md", "a\n");
    write("문서/옛 이름.md", "same\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = commitOf(repo, "HEAD")!;
    write("문서/기존 안내.md", "changed\n");
    git("mv", "문서/옛 이름.md", "문서/새 이름.md");
    write("문서/새 파일.md", "new\n");
    const changes = new Map(changedPaths(repo, base).map((change) => [change.path, change.status]));
    assert.equal(changes.get("문서/기존 안내.md"), "M");
    assert.equal(changes.get("문서/옛 이름.md"), "D");
    assert.equal(changes.get("문서/새 이름.md"), "R");
    assert.equal(changes.get("문서/새 파일.md"), "A");
  });

  test("계획 파일이 한 글자 바뀌거나 사라지면 부분 트리 해시가 달라진다", () => {
    write("x.java", "class X {}\n");
    const before = partialTreeHash(repo, ["x.java"]);
    write("x.java", "class X { }\n");
    assert.notEqual(before, partialTreeHash(repo, ["x.java"]));
    rmSync(join(repo, "x.java"));
    assert.notEqual(before, partialTreeHash(repo, ["x.java"]));
  });

  test("바이너리 파일은 바이트로 해시한다 — U+FFFD 로 뭉개지는 변경도 드러난다", () => {
    writeFileSync(join(repo, "fixture.bin"), Buffer.from([0x50, 0xff, 0x00, 0xfe]));
    const before = partialTreeHash(repo, ["fixture.bin"]);
    writeFileSync(join(repo, "fixture.bin"), Buffer.from([0x50, 0xfe, 0x00, 0xc0]));
    assert.notEqual(partialTreeHash(repo, ["fixture.bin"]), before);
  });

  test("유효한 UTF-8 파일(BOM·한글·CRLF)의 해시는 바이트 해시로 바꿔도 그대로다 — 진행 중 작업의 증거가 유지된다", () => {
    // 골든은 바이트 해시로 바꾸기 전 dist(문자열 해시)로 계산한 값이다
    writeFileSync(join(repo, "k.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("한글 첫 줄\r\n둘째 줄 — CRLF\r\n", "utf-8")]));
    assert.equal(partialTreeHash(repo, ["k.txt", "missing.txt"]), "sha256:060e0e246900df38");
  });
});

// ---- check ----

describe("code-agent check", () => {
  test("계획 밖 변경이 있으면 명령을 돌리기 전에 멈춘다", async () => {
    toCheck();
    write("src/main/java/com/acme/app/application/order/domain/Sneaky.java", "class Sneaky {}\n");
    await assert.rejects(
      () => check(requireValidatable(repo, "check")),
      (error: Error) => error instanceof Stop && /계획 밖 변경 \[A\] .*Sneaky\.java/.test(error.message),
    );
    // 이 폴더에는 스테이지 전이 기록(stages.jsonl)이 이미 들어 있다 — 여기서 없어야 하는 것은
    // **검증 실행 로그**다. 명령을 하나도 돌리지 않았다는 것이 이 테스트가 보는 것이다.
    assert.deepEqual(readdirSync(join(repo, ".code-agent/log")).filter((name) => name.endsWith(".log")), []);
    assert.equal(loadEvidence(repo, "ORD-1", "order"), undefined);
  });

  test("계획 파일이 사라졌으면 멈춘다 — 지워서 통과시키는 길", async () => {
    toCheck();
    rmSync(join(repo, TEST_FILE));
    await assert.rejects(
      () => check(requireValidatable(repo, "check")),
      (error: Error) => error instanceof Stop && /계획에 있는데 없는 파일 .*OrderTest\.java/.test(error.message),
    );
  });

  test("통과하면 증거와 ⑧ 을 남기고 next 가 test 로 넘긴다", async () => {
    toCheck();
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /build: passed/);

    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.rounds, 1);
    assert.equal(evidence.baseCommit, loadActive(repo)!.baseCommit);
    assert.equal(evidence.runs.filter((run) => run.phase === "check").length, 1);
    assert.ok(existsSync(join(repo, ".code-agent/log/check-1-build.log")));
    assert.match(readFileSync(join(repo, validationDocFile("ORD-1")), "utf-8"), /## 실행 결과/);

    next(repo);
    assert.equal(loadActive(repo)!.phase, "test");
  });

  test("회차는 명령을 돌리기 **전에** 올라간다 — 죽여서 카운터를 피할 수 없다", async () => {
    useManifest({ build: PRINT_ROUNDS });
    toCheck();
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /build: passed/);
    assert.match(readFileSync(join(repo, ".code-agent/log/check-1-build.log"), "utf-8"), /rounds=1/);
  });

  test("돌아서 실패한 명령은 failed 다 — next 가 열리지 않는다", async () => {
    useManifest({ build: FAIL });
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.runs[0].outcome, "failed");
    assert.throws(() => next(repo), /build: failed/);
  });

  test("돌지 못한 명령은 error 다 — failed 와 섞지 않고, 역시 next 가 열리지 않는다", async () => {
    useManifest({ build: NOT_INSTALLED });
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.runs[0].outcome, "error");
    assert.throws(() => next(repo), /build: error/);
  });

  test("⑦ 의 TC id 가 계획 파일 어디에도 없으면 test 전에 알려 준다 — 막지는 않는다 (FLOW-05)", async () => {
    toCheck();
    write(TEST_FILE, "// TC-1 만 있다\nclass OrderTest {}\n");
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /!! ⑦ 의 TC id 가 계획 파일 어디에도 없습니다: TC-2/);
    assert.match(out, /build: passed/);
  });

  test("선언되지 않은 검증은 not-run 이고 통과로 세지 않는다", async () => {
    useManifest({ build: undefined }, QUALITY.replace("- `build`: 컴파일", "- 없음 — 아직 없다"));
    toCheck();
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /build: not-run/);
    assert.match(out, /돌릴 명령이 하나도 선언돼 있지 않습니다/);
    assert.throws(() => next(repo), /build: not-run/);
  });
});

// ---- 증거 묶기 ----

describe("증거는 트리·매니페스트·계획에 묶인다", () => {
  test("통과 뒤 계획 파일을 한 글자 고치면 next 가 거부한다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    assert.throws(() => next(repo), /검증 뒤 계획 파일이 바뀌었습니다/);
  });

  test("통과 뒤 test 명령을 약한 것으로 바꾸면 next 가 거부한다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    write("code-agent.json", manifest({ test: ["node", "-e", "0"] }));
    // 승인도 stale-manifest 가 된다 — next 는 스테이지 게이트보다 먼저 재진입 문장으로 멈춘다(status 의 다음: 과 같다)
    assert.throws(() => next(repo), /계획이 승인되지 않았습니다 \(stale-manifest\)\. 승인 무효\(stale-manifest/);
    // 그 자리에서 다시 승인해도 통과는 옛 선언에 묶여 있어 넘어가지 않는다
    approve();
    assert.throws(() => next(repo), /경계·검증 선언이 바뀌었습니다/);
  });

  test("⑧ 을 손으로 고치면 next 가 거부하고, 모델은 애초에 쓸 수 없다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.match(writeFileHook(validationDocFile("ORD-1")) ?? "", /코드가 렌더합니다/);
    write(validationDocFile("ORD-1"), "# 전부 통과했습니다\n");
    assert.throws(() => next(repo), /08-validation\.md 가 증거와 다릅니다/);
  });
});

// ---- test ----

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
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
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

describe("테스트 동결", () => {
  test("테스트가 돌기 전에는 쓰고, 한 번 돈 뒤에는 hook 이 거부한다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    assert.equal(writeFileHook(TEST_FILE), undefined);

    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /테스트가 이미 돌아 얼어 있는 파일입니다/);
    // 테스트가 아닌 계획 파일은 그대로 고친다 — 얼리는 것은 단언뿐이다
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
  });

  test("실패한 테스트도 동결한다 — 실패를 지워 통과시키는 길이 본체다", async () => {
    useManifest({ test: FAIL });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });

  test("결과가 하나도 인식되지 않고 실패도 없던 test 실행은 얼리지 않는다 (PVR-9)", async () => {
    useManifest({ test: PASS });
    toCheck();
    const result = await verify(repo);
    assert.equal(result.node, "diagnose");
    assert.equal(result.failure?.class, "result-unconfirmed");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.testFreeze, undefined);
    assert.equal(writeFileHook(TEST_FILE), undefined);
  });

  test("일부만 인식된 회차는 수집 수정 1회 동안 열리고, 그 회차는 고쳐 쓰기를 쓰지 않는다 (PVR-9)", async () => {
    // 테스트 파일에 적힌 TC 만 결과로 찍는 러너
    useManifest({ test: ["node", "-e", `const t=require('fs').readFileSync('${TEST_FILE}','utf-8');['TC-1','TC-2'].forEach((id,i)=>{if(t.includes(id))console.log('ok '+(i+1)+' - '+id)})`] });
    toCheck();
    write(TEST_FILE, "// TC-1\nclass OrderTest {}\n");
    assert.equal((await verify(repo)).node, "diagnose");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.testFreeze!.round, 1);
    assert.equal(writeFileHook(TEST_FILE), undefined, "수집 수정 창이 열려 있다");
    assert.match(context(repo), /결과 미확인 — 수집 수정 1회 동안 TC 이름만 고칠 수 있음/);
    write(TEST_FILE, "// TC-1 · TC-2\nclass OrderTest {}\n");
    const result = await verify(repo);
    assert.equal(result.node, "review");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.retry!.causes["2"], "collect");
    assert.equal(verifyView(loadWork(repo)!, evidence).budget.fix.used, 0);
    assert.ok(evidence.testFreeze!.rebased![0].files.includes(TEST_FILE));
    assert.equal(evidence.testFreeze!.rebased![0].by, "collect");
    assert.match(readFileSync(join(repo, validationDocFile("ORD-1")), "utf-8"), /2회차 \(수집 수정\): 전부 통과 · 수집 수정으로 바뀐 테스트 파일/);
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는/);
  });

  test("동결 뒤 바뀐 테스트 파일은 게이트가 증거로 다시 대조한다 — ⑨ 지적으로 연 파일만 다음 회차가 기준을 갱신한다 (PVR-15)", async () => {
    await toReview();
    // hook 을 거치지 않고 바꾼 경우
    write(TEST_FILE, "// TC-1 · TC-2 (몰래)\nclass OrderTest {}\n");
    assert.ok(stageProblems(loadWork(repo)!, "test").some((problem) => /테스트 동결 뒤 바뀐 kind:test 파일/.test(problem)));
    await assert.rejects(verify(repo), (error: Error) => error instanceof Stop && /검증 전제가 맞지 않습니다[\s\S]*테스트 동결 뒤 바뀐/.test(error.message));
  });

  test("⑨ 지적으로 연 테스트 파일은 다음 check 가 동결 기준을 갱신한다 (PVR-15)", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 기대 결과를 확인하지 않는다 |`);
    assert.equal(writeFileHook(TEST_FILE), undefined);
    write(TEST_FILE, "// TC-1 · TC-2 (지적 반영)\nclass OrderTest {}\n");
    assert.equal((await verify(repo)).node, "review");
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.testFreeze!.rebased![0].by, "finding");
    assert.equal(stageProblems(loadWork(repo)!, "test").some((problem) => /테스트 동결 뒤 바뀐/.test(problem)), false);
  });

  test("⑨ 지적으로 연 테스트 파일은 그 리뷰 회차에 한 번만 기준이 된다 — 그 뒤 hook 을 거치지 않은 변경은 게이트가 잡는다 (PVR-15)", async () => {
    useManifest({ build: ["node", "-e", `process.exit(require('fs').readFileSync('${ORDER}/domain/Order.java','utf-8').includes('broken') ? 3 : 0)`] });
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 기대 결과를 확인하지 않는다 |`);
    assert.equal(writeFileHook(TEST_FILE), undefined);
    write(TEST_FILE, "// TC-1 · TC-2 (지적 반영)\nclass OrderTest {}\n");
    write(`${ORDER}/domain/Order.java`, "class Order { broken }\n");
    await check(requireValidatable(repo, "check"));
    const opened = loadEvidence(repo, "ORD-1", "order")!.testFreeze!.rebased!;
    assert.deepEqual(opened.map((entry) => [entry.by, entry.reviewRound, entry.files]), [["finding", 1, [TEST_FILE]]]);
    // check 로 되감긴 뒤에는 hook 이 그 파일을 다시 닫는다 — 그래도 바뀌었다면 지적이 연 변경이 아니다
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
    write(TEST_FILE, "// TC-1 · TC-2 (몰래 한 번 더)\nclass OrderTest {}\n");
    write(`${ORDER}/domain/Order.java`, "class Order { fixed }\n");
    await check(requireValidatable(repo, "check"));
    const evidence = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(evidence.retry!.causes[String(evidence.rounds)], "fix");
    assert.equal(evidence.testFreeze!.rebased!.length, 1, "같은 리뷰 회차에 두 번 받아들이지 않는다");
    assert.ok(stageProblems(loadWork(repo)!, "test").some((problem) => problem.includes(`테스트 동결 뒤 바뀐 kind:test 파일: ${TEST_FILE}`)));
  });

  test("implement 스테이지에서는 같은 파일을 쓴다", () => {
    toCheck();
    saveActive(repo, { ...loadActive(repo)!, phase: "implement", stage: "test" });
    assert.equal(writeFileHook(TEST_FILE), undefined);
  });

  test("테스트가 돈 뒤에는 implement 로 되감아도 얼어 있다 — 동결은 커서가 아니라 증거에 묶인다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);

    // 커서를 구현으로 빼고 테스트 단계까지 걸어 와도 같다 — 단언을 지워 통과시키는 길이 여기서도 닫힌다
    back(repo, "implement");
    next(repo);
    next(repo);
    assert.equal(loadActive(repo)!.stage, "test");
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });

  // 같은 회차의 리뷰는 한 번만 기록된다(PVR-2) — 지적 두 줄은 한 실행의 결과로 함께 기록한다
  test("⑨ 에 그 파일을 가리키는 열린 계획 안 지적이 있으면 풀린다 — 해결로 닫으면 다시 언다", async () => {
    await toReview();
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);

    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${ORDER}/domain/Order.java | 계획 안 | 열림 | 필드가 public 이다 |`,
      `| F2 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 기대 결과를 확인하지 않는다 |`);
    assert.equal(writeFileHook(TEST_FILE), undefined);

    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\| 열림 \|/g, "| 해결 |"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });

  test("다른 파일을 가리키는 지적은 열쇠가 아니다 — 열쇠는 그 경로를 가리킨 줄 하나다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${ORDER}/domain/Order.java | 계획 안 | 열림 | 필드가 public 이다 |`);
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });
});

// ---- 매니페스트 ----

describe("매니페스트 kind:\"test\"", () => {
  test("enum 에 값을 더해도 그 값을 쓰지 않는 매니페스트의 해시는 그대로다", () => {
    // P4 코드가 같은 매니페스트에 내던 값. 바뀌면 진행 중인 모든 계획 승인이 stale-manifest 로 떨어진다
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-hash-")));
    writeFileSync(
      join(dir, "code-agent.json"),
      JSON.stringify({
        language: "java",
        sourceExtensions: [".java"],
        domainBase: "src/main/java/com/acme/app",
        domainRoots: ["application"],
        conventions: ["doc/conventions.md"],
        docs: { architecture: "doc/architecture.md" },
        referenceDomain: "deal",
        build: ["gradlew", "compileJava", "-q"],
        test: ["gradlew", "test"],
        stages: [
          { key: "entity", title: "Entity", template: "01-entity.md", kinds: ["feature"], exemplars: ["domain/{Ref}.java"], outputDirs: ["domain"] },
          { key: "repository", title: "Repository", template: "02-repository.md", kinds: ["feature"], exemplars: ["repository/"], outputDirs: ["repository"] },
        ],
      }),
    );
    assert.equal(hashManifest(loadManifest(dir)), "sha256:c61b36d89e42e46e");
    rmSync(dir, { recursive: true, force: true });
  });

  test("kind:\"test\" 를 선언하면 해시가 달라진다 — 승인 뒤 동결을 끌 수 없다", () => {
    const withTest = loadManifest(repo);
    write("code-agent.json", manifest().replace(JSON.stringify({ kind: "test" }).slice(1, -1), JSON.stringify({ kind: "code" }).slice(1, -1)));
    assert.notEqual(hashManifest(withTest), hashManifest(loadManifest(repo)));
  });
});

// ---- hook · Stop hook ----

describe("hook — 검증 명령", () => {
  test("code-agent check · test 는 Bash 로 부를 수 있고, 연결은 거부된다", () => {
    toCheck();
    assert.equal(hook("Bash", { command: "code-agent check" }), undefined);
    assert.equal(hook("Bash", { command: "code-agent test" }), undefined);
    assert.match(hook("Bash", { command: "code-agent check && git commit -m x" }) ?? "", /연결·리다이렉트/);
    // 되감기도 모델이 부를 수 있다 — 뒤로만 가고 지우는 것이 없어 건너뛸 수 있는 것이 없다
    assert.equal(hook("Bash", { command: "code-agent back design" }), undefined);
    // 커서를 지우는 abort 는 그대로 사람의 자리다 — 열어 두면 hook 이 아무것도 판정하지 않게 된다
    assert.match(hook("Bash", { command: "code-agent abort" }) ?? "", /현재 세션의 ca-answer 동의 절차/);
  });
});

// ---- 수정 루프의 입구 ----

describe("code-agent check 는 검증 스테이지를 되감는다", () => {
  test("test 에서 실패하고 고친 뒤 공개 명령만으로 한 바퀴를 돈다", async () => {
    useManifest({ test: FAIL_UNTIL_FIXED });
    toCheck();

    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.throws(() => next(repo), /test: failed/);

    // 계획 안 파일을 고친다 — 여기까지는 늘 되던 것이고, 막혔던 것은 그다음이다
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
    write(`${ORDER}/domain/Order.java`, "class Order { /* fixed */ }\n");

    // 스킬이 시키는 "code-agent check 부터 다시" — 커서를 손대는 내부 함수는 쓰지 않는다
    await check(requireValidatable(repo, "check"));
    assert.equal(loadActive(repo)!.phase, "check");
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.rounds, 2);
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "review");

    openRound(requireValidatable(repo, "review"));
    writeFindings();
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
  });

  test("review · integrate 에서도 같은 자리로 되감고, deliver 는 되감지 않는다", async () => {
    await toDeliver();
    assert.throws(
      () => requireValidatable(repo, "check"),
      (error: Error) => error instanceof Stop && /지금: deliver/.test(error.message),
    );
    assert.equal(loadActive(repo)!.phase, "deliver");

    saveActive(repo, { ...loadActive(repo)!, phase: "integrate" });
    requireValidatable(repo, "check");
    assert.equal(loadActive(repo)!.phase, "check");
  });
});

// ---- 테스트 동결의 탈출구 ----

describe("동결을 푸는 지적은 열린 회차에 묶인다", () => {
  test("회차가 열리기 전에 제가 적어 둔 지적은 풀지 못한다 (test 스테이지)", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);

    // ⑨ 는 작업 폴더 안이라 쓰는 것 자체는 막지 않는다 — 막는 것은 그것이 열쇠가 되는 일이다
    assert.equal(writeFileHook(reviewDocFile("ORD-1")), undefined);
    forgeReviewDoc(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 틀렸다 |`);
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
    assert.equal(loadReview(repo, "ORD-1", "order"), undefined, "회차가 없는데 기록이 생기지 않는다");
  });

  test("review 스테이지라도 회차를 열기 전에는 풀지 못한다", async () => {
    await toReview();
    forgeReviewDoc(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 틀렸다 |`);
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/);
  });

  test("푼 사실은 코드가 회차 기록에 남기고, 그 줄은 지울 수 없다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings(`| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 기대 결과를 확인하지 않는다 |`);
    assert.equal(writeFileHook(TEST_FILE), undefined);
    assert.deepEqual(loadReview(repo, "ORD-1", "order")!.used, [{ id: "F1", path: TEST_FILE, round: 1 }]);

    // 쓰고 나서 줄을 지우면 커밋된 ⑨ 에 아무 흔적도 남지 않는다 — 게이트가 그것을 기억한다
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^\| F1 .*$/m, "- 없음"));
    assert.throws(() => next(repo), /F1 이 표에 없습니다/);
  });

  test("상태 칸은 글자 그대로 본다 — 미해결 은 해결이 아니다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const row = `| F1 | ${TEST_FILE} | 계획 안 | 미해결 | 단언이 틀렸다 |`;
    writeFindingsDoc(row);
    // hook 이 기록 전에 상태 값을 돌려보낸다 — 기록이 없으므로 열쇠도 될 수 없다
    const event = { cwd: repo, session_id: "session", agent_id: "reviewer", agent_type: "ca-reviewer" };
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    assert.throws(() => observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: row }), /상태 칸은 열림 · 해결 둘뿐입니다\(미해결\)/);
    assert.throws(() => next(repo), /열린 지적: F1/);
    assert.throws(() => next(repo), /상태 칸은 열림 · 해결 둘뿐입니다/);
    // 열쇠로도 쓰이지 않는다 — 여는 쪽과 닫는 쪽이 같은 규칙을 딛는다
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/, "유효하지 않은 상태는 동결을 풀지 않는다");

    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace("| 미해결 |", "| 해결 안 됨 |"));
    assert.throws(() => next(repo), /열린 지적: F1/);
  });
});
