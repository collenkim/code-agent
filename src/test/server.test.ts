/**
 * 서버 경로의 회귀 테스트.
 *
 * 서버가 하는 일은 CLI와 같아야 한다 — 전송만 다르다. 그래서 여기서 확인하는 것은
 * "왕복 한 번이 상태를 정확히 한 칸 움직이는가"와 "설정 오류가 첫 요청이 아니라
 * 작업을 만들 때 드러나는가" 두 가지다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import * as api from "../server/api";
import { JobStore } from "../server/jobs";
import { page } from "../server/ui";

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
    {
      key: "service",
      title: "서비스",
      template: "02-service.md",
      exemplars: ["service.py"],
      outputDirs: ["."],
    },
  ],
};

const PLAN_RESPONSE = JSON.stringify({
  domainName: "shipment",
  domainLabel: "배송",
  domainRoot: "",
  domainDirName: "shipment",
  files: [
    { stage: "model", path: "app/features/shipment/models.py", purpose: "배송 모델" },
    { stage: "service", path: "app/features/shipment/service.py", purpose: "배송 서비스" },
  ],
  conventions: [{ rule: "dataclass 를 쓴다", source: "doc/conventions.md" }],
  conflicts: [],
  openQuestions: [],
  reasoning: "참조 도메인 구조를 그대로 따랐다",
});

/** 생성 단계 응답 — 채팅에서 오는 지시 블록 형태 그대로 */
const MODEL_RESPONSE = [
  "### write app/features/shipment/models.py",
  "```python",
  "from dataclasses import dataclass",
  "",
  "@dataclass",
  "class Shipment:",
  "    id: int",
  "```",
  "",
  "### done",
].join("\n");

let root: string;
let repoRoot: string;
let statePath: string;
let store: JobStore;
let jobId: string;

