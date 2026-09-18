/**
 * 검증 worktree — 무엇이 올라가고 무엇이 올라가지 않는가.
 *
 * 생성물만으로는 빌드할 수 없고(의존 코드가 저장소에 있다) 대상 저장소 작업트리에 직접 쓰면
 * "저장소 무변경" 약속이 깨지므로, 임시 git worktree 에 얹어 돌린다. 여기서 판정되는 것은
 * **그 worktree 가 저장소와 생성물만으로 이루어지는가**다 — 계획·세션이 따라 올라가면
 * 검증 명령이 보는 트리에 저장소에는 없던 파일이 생기고, 그것으로 깨지는 검사가 있다.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { pinRefs, verifyByBuild } from "../core/build";
import { loadManifest } from "../core/manifest";
import {
  rememberedRefs,
  rememberIssuedToken,
  rememberRefs,
  takeIssuedToken,
} from "../core/targets";
import type { Manifest } from "../core/manifest";

let root: string;
let repo: string;
let outDir: string;

/** worktree 가 실제로 무엇을 보는지 그대로 찍는 명령. 검증이 아니라 관측이 목적이다 */
const LIST_TREE = [
  "node",
  "-e",
  "const {readdirSync}=require('fs');console.log(readdirSync('.',{withFileTypes:true})" +
    ".map(e=>e.name+(e.isDirectory()?'/':'')).sort().join(' '))",
];

function manifestWith(build: string[]): Manifest {
  return {
    language: "javascript",
    sourceExtensions: [".js"],
    domainBase: "src",
    domainRoots: [],
    conventions: [],
    build,
    commands: {},
    workOrder: { attributes: [], requireApprover: false, requireVerifiedApproval: false },
    stages: [
      {
        key: "impl",
        title: "구현",
        template: "01.md",
        kind: "code",
        kinds: [],
        confirm: true,
        reads: [],
        exemplars: [],
        scope: "project",
        outputDirs: ["src"],
      },
    ],
  };
}

const STAGES = [
  { stage: "impl", attempts: 1, files: [{ path: "src/thing.js", content: "module.exports = 2;\n" }] },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-verify-"));
  repo = join(root, "repo");
  outDir = join(root, "out");

  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# repo\n", "utf-8");
  writeFileSync(join(repo, "src", "existing.js"), "module.exports = 1;\n", "utf-8");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
    { cwd: repo },
  );

  // 생성물과, 생성물이 아닌 진행 상태가 같은 디렉토리에 있다 — 이것이 실제 out/ 의 모습이다.
  mkdirSync(join(outDir, "src"), { recursive: true });
  mkdirSync(join(outDir, ".code-agent"), { recursive: true });
  writeFileSync(join(outDir, "src", "thing.js"), "module.exports = 2;\n", "utf-8");
  writeFileSync(join(outDir, ".plan.json"), "{}", "utf-8");
  writeFileSync(join(outDir, ".spec-slots.json"), "{}", "utf-8");
  writeFileSync(join(outDir, ".code-agent", "session.json"), "{}", "utf-8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("검증 worktree 는 저장소와 생성물만 본다", () => {
  test("생성물은 올라간다", async () => {
    const result = await verifyByBuild(repo, manifestWith(LIST_TREE), outDir, STAGES, "build");

    assert.equal(result.outcome, "passed", result.log);
    assert.match(result.log, /README\.md/, "저장소 파일이 있어야 한다");
    assert.match(result.log, /src\//, "생성물이 얹혀야 한다");
  });

  test("계획·세션·파생물은 올라가지 않는다", async () => {
    const result = await verifyByBuild(repo, manifestWith(LIST_TREE), outDir, STAGES, "build");

    assert.doesNotMatch(result.log, /\.plan\.json/, "계획은 생성물이 아니다");
    assert.doesNotMatch(result.log, /\.code-agent/, "세션은 생성물이 아니다");
    assert.doesNotMatch(result.log, /\.spec-slots\.json/, "파생물은 생성물이 아니다");
  });

  test("돌지 못한 명령은 실패가 아니라 실행 오류다", async () => {
    const result = await verifyByBuild(
      repo,
      manifestWith(["code-agent-no-such-command-xyz"]),
      outDir,
      STAGES,
      "build",
    );

    assert.equal(result.outcome, "error", "환경 고장을 재현으로 읽으면 안 된다");
    assert.match(result.log, /실행 파일을 찾을 수 없습니다/);
  });
});

