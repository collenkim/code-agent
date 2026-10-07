import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { hashManifest } from "../core/approval";
import { loadManifest } from "../core/manifest";
import { next, requireValidatable, Stop, submitPlan } from "../agent/commands";
import { start } from "./confirmedStart";
import { commitDelivery, prDocFile } from "../agent/deliver";
import { checkCommands, loadEvidence, prepareCommand, runsOf, stageProblems, testCommands, validationDocFile } from "../agent/evidence";
import { loadActive } from "../agent/layout";
import { openRound, reviewDocFile } from "../agent/review";
import { recordReviewFixture } from "./reviewFixture";
import { check, integrate, runTests } from "../agent/validate";
import { RetryRefused } from "../agent/retryPolicy";
import { loadWork } from "../agent/work";
/**
 * 반영 커밋 범위와 integrate 의 prepare.
 *
 * p6.test 에서 describe 단위로 옮겼다(이름·본문 그대로). 저장소·헬퍼·상수는 kindFlowFixture.ts 에 있다.
 */
import {
  PASS, FAIL, NOT_INSTALLED, STRATEGY_PREPARE, QUALITY_PREPARE, repo, write, git, confirmDocs, approve, newRepo, dropRepo, manifest,
} from "./kindFlowFixture";

// ==== 5·6. deliver 커밋 범위 · integrate 의 prepare ====

const FEAT_SRC = "src/main/app/greeting.js";
const FEAT_TEST = "src/test/greeting.test.js";
const PRINT_TC = ["node", "-e", "console.log('ok 1 - TC-1')"];

const FEAT_ORDER = ["---", "kind: feature", "id: ORD-9", "title: 인사 기능", "target: greeting", "---", "", "이름을 받아 인사한다.", ""].join("\n");

const FEAT_PLAN = {
  domainName: "Greeting",
  domainLabel: "인사",
  domainRoot: "",
  domainDirName: "greeting",
  files: [
    { stage: "code", path: FEAT_SRC, purpose: "인사 함수", requirements: ["R1"] },
    { stage: "test", path: FEAT_TEST, purpose: "테스트", requirements: ["R1"] },
  ],
  sequence: [{ step: "code", why: "먼저" }, { step: "test", why: "다음" }],
  approach: "순수 함수로 만든다",
  conventions: [], conflicts: [], openQuestions: [], reasoning: "단순하다",
};

