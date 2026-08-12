/**
 * 수동 모드(API 미사용) 경로의 회귀 테스트.
 *
 * 이 경로가 Phase 1의 전부라서 여기가 깨지면 아무것도 못 한다. 실제로 gate 프롬프트가
 * 전 단계에서 깨져 있었는데도 아무도 몰랐던 이유가 테스트가 없어서였다.
 *
 * ANTHROPIC_API_KEY 없이 돌아야 한다 — 그것이 수동 모드의 존재 이유다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { emitPrompt, ingestResponse, parsePromptTarget } from "../core/manualRun";
import { loadPreviousResults, loadStageFiles, savePlan } from "../core/state";
import type { BuildContext, BuildPlan } from "../core/types";

const MANIFEST = {
  language: "python",
  sourceExtensions: [".py"],
  domainBase: "app/features",
  domainRoots: [],
  conventions: ["doc/conventions.md"],
  referenceDomain: "orders",
  stages: [
    {
      key: "model",
      title: "모델",
      template: "01-model.md",
      kind: "code" as const,
      scope: "domain" as const,
      exemplars: ["models.py"],
      outputDirs: ["."],
    },
    {
      key: "service",
      title: "서비스",
      template: "02-service.md",
      kind: "code" as const,
      scope: "domain" as const,
      exemplars: ["service.py"],
      outputDirs: ["."],
    },
  ],
};

/** 계획은 사람이 채팅에서 받아 넣는 값이라, 테스트에서는 고정값을 직접 쓴다. */
const PLAN: BuildPlan = {
  domainName: "shipment",
  domainLabel: "배송",
  domainRoot: "",
  domainDirName: "shipment",
  files: [
    { stage: "model", path: "app/features/shipment/models.py", purpose: "배송 모델" },
    { stage: "service", path: "app/features/shipment/service.py", purpose: "배송 서비스" },
  ],
  conventions: [{ rule: "dataclass 사용", source: "doc/conventions.md" }],
  conflicts: [],
  openQuestions: [],
  reasoning: "참조 도메인 구조를 그대로 따랐다",
};

const MODEL_CODE = "from dataclasses import dataclass\n\n@dataclass\nclass Shipment:\n    id: int\n";

let root: string;
let repoRoot: string;
let outDir: string;

