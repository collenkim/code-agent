import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { next, requireValidatable, Stop } from "../agent/commands";
import { start } from "./confirmedStart";
import { loadEvidence, saveEvidence, testCaseEvidence, tcPrecheck, validationDocFile, verifyView } from "../agent/evidence";
import { loadActive, saveActive } from "../agent/layout";
import { changedPaths, commitOf, partialTreeHash } from "../agent/tree";
import { check } from "../agent/validate";
import { verify } from "../agent/verificationFlow";
import { loadWork } from "../agent/work";
import { readTimeline, summarizeTimeline } from "../agent/timeline";
import { ORDER, TEST_FILE, FAIL, NOT_INSTALLED, PRINT_ROUNDS, manifest, QUALITY, repo, write, git, writeFileHook, approve, useManifest, toCheck, createStageRepo, removeStageRepo } from "./stageFixture";

/**
 * 검증 스테이지 — 기준 커밋·check·test·증거 묶임·수정 루프·테스트 동결·검증 hook·되감기·실행별 로그.
 *
 * 임시 git 저장소에 실제 함수를 그대로 부른다.
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */

beforeEach(() => createStageRepo());

afterEach(() => removeStageRepo());

test("2-8 코드 결함으로 테스트를 동결한 뒤에는 수집 수정 예산이 없다", async () => {
  useManifest({ test: FAIL }); toCheck();
  await verify(repo);
  const evidence = loadEvidence(repo, "ORD-1", "order")!;
  assert.ok(evidence.testFreeze);
  assert.equal(verifyView(loadWork(repo)!, evidence).budget.collect.limit, 0);
});

test("2-8 묶임이 달라지고 오래된 표지도 같은 PC의 실행이 살아 있으면 check를 막는다", async () => {
  toCheck(); await check(requireValidatable(repo, "check"));
  const evidence = loadEvidence(repo, "ORD-1", "order")!;
  evidence.planHash = "different-plan";
  evidence.retry = { ...evidence.retry!, started: { phase: "test", round: evidence.rounds, pid: process.ppid, host: hostname(), at: "2000-01-01T00:00:00.000Z" } };
  saveEvidence(repo, evidence);
  await assert.rejects(() => check(loadWork(repo)!), /실행 중/);
});

test("1-5 구현 파일이 찍은 TC 통과 출력은 테스트 파일에 토큰이 없으면 unknown이다", () => {
  toCheck();
  write(TEST_FILE, "// TC-1\nclass OrderTest {}\n");
  write(`${ORDER}/domain/Order.java`, '// TC-2\nclass Order {}\n');
  const work = loadWork(repo)!;
  assert.deepEqual(tcPrecheck(work), ["TC-2"]);
  for (const output of ['ok 1 - TC-2', JSON.stringify({ type: "code-agent-test", id: "TC-2", status: "passed" })]) {
    const result = testCaseEvidence(work, output).find(item => item.id === "TC-2")!;
    assert.equal(result.status, "unknown");
    assert.match(result.where ?? "", /출력에만 있음/);
  }
  assert.equal(testCaseEvidence(work, "ok 1 - TC-1")[0].status, "passed");
});

test("1-6 검증 명령의 승인 원장 변경을 복원하고 실행을 guard로 남긴다", async () => {
  const paths = [".code-agent/approvals/ORD-1.jsonl", ".code-agent/approvals/docs.jsonl"];
  useManifest({ build: ["node", "-e", `for (const p of ${JSON.stringify(paths)}) require('fs').appendFileSync(p, '\\n')`] });
  toCheck();
  const before = paths.map(path => readFileSync(join(repo, path)));
  await check(requireValidatable(repo, "check"));
  paths.forEach((path, index) => assert.deepEqual(readFileSync(join(repo, path)), before[index], path));
  assert.equal(loadEvidence(repo, "ORD-1", "order")!.runs[0].cause, "guard");
});

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

  test("기준 커밋이 없는 커서는 진행하지 않고 다시 시작하게 한다", () => {
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
      (error: Error) => error instanceof Stop && /계획에 있는데 없는 파일: .*OrderTest\.java/.test(error.message),
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
    // 실행마다 따로 남는 로그 — 이름에 시작 시각이 들고, 머리에 시작·끝·소요가 있다
    const [run] = evidence.runs.filter((entry) => entry.phase === "check");
    assert.match(run.logFile!, /^\.code-agent\/log\/verify\/ORD-1\/check-1-build-\d{8}T\d{9}Z\.log$/);
    assert.ok(run.endedAt && typeof run.durationMs === "number");
    assert.ok(readFileSync(join(repo, run.logFile!), "utf-8").includes(`시작 ${run.at} · 끝 ${run.endedAt} · ${run.durationMs}ms · exit 0`));
    assert.match(readFileSync(join(repo, validationDocFile("ORD-1")), "utf-8"), /## 실행 결과/);

    next(repo);
    assert.equal(loadActive(repo)!.phase, "test");
  });

  test("회차는 명령을 돌리기 **전에** 올라간다 — 죽여서 카운터를 피할 수 없다", async () => {
    useManifest({ build: PRINT_ROUNDS });
    toCheck();
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /build: passed/);
    assert.match(readFileSync(join(repo, loadEvidence(repo, "ORD-1", "order")!.runs.at(-1)!.logFile!), "utf-8"), /rounds=1/);
  });

  test("다시 돌려도 앞 실행의 로그를 덮지 않고, 실행마다 시작·끝·소요를 타임라인에 남긴다", async () => {
    useManifest({ build: PRINT_ROUNDS });
    toCheck();
    await check(requireValidatable(repo, "check"));
    await check(requireValidatable(repo, "check"));
    // 증거에는 단계마다 마지막 실행만 남는다 — 앞 실행은 로그 파일과 타임라인에 남는다
    const ended = readTimeline(repo).filter((event) => event.type === "verify.ended");
    const logs = ended.map((event) => String(event.detail?.logFile));
    assert.equal(new Set(logs).size, 2);
    assert.deepEqual(readdirSync(join(repo, ".code-agent/log/verify/ORD-1")).sort(), logs.map((file) => file.split("/").at(-1)).sort());
    assert.ok(logs.every((file) => /^rounds=\d$/m.test(readFileSync(join(repo, file), "utf-8"))));
    assert.deepEqual(ended.map((event) => [event.workId, event.phase, event.detail?.outcome]), [["ORD-1", "check", "passed"], ["ORD-1", "check", "passed"]]);
    assert.ok(ended.every((event) => typeof event.detail?.durationMs === "number" && String(event.detail.startedAt) <= event.at));
    assert.equal(loadEvidence(repo, "ORD-1", "order")!.runs.find((run) => run.phase === "check")!.logFile, logs[1]);
    assert.deepEqual(summarizeTimeline(readTimeline(repo)).runs.map((run) => run.logFile), logs);
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

  test("⑦의 TC id가 대조 대상 파일에 없으면 test 전에 알려 주며 진행을 막지는 않는다", async () => {
    toCheck();
    write(TEST_FILE, "// TC-1 만 있다\nclass OrderTest {}\n");
    const out = await check(requireValidatable(repo, "check"));
    assert.match(out, /!! ⑦ 의 TC id 가 대조 대상 파일에 없습니다: TC-2/);
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
