import { strict as assert } from "node:assert";

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { blockCount, readBlock, stripBlock, upsertBlock } from "../agent/blocks";
import { next, requireValidatable, Stop } from "../agent/commands";
import { commitDelivery, deliver, deliverProblems, prDocFile, traceRows } from "../agent/deliver";
import { loadEvidence, outsideChanges, validationDocFile } from "../agent/evidence";
import { applyEntry, parseProposal } from "../agent/knowledge";
import { reviewDocFile } from "../agent/review";

import { loadWork } from "../agent/work";
import { ORDER, REQUIREMENTS, repo, write, git, toDeliver, writePr, createStageRepo, removeStageRepo } from "./stageFixture";

/**
 * 통합 검증과 반영 — integrate·deliver·KNOWLEDGE 제안·⑩ 추적표·커밋 자리·코드 구역.
 *
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */

beforeEach(() => createStageRepo());

afterEach(() => removeStageRepo());

// ---- 10 통합 검증 ----

describe("code-agent deliver", () => {
  test("추적표는 R → AC → 파일 → TC → 검증을 코드가 이어 붙인다", async () => {
    await toDeliver();
    const rows = traceRows(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order"));
    const first = rows.find((row) => row.requirement === "R1")!;
    assert.deepEqual(first.acceptance, ["AC-R1-1"]);
    assert.deepEqual(first.cases, ["TC-1"]);
    assert.ok(first.files.includes(`${ORDER}/domain/Order.java`));
    assert.deepEqual(first.verified, ["TC-1: passed (출력)"]);
  });

  test("TTY 가 아니면 커밋하지 않는다 — 게이트를 다 지나도 마지막 문이 닫혀 있다", async () => {
    await toDeliver();
    writePr();
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널에서 받습니다/);
    // 확인 화면을 그리기 전에 코드 구역은 렌더된다
    const doc = readFileSync(join(repo, prDocFile("ORD-1")), "utf-8");
    assert.match(doc, /<!-- code-agent:trace:start -->/);
    assert.match(doc, /\| R1 \| AC-R1-1 \|/);
    assert.match(doc, /## 변경 요약/);
    // rounds 는 검증 회차 총수다 — 고쳐 쓰기 수와 가른다
    assert.match(doc, /^- 검증 회차: 1 · 고쳐 쓰기 0\/2회$/m);
    assert.equal(git("log", "-1", "--format=%s"), "init");
  });

  test("코드 구역을 손으로 고치면 다시 렌더해 덮는다", async () => {
    await toDeliver();
    writePr();
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);
    const path = join(repo, prDocFile("ORD-1"));
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(/\| R1 \|[^\n]*\|/, "| R1 | 전부 통과 | 전부 통과 | 전부 통과 | 전부 통과 |"),
    );
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);
    assert.match(readFileSync(path, "utf-8"), /\| R1 \| AC-R1-1 \|/);
  });

  test("모델 구역이 비었거나 추적표에 빈 칸이 있으면 커밋하지 않는다", async () => {
    await toDeliver();
    const empty = deliverProblems(loadWork(repo)!, "# 빈 문서\n");
    for (const heading of ["요약", "확인 방법", "위험·되돌리기"]) {
      assert.ok(empty.some((problem) => problem.includes(`## ${heading}`)), heading);
    }

    // AC 가 없는 요구 항목을 넣으면 추적표에 빈 칸이 생긴다
    write("doc/work/ORD-1/01-requirements.md", `${REQUIREMENTS}\n\n## R3 · 주문 취소\n근거: "주문을 조회한다."\n`);
    assert.ok(deliverProblems(loadWork(repo)!, "# x").some((problem) => /추적표의 R3 이 비어 있습니다/.test(problem)));
  });

  test("검증되지 않은 트리에서는 반영이 열리지 않는다", async () => {
    await toDeliver();
    writePr();
    write(`${ORDER}/domain/Order.java`, "class Order { /* 반영 직전 */ }\n");
    assert.throws(
      () => deliver(requireValidatable(repo, "deliver")),
      (error: Error) => error instanceof Stop && /반영할 수 없습니다/.test(error.message),
    );
  });

  test("검증된 변경 집합만 커밋한다 — 같은 트리의 무관한 파일은 들어가지 않는다", async () => {
    await toDeliver();
    writePr();
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);

    write("unrelated.txt", "이 작업과 상관없는 파일\n");
    const { commit, outside } = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order")!, []);
    assert.deepEqual(outside, []);
    const files = git("show", "--name-only", "--format=", commit).split("\n").map((line) => line.trim()).filter(Boolean);
    assert.ok(files.includes(`${ORDER}/domain/Order.java`));
    assert.ok(files.includes(validationDocFile("ORD-1")));
    assert.ok(files.includes(reviewDocFile("ORD-1")));
    assert.ok(files.includes(prDocFile("ORD-1")));
    assert.ok(files.includes(".code-agent/work/ORD-1/order.verify.json"));
    assert.ok(files.includes(".code-agent/work/ORD-1/order.review.json"));
    assert.equal(files.includes("unrelated.txt"), false);
    const message = git("log", "-1", "--format=%B");
    assert.match(message, /^\[ORD-1\] 주문 도메인 추가/);
    assert.match(message, /요구: R1, R2/);
  });

  test("저장소 pre-commit hook 이 커밋에 더한 목록 밖 파일을 드러낸다", async () => {
    await toDeliver();
    writePr();
    write("audit/turns.md", "기존 감사 기록\n");
    git("add", "audit/turns.md"); git("commit", "-qm", "audit");
    // 다른 도구의 hook 처럼 커밋마다 추적 중인 감사 파일을 고쳐 임시 index 에 올린다
    write(".git/hooks/pre-commit", "#!/bin/sh\necho turn >> audit/turns.md\ngit add audit/turns.md\n");
    chmodSync(join(repo, ".git/hooks/pre-commit"), 0o755);
    const { commit, outside } = commitDelivery(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order")!, []);
    assert.deepEqual(outside, ["audit/turns.md"]);
    assert.ok(git("show", "--name-only", "--format=", commit).includes("audit/turns.md"));
  });

  test("next 는 반영을 끝내지 않는다 — 사람의 자리로 넘긴다", async () => {
    await toDeliver();
    assert.throws(() => next(repo), /code-agent deliver/);
    assert.ok(existsSync(join(repo, ".code-agent/active.json")));
  });
});

