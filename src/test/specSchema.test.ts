/**
 * 1차 게이트 — 입력 규격(슬롯) 대조.
 *
 * 확인하려는 것은 두 가지다.
 *   ① 빈칸을 알아채는 주체가 **코드**인가. 모델이 질문을 떠올렸는지에 기대면 안 된다.
 *   ② 뽑아 놓은 항목이 **캐시가 아니라 파생물**인가. 스펙을 고치면 무효가 되어야 한다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { questionsPath } from "../core/session";
import { loadSlots } from "../core/specSchema";
import { applyResponse, nextPrompt } from "../core/turn";
import type { BuildContext } from "../core/types";

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
      exemplars: ["models.py"],
      outputDirs: ["."],
    },
  ],
};

/** 프로젝트가 선언하는 입력 규격. 에이전트는 이 목록을 들고 있지 않는다. */
const SPEC_SCHEMA = {
  slots: [
    {
      key: "data",
      title: "저장할 데이터 항목",
      requiredFor: ["feature"],
      question: "이 도메인이 저장할 데이터 항목은 무엇인가요?",
    },
    {
      key: "states",
      title: "상태값과 허용 전이",
      requiredFor: ["feature"],
      question: "상태값과 허용된 전이는 무엇인가요?",
    },
    {
      key: "repro",
      title: "재현 조건",
      requiredFor: ["fix"],
      question: "어떤 조건에서 재현되나요?",
    },
  ],
};

const PLAN_RESPONSE = {
  domainName: "shipment",
  domainLabel: "배송",
  domainRoot: "",
  domainDirName: "shipment",
  files: [{ stage: "model", path: "app/features/shipment/models.py", purpose: "배송 모델" }],
  conventions: [{ rule: "dataclass 사용", source: "doc/conventions.md" }],
  conflicts: [],
  openQuestions: [] as string[],
  reasoning: "참조 도메인 구조를 따랐다",
};

const SPEC_BODY =
  "# 배송(shipment) 도메인\n\n" +
  "## 데이터\n- id: 식별자\n- address: 주소\n\n" +
  "## 상태\n준비 → 배송중 → 완료 순으로만 넘어간다.\n";

let root: string;
let context: BuildContext;

