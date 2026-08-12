/**
 * 액션 파서 테스트.
 *
 * 이 파서가 존재하는 이유가 "JSON은 사람이 클립보드로 나르기에 너무 잘 깨진다"이므로,
 * 정상 파싱만큼이나 **깨졌을 때 무엇이 왜 깨졌는지 짚어 주는지**가 중요하다.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { parseActions } from "../core/fence";

/** 백틱이 많이 나와서, 줄 배열로 쓰는 편이 읽기 쉽다. */
function response(...lines: string[]): string {
  return lines.join("\n");
}

describe("parseActions — 정상 응답", () => {
  test("write 는 코드블록 내용을 그대로 가져온다", () => {
    const { actions, errors } = parseActions(
      response("### write app/models.py", "```python", "class Shipment:", "    id: int", "```"),
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(actions, [
      { type: "write", path: "app/models.py", content: "class Shipment:\n    id: int\n" },
    ]);
  });

  test("이스케이프가 필요 없다 — 따옴표·역슬래시가 그대로 살아남는다", () => {
    const content = `printf("a\\tb\\n"); // "따옴표" 그대로`;
    const { actions } = parseActions(response("### write a.c", "```c", content, "```"));

    assert.equal((actions[0] as { content: string }).content, `${content}\n`);
  });

  test("내용에 코드블록이 있으면 백틱 4개로 감싼다", () => {
    const { actions, errors } = parseActions(
      response("### write README.md", "````", "예시:", "```js", "run()", "```", "````"),
    );

    assert.deepEqual(errors, []);
    assert.equal(
      (actions[0] as { content: string }).content,
      "예시:\n```js\nrun()\n```\n",
    );
  });

  test("코드블록 안의 '### write' 는 지시가 아니라 내용이다", () => {
    const { actions } = parseActions(
      response("### write doc/guide.md", "```", "### write 는 이렇게 씁니다", "```"),
    );

    assert.equal(actions.length, 1, "블록 안의 헤더를 새 액션으로 읽으면 안 된다");
    assert.match((actions[0] as { content: string }).content, /### write 는/);
  });

  test("edit 은 find 와 replace 를 짝으로 읽는다", () => {
    const { actions, errors } = parseActions(
      response(
        "### edit app/models.py",
        "#### find",
        "```",
        "    id: int",
        "```",
        "#### replace",
        "```",
        "    id: int",
        "    address: str",
        "```",
      ),
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(actions, [
      {
        type: "edit",
        path: "app/models.py",
        find: "    id: int",
        replace: "    id: int\n    address: str",
      },
    ]);
  });

  test("read·list·run·done 은 한 줄로 끝난다", () => {
    const { actions, errors } = parseActions(
      response("### read app/a.py", "### list app/", "### run test", "### done"),
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(actions, [
      { type: "read", path: "app/a.py" },
      { type: "list", path: "app/" },
      { type: "run", command: "test" },
      { type: "done" },
    ]);
  });

  test("ask 와 note 는 다음 지시 전까지의 산문을 가져간다", () => {
    const { actions, errors } = parseActions(
      response(
        "### ask",
        "상태값이 스펙에 없습니다.",
        "어떤 상태를 두나요?",
        "",
        "### note",
        "참조 표준에 없어 판단했습니다.",
        "### done",
      ),
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(actions, [
      { type: "ask", question: "상태값이 스펙에 없습니다.\n어떤 상태를 두나요?" },
      { type: "note", text: "참조 표준에 없어 판단했습니다." },
      { type: "done" },
    ]);
  });

  test("여러 액션이 순서대로 나온다", () => {
    const { actions } = parseActions(
      response(
        "### read app/orders/service.py",
        "### write app/shipment/service.py",
        "```",
        "pass",
        "```",
        "### done",
      ),
    );

    assert.deepEqual(
      actions.map((action) => action.type),
      ["read", "write", "done"],
    );
  });
});

describe("parseActions — 깨진 응답", () => {
  test("잘린 코드블록은 잘렸다고 알려준다", () => {
    const { errors } = parseActions(
      response("### write app/models.py", "```python", "class Shipment:"),
    );

    assert.equal(errors.length, 1);
    assert.match(errors[0], /잘렸을 수 있습니다/);
    assert.match(errors[0], /app\/models\.py/, "어느 파일인지 알려줘야 한다");
  });

  test("산문 응답은 출력 형식을 다시 보라고 한다", () => {
    const { actions, errors } = parseActions("네, 배송 도메인 코드를 만들어 드리겠습니다!");

    assert.deepEqual(actions, []);
    assert.match(errors[0], /출력 형식/);
  });

  test("경로 없는 write 는 위치를 짚어 준다", () => {
    const { errors } = parseActions(response("### write", "```", "x", "```"));

    assert.match(errors[0], /1행/);
    assert.match(errors[0], /경로가 없습니다/);
  });

  test("replace 없는 edit 은 무엇이 빠졌는지 알려준다", () => {
    const { errors } = parseActions(
      response("### edit app/a.py", "#### find", "```", "x", "```"),
    );

    assert.match(errors[0], /replace/);
  });

  test("빈 ask 는 거부한다", () => {
    const { errors } = parseActions(response("### ask", "", "### done"));

    assert.match(errors[0], /비어 있습니다/);
  });
});