function write(relativePath: string, content: string) {
  const path = join(repoRoot, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-server-test-"));
  repoRoot = join(root, "repo");
  statePath = join(root, "state", "jobs.json");

  write("app/features/orders/models.py", "from dataclasses import dataclass\n\n@dataclass\nclass Order:\n    id: int\n");
  write("app/features/orders/service.py", "class OrderService:\n    pass\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n\n## 4. 자가검증 체크리스트\n- [ ] dataclass 인가\n");
  write("doc/templates/02-service.md", "# [02] 서비스\n");
  // 0차 게이트가 생긴 뒤로는 어떤 실행이든 작업 지시서 머리말이 있어야 한다.
  writeFileSync(
    join(root, "spec.md"),
    "---\nkind: feature\nid: TEST-1\ntitle: 배송 도메인 추가\ntarget: shipment\n---\n\n" +
      "# 배송(shipment) 도메인. 필드: id\n",
    "utf-8",
  );

  store = new JobStore(statePath);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("JobStore — 작업 목록", () => {
  test("작업을 만들 때 설정을 실제로 읽어 본다", () => {
    // 경로 오타를 첫 프롬프트 요청까지 끌고 가면 어디가 틀렸는지 알기 어려워진다.
    assert.throws(
      () =>
        store.create({
          repo: repoRoot,
          templates: "doc/없는디렉토리",
          out: join(root, "out-bad"),
        }),
      /code-agent\.json/,
    );
  });

  test("정상 설정이면 작업이 만들어진다", () => {
    const job = store.create({
      label: "shipment",
      repo: repoRoot,
      templates: "doc/templates",
      out: join(root, "out"),
      specs: [join(root, "spec.md")],
    });

    jobId = job.id;
    assert.equal(job.label, "shipment");
    assert.equal(store.list().length, 1);
  });

  test("같은 출력 디렉토리를 쓰는 작업은 거부한다", () => {
    // 계획과 세션이 out/ 안에 있어 섞이면 두 작업 다 못 쓰게 된다.
    assert.throws(
      () =>
        store.create({
          repo: repoRoot,
          templates: "doc/templates",
          out: join(root, "out"),
        }),
      /이미 같은 출력 디렉토리/,
    );
  });

  test("새 인스턴스가 디스크에서 작업을 복구한다", () => {
    // 서버를 껐다 켜도 이어져야 한다.
    assert.equal(new JobStore(statePath).list().length, 1);
  });
});

describe("왕복 — 프롬프트 하나에 상태 한 칸", () => {
  test("처음 할 차례는 계획이다", () => {
    const state = api.status(store, jobId);

    assert.equal(state.target, "plan");
    assert.equal(state.hasPlan, false);
    assert.equal(state.turn, 0);
  });

  test("프롬프트를 여러 번 받아도 상태가 움직이지 않는다", () => {
    const first = api.prompt(store, jobId).prompt;
    const second = api.prompt(store, jobId).prompt;

    assert.equal(first, second);
    assert.equal(api.status(store, jobId).turn, 0, "프롬프트 요청은 턴이 아니다");
  });

  test("빈 응답은 반영하지 않는다", () => {
    assert.throws(() => api.respond(store, jobId, "   "), /빈 응답/);
  });

  test("계획을 반영하면 첫 단계로 넘어간다", () => {
    const out = api.respond(store, jobId, PLAN_RESPONSE);

    assert.ok(out.planSaved, "계획 파일이 저장돼야 한다");
    assert.equal(out.advanced, true);
    assert.equal(out.next.target, "model");
    assert.equal(out.next.turn, 1);
  });

  test("생성 프롬프트에 참조 표준이 실려 있다", () => {
    const body = api.prompt(store, jobId).prompt ?? "";

    assert.match(body, /class Order/, "참조 도메인 코드가 선주입돼야 한다");
    assert.match(body, /dataclass 를 쓴다/, "컨벤션이 실려야 한다");
  });

  test("응답을 반영하면 파일이 out/ 에 쓰이고 검수로 넘어간다", () => {
    const out = api.respond(store, jobId, MODEL_RESPONSE);

    assert.equal(out.violations.length, 0);
    assert.equal(out.writtenFiles.length, 1);
    assert.equal(out.advanced, true);
    assert.equal(out.next.target, "gate:model");
    assert.ok(existsSync(join(root, "out", "app/features/shipment/models.py")));
  });

  test("검수를 통과하면 다음 단계로 넘어간다", () => {
    const out = api.respond(store, jobId, JSON.stringify({ violations: [] }));

    assert.equal(out.advanced, true);
    assert.equal(out.next.target, "service");
  });

  test("형식이 깨진 응답은 아무것도 반영하지 않는다", () => {
    const out = api.respond(store, jobId, "네, 코드를 만들어 드리겠습니다!");

    assert.ok(out.parseErrors.length > 0);
    assert.equal(out.writtenFiles.length, 0);
    assert.equal(out.advanced, false);
    assert.equal(out.next.target, "service", "같은 단계에 머문다");
  });

  test("경계 밖 파일은 거부되고 디스크에 남지 않는다", () => {
    const response = [
      "### write app/features/other/hack.py",
      "```python",
      "x = 1",
      "```",
      "",
      "### done",
    ].join("\n");

    const out = api.respond(store, jobId, response);

    assert.equal(out.violations.length, 1);
    assert.match(out.violations[0].item, /경계/);
    assert.equal(out.writtenFiles.length, 0);
    assert.equal(existsSync(join(root, "out", "app/features/other/hack.py")), false);
  });
});

describe("질문 — 답할 때까지 멈춘다", () => {
  test("모델이 물으면 진행이 막힌다", () => {
    const out = api.respond(store, jobId, "### ask\n주소 최대 길이는?");

    assert.equal(out.questionsAdded, 1);
    assert.equal(out.next.target, "blocked");
    assert.equal(out.next.openQuestionCount, 1);
    assert.equal(out.next.hasPrompt, false, "막힌 동안에는 프롬프트가 나오지 않는다");
  });

  test("없는 질문에 답하려 하면 알려준다", () => {
    assert.throws(() => api.answer(store, jobId, [{ id: 99, answer: "x" }]), /그런 질문이 없습니다/);
  });

  test("답을 채우면 풀리고 그 답이 프롬프트에 실린다", () => {
    const state = api.answer(store, jobId, [{ id: 1, answer: "최대 200자" }]);

    assert.equal(state.openQuestionCount, 0);
    assert.equal(state.target, "service");

    const body = api.prompt(store, jobId).prompt ?? "";
    assert.match(body, /최대 200자/, "사람이 답한 것이 다음 프롬프트에 들어가야 한다");
  });
});

describe("화면", () => {
  test("외부에서 가져오는 자원이 없다", () => {
    // 오프라인에서도 떠야 한다. CDN 링크가 끼면 그 순간 깨진다.
    const html = page();

    assert.equal(/<(script|link|img)[^>]+(src|href)\s*=\s*["']https?:/i.test(html), false);
    assert.match(html, /<title>code-agent<\/title>/);
  });
});