function write(relativePath: string, content: string) {
  const path = join(root, "repo", relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function writeSpec(body: string, kind = "feature") {
  writeFileSync(
    join(root, "spec.md"),
    `---\nkind: ${kind}\nid: TEST-1\ntitle: 배송 도메인 추가\ntarget: shipment\n---\n\n${body}`,
    "utf-8",
  );
}

/** 사람이 questions.md 를 열어 답을 적는 것과 같은 일 */
function answerAll(answer: string) {
  const path = questionsPath(context.outDir);
  writeFileSync(
    path,
    readFileSync(path, "utf-8").replace(/\(여기에 답을 적으세요\)/g, answer),
    "utf-8",
  );
}

/** 모델이 항목을 뽑아 준 것과 같은 응답 */
function extracted(slots: { key: string; value: string; evidence: string }[]): string {
  return JSON.stringify({ slots });
}

const BOTH_FOUND = [
  { key: "data", value: "id, address", evidence: "- id: 식별자\n- address: 주소" },
  { key: "states", value: "준비 → 배송중 → 완료", evidence: "준비 → 배송중 → 완료 순으로만 넘어간다." },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-slots-"));
  write("app/features/orders/models.py", "class Order:\n    pass\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n");
  write("doc/templates/spec-schema.json", JSON.stringify(SPEC_SCHEMA, null, 2));
  writeSpec(SPEC_BODY);

  context = {
    specPaths: [join(root, "spec.md")],
    templatesDir: "doc/templates",
    repoRoot: join(root, "repo"),
    outDir: join(root, "out"),
    maxRetries: 1,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("선언한 프로젝트에서만 돈다", () => {
  test("규격을 선언하면 계획보다 먼저 항목을 뽑는다", () => {
    const next = nextPrompt(context);

    assert.equal(next.label, "intake");
    assert.match(next.prompt!, /뽑아낼 항목/);
    assert.match(next.prompt!, /판단하거나 채우지 않는다/);
  });

  test("규격을 선언하지 않은 프로젝트는 예전처럼 계획부터 간다", () => {
    rmSync(join(root, "repo/doc/templates/spec-schema.json"));

    assert.equal(nextPrompt(context).label, "plan");
  });

  test("필수 여부는 kind 가 정한다 — fix 전용 항목은 feature 에서 묻지 않는다", () => {
    const outcome = applyResponse(context, extracted(BOTH_FOUND));

    assert.equal(outcome.questionsAdded, 0, "repro 는 fix 전용이라 묻지 않는다");
    assert.equal(nextPrompt(context).label, "plan");
  });
});

describe("빈칸을 코드가 판정한다", () => {
  test("근거를 못 찾은 필수 항목이 질문이 된다", () => {
    const outcome = applyResponse(
      context,
      extracted([
        { key: "data", value: "id, address", evidence: "- id: 식별자" },
        { key: "states", value: "", evidence: "" },
      ]),
    );

    assert.equal(outcome.questionsAdded, 1);
    assert.match(readFileSync(questionsPath(context.outDir), "utf-8"), /상태값과 허용된 전이는/);
    assert.equal(nextPrompt(context).label, "blocked");
  });

  test("인용 없이 채운 값은 채워진 것으로 보지 않는다", () => {
    // 모델이 관행으로 지어내면 옮겨 올 문장이 없다. 그 자리를 코드가 잡는다.
    const outcome = applyResponse(
      context,
      extracted([
        { key: "data", value: "id, address", evidence: "- id: 식별자" },
        { key: "states", value: "준비·배송중·완료·취소", evidence: "" },
      ]),
    );

    assert.equal(outcome.questionsAdded, 1, "근거 없는 값은 통과하면 안 된다");
  });

  test("빈 항목이 여럿이면 전부 질문으로 남고 전부 막는다", () => {
    const outcome = applyResponse(
      context,
      extracted([
        { key: "data", value: "", evidence: "" },
        { key: "states", value: "", evidence: "" },
      ]),
    );

    assert.equal(outcome.questionsAdded, 2);
    assert.match(nextPrompt(context).message!, /답하지 않은 질문이 2건/);
  });

  test("사람이 답하면 그 항목은 다시 묻지 않고 계획으로 넘어간다", () => {
    applyResponse(context, extracted([{ key: "states", value: "", evidence: "" }]));
    assert.equal(nextPrompt(context).label, "blocked");

    answerAll("준비·배송중·완료 세 가지");

    assert.equal(nextPrompt(context).label, "plan");
  });

  test("사람이 답한 것이 계획 프롬프트에 실린다", () => {
    // 1차 게이트의 질문은 계획 이전에 걸리므로, 여기서 빠지면 계획이 그 답을 모른 채 세워진다.
    applyResponse(context, extracted([{ key: "states", value: "", evidence: "" }]));
    answerAll("준비·배송중·완료 세 가지");

    assert.match(nextPrompt(context).prompt!, /준비·배송중·완료 세 가지/);
  });
});

describe("파생물이지 캐시가 아니다", () => {
  test("뽑은 항목은 스펙 해시와 함께 남는다", () => {
    applyResponse(context, extracted(BOTH_FOUND));

    const saved = loadSlots(context.outDir)!;
    assert.match(saved.specHash, /^sha256:/);
    assert.equal(saved.slots.length, 2);
  });

  test("스펙이 바뀌면 앞서 뽑은 것이 무효가 되어 다시 뽑는다", () => {
    applyResponse(context, extracted(BOTH_FOUND));
    assert.equal(nextPrompt(context).label, "plan");

    // 사람이 스펙을 고쳤다. 앞서 뽑은 항목을 그대로 쓰면 문서를 고쳐 게이트를 우회할 수 있다.
    writeSpec(`${SPEC_BODY}\n## 추가\n취소 상태가 생겼다.\n`);

    assert.equal(nextPrompt(context).label, "intake", "문서가 정본이다");
  });

  test("계획을 세운 뒤에 스펙을 고쳐도 다시 뽑는다", () => {
    applyResponse(context, extracted(BOTH_FOUND));
    applyResponse(context, JSON.stringify(PLAN_RESPONSE));
    assert.equal(nextPrompt(context).label, "model");

    writeSpec(`${SPEC_BODY}\n## 추가\n취소 상태가 생겼다.\n`);

    assert.equal(nextPrompt(context).label, "intake");
  });
});

describe("확정된 항목을 축약해 싣는다", () => {
  test("계획 프롬프트에 근거와 함께 들어간다", () => {
    applyResponse(context, extracted(BOTH_FOUND));

    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /스펙에서 확정된 항목 — 근거와 함께/);
    assert.match(prompt, /## 상태값과 허용 전이/);
    assert.match(prompt, /> 근거: 준비 → 배송중 → 완료 순으로만 넘어간다\./);
  });

  test("생성 프롬프트는 컨벤션 전문 대신 계획이 뽑은 규칙을 싣는다", () => {
    applyResponse(context, extracted(BOTH_FOUND));
    applyResponse(context, JSON.stringify(PLAN_RESPONSE));

    const prompt = nextPrompt(context).prompt!;

    assert.match(prompt, /이번 생성에 걸리는 규칙/);
    assert.match(prompt, /dataclass 사용\n  근거: doc\/conventions\.md/);
    assert.doesNotMatch(prompt, /# 코드 컨벤션 문서/, "전문 덤프는 빠져야 한다");
  });
});
