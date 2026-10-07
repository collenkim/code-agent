/**
 * 작업 지시서 검사 — 작업이 시작되기 전의 입구.
 *
 * 여기서 확인하는 것은 "무엇이 걸리는가"보다 **걸렸을 때 작업이 시작되지 않는가**다.
 * 뒤 층의 검사는 전부 작업이 이미 돌기 시작한 뒤에 일어나므로, 이 층이 새면 통제가
 * 모델이 협조하는 동안만 유지된다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  errorLogOf,
  errorLogProblems,
  loadWorkOrder,
  slug,
  parseFrontMatter,
  validateWorkOrder,
  WorkOrderError,
  withoutErrorLog,
} from "../core/workOrder";
import type { WorkOrderPolicy } from "../core/workOrder";

const OPEN: WorkOrderPolicy = { attributes: [], requireApprover: false };

let root: string;
let repoRoot: string;

/** 지시서 본문을 파일로 써서 경로를 돌려준다 — loadWorkOrder 는 파일에서 읽는다. */
function spec(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body, "utf-8");
  return path;
}

function order(body: string, policy: WorkOrderPolicy = OPEN) {
  return loadWorkOrder(repoRoot, spec("order.md", body), policy);
}

function problems(body: string, policy: WorkOrderPolicy = OPEN): string[] {
  try {
    order(body, policy);
  } catch (err) {
    assert.ok(err instanceof WorkOrderError, `WorkOrderError 여야 한다: ${err}`);
    return err.problems.map((problem) => `${problem.attribute}: ${problem.detail}`);
  }
  assert.fail("통과하면 안 되는 지시서가 통과했다");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-order-"));
  repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "app/features/orders"), { recursive: true });
  mkdirSync(join(repoRoot, "app/common/tx"), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("머리말 파서 — 봉투는 하나다", () => {
  test("첫 줄이 --- 가 아니면 머리말이 없는 문서다", () => {
    assert.equal(parseFrontMatter("# 그냥 문서\n\n---\nkind: feature\n---\n"), undefined);
  });

  test("스칼라와 두 가지 배열 표기를 읽는다", () => {
    const values = parseFrontMatter(
      "---\n" +
        "kind: refactor\n" +
        "scope: [app/a, app/b]\n" +
        "preserve:\n  - 공개 시그니처\n  - app/schema.sql\n" +
        "---\n본문\n",
    );

    assert.deepEqual(values, {
      kind: "refactor",
      scope: ["app/a", "app/b"],
      preserve: ["공개 시그니처", "app/schema.sql"],
    });
  });

  test("따옴표는 벗기고 안쪽은 건드리지 않는다", () => {
    const values = parseFrontMatter('---\ntitle: "정산: 경계 정리"\n---\n');
    assert.deepEqual(values, { title: "정산: 경계 정리" });
  });

  test("들여쓴 중첩 구조는 거부한다 — 봉투가 갈라지는 자리다", () => {
    assert.throws(
      () => parseFrontMatter("---\nowner:\n  name: kai\n---\n"),
      /읽을 수 없습니다/,
    );
  });

  test("닫는 --- 가 없으면 거부한다", () => {
    assert.throws(() => parseFrontMatter("---\nkind: feature\n본문\n"), /닫는/);
  });

  test("같은 속성이 두 번 나오면 거부한다", () => {
    assert.throws(() => parseFrontMatter("---\nid: A\nid: B\n---\n"), /두 번/);
  });
});

describe("작업 지시서 검사 — 존재 · 값 · 오타", () => {
  test("정상 지시서는 값을 정규화해 돌려준다", () => {
    const result = order(
      "---\nkind: feature\nid: PROJ-1\ntitle: 배송 추가\ntarget: shipment\n---\n",
    );

    assert.equal(result.kind, "feature");
    assert.equal(result.id, "PROJ-1");
    assert.deepEqual(result.target, ["shipment"], "하나여도 배열로 정규화한다");
    assert.deepEqual(result.scope, []);
    assert.equal(result.approver, undefined);
  });

  test("머리말이 아예 없으면 예시를 보여 주고 멈춘다", () => {
    const found = problems("# 머리말 없는 문서\n");
    assert.match(found[0], /작업 지시서가 없습니다/);
  });

  test("필수 속성이 빠지면 한 번에 모아 알린다", () => {
    const found = problems("---\nkind: feature\n---\n");

    assert.equal(found.length, 3, "id · title · target 이 한 번에 나와야 한다");
    assert.ok(found.some((entry) => entry.startsWith("id:")));
    assert.ok(found.some((entry) => entry.startsWith("title:")));
    assert.ok(found.some((entry) => entry.startsWith("target:")));
  });

  test("알 수 없는 kind 는 고를 수 있는 값을 알려준다", () => {
    const found = problems("---\nkind: featrue\nid: A\ntitle: t\ntarget: x\n---\n");
    assert.match(found[0], /featrue.*feature \| fix \| refactor/s);
  });

  test("모르는 속성은 거부한다 — 오타를 넘기면 안 걸리는 상태가 된다", () => {
    const found = problems(
      "---\nkind: feature\nid: A\ntitle: t\ntarget: x\npriorty: P1\n---\n",
    );
    assert.match(found[0], /priorty.*선언한 속성도 아닙니다/s);
  });
});

describe("작업 지시서 검사 — kind 별 필수", () => {
  const base = "id: A\ntitle: t\ntarget: app/features/orders\n";

  test("refactor 는 scope 와 preserve 가 필수다", () => {
    const found = problems(`---\nkind: refactor\n${base}---\n`);

    assert.equal(found.length, 2);
    assert.ok(found.some((entry) => entry.startsWith("scope:")));
    assert.ok(found.some((entry) => entry.startsWith("preserve:")));
  });

  test("fix 도 같다", () => {
    const found = problems(`---\nkind: fix\n${base}---\n`);
    assert.equal(found.length, 2);
  });

  test("feature 는 새로 만드는 것이라 scope·preserve 를 묻지 않는다", () => {
    const result = order("---\nkind: feature\nid: A\ntitle: t\ntarget: 새도메인\n---\n");
    assert.deepEqual(result.preserve, []);
  });
});

describe("작업 지시서 검사 — 경로 실재", () => {
  test("refactor 의 target 이 저장소에 없으면 거부한다", () => {
    const found = problems(
      "---\nkind: refactor\nid: A\ntitle: t\ntarget: app/features/없음\n" +
        "scope: [app/features/orders]\npreserve: [공개 시그니처]\n---\n",
    );
    assert.match(found[0], /target.*없는 경로입니다/s);
  });

  test("feature 의 target 은 이제 만들 도메인이라 실재를 묻지 않는다", () => {
    const result = order("---\nkind: feature\nid: A\ntitle: t\ntarget: 아직없는도메인\n---\n");
    assert.deepEqual(result.target, ["아직없는도메인"]);
  });

  test("scope 는 어느 종류에서든 경로라 실재를 묻는다", () => {
    const found = problems(
      "---\nkind: fix\nid: A\ntitle: t\ntarget: app/features/orders\n" +
        "scope: [app/features/orders, app/없음]\npreserve: [동작]\n---\n",
    );

    assert.equal(found.length, 1, "있는 경로는 걸리지 않아야 한다");
    assert.match(found[0], /app\/없음/);
  });

  test("preserve 는 문장을 섞어 쓰므로 실재를 묻지 않는다", () => {
    const result = order(
      "---\nkind: refactor\nid: A\ntitle: t\ntarget: app/common/tx\n" +
        "scope: [app/common/tx]\npreserve: [OrderFacade 공개 시그니처, orders_* 테이블 스키마]\n---\n",
    );
    assert.equal(result.preserve.length, 2);
  });
});

describe("작업 지시서 검사 — 프로젝트 확장 속성", () => {
  const policy: WorkOrderPolicy = {
    requireApprover: true,
    attributes: [
      { name: "priority", required: true, values: ["P1", "P2"] },
      { name: "sprint", required: false },
    ],
  };
  const base = "---\nkind: feature\nid: A\ntitle: t\ntarget: shipment\n";

  test("선언한 필수 속성이 빠지면 거부한다", () => {
    const found = problems(`${base}approver: lead\n---\n`, policy);
    assert.match(found[0], /priority.*필수로 선언/s);
  });

  test("허용 목록 밖의 값은 거부한다", () => {
    const found = problems(`${base}approver: lead\npriority: P9\n---\n`, policy);
    assert.match(found[0], /P9.*허용: P1, P2/s);
  });

  test("requireApprover 를 켠 프로젝트에서는 승인자가 필수다", () => {
    const found = problems(`${base}priority: P1\n---\n`, policy);
    assert.match(found[0], /approver/);
  });

  test("통과하면 확장 속성은 extra 에 담기고 파이프라인은 쓰지 않는다", () => {
    const result = order(`${base}approver: lead\npriority: P1\nsprint: S-42\n---\n`, policy);

    assert.deepEqual(result.extra, { priority: "P1", sprint: "S-42" });
    assert.equal(result.approver, "lead");
  });

  test("승인자 개념이 없는 프로젝트는 approver 를 요구하지 않는다", () => {
    const result = order(`${base}---\n`, OPEN);
    assert.equal(result.approver, undefined);
  });
});

describe("validateWorkOrder — 값만 주어졌을 때", () => {
  test("파일 없이도 같은 규칙으로 검사한다", () => {
    assert.throws(
      () =>
        validateWorkOrder(
          repoRoot,
          { kind: "refactor", id: "A", title: "t", target: "app/features/orders" },
          "(메모리)",
          OPEN,
        ),
      /scope/,
    );
  });
});

/**
 * 원장 경로와 계획 경로가 같은 규칙을 써야 한다.
 *
 * 지시서 id 와 대상 이름은 그대로 디렉토리·파일 이름이 된다(`approvals/<id>/<target>-N.plan.json`).
 * 파일 이름으로 쓸 수 없는 문자가 섞이면 두 자리가 서로 다른 곳을 가리키게 된다.
 */
describe("slug — 이름이 경로가 될 때", () => {
  test("대상 이름에 @ 나 # 이 있어도 갈리지 않는다", () => {
    assert.equal(slug("a@b#c"), "a-b-c");
  });

  test("경로 구분자도 같은 규칙으로 걸린다", () => {
    assert.equal(slug("app/features/settlement"), "app-features-settlement");
  });

  test("이름으로 쓸 것이 남지 않으면 unnamed 다 — 점만 남으면 경로가 거슬러 오른다", () => {
    assert.equal(slug("."), "unnamed");
    assert.equal(slug(".."), "unnamed");
    assert.equal(slug("주문 도메인"), "unnamed", "ASCII 밖은 이름으로 쓰지 않는다");
  });
});

describe("fix 의 오류 로그", () => {
  const head = "---\nkind: fix\nid: B-1\ntitle: t\ntarget: src\n---\n\n총액이 틀린다\n";

  test("로그 원문 코드 블록 · 없는 사유와 재현 절차 중 하나가 있어야 한다 — fix 에서만", () => {
    assert.equal(errorLogProblems("fix", head).length, 1);
    assert.deepEqual(errorLogProblems("feature", head), []);
    assert.equal(errorLogProblems("fix", `${head}\n## 오류 로그\n\n\`\`\`text\n\n\`\`\`\n`).length, 1, "빈 로그는 로그가 아니다");
    assert.equal(errorLogProblems("fix", `${head}\n## 오류 로그 없음\n\n- 사유: 화면 증상\n`).length, 1, "재현 절차가 있어야 한다");
    assert.deepEqual(errorLogProblems("fix", `${head}\n## 오류 로그 없음\n\n- 사유: 화면 증상\n- 재현 절차:\n  1. 연다\n`), []);
  });

  test("로그 안의 `## ` 줄과 백틱은 절 경계가 아니고, 로그는 요구 본문에서 빠진다", () => {
    const log = "ERROR boom\n## not a heading\n```inner```\n    at x(Foo.java:3)";
    const text = `${head}\n## 오류 로그\n\n\`\`\`\`text\n${log}\n\`\`\`\`\n\n## 배경\n- 지난주부터\n`;
    assert.deepEqual(errorLogOf(text), { log });
    const body = withoutErrorLog(text);
    assert.ok(!body.includes("ERROR boom") && !body.includes("not a heading"));
    assert.ok(body.includes("## 배경") && body.includes("총액이 틀린다"));
  });
});