describe("매니페스트 — 조용히 무시되는 선언을 만들지 않는다", () => {
  function writeManifest(value: unknown): string {
    const dir = join(root, "templates");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code-agent.json"), JSON.stringify(value), "utf-8");
    return dir;
  }

  test("commands 에 build·test 를 선언하면 거부한다", () => {
    const base = manifestWith(["npm", "run", "build"]);

    for (const reserved of ["build", "test"]) {
      const dir = writeManifest({ ...base, commands: { [reserved]: ["echo", "x"] } });

      assert.throws(
        () => loadManifest(dir),
        new RegExp(`${reserved} 은 commands 에 선언할 수 없습니다`),
        `${reserved} 를 적으면 조용히 무시되던 자리다`,
      );
    }
  });

  test("다른 이름은 그대로 받는다", () => {
    const dir = writeManifest({
      ...manifestWith(["npm", "run", "build"]),
      commands: { migrate: ["npm", "run", "migrate"] },
    });

    assert.deepEqual(loadManifest(dir).commands, { migrate: ["npm", "run", "migrate"] });
  });
});

/**
 * 브랜치는 움직이고 체크아웃도 바뀐다.
 *
 * 굳혀 두지 않으면 같은 작업이 언제 검증하느냐에 따라 다른 코드를 보게 된다 — 레거시
 * 브랜치를 진행하는 중이라면 그 차이가 그대로 "통과했는데 실제로는 안 되는" 자리가 된다.
 * 그래서 여기서 보는 것은 **검증이 지금의 HEAD 가 아니라 굳혀 둔 커밋 위에 서는가**다.
 */
describe("검증은 굳혀 둔 커밋 위에 선다", () => {
  /** 지금 HEAD 의 커밋 */
  function head(): string {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
  }

  function commitFile(name: string) {
    writeFileSync(join(repo, name), "x\n", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", name],
      { cwd: repo },
    );
  }

  test("ref 를 주면 그 커밋의 트리를 본다 — 그 뒤 커밋은 보이지 않는다", async () => {
    const pinned = head();
    commitFile("LATER.md");

    const result = await verifyByBuild(repo, manifestWith(LIST_TREE), outDir, STAGES, "build", pinned);

    assert.ok(result.passed, result.log);
    assert.ok(!result.log.includes("LATER.md"), `굳힌 커밋 이후의 파일이 올라왔다:\n${result.log}`);
    assert.ok(result.log.includes("README.md"), result.log);
  });

  test("ref 를 주지 않으면 예전처럼 그때의 HEAD 를 본다", async () => {
    commitFile("LATER.md");

    const result = await verifyByBuild(repo, manifestWith(LIST_TREE), outDir, STAGES, "build");

    assert.ok(result.passed, result.log);
    assert.ok(result.log.includes("LATER.md"), result.log);
  });

  test("없는 커밋을 주면 실패가 아니라 실행 오류로 갈린다", async () => {
    const result = await verifyByBuild(
      repo,
      manifestWith(LIST_TREE),
      outDir,
      STAGES,
      "build",
      "없는브랜치",
    );

    // 재현된 실패로 읽히면 "검증했는데 깨졌다"로 오독된다. 환경이 어긋난 것과 구분한다.
    assert.equal(result.outcome, "error");
    assert.match(result.log, /없는브랜치/);
  });
});