function write(relativePath: string, content: string) {
  const path = join(repoRoot, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function context(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    specPaths: [join(root, "spec.md")],
    templatesDir: "doc/templates",
    repoRoot,
    outDir,
    maxRetries: 1,
    ...overrides,
  };
}

/** 응답 파일에 채팅 응답을 흉내 낸 JSON을 써서 경로를 돌려준다. */
function answer(name: string, body: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(body), "utf-8");
  return path;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-test-"));
  repoRoot = join(root, "repo");
  outDir = join(root, "out");

  write("app/features/orders/models.py", "from dataclasses import dataclass\n\n@dataclass\nclass Order:\n    id: int\n");
  write("app/features/orders/service.py", "class OrderService:\n    pass\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n\n## 4. 자가검증 체크리스트\n- [ ] dataclass 인가\n");
  write("doc/templates/02-service.md", "# [02] 서비스\n");
  writeFileSync(join(root, "spec.md"), "# 배송(shipment) 도메인. 필드: id\n", "utf-8");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("state — 단계 산출물 되읽기", () => {
  test("loadStageFiles 는 그 단계 자신의 산출물을 돌려준다", () => {
    savePlan(outDir, PLAN);
    mkdirSync(join(outDir, "app/features/shipment"), { recursive: true });
    writeFileSync(join(outDir, "app/features/shipment/models.py"), MODEL_CODE, "utf-8");

    const files = loadStageFiles(outDir, PLAN, "model");

    assert.equal(files.length, 1);
    assert.equal(files[0].path, "app/features/shipment/models.py");
    assert.equal(files[0].content, MODEL_CODE);
  });

  test("아직 만들어지지 않은 단계는 빈 목록이다", () => {
    assert.deepEqual(loadStageFiles(outDir, PLAN, "service"), []);
  });

  test("loadPreviousResults 는 대상 단계 자신을 포함하지 않는다", () => {
    const previous = loadPreviousResults(outDir, PLAN, MANIFEST.stages, "service");

    assert.deepEqual(
      previous.map((result) => result.stage),
      ["model"],
      "service 앞에는 model 만 있어야 한다",
    );
  });
});

describe("emitPrompt — 붙여넣을 프롬프트", () => {
  test("gate 프롬프트에 그 단계의 산출물이 들어간다", () => {
    // 회귀: 앞 단계 목록에서 대상 단계를 찾으려 해 항상 비어 있었고,
    // "산출물이 없습니다" 로 모든 단계의 gate 가 실행 불가였다.
    const prompt = emitPrompt(context(), parsePromptTarget("gate:model"));

    assert.match(prompt, /class Shipment/, "검수 대상 코드가 프롬프트에 있어야 한다");
    assert.match(prompt, /app\/features\/shipment\/models\.py/);
    assert.match(prompt, /자가검증 체크리스트/, "단계 템플릿의 체크리스트가 실려야 한다");
  });

  test("산출물이 없는 단계의 gate 는 이유를 알려주고 멈춘다", () => {
    assert.throws(
      () => emitPrompt(context(), parsePromptTarget("gate:service")),
      /산출물이/,
    );
  });

  test("생성 프롬프트에는 앞 단계 산출물이 들어간다", () => {
    const prompt = emitPrompt(context(), parsePromptTarget("service"));

    assert.match(prompt, /class Shipment/, "model 단계 결과가 service 입력이 되어야 한다");
    assert.match(prompt, /class OrderService/, "참조 표준 코드가 실려야 한다");
  });

  test("알 수 없는 단계는 선언된 단계를 알려준다", () => {
    assert.throws(() => emitPrompt(context(), parsePromptTarget("nope")), /model, service/);
  });
});

describe("ingestResponse — 응답 반영", () => {
  test("경계 밖 파일은 쓰지 않고 거부한다", () => {
    const path = answer("bad.txt", {
      files: [{ path: "app/features/other/x.py", content: "bad" }],
    });

    assert.throws(
      () => ingestResponse(context({ specPaths: [] }), parsePromptTarget("service"), path),
      /do-not-touch 경계/,
    );
    assert.equal(
      existsSync(join(outDir, "app/features/other/x.py")),
      false,
      "거부된 파일은 디스크에 남으면 안 된다",
    );
  });

  test("상위 경로 참조는 거부한다", () => {
    const path = answer("escape.txt", {
      files: [{ path: "../../etc/passwd", content: "bad" }],
    });

    assert.throws(
      () => ingestResponse(context({ specPaths: [] }), parsePromptTarget("service"), path),
      /경로 규칙/,
    );
  });

  test("산문 응답은 무엇이 문제인지 알려준다", () => {
    const path = join(root, "prose.txt");
    writeFileSync(path, "네, 코드를 만들어 드리겠습니다!", "utf-8");

    assert.throws(
      () => ingestResponse(context({ specPaths: [] }), parsePromptTarget("service"), path),
      /출력 형식/,
    );
  });

  test("정상 응답은 out/ 에 쓰이고 gate 로 이어진다", () => {
    const code = "class ShipmentService:\n    pass\n";
    const path = answer("ok.txt", {
      files: [{ path: "app/features/shipment/service.py", content: code }],
    });

    const result = ingestResponse(context({ specPaths: [] }), parsePromptTarget("service"), path);

    assert.equal(result.writtenFiles.length, 1);
    assert.deepEqual(result.violations, [], "계획대로 만들었으면 위반이 없어야 한다");
    assert.match(emitPrompt(context(), parsePromptTarget("gate:service")), /class ShipmentService/);
  });
});
