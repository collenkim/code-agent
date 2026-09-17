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

import { verifyByBuild } from "../core/build";
import { loadManifest } from "../core/manifest";
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
