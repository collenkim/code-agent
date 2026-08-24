/**
 * kind: adopt — 이미 있는 저장소에 도입한다.
 *
 * 여기서 판정되는 것은 **근거가 어디서 오는가**다. adopt 에는 복제할 참조 도메인이 없고
 * 이미 있는 코드가 정본이므로, 그 코드를 코드가 읽어 실어야 한다. 싣지 않으면 계획이
 * 파일 경로를 지어내고 그 뒤 단계가 저장소를 처음부터 훑는다.
 *
 * 이 테스트들은 실제로 한 번 돌려 본 뒤에 생겼다 — 그 실행에서 탐색 8건 중 5건이
 * "저장소에 무슨 파일이 있나" 였다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { laneDir } from "../core/targets";
import { applyResponse, decideApproval, nextPrompt } from "../core/turn";
import type { BuildContext } from "../core/types";
import { validateWorkOrder } from "../core/workOrder";

const MANIFEST = {
  language: "typescript",
  sourceExtensions: [".ts"],
  domainBase: "src",
  domainRoots: [],
  conventions: [],
  stages: [
    {
      key: "survey",
      title: "구조 조사서",
      template: "01-survey.md",
      kind: "doc",
      kinds: ["adopt", "bootstrap"],
      scope: "project",
      exemplars: [],
      reads: ["package.json"],
      outputDirs: ["doc"],
    },
  ],
};

const PLAN = {
  domainName: "code-agent",
  domainLabel: "저장소",
  domainRoot: "",
  domainDirName: "",
  files: [{ stage: "survey", path: "doc/survey.md", purpose: "구조 조사서" }],
  conventions: [],
  conflicts: [],
  openQuestions: [] as string[],
  reasoning: "코드에서 읽어 낸다",
};

let root: string;
let context: BuildContext;

function write(relative: string, content: string) {
  const path = join(root, "repo", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-adopt-"));
  write("src/core/state.ts", "export const PLAN_FILE = 1;\n");
  write("src/cli/index.ts", "export const cli = 1;\n");
  write("package.json", '{ "name": "target", "dependencies": { "zod": "^4" } }\n');
  // 소스가 아닌 것들 — 대상이 저장소 전체(`.`)여도 실려서는 안 된다.
  write("node_modules/dep/index.ts", "export const noise = 1;\n");
  write(".idea/workspace.ts", "export const noise = 2;\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-survey.md", "# [01] 조사\n");
  writeFileSync(
    join(root, "spec.md"),
    "---\nkind: adopt\nid: ADOPT-1\ntitle: 도입\ntarget: .\n---\n\n# 도입 대상\n",
    "utf-8",
  );

  context = {
    specPaths: [join(root, "spec.md")],
    templatesDir: "doc/templates",
    repoRoot: join(root, "repo"),
    outDir: join(root, "out"),
    gate: false,
    maxRetries: 1,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("근거는 이미 있는 코드에서 온다", () => {
  test("참조 표준이 없으면 대상의 현재 파일이 계획 프롬프트에 실린다", () => {
    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /# 대상의 현재 파일/);
    assert.match(prompt, /src\/core\/state\.ts/);
    assert.match(prompt, /src\/cli\/index\.ts/);
    assert.doesNotMatch(prompt, /복제할 기존 코드가 없는 실행이다/);
  });

  test("소스가 아닌 곳은 싣지 않는다 — 상한에 걸려 정작 볼 파일이 밀려난다", () => {
    const prompt = nextPrompt(context).prompt!;

    assert.doesNotMatch(prompt, /node_modules/);
    assert.doesNotMatch(prompt, /\.idea/);
  });

  test("복제할 코드도 없고 대상이 경로도 아니면 없다고 말한다", () => {
    writeFileSync(
      join(root, "spec.md"),
      "---\nkind: bootstrap\nid: NEW-1\ntitle: 새로 만든다\ntarget: 새-프로젝트\n---\n\n# 새 프로젝트\n",
      "utf-8",
    );

    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /복제할 기존 코드가 없는 실행이다/);
  });

  test("단계가 선언한 파일은 코드가 읽어 싣는다 — 사람이 옮겨 적으면 어긋난다", () => {
    applyResponse(context, JSON.stringify(PLAN));
    decideApproval(context, "approved", { approver: "팀장", target: "." });

    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /# 프로젝트가 선언한 참고 파일/);
    assert.match(prompt, /## package\.json/);
    assert.match(prompt, /"zod": "\^4"/);
  });
});

describe("대상 이름이 경로를 거스르지 않는다", () => {
  test("점으로만 된 대상은 갈래 이름으로 쓰지 않는다", () => {
    const order = (target: string) =>
      validateWorkOrder(
        join(root, "repo"),
        { kind: "adopt", id: "ADOPT-1", title: "t", target },
        "spec.md",
        { attributes: [], requireApprover: false },
      );

    assert.equal(laneDir("out", order("."), "."), join("out", "ADOPT-1", "unnamed"));
    assert.equal(laneDir("out", order(".."), ".."), join("out", "ADOPT-1", "unnamed"));
  });
});