describe("pinRefs — 작업·비교 브랜치 굳히기", () => {
  test("생략하면 작업은 HEAD, 비교는 기본 브랜치로 굳는다", async () => {
    const refs = await pinRefs(repo);

    assert.ok(refs);
    assert.equal(refs.work.ref, "HEAD");
    assert.match(refs.work.commit, /^[0-9a-f]{40}$/);
    // git init 의 기본 브랜치는 설정에 따라 master 이거나 main 이다. 둘 다 받는다.
    assert.ok(["master", "main"].includes(refs.base?.ref ?? ""), refs.base?.ref ?? "(없음)");
  });

  test("master 도 main 도 없으면 비교는 비워 두고 작업은 그대로 굳는다", async () => {
    // 기본 브랜치 이름이 다른 저장소 하나 때문에 작업을 통째로 막지 않는다.
    execFileSync("git", ["branch", "-m", "trunk"], { cwd: repo });

    const refs = await pinRefs(repo);

    assert.ok(refs);
    assert.match(refs.work.commit, /^[0-9a-f]{40}$/, "검증이 딛는 자리는 그대로 굳어야 한다");
    assert.equal(refs.base, undefined, "짐작해서 적지 않는다");
  });

  test("적어 주면 그 이름으로 굳는다", async () => {
    execFileSync("git", ["branch", "release"], { cwd: repo });
    execFileSync("git", ["checkout", "-qb", "feat/x"], { cwd: repo });

    const refs = await pinRefs(repo, "feat/x", "release");

    assert.ok(refs);
    assert.equal(refs.work.ref, "feat/x");
    assert.equal(refs.base?.ref, "release");
    // 지금은 둘이 같은 커밋을 가리킨다 — 굳은 값이라 이후 브랜치가 움직여도 이 값은 그대로다.
    assert.equal(refs.work.commit, refs.base?.commit);
  });

  test("없는 이름은 조용히 넘기지 않는다", async () => {
    await assert.rejects(() => pinRefs(repo, "없는브랜치"), /작업 브랜치를 찾을 수 없습니다/);
    await assert.rejects(() => pinRefs(repo, undefined, "없는브랜치"), /비교 브랜치를 찾을 수 없습니다/);
  });

  test("git 저장소가 아니면 굳히지 않는다 — 스펙만 두는 폴더도 작업 대상이다", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });

    assert.equal(await pinRefs(plain), undefined);
  });

  test("git 저장소가 아닌데 브랜치를 적었으면 그건 오타다", async () => {
    const plain = join(root, "plain2");
    mkdirSync(plain, { recursive: true });

    await assert.rejects(() => pinRefs(plain, "master"), /git 저장소가 아닙니다/);
  });
});

/**
 * CLI 는 명령마다 새 프로세스다.
 *
 * `next` 와 `apply` 가 다른 프로세스라, 굳힌 값을 어딘가에 적어 두지 않으면 매 호출이 그때의
 * HEAD 를 다시 굳힌다 — 그러면 "굳혔다"는 말이 거짓이 되고, 앞 단계는 A 위에서 뒤 단계는
 * B 위에서 검증된 산출물이 한 out 에 섞인다. 여기서 보는 것은 **두 번째 호출이 첫 번째가
 * 굳힌 자리를 그대로 쓰는가**다.
 */
describe("굳힌 자리는 호출이 갈려도 유지된다", () => {
  let outDir2: string;

  beforeEach(() => {
    outDir2 = join(root, "out-cli");
    mkdirSync(outDir2, { recursive: true });
  });

  function moveHead(name: string) {
    writeFileSync(join(repo, name), "x\n", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", name],
      { cwd: repo },
    );
  }

  test("두 번째 호출은 HEAD 가 움직여도 처음 굳힌 커밋을 쓴다", async () => {
    const first = await pinRefs(repo);
    assert.ok(first);
    rememberRefs(outDir2, first);

    moveHead("MOVED.md");

    // 두 번째 프로세스가 하는 일과 같다 — 적힌 것이 있으면 다시 굳히지 않는다.
    const second = rememberedRefs(outDir2);

    assert.equal(second?.work.commit, first.work.commit, "굳힌 커밋이 따라 움직이면 안 된다");

    // 그 커밋으로 검증하면 그 뒤의 커밋은 보이지 않는다.
    const result = await verifyByBuild(
      repo,
      manifestWith(LIST_TREE),
      outDir,
      STAGES,
      "build",
      second!.work.commit,
    );
    assert.ok(result.passed, result.log);
    assert.ok(!result.log.includes("MOVED.md"), `굳힌 뒤의 커밋이 올라왔다:\n${result.log}`);
  });

  test("토큰을 받아 가도 굳힌 자리는 남는다", () => {
    // run.json 을 다시 쓰는 자리가 여럿이다. 그중 하나가 통째로 덮어쓰면 조용히 사라진다.
    const pinned = { work: { ref: "HEAD", commit: "a".repeat(40) } };
    rememberRefs(outDir2, pinned);
    rememberIssuedToken(outDir2, "shipment", "token-1");

    assert.equal(takeIssuedToken(outDir2), "token-1");
    assert.deepEqual(rememberedRefs(outDir2), pinned, "토큰만 지워야 한다");
  });
});
