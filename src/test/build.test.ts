/**
 * 검증 worktree — 무엇 위에 무엇이 얹히는가.
 *
 * 바뀐 파일만으로는 빌드할 수 없고(의존 코드가 저장소에 있다) 사람이 보고 있는 작업트리에서
 * 그대로 돌리면 검증이 중간 상태를 밟으므로, 임시 git worktree 에 얹어 돌린다. 여기서
 * 판정되는 것은 **그 worktree 가 굳혀 둔 커밋의 저장소 위에 얹은 파일로 이루어지는가**다.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { hashManifest } from "../core/approval";
import { pinRefs, runCommand, verifyByBuild } from "../core/build";
import { loadManifest } from "../core/manifest";
import type { Manifest } from "../core/manifest";

let root: string;
let repo: string;
let filesDir: string;

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
    fixRounds: 2,
    commandTimeoutMinutes: 10,
    plugins: {},
    commands: {},
    docs: {},
    git: { base: "master" },
    workOrder: { attributes: [], requireApprover: false, requireVerifiedApproval: false },
    stages: [
      {
        key: "impl",
        title: "구현",
        template: "01.md",
        kind: "code",
        kinds: [],
        confirm: true,
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
  filesDir = join(root, "changed");

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

  // worktree 에 얹을 파일들 — 저장소 루트 기준 구조를 그대로 갖는다.
  mkdirSync(join(filesDir, "src"), { recursive: true });
  writeFileSync(join(filesDir, "src", "thing.js"), "module.exports = 2;\n", "utf-8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("검증 worktree 는 저장소 위에 바뀐 파일을 얹는다", () => {
  test("바뀐 파일은 올라간다", async () => {
    const result = await verifyByBuild(repo, manifestWith(LIST_TREE), filesDir, STAGES, "build");

    assert.equal(result.outcome, "passed", result.log);
    assert.match(result.log, /README\.md/, "저장소 파일이 있어야 한다");
    assert.match(result.log, /src\//, "바뀐 파일이 얹혀야 한다");
  });

  test("돌지 못한 명령은 실패가 아니라 실행 오류다", async () => {
    const result = await verifyByBuild(
      repo,
      manifestWith(["code-agent-no-such-command-xyz"]),
      filesDir,
      STAGES,
      "build",
    );

    assert.equal(result.outcome, "error", "환경 고장을 재현으로 읽으면 안 된다");
    assert.match(result.log, /실행 파일을 찾을 수 없습니다/);
  });

  /**
   * 재현 실패와 환경 고장을 가른다.
   *
   * 둘을 같은 "실패"로 읽으면 git 저장소가 아닌 곳에서 아무 테스트도 안 쓰고 검증이 끝난다 —
   * `expect: fail` 은 `failed` 만 재현으로 인정한다.
   */
  test("git 저장소가 아니면 실행 오류다 — 재현으로 치지 않는다", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });

    const result = await verifyByBuild(repo, manifestWith(LIST_TREE), filesDir, STAGES, "build");

    assert.equal(result.outcome, "error");
    assert.notEqual(result.outcome, "failed", "환경이 고장 난 것은 재현이 아니다");
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

    const result = await verifyByBuild(repo, manifestWith(LIST_TREE), filesDir, STAGES, "build", pinned);

    assert.ok(result.passed, result.log);
    assert.ok(!result.log.includes("LATER.md"), `굳힌 커밋 이후의 파일이 올라왔다:\n${result.log}`);
    assert.ok(result.log.includes("README.md"), result.log);
  });

  test("ref 를 주지 않으면 예전처럼 그때의 HEAD 를 본다", async () => {
    commitFile("LATER.md");

    const result = await verifyByBuild(repo, manifestWith(LIST_TREE), filesDir, STAGES, "build");

    assert.ok(result.passed, result.log);
    assert.ok(result.log.includes("LATER.md"), result.log);
  });

  test("없는 커밋을 주면 실패가 아니라 실행 오류로 갈린다", async () => {
    const result = await verifyByBuild(
      repo,
      manifestWith(LIST_TREE),
      filesDir,
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
 * 매니페스트의 빈 배열 — 두 독자가 어긋나던 자리.
 *
 * `evidence.argvOf` 는 `build: []` 를 "선언 없음"(not-run · skipped)으로 보고, `docs.commandProblems`
 * 는 `manifest.build ? …` 라서 있는 것으로 봤다. 그래서 문서에 `test` 를 적으면 확정 게이트를
 * 통과하고 `code-agent test` 는 아무것도 돌리지 않은 결과 위에 "돌렸다" 를 세울 수 있었다.
 * 스키마에서 막아 애초에 로드되지 않게 한다 — 규칙 하나를 세 자리에 다르게 두지 않는다.
 */
describe("빈 명령 배열은 형식 오류다", () => {
  function load(raw: Record<string, unknown>): Manifest {
    const dir = mkdtempSync(join(tmpdir(), "code-agent-manifest-"));
    writeFileSync(join(dir, "code-agent.json"), JSON.stringify({
      domainBase: "src",
      stages: [{ key: "only", title: "하나", template: "t.md" }],
      ...raw,
    }), "utf-8");
    try {
      return loadManifest(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("build: [] 은 로드되지 않는다 — 조용한 통과가 여기서 끊긴다", () => {
    assert.throws(() => load({ build: [] }), /형식 오류[\s\S]*build/);
  });

  test("test: [] 도 같다", () => {
    assert.throws(() => load({ test: [] }), /형식 오류[\s\S]*test/);
  });

  test("commands 의 빈 값도 같은 함정이다", () => {
    assert.throws(() => load({ commands: { migrate: [] } }), /형식 오류[\s\S]*commands\.migrate/);
  });

  test("한 원소짜리는 그대로 통과한다 — 막는 것은 빈 것뿐이다", () => {
    assert.deepEqual(load({ build: ["make"], commands: { lint: ["eslint"] } }).build, ["make"]);
  });

  /**
   * **해시 중립 증명.** `.min(1)` 은 *유효한* 매니페스트의 파싱 결과를 한 글자도 바꾸지 않는다.
   * 아래 두 리터럴은 변경 전(HEAD) 트리를 그대로 빌드해 뽑은 값이다 — 이 테스트가 깨지면
   * 이미 받은 승인이 전부 stale-manifest 가 된다는 뜻이므로, 값을 고치지 말고 원인을 본다.
   */
  test("기존 매니페스트의 hashManifest 는 변경 전과 같다", () => {
    assert.equal(
      hashManifest(load({
        language: "java",
        domainBase: "src/main/java/com/acme/app/application",
        domainRoots: ["", "admin"],
        conventions: ["doc/conventions.md"],
        referenceDomain: "deal",
        build: ["./gradlew", "compileJava"],
        test: ["./gradlew", "test"],
        prepare: ["npm", "ci"],
        commands: { migrate: ["./gradlew", "flywayMigrate"], lint: ["./gradlew", "spotlessCheck"] },
        fixRounds: 3,
        stages: [
          { key: "domain", title: "도메인", template: "domain.md", outputDirs: ["domain"], exemplars: ["{Ref}.java"] },
          { key: "verify", title: "검증", template: "verify.md", kind: "verify", expect: "pass", scope: "project" },
        ],
      })),
      "sha256:da07ca103b10411f",
    );
    assert.equal(hashManifest(load({})), "sha256:3e247950176e5efa");
  });
});

describe("검증 명령 제한 시간", () => {
  function load(raw: Record<string, unknown>): Manifest {
    const dir = mkdtempSync(join(tmpdir(), "code-agent-manifest-"));
    writeFileSync(join(dir, "code-agent.json"), JSON.stringify({ domainBase: "src", stages: [{ key: "only", title: "하나", template: "t.md" }], ...raw }), "utf-8");
    try { return loadManifest(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("시간을 넘기면 출력 파이프를 쥔 손자까지 끝내고 기다림 없이 실행 오류로 돌아온다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ca-timeout-")), pidFile = join(dir, "grandchild.pid");
    // gradle 처럼 셸 아래 손자가 stdout 을 물려받아 오래 산다
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},30000)`;
    try {
      const started = Date.now();
      const result = await runCommand(dir, ["node", "-e", script], process.env, 1500);
      assert.ok(Date.now() - started < 15000, "close 를 기다리며 멈추지 않는다");
      assert.match(result.error?.message ?? "", /제한 시간 1\.5초.*commandTimeoutMinutes/);
      if (process.platform === "win32" && existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        assert.throws(() => process.kill(pid, 0), "Windows 에서는 프로세스 트리째 끝낸다");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("제한 시간은 code-agent.json 으로 바꾸고, 바꿔도 승인 해시는 그대로다", () => {
    assert.equal(load({}).commandTimeoutMinutes, 10);
    assert.equal(load({ commandTimeoutMinutes: 45 }).commandTimeoutMinutes, 45);
    assert.equal(hashManifest(load({ commandTimeoutMinutes: 45 })), hashManifest(load({})));
    assert.throws(() => load({ commandTimeoutMinutes: 0 }));
  });

  test("환경 오류 패턴은 선언했을 때만 승인 해시에 들어가고, 너무 짧은 문구는 받지 않는다", () => {
    assert.equal(hashManifest(load({ environmentErrors: [] })), hashManifest(load({})), "선언하지 않은 기존 프로젝트의 승인은 그대로다");
    assert.notEqual(hashManifest(load({ environmentErrors: ["Could not find a valid Docker environment"] })), hashManifest(load({})));
    assert.throws(() => load({ environmentErrors: ["Error"] }), /6자 이상/);
  });
});
