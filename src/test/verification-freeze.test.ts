import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { hashManifest } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { back, context, next, requireValidatable, Stop } from "../agent/commands";
import { loadEvidence, stageProblems, validationDocFile, verifyView } from "../agent/evidence";
import { loadActive, saveActive } from "../agent/layout";
import { loadReview, openRound, reviewDocFile } from "../agent/review";
import { observeReviewer } from "../agent/reviewHook";
import { check, runTests } from "../agent/validate";
import { verify } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { ORDER, TEST_FILE, PASS, FAIL, FAIL_UNTIL_FIXED, manifest, repo, write, hook, writeFileHook, useManifest, toCheck, toReview, writeFindingsDoc, writeFindings, forgeReviewDoc, toDeliver, createStageRepo, removeStageRepo } from "./stageFixture";

/**
 * 검증 스테이지 — 기준 커밋·check·test·증거 묶임·수정 루프·테스트 동결·검증 hook·되감기·실행별 로그.
 *
 * 임시 git 저장소에 실제 함수를 그대로 부른다.
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */

beforeEach(() => createStageRepo());

afterEach(() => removeStageRepo());

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

  // 같은 회차의 리뷰는 한 번만 기록된다 — 지적 두 줄은 한 실행의 결과로 함께 기록한다
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
    // 매니페스트 해시의 호환 기준값. 바뀌면 진행 중인 모든 계획 승인이 stale-manifest 로 떨어진다
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

  test("상태 칸 — 미해결 은 해결이 아니다: hook 은 같은 뜻의 열림으로 고쳐 기록하고, 뜻을 정할 수 없는 값은 글자 그대로 본다", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    const row = `| F1 | ${TEST_FILE} | 계획 안 | 미해결 | 단언이 틀렸다 |`;
    writeFindingsDoc(row);
    const event = { cwd: repo, session_id: "session", agent_id: "reviewer", agent_type: "ca-reviewer" };
    observeReviewer({ ...event, hook_event_name: "SubagentStart" });
    observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: row });
    assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.at(-1)!.reviewers![0].result, `| F1 | ${TEST_FILE} | 계획 안 | 열림 | 단언이 틀렸다 |`);
    assert.throws(() => next(repo), /열린 지적: F1/);
    // 고친 값은 리뷰어가 뜻한 그대로(열림)라 계획 안 열린 지적으로서 그 파일을 고칠 열쇠가 된다 — 해결로 읽히지는 않는다
    assert.equal(writeFileHook(TEST_FILE), undefined, "계획 안 열린 지적은 그 파일의 동결을 푼다");

    // 손으로 쓴 문서의 상태 칸은 게이트가 글자 그대로 본다 — 해결이 아닌 값은 열쇠가 되지 않는다
    const path = join(repo, reviewDocFile("ORD-1"));
    writeFileSync(path, readFileSync(path, "utf-8").replace("| 열림 | 단언이 틀렸다 |", "| 해결 안 됨 | 단언이 틀렸다 |"));
    assert.throws(() => next(repo), /상태 칸은 열림 · 해결 둘뿐입니다/);
    assert.match(writeFileHook(TEST_FILE) ?? "", /얼어 있는 파일입니다/, "유효하지 않은 상태는 동결을 풀지 않는다");
  });
});
