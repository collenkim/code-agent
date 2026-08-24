/**
 * kind: fix — 재현이 먼저다.
 *
 * 여기서 판정되는 것은 하나다. **재현 테스트가 먼저 실패하고, 고친 뒤에 통과하는가.**
 * 그리고 그 판정을 모델의 말이 아니라 **실제로 돌린 결과**로 하는가.
 *
 * 고치고 나서 테스트를 쓰면 그 테스트가 결함을 잡는지 알 수 없다. 지금 코드에서 실패하는
 * 것을 먼저 보여야 그 뒤의 통과가 뜻을 갖는다 — 그래서 이 테스트는 명령을 실제로 돌린다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { loadSession } from "../core/session";
import { applyResponse, decideApproval, nextPrompt } from "../core/turn";
import type { BuildContext } from "../core/types";

const MANIFEST = {
  language: "javascript",
  sourceExtensions: [".js"],
  domainBase: "app",
  domainRoots: [],
  conventions: [],
  test: ["node", "tests/repro.js"],
  stages: [
    {
      // 재현 단계는 테스트만 쓸 수 있고, 그 명령이 **실패해야** 끝난다.
      key: "repro",
      title: "재현 테스트",
      template: "80-repro.md",
      kind: "verify",
      kinds: ["fix"],
      expect: "fail",
      scope: "project",
      exemplars: [],
      outputDirs: ["tests"],
    },
    {
      // 수정 단계는 본문 소스만 고칠 수 있다 — 테스트를 지워 통과시키는 길이 구조적으로 막힌다.
      key: "fix",
      title: "수정",
      template: "81-fix.md",
      kind: "verify",
      kinds: ["fix"],
      expect: "pass",
      scope: "project",
      exemplars: [],
      outputDirs: ["app"],
    },
  ],
};

const ORDER =
  "---\n" +
  "kind: fix\n" +
  "id: FIX-1\n" +
  "title: add 가 둘째 인자를 더하지 않는다\n" +
  "target: app/bug.js\n" +
  "scope: [app, tests]\n" +
  "preserve: [add 의 공개 시그니처]\n" +
  "---\n";

const PLAN = {
  files: [
    { stage: "repro", path: "tests/repro.js", purpose: "결함을 재현하는 테스트" },
    { stage: "fix", path: "app/bug.js", purpose: "둘째 인자를 더하도록 고친다" },
  ],
  preserve: [{ item: "add 의 공개 시그니처", how: "인자 수와 이름을 그대로 둔다" }],
  conventions: [],
  conflicts: [],
  openQuestions: [] as string[],
  reasoning: "재현 먼저, 그 다음 수정",
};

/** 결함을 재현하는 테스트 — 지금 코드에서는 실패한다 */
const REPRO_TEST = [
  '### write tests/repro.js',
  "```js",
  'const assert = require("assert");',
  'const { add } = require("../app/bug.js");',
  "assert.strictEqual(add(1, 2), 3);",
  "```",
].join("\n");

/** 아무것도 재현하지 못하는 테스트 — 지금 코드에서도 통과한다 */
const USELESS_TEST = [
  '### write tests/repro.js',
  "```js",
  'const assert = require("assert");',
  "assert.ok(true);",
  "```",
].join("\n");

const FIX_EDIT = [
  "### edit app/bug.js",
  "#### find",
  "```",
  "  return a;",
  "```",
  "#### replace",
  "```",
  "  return a + b;",
  "```",
].join("\n");

let root: string;
let context: BuildContext;

