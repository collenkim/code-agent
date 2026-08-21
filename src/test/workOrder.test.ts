/**
 * 0차 게이트 — 작업 지시서 검사.
 *
 * 여기서 확인하는 것은 "무엇이 걸리는가"보다 **걸렸을 때 모델을 부르지 않는가**다.
 * 뒤 층의 검사는 전부 모델을 한 번 부른 뒤에 일어나므로, 이 층이 새면 통제가
 * 모델이 협조하는 동안만 유지된다.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  describeWorkOrder,
  loadWorkOrder,
  parseFrontMatter,
  validateWorkOrder,
  WorkOrderError,
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
  return loadWorkOrder(repoRoot, [spec("order.md", body)], policy);
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

describe("0차 게이트 — 존재 · 값 · 오타", () => {
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

  test("머리말이 두 장에 있으면 거부한다 — 순서에 기대지 않는다", () => {
    const head = "---\nkind: feature\nid: A\ntitle: t\ntarget: x\n---\n";
    assert.throws(
      () => loadWorkOrder(repoRoot, [spec("one.md", head), spec("two.md", head)], OPEN),
      /두 장|2 장/,
    );
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
    assert.match(found[0], /featrue.*bootstrap \| adopt \| feature \| fix \| refactor/s);
  });

  test("모르는 속성은 거부한다 — 오타를 넘기면 안 걸리는 상태가 된다", () => {
    const found = problems(
      "---\nkind: feature\nid: A\ntitle: t\ntarget: x\npriorty: P1\n---\n",
    );
    assert.match(found[0], /priorty.*선언한 속성도 아닙니다/s);
  });
});

describe("0차 게이트 — kind 별 필수", () => {
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

  test("bootstrap 은 보존할 것이 아직 없어 preserve 를 묻지 않는다", () => {
    const result = order("---\nkind: bootstrap\nid: A\ntitle: t\ntarget: 신규프로젝트\n---\n");
    assert.deepEqual(result.preserve, []);
  });
});

describe("0차 게이트 — 경로 실재", () => {
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

describe("0차 게이트 — 프로젝트 확장 속성", () => {
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

describe("describeWorkOrder — 프롬프트에 실리는 형태", () => {
  test("scope 와 preserve 가 규칙 문장으로 나온다", () => {
    const text = describeWorkOrder(
      order(
        "---\nkind: refactor\nid: A\ntitle: 경계 정리\ntarget: app/common/tx\n" +
          "scope: [app/common/tx]\npreserve: [OrderFacade 공개 시그니처]\n---\n",
      ),
    );

    assert.match(text, /작업 종류: refactor/);
    assert.match(text, /건드려도 되는 곳: app\/common\/tx/);
    assert.match(text, /바뀌면 안 되는 것/);
    assert.match(text, /OrderFacade 공개 시그니처/);
  });

  test("보존할 것이 없는 종류에는 그 줄이 아예 없다", () => {
    const text = describeWorkOrder(
      order("---\nkind: feature\nid: A\ntitle: t\ntarget: shipment\n---\n"),
    );

    assert.doesNotMatch(text, /바뀌면 안 되는 것/);
    assert.doesNotMatch(text, /건드려도 되는 곳/);
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