// ---- 공통 KNOWLEDGE ----

describe("KNOWLEDGE 갱신 제안", () => {
  test("이번 작업의 R 을 근거로 들지 않은 항목은 적용 후보가 아니다", () => {
    const { entries, skipped } = parseProposal(
      [
        "## data-dictionary",
        "### `ORDER` 주문",
        "- 근거: R1",
        "- id: Long",
        "",
        "### `PAYMENT` 결제",
        "- 다른 작업에서 본 것",
        "",
        "## 없는-종류",
        "### `X` x",
        "- R1",
      ].join("\n"),
      ["R1", "R2"],
    );
    assert.deepEqual(entries.map((entry) => entry.key), ["ORDER"]);
    assert.deepEqual(entries[0].requirements, ["R1"]);
    assert.ok(skipped.some((reason) => /PAYMENT/.test(reason)));
    assert.ok(skipped.some((reason) => /없는-종류/.test(reason)));
  });

  test("같은 키는 그 자리에서 갈아 끼우고, 다른 항목은 지우지 않는다", () => {
    const before = ["# 데이터 사전", "", "### `ORDER` 주문", "- id: Long", "", "### `ITEM` 항목", "- 그대로", ""].join("\n");
    const { entries } = parseProposal("## data-dictionary\n### `ORDER` 주문\n- 근거: R1\n- id: UUID\n", ["R1"]);
    const after = applyEntry(before, entries[0]);
    assert.match(after, /### `ORDER` 주문\n- 근거: R1\n- id: UUID/);
    assert.equal(after.includes("- id: Long"), false);
    assert.match(after, /### `ITEM` 항목\n- 그대로/);
  });

  test("새 키는 해당 종류 절에 붙는다", () => {
    const { entries } = parseProposal("## api-catalog\n### `GET:/api/orders` 조회\n- 근거: R2\n", ["R2"]);
    const after = applyEntry("# API 목록\n", entries[0]);
    assert.match(after, /# API 목록\n\n## api-catalog\n\n### `GET:\/api\/orders` 조회/);
  });
});

// ---- ⑩ 의 코드 구역 ----

describe("⑩ 의 추적표는 하나뿐이다", () => {
  test("표시 짝이 둘이면 하나로 합치고 위조본을 걷어 낸다", async () => {
    await toDeliver();
    writePr();
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);

    const path = join(repo, prDocFile("ORD-1"));
    writeFileSync(
      path,
      `${readFileSync(path, "utf-8")}\n<!-- code-agent:trace:start -->\n## 추적표\n\n| R | AC | 계획 파일 | TC | 검증 |\n|---|---|---|---|---|\n| R9 | AC-R9-1 | 전부 통과 | TC-9 | TC-9: 출력 |\n<!-- code-agent:trace:end -->\n`,
    );
    assert.throws(() => deliver(requireValidatable(repo, "deliver")), /터미널/);

    const after = readFileSync(path, "utf-8");
    assert.equal(after.split("<!-- code-agent:trace:start -->").length - 1, 1, "짝은 하나만 남는다");
    assert.equal(after.includes("R9"), false, "위조된 줄은 커밋될 파일에 남지 않는다");
    assert.match(after, /\| R1 \| AC-R1-1 \|/);
  });

  test("표시 없이 쓴 추적표는 커밋을 세운다 — 재렌더가 덮지 못하고 아래에 덧붙는다", async () => {
    await toDeliver();
    write(
      prDocFile("ORD-1"),
      [
        "# ORD-1 변경 보고서",
        "",
        "## 요약", "주문 도메인을 더했다.",
        "", "## 확인 방법", "OrderRepository 를 부른다.",
        "", "## 위험·되돌리기", "없음.",
        "",
        "## 추적표",
        "",
        "| R | AC | 계획 파일 | TC | 검증 |",
        "|---|---|---|---|---|",
        "| R1 | 전부 통과 | 전부 통과 | 전부 통과 | 전부 통과 |",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => deliver(requireValidatable(repo, "deliver")),
      (error: Error) => error instanceof Stop && /`## 추적표` 이 코드 구역 밖에 있습니다/.test(error.message),
    );
    assert.equal(git("log", "-1", "--format=%s"), "init");
  });
});

// ---- 반영이 서는 자리 ----

describe("code-agent deliver — 커밋되는 자리", () => {
  test("작업 브랜치가 아니면 커밋하지 않는다", async () => {
    await toDeliver();
    writePr();
    git("switch", "-q", "-c", "elsewhere");
    assert.throws(
      () => deliver(requireValidatable(repo, "deliver")),
      (error: Error) => error instanceof Stop && /작업 브랜치가 아닙니다 \(지금 elsewhere/.test(error.message),
    );
  });

  test("커밋이 실패해 KNOWLEDGE 적용본만 남아도 다시 반영할 수 있다", async () => {
    await toDeliver();
    writePr();
    // deliver 가 사람이 고른 항목을 적용한 뒤 git commit 이 실패한 상태
    write("doc/knowledge/data-dictionary.md", "# 데이터 사전\n\n### `ORDER` 주문\n- 근거: R1\n- id: Long\n");

    const work = loadWork(repo)!;
    assert.equal(outsideChanges(work).some((change) => change.path.startsWith("doc/knowledge/")), false);
    assert.deepEqual(deliverProblems(work, readFileSync(join(repo, prDocFile("ORD-1")), "utf-8")), []);
  });
});

// ---- 코드 구역 ----

describe("코드 구역 표시는 한 짝뿐이다", () => {
  const S = "<!-- code-agent:t:start -->";
  const E = "<!-- code-agent:t:end -->";

  test("짝이 하나면 안쪽을 읽고, 둘이면 어느 쪽도 믿지 않는다", () => {
    assert.equal(readBlock(`앞\n${S}\n표\n${E}\n뒤`, "t"), "표");
    assert.equal(readBlock(`${S}\n진짜\n${E}\n${S}\n위조\n${E}`, "t"), undefined);
    // 짝을 못 이룬 표시가 하나 더 있는 것도 같다 — 어디까지가 코드가 쓴 것인지 알 수 없다
    assert.equal(readBlock(`${S}\n진짜\n${E}\n${S}`, "t"), undefined);
    assert.equal(readBlock("표시 없음", "t"), undefined);
  });

  test("덜어 낼 때도 갈아 끼울 때도 모든 짝을 본다", () => {
    assert.equal(stripBlock(`앞${S}a${E}가운데${S}b${E}뒤`, "t"), "앞가운데뒤");
    assert.equal(upsertBlock(`앞${S}a${E}가운데${S}b${E}뒤`, "t", "새것"), `앞${S}\n새것\n${E}가운데뒤`);
    assert.equal(upsertBlock("바깥만", "t", "새것"), `바깥만\n\n${S}\n새것\n${E}\n`);
    assert.equal(blockCount(`${S}a${E}${S}b${E}`, "t"), 2);
  });
});