function write(relative: string, content: string) {
  const path = join(root, "repo", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function lane(...parts: string[]): string {
  return join(root, "out", "FIX-1", "app-bug.js", ...parts);
}

function git(...args: string[]) {
  const done = spawnSync("git", args, { cwd: join(root, "repo"), encoding: "utf-8" });
  assert.equal(done.status, 0, `git ${args[0]} 실패: ${done.stderr}`);
}

/** 계획을 세우고 승인까지 받은 상태 */
function planned() {
  applyResponse(context, JSON.stringify(PLAN));
  decideApproval(context, "approved", { approver: "팀장", target: "app/bug.js" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-fix-"));
  write("app/bug.js", "function add(a, b) {\n  return a;\n}\n\nmodule.exports = { add };\n");
  write("tests/existing.js", 'require("assert").ok(true);\n');
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/80-repro.md", "# [80] 재현 테스트\n");
  write("doc/templates/81-fix.md", "# [81] 수정\n");
  writeFileSync(join(root, "spec.md"), `${ORDER}\n# add(1, 2) 가 1 을 돌려준다\n`, "utf-8");

  // 검증은 임시 worktree 에서 돈다 — 저장소가 있어야 한다.
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture",
  );

  context = {
    specPaths: [join(root, "spec.md")],
    templatesDir: "doc/templates",
    repoRoot: join(root, "repo"),
    outDir: join(root, "out"),
    // 이 테스트가 보려는 것은 모델 검수가 아니라 돌려 본 결과다.
    gate: false,
    maxRetries: 1,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("계획은 재현부터 세운다", () => {
  test("계획 프롬프트가 재현을 먼저 요구한다", () => {
    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /결함 수정 계획자/);
    assert.match(prompt, /재현 테스트가 먼저다/);
    assert.match(prompt, /지금 코드에서 실패해야 한다/);
    assert.match(prompt, /"preserve"/, "고치는 작업이므로 보존 조건을 든다");
  });

  test("계획이 서면 재현 단계부터 돈다", () => {
    planned();

    assert.equal(nextPrompt(context).label, "repro");
  });
});

describe("돌려 보지 않으면 끝나지 않는다", () => {
  test("테스트만 쓰고 done 하면 단계가 끝나지 않는다", () => {
    planned();

    const outcome = applyResponse(context, `${REPRO_TEST}\n\n### done`);

    assert.equal(outcome.advanced, false);
    assert.equal(outcome.violations[0].item, "검증 미확인");
    assert.match(outcome.violations[0].detail, /돌려 보지 않고 끝냈습니다/);
  });

  test("실패를 확인한 뒤 done 하면 넘어간다 — 이것이 red 다", () => {
    planned();
    applyResponse(context, REPRO_TEST);

    const ran = applyResponse(context, "### run test");
    assert.equal(ran.execution!.verified, "fail", "재현 테스트는 지금 코드에서 실패해야 한다");
    assert.equal(loadSession(lane()).verified.repro, "fail");

    const done = applyResponse(context, "### done");
    assert.equal(done.advanced, true);
    assert.equal(nextPrompt(context).label, "fix");
  });

  test("재현하지 못하는 테스트는 거부한다 — 통과해 버리면 재현이 아니다", () => {
    planned();
    applyResponse(context, USELESS_TEST);
    const ran = applyResponse(context, "### run test");
    assert.equal(ran.execution!.verified, "pass");

    const done = applyResponse(context, "### done");

    assert.equal(done.advanced, false);
    assert.match(done.violations[0].detail, /재현하지 못한 테스트/);
  });

  test("돌려 본 뒤에 파일을 또 바꾸면 그 결과는 무효다", () => {
    planned();
    applyResponse(context, REPRO_TEST);
    applyResponse(context, "### run test");
    assert.equal(loadSession(lane()).verified.repro, "fail");

    // 확인 뒤에 테스트를 갈아 치웠다 — 앞서 본 실패는 이 파일에 대한 것이 아니다.
    const changed = applyResponse(context, `${USELESS_TEST}\n\n### done`);

    assert.equal(changed.advanced, false);
    assert.equal(loadSession(lane()).verified.repro, undefined);
    assert.equal(changed.violations[0].item, "검증 미확인");
  });
});

describe("고친 뒤에는 통과해야 끝난다 — 이것이 green 이다", () => {
  /** 재현 단계를 끝내 놓는다 */
  function reachFix() {
    planned();
    applyResponse(context, REPRO_TEST);
    applyResponse(context, "### run test");
    applyResponse(context, "### done");
  }

  test("고치지 않은 채 done 하면 끝나지 않는다", () => {
    reachFix();

    applyResponse(context, "### run test");
    const done = applyResponse(context, "### done");

    assert.equal(done.advanced, false);
    assert.match(done.violations[0].detail, /아직 실패합니다/);
  });

  test("고치고 통과를 확인하면 끝난다", () => {
    reachFix();

    applyResponse(context, FIX_EDIT);
    const ran = applyResponse(context, "### run test");
    assert.equal(ran.execution!.verified, "pass", "고친 뒤에는 통과해야 한다");

    const done = applyResponse(context, "### done");
    assert.equal(done.advanced, true);
    assert.match(
      readFileSync(lane("app/bug.js"), "utf-8"),
      /return a \+ b;/,
      "고친 내용은 out/ 에만 있다",
    );
    assert.match(
      readFileSync(join(root, "repo", "app/bug.js"), "utf-8"),
      /return a;\n/,
      "대상 저장소는 건드리지 않는다",
    );
  });

  test("수정 단계에서는 테스트를 고칠 수 없다 — 단언을 지워 통과시키는 길을 막는다", () => {
    reachFix();

    const outcome = applyResponse(
      context,
      [
        "### edit tests/repro.js",
        "#### find",
        "```",
        "assert.strictEqual(add(1, 2), 3);",
        "```",
        "#### replace",
        "```",
        "assert.ok(true);",
        "```",
      ].join("\n"),
    );

    assert.equal(outcome.violations[0].item, "do-not-touch 경계");
    assert.ok(existsSync(lane("tests/repro.js")));
    assert.match(
      readFileSync(lane("tests/repro.js"), "utf-8"),
      /assert\.strictEqual/,
      "단언이 살아 있어야 한다",
    );
  });
});