describe("P6 · deliver 커밋 범위 · integrate 의 prepare", () => {
  beforeEach(() => {
    newRepo("ca-p6-int-");
    write("doc/work/ORD-9.md", FEAT_ORDER);
  });
  afterEach(dropRepo);

  /** 매니페스트를 굳히고 커밋한다 — 작업 시작 전에만 부른다 */
  function useManifest(overrides: Record<string, unknown> = {}): void {
    write("code-agent.json", manifest({ test: PRINT_TC, ...overrides }));
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "init");
  }

  function toIntegrate(): void {
    start(repo, join(repo, "doc/work/ORD-9.md"));
    write("doc/work/ORD-9/01-requirements.md",
      ["# ORD-9 요구사항 정의", "## R1 · 인사한다", "근거: \"이름을 받아 인사한다.\"", "- 데이터: 만든다", "## 가정", "- 없음"].join("\n"));
    write("doc/work/ORD-9/02-analysis.md", [
      "# 영향도 분석", "## 기존 시스템 분석", "- 붙을 코드가 없다 — 새 파일이다",
      "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
      `| R1 | ${FEAT_SRC} | 없음 | 없음 — 새 파일 |`, "## Risk", "- 없음",
    ].join("\n"));
    write("doc/work/ORD-9/03-design.md", [
      "# 기술 설계", "## 구성 요소", "- greeting", "## 처리 흐름", "- 이름 → 문자열",
      "## API", "해당 없음 — 접점이 없다", "## 데이터", "해당 없음 — 저장하지 않는다", "## 설계 결정", "- 순수 함수",
    ].join("\n"));
    write("doc/work/ORD-9/04-functional.md", [
      "# 기능 명세", "## 기능 정의", "- R1: 인사한다", "## 업무 규칙", "- 없음 — 규칙이 없다",
      "## 예외", "- 빈 이름: Error", "## 수락 기준", "- AC-R1-1: 이름을 주면 인사 문자열이 나온다",
    ].join("\n"));
    write("doc/work/ORD-9/07-test-spec.md", [
      "# 테스트 명세", "## 테스트 케이스", "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 이름을 준다 | 인사 문자열이 나온다 |",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);
    write("doc/work/ORD-9/plan.json", JSON.stringify(FEAT_PLAN));
    submitPlan(repo, join(repo, "doc/work/ORD-9/plan.json"));
    approve();
    next(repo);
    write(FEAT_SRC, "module.exports = { greet: (name) => `안녕 ${name}` };\n");
    next(repo);
    write(FEAT_TEST, "// TC-1\n");
    next(repo);
  }

  async function runToIntegrate(): Promise<void> {
    toIntegrate();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test"));
    next(repo);
    openRound(requireValidatable(repo, "review"));
    const path = join(repo, reviewDocFile("ORD-9"));
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n- 없음\n`);
    recordReviewFixture(repo);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "integrate");
  }

  // ---- deliver 커밋 범위 ----

  test("H2: doc/와 상태 경로를 무시해도 지정한 문서·증거·지식만 커밋한다", async () => {
    useManifest();
    write(".gitignore", "build/\ndoc/\n.code-agent/\n"); git("add", ".gitignore"); git("commit", "-qm", "ignore generated docs");
    await runToIntegrate(); await integrate(requireValidatable(repo, "integrate")); next(repo);
    write(prDocFile("ORD-9"), "## 요약\n인사\n## 확인 방법\n테스트\n## 위험·되돌리기\n없음\n");
    write("doc/knowledge/selected.md", "selected\n"); write("doc/knowledge/unrelated.md", "unrelated\n");
    write("doc/work/OTHER/raw.md", "other work\n"); write(".code-agent/work/OTHER/evidence.json", "{}\n");
    write("unrelated.txt", "already staged\n"); git("add", "unrelated.txt");
    const { commit } = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-9", "greeting")!, ["doc/knowledge/selected.md"]);
    const files = git("show", "--name-only", "--format=", commit);
    for (const file of [FEAT_SRC, prDocFile("ORD-9"), "doc/knowledge/selected.md", ".code-agent/work/ORD-9/greeting.verify.json"]) assert.ok(files.includes(file));
    assert.doesNotMatch(files, /OTHER|unrelated/);
    assert.equal(git("diff", "--cached", "--name-only"), "unrelated.txt");
  });

  test("H2: add 실패는 Stop으로 안내하고 기존 index와 작업 커서를 유지한다", async () => {
    useManifest(); await runToIntegrate(); await integrate(requireValidatable(repo, "integrate")); next(repo);
    write(prDocFile("ORD-9"), "review\n");
    write("unrelated.txt", "already staged\n"); git("add", "unrelated.txt");
    const before = readFileSync(join(repo, ".git/index"));
    write(".git/index.lock", "fixture lock\n");
    try {
      assert.throws(() => commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-9", "greeting")!, []),
        (error: unknown) => error instanceof Stop && /git add 가 실패/.test(error.message));
      assert.deepEqual(readFileSync(join(repo, ".git/index")), before);
      assert.equal(loadActive(repo)?.phase, "deliver");
    } finally { rmSync(join(repo, ".git/index.lock")); }
  });

  test("33. 반영 커밋은 도입 설정을 포함하고 다른 작업 증거와 무관한 파일은 제외한다", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    write(prDocFile("ORD-9"),
      ["# ORD-9 변경 보고서", "", "## 요약", "인사 함수를 더했다.", "", "## 확인 방법", "greet 를 부른다.", "", "## 위험·되돌리기", "없음 — 새 파일이라 지우면 된다.", ""].join("\n"));

    // 같은 트리에 남의 증거와 도입 설정을 둔다. 명시된 도입 설정만 반영한다.
    write(".code-agent/work/OTHER-1/x.verify.json", "{}\n");
    write(".code-agent/models.json", "{}\n");
    write(".code-agent/codex-models.json", "{}\n");
    write("unrelated.txt", "상관없는 파일\n");

    const work = loadWork(repo)!;
    const { commit } = commitDelivery(work, loadEvidence(repo, "ORD-9", "greeting")!, []);
    const files = git("show", "--name-only", "--format=", commit).split("\n").map((line) => line.trim()).filter(Boolean);

    assert.equal(files.includes(".code-agent/work/OTHER-1/x.verify.json"), false);
    assert.equal(files.includes(".code-agent/models.json"), true);
    assert.equal(files.includes(".code-agent/codex-models.json"), true);
    assert.equal(files.includes("unrelated.txt"), false);
    // 커밋되지 않았을 뿐 아니라 스테이지에도 올라가지 않았다 — 여전히 미추적이다
    const untracked = git("status", "--porcelain");
    assert.doesNotMatch(untracked, /\.code-agent\/models\.json/);
    assert.match(untracked, /\?\? \.code-agent\/work\/OTHER-1\//);
  });

  test("34. 이 작업의 파일·증거·원장은 같은 커밋에 들어간다", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    write(prDocFile("ORD-9"),
      ["# ORD-9 변경 보고서", "", "## 요약", "인사 함수를 더했다.", "", "## 확인 방법", "greet 를 부른다.", "", "## 위험·되돌리기", "없음.", ""].join("\n"));

    const { commit } = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-9", "greeting")!, []);
    const files = git("show", "--name-only", "--format=", commit).split("\n").map((line) => line.trim()).filter(Boolean);
    for (const expected of [
      FEAT_SRC,
      FEAT_TEST,
      ".code-agent/work/ORD-9/greeting.verify.json",
      ".code-agent/work/ORD-9/greeting.review.json",
      ".code-agent/work/ORD-9/greeting.plan.json",
      ".code-agent/approvals/ORD-9.jsonl",
      ".code-agent/approvals/ORD-9/greeting-1.plan.json",
      validationDocFile("ORD-9"),
      reviewDocFile("ORD-9"),
      prDocFile("ORD-9"),
    ]) {
      assert.ok(files.includes(expected), `커밋에 없습니다: ${expected}`);
    }
  });

  test("34b. 이미 인덱스에 올라가 있던 남의 파일은 반영 커밋에 실리지 않는다", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    write(prDocFile("ORD-9"),
      ["# ORD-9 변경 보고서", "", "## 요약", "인사 함수를 더했다.", "", "## 확인 방법", "greet 를 부른다.", "", "## 위험·되돌리기", "없음.", ""].join("\n"));

    // 사람이 터미널에서 친 git add · 앞서 실패한 deliver 가 남긴 스테이지
    write("unrelated.txt", "상관없는 파일\n");
    write(".code-agent/work/OTHER-1/x.verify.json", "{}\n");
    git("add", "--", "unrelated.txt", ".code-agent/work/OTHER-1/x.verify.json");

    const { commit } = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-9", "greeting")!, []);
    const files = git("show", "--name-only", "--format=", commit).split("\n").map((line) => line.trim()).filter(Boolean);
    assert.equal(files.includes("unrelated.txt"), false);
    assert.equal(files.includes(".code-agent/work/OTHER-1/x.verify.json"), false);
    assert.ok(files.includes(FEAT_SRC), `이 작업의 파일이 빠졌습니다: ${files.join(", ")}`);
    // 스테이지에는 그대로 남아 있다 — 사람이 올린 것을 이 명령이 되돌리지는 않는다
    assert.match(git("status", "--porcelain"), /^A {2}unrelated\.txt$/m);
  });

  test("35. 없는 경로가 섞여도 git add 가 서지 않는다 (존재 필터 회귀)", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    next(repo);
    write(prDocFile("ORD-9"),
      ["# ORD-9 변경 보고서", "", "## 요약", "인사 함수를 더했다.", "", "## 확인 방법", "greet 를 부른다.", "", "## 위험·되돌리기", "없음.", ""].join("\n"));

    // 판정 스냅샷 디렉토리가 없는 상태 · 아직 쓰이지 않은 KNOWLEDGE 경로
    rmSync(join(repo, ".code-agent/approvals/ORD-9"), { recursive: true, force: true });
    const { commit } = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-9", "greeting")!, ["doc/knowledge/없는-파일.md"]);
    assert.equal(commit.length, 40);
  });

  // ---- prepare ----

  test("36. prepare 가 없는 매니페스트의 해시는 그대로다 (골든 — 기존 승인 보존)", () => {
    write("code-agent.json", JSON.stringify({
      language: "java",
      sourceExtensions: [".java"],
      domainBase: "src/main/java/com/acme/app",
      domainRoots: ["application"],
      conventions: ["doc/conventions.md"],
      docs: { architecture: "doc/architecture.md" },
      referenceDomain: "deal",
      build: ["node", "-e", "process.exit(0)"],
      test: ["node", "-e", "process.exit(0)"],
      stages: [
        { key: "entity", title: "Entity", template: "01-entity.md", kinds: ["feature"], outputDirs: ["domain"] },
        { key: "repository", title: "Repository", template: "02-repository.md", kinds: ["feature"], outputDirs: ["repository"] },
        { key: "test", title: "테스트", template: "03-test.md", kind: "test", kinds: ["feature"], scope: "project", outputDirs: ["src/test"] },
      ],
    }));
    assert.equal(hashManifest(loadManifest(repo)), "sha256:d54b43e8bd896c09");
  });

  test("37. prepare 를 선언하면 해시가 달라진다 — 묶임이 실재한다", () => {
    write("code-agent.json", manifest());
    const before = hashManifest(loadManifest(repo));
    write("code-agent.json", manifest({ prepare: ["npm", "ci"] }));
    assert.notEqual(hashManifest(loadManifest(repo)), before);
  });

  test("38. commands 에 prepare 를 선언하면 형식 오류다", () => {
    write("code-agent.json", manifest({ commands: { prepare: PASS } }));
    assert.throws(() => loadManifest(repo), /prepare 은 commands 에 선언할 수 없습니다/);
  });

  test("38b. 빈 prepare 는 형식 오류다 — 돈다고 읽히는데 조용히 건너뛰는 선언을 두지 않는다", () => {
    write("code-agent.json", manifest({ prepare: [] }));
    assert.throws(() => loadManifest(repo), /prepare/);
  });

  test("38c. 문서가 `prepare` 를 명령 이름으로 적어도 check·test 가 준비 명령을 돌리지 않는다", () => {
    // 준비 명령은 깨끗한 worktree 의 것이다 — 사람이 보고 있는 작업 트리에서 돌면 스키마가 적은 약속이 깨진다
    write("code-agent.json", manifest({ test: PRINT_TC, prepare: ["npm", "ci"] }));
    write("doc/test-strategy.md", STRATEGY_PREPARE);
    write("doc/quality.md", QUALITY_PREPARE);
    const loaded = loadManifest(repo);
    for (const spec of [...testCommands(repo, loaded), ...checkCommands(repo, loaded)].filter((spec) => spec.kind === "prepare")) {
      assert.equal(spec.argv, undefined, "작업 트리에서 준비 명령이 풀렸습니다");
    }
    // 통합 검증의 자리에서는 그대로 돈다
    assert.deepEqual(prepareCommand(loaded), { kind: "prepare", argv: ["npm", "ci"] });
  });

  test("39. prepare 가 통과하면 worktree 안에서 build·test 가 이어 돈다", async () => {
    useManifest({ prepare: PASS });
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    const runs = runsOf(loadEvidence(repo, "ORD-9", "greeting")!, "integrate");
    assert.deepEqual(runs.map((run) => `${run.kind}=${run.outcome}`), ["prepare=passed", "build=passed", "test=passed"]);
    assert.deepEqual(stageProblems(loadWork(repo)!, "integrate"), []);
  });

  test("40. prepare 가 실패하면 build·test 를 돌리지 않고 통합 검증이 막힌다", async () => {
    useManifest({ prepare: FAIL });
    await runToIntegrate();
    const out = await integrate(requireValidatable(repo, "integrate"));
    assert.match(out, /준비 명령이 실패해 build·test 를 돌리지 않았습니다/);
    const runs = runsOf(loadEvidence(repo, "ORD-9", "greeting")!, "integrate");
    assert.deepEqual(runs.map((run) => run.kind), ["prepare"]);
    assert.equal(runs[0].cause, "environment", "준비 실패는 환경으로 분류한다 — 결과는 failed 그대로다");
    assert.ok(stageProblems(loadWork(repo)!, "integrate").some((problem) => /prepare: failed/.test(problem)));
  });

  test("40b. prepare 실패의 통합 검증 재실행은 같은 회차로 2회까지다", async () => {
    useManifest({ prepare: FAIL });
    await runToIntegrate();
    for (let tries = 0; tries < 3; tries++) {
      const out = await integrate(requireValidatable(repo, "integrate"));
      assert.match(out, /환경 문제로 분류했습니다/);
      // 재개 안내는 한 가지다 — 같은 회차는 code-agent integrate 로 다시 돈다. verify --retry 는 check 로 되감아 같은 코드 재실행을 쓴다
      assert.match(out, new RegExp(`code-agent integrate 로 같은 회차를 다시 돌리세요 — 고쳐 쓰기 회차를 쓰지 않습니다\\(남은 통합 검증 재실행 ${2 - tries}회\\)`));
      assert.doesNotMatch(out, /verify --retry|같은 코드 재실행/);
      assert.equal(out.match(/남은 통합 검증 재실행/g)!.length, 1);
      const evidence = loadEvidence(repo, "ORD-9", "greeting")!;
      assert.equal(runsOf(evidence, "integrate")[0].cause, "environment");
      assert.equal(evidence.retry!.integrateReruns[String(evidence.rounds)] ?? 0, tries);
      assert.equal(evidence.retry!.started, undefined, "끝 저장이 시작 표지를 지운다");
    }
    await assert.rejects(() => integrate(requireValidatable(repo, "integrate")),
      (error: Error) => error instanceof RetryRefused && /통합 검증 재실행 한도 2회/.test(error.message));
  });

  test("41. prepare 실행 파일이 없으면 error 로 막힌다", async () => {
    useManifest({ prepare: NOT_INSTALLED });
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    const runs = runsOf(loadEvidence(repo, "ORD-9", "greeting")!, "integrate");
    assert.deepEqual(runs.map((run) => `${run.kind}=${run.outcome}`), ["prepare=error"]);
    assert.ok(stageProblems(loadWork(repo)!, "integrate").some((problem) => /prepare: error/.test(problem)));
  });

  test("42. prepare 를 선언하지 않은 매니페스트의 통합 검증은 그대로 통과한다 (C4 회귀)", async () => {
    useManifest();
    await runToIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    const runs = runsOf(loadEvidence(repo, "ORD-9", "greeting")!, "integrate");
    assert.deepEqual(runs.map((run) => `${run.kind}=${run.outcome}`), ["build=passed", "test=passed"]);
    assert.deepEqual(stageProblems(loadWork(repo)!, "integrate"), []);
  });

  test("43. 계획이 prepare 명령이 가리키는 파일을 쓰면 제출되지 않는다", () => {
    useManifest({ prepare: ["node", FEAT_SRC] });
    start(repo, join(repo, "doc/work/ORD-9.md"));
    write("doc/work/ORD-9/01-requirements.md",
      ["# ORD-9 요구사항 정의", "## R1 · 인사한다", "근거: \"이름을 받아 인사한다.\"", "- 데이터: 만든다", "## 가정", "- 없음"].join("\n"));
    write("doc/work/ORD-9/02-analysis.md", [
      "# 영향도 분석", "## 기존 시스템 분석", "- 붙을 코드가 없다 — 새 파일이다",
      "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
      `| R1 | ${FEAT_SRC} | 없음 | 없음 — 새 파일 |`, "## Risk", "- 없음",
    ].join("\n"));
    write("doc/work/ORD-9/03-design.md", [
      "# 기술 설계", "## 구성 요소", "- greeting", "## 처리 흐름", "- 이름 → 문자열",
      "## API", "해당 없음 — 접점이 없다", "## 데이터", "해당 없음 — 저장하지 않는다", "## 설계 결정", "- 순수 함수",
    ].join("\n"));
    write("doc/work/ORD-9/04-functional.md", [
      "# 기능 명세", "## 기능 정의", "- R1: 인사한다", "## 업무 규칙", "- 없음 — 규칙이 없다",
      "## 예외", "- 빈 이름: Error", "## 수락 기준", "- AC-R1-1: 이름을 주면 인사 문자열이 나온다",
    ].join("\n"));
    write("doc/work/ORD-9/07-test-spec.md", [
      "# 테스트 명세", "## 테스트 케이스", "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |", "|---|---|---|---|---|",
      "| TC-1 | Unit | AC-R1-1 | 이름을 준다 | 인사 문자열이 나온다 |",
    ].join("\n"));
    next(repo);
    next(repo);
    next(repo);
    write("doc/work/ORD-9/plan.json", JSON.stringify(FEAT_PLAN));
    assert.throws(
      () => submitPlan(repo, join(repo, "doc/work/ORD-9/plan.json")),
      /검증 명령이 이 계획이 쓰는 파일을 가리킵니다/,
    );
  });
});
