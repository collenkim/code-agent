import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { context, next, requireValidatable, status, submitPlan } from "../agent/commands";
import { deliver, prDocFile } from "../agent/deliver";
import { decide } from "../agent/hook";
import { applyProposal, documentEntries, keyRefs, parseProposal, proposalCheck, proposalFile } from "../agent/knowledge";
import { knowledgeFind, knowledgeList } from "../agent/knowledgeCommands";
import { buildIndex, docImpactRows, freshness } from "../agent/knowledgeIndex";
import { loadActive, saveActive, STAGES_LOG } from "../agent/layout";
import { openRound } from "../agent/review";
import { withInteraction } from "../agent/tty";
import { usageReport } from "../agent/usage";
import { check, integrate, runTests } from "../agent/validate";
import { start } from "./confirmedStart";
import * as stage from "./stageFixture";

/**
 * 문서·지식 — 기능·흐름 KNOWLEDGE, 요청 시 인덱스·검색, 최신성, 02 문서 영향 게이트, 반영의 제안 검사, `knowledge find`, 문서 탐색 측정.
 * 앞 절은 작은 임시 저장소로 함수를 직접 부르고, 뒤 절은 스테이지 픽스처로 접수부터 반영까지 실제 명령을 밟는다.
 */

let repo: string;

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf-8" }).trim();
}

function commit(message: string): void {
  git("add", "-A");
  git("commit", "-qm", message);
}

const FEATURES = "doc/knowledge/features.md";
const RULES = "doc/knowledge/business-rules.md";

test("공백을 포함한 지식 키는 정의·참조·문서 영향 표가 같은 식별자로 읽는다", () => {
  const text = "### `공통 규약` 오류 응답\n- 정책: `다른 규약`\n";
  assert.equal(documentEntries(text)[0].key, "공통 규약");
  assert.deepEqual(keyRefs("`공통 규약`, `ERROR-RESPONSE`"), ["공통 규약", "ERROR-RESPONSE"]);
  assert.deepEqual(docImpactRows("| doc/rules.md | `공통 규약` | 갱신 | 응답 변경 |")[0].keys, ["공통 규약"]);
});

function entry(key: string, title: string, fields: string[]): string {
  return [`### \`${key}\` ${title}`, ...fields.map((field) => `- ${field}`), ""].join("\n");
}

describe("최신성 — 항목을 마지막으로 바꾼 커밋 뒤의 근거 코드 변경", () => {
  beforeEach(() => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-know-fresh-")));
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
    write("src/a.ts", "export const a = 1;\n");
    write("src/b.ts", "export const b = 1;\n");
    write("src/c.ts", "export const c = 1;\n");
    write(FEATURES, ["# 기능 목록", "", "## 기능", "",
      entry("FEAT-A", "가", ["목적: 가", "코드: src/a.ts"]),
      entry("FEAT-B", "나", ["목적: 나", "코드: src/b.ts"]),
      entry("FEAT-C", "다", ["목적: 다", "코드: src/c.ts"]),
    ].join("\n"));
    commit("[W-1] 씨앗");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function states(): Record<string, string> {
    const index = buildIndex(repo, undefined, []);
    const fresh = freshness(repo, index.entries);
    return Object.fromEntries(index.entries.map((item) => [item.key, fresh.get(item)!.state]));
  }

  test("관련 코드가 바뀐 항목만 재검토 필요다 — 관련 없는 변경은 다른 항목을 흔들지 않는다", () => {
    assert.deepEqual(states(), { "FEAT-A": "최신", "FEAT-B": "최신", "FEAT-C": "최신" });
    write("src/a.ts", "export const a = 2;\n");
    write("README.md", "관련 없는 변경\n");
    commit("[W-2] 가 수정");
    assert.deepEqual(states(), { "FEAT-A": "재검토 필요", "FEAT-B": "최신", "FEAT-C": "최신" });
    const index = buildIndex(repo, undefined, []);
    const fresh = freshness(repo, index.entries).get(index.entries[0])!;
    assert.deepEqual(fresh.changed.map((change) => [change.id, change.path]), [["W-2", "src/a.ts"]]);
  });

  test("근거 코드를 바꾼 작업이 02 에서 영향 없음으로 판단했으면 재검토로 세지 않는다", () => {
    write("doc/work/W-3/02-analysis.md", ["# 영향도", "## 문서 영향", "| 문서 | 키 | 판단 | 근거 |", "|---|---|---|---|", "| features | `FEAT-B` | 영향 없음 | 동작은 그대로 — 이름만 정리 |", ""].join("\n"));
    write("src/b.ts", "export const b = 1; // 정리\n");
    commit("[W-3] 나 정리");
    assert.equal(states()["FEAT-B"], "최신");
  });

  test("갱신을 선언하고 반영하지 않은 항목은 보류, 근거 파일이 없으면 참조 없음, 커밋 전은 미커밋이다", () => {
    write("doc/work/W-4/02-analysis.md", ["# 영향도", "## 문서 영향", "| 문서 | 키 | 판단 | 근거 |", "|---|---|---|---|", "| features | `FEAT-C` | 갱신 | 다에 입력이 는다 |", ""].join("\n"));
    commit("[W-4] 다 입력 추가(문서 갱신은 보류)");
    rmSync(join(repo, "src/a.ts"));
    commit("[W-5] 가 삭제");
    write(FEATURES, `${readFileSync(join(repo, FEATURES), "utf-8")}\n${entry("FEAT-D", "라", ["코드: src/b.ts"])}`);
    const now = states();
    assert.equal(now["FEAT-C"], "보류");
    assert.equal(now["FEAT-A"], "참조 없음");
    assert.equal(now["FEAT-D"], "미커밋");
    const list = knowledgeList(repo);
    assert.match(list, /FEAT-C\s+W-1\s+[^\n]*\[보류: W-4 가 갱신을 선언하고 반영하지 않음\]/);
    assert.match(list, /FEAT-A\s+W-1\s+[^\n]*\[참조 없음: src\/a\.ts\]/);
    assert.match(list, /FEAT-B\s+W-1\s+src\/b\.ts {2}\[최신\]\n/);
  });
});

describe("검색·반드시 적용하는 업무 정책 — knowledge find", () => {
  beforeEach(() => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-know-find-")));
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
    write("src/order/cancel.ts", "export function cancel() {}\n");
    write(FEATURES, ["# 기능 목록", "", "## 기능", "",
      entry("FEAT-ORDER-CANCEL", "주문 취소", ["목적: 배송 전 주문을 취소한다", "관련 정책: `BR-ORDER-02`", "코드: src/order/cancel.ts", "별칭: 주문 철회"]),
    ].join("\n"));
    write(RULES, ["# 업무 규칙·용어집", "", "## 업무 규칙", "",
      entry("BR-ORDER-01", "금액은 원 단위", ["구분: 필수", "상태: 확정", "출처: ORD-1 R1", "범위: 전체"]),
      entry("BR-ORDER-02", "배송 뒤 취소 불가", ["구분: 필수", "상태: 확정", "출처: 사용자 결정 Q2", "범위: src/order"]),
      entry("BR-ORDER-03", "취소 사유는 선택", ["구분: 권장", "상태: 확정", "출처: ORD-1 R2", "범위: 전체"]),
      entry("BR-ORDER-04", "취소는 하루 세 번", ["구분: 필수", "상태: 관찰", "출처: src/order/cancel.ts:1", "범위: 전체"]),
    ].join("\n"));
    commit("[ORD-1] 씨앗");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("별칭으로 기능을 찾고 줄 범위·연결(손으로 쓴 `관련 정책` 도)을 보여 준다. 범위 전체인 필수 확정 정책은 순위와 관계없이 붙는다", () => {
    const text = knowledgeFind(repo, "철회");
    assert.match(text, /^- doc\/knowledge\/features\.md L\d+-L\d+ · `FEAT-ORDER-CANCEL` 주문 취소 \[기능\] \(낱말 철회\)$/m);
    assert.match(text, /^ {2}코드 src\/order\/cancel\.ts · 정책 BR-ORDER-02$/m);
    const mandatory = text.slice(text.indexOf("반드시 적용하는 업무 정책"));
    assert.match(mandatory, /BR-ORDER-01/);
    assert.match(mandatory, /BR-ORDER-02[^\n]*FEAT-ORDER-CANCEL 가 가리킴/);
    assert.doesNotMatch(mandatory, /BR-ORDER-03/, "권장은 반드시 적용이 아니다");
    assert.doesNotMatch(mandatory, /BR-ORDER-04/, "관찰은 승인된 정책이 아니다");
  });

  test("경로·키로 찾고, 넘치면 잘렸다고 적고, 없으면 코드를 직접 찾으라고 한다", () => {
    assert.match(knowledgeFind(repo, "src/order/cancel.ts"), /`FEAT-ORDER-CANCEL`[^\n]*\(경로 src\/order\/cancel\.ts/);
    assert.match(knowledgeFind(repo, "BR-ORDER-03"), /^- doc\/knowledge\/business-rules\.md L\d+-L\d+ · `BR-ORDER-03` 취소 사유는 선택 \[업무 정책 · 권장 확정\] \(키\)$/m);
    write(FEATURES, ["# 기능 목록", "", "## 기능", "", ...Array.from({ length: 20 }, (_, index) => entry(`FEAT-X-${index}`, `정산 ${index}`, ["코드: src/order/cancel.ts"]))].join("\n"));
    assert.match(knowledgeFind(repo, "정산"), /- 범위: 걸린 20개 중 상위 15개만/);
    assert.match(knowledgeFind(repo, "없는낱말"), /걸린 항목이 없습니다[\s\S]*코드와 테스트를 직접 찾으세요/);
    assert.throws(() => knowledgeFind(repo, " "), /사용법: code-agent knowledge/);
  });
});

describe("제안 — 삭제·이름 변경과 반영 전 검사", () => {
  beforeEach(() => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-know-prop-")));
    write("src/order/register.ts", "export {};\n");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const DOC = ["# 기능 목록", "", "## 기능", "", entry("FEAT-OLD", "옛 이름", ["코드: src/order/register.ts"]), entry("FEAT-GONE", "없어질 것", ["코드: src/order/register.ts"])].join("\n");

  test("대체는 옛 항목 자리에 새 항목을 넣고 대체 줄을 남기지 않는다. 삭제는 그 항목만 지운다", () => {
    const { entries } = parseProposal([
      "## features",
      entry("FEAT-NEW", "새 이름", ["대체: `FEAT-OLD`", "코드: src/order/register.ts", "근거: R1"]),
      entry("FEAT-GONE", "없어질 것", ["삭제: R2 로 기능을 없앴다"]),
    ].join("\n"), ["R1", "R2"]);
    assert.deepEqual(entries.map((item) => [item.key, item.op, item.replaces]), [["FEAT-NEW", "replace", "FEAT-OLD"], ["FEAT-GONE", "remove", undefined]]);
    const after = entries.reduce((text, item) => applyProposal(text, item), DOC);
    assert.ok(after.indexOf("FEAT-NEW") > 0 && !after.includes("FEAT-OLD") && !after.includes("FEAT-GONE"), after);
    assert.doesNotMatch(after, /대체:/);
  });

  test("구현되지 않은 경로·관찰을 확정으로 올린 정책은 후보에서 빠진다. 옛 작업의 제안은 지금처럼 받는다", () => {
    const options = (strict: boolean) => ({ keys: ["R1"], strict, known: () => true });
    const [planned, noCode, observed, confirmed, watched, bare] = parseProposal([
      "## features",
      entry("FEAT-PLAN", "계획만", ["코드: src/order/cancel.ts", "근거: R1"]),
      entry("FEAT-NOCODE", "코드 없음", ["목적: 무엇", "근거: R1"]),
      "## business-rules",
      entry("BR-X-01", "관찰을 확정으로", ["구분: 필수", "상태: 확정", "출처: src/order/register.ts:1", "근거: R1"]),
      entry("BR-X-02", "요구로 확정", ["구분: 필수", "상태: 확정", "출처: R1", "근거: R1"]),
      entry("BR-X-03", "지금 동작", ["구분: 권장", "상태: 관찰", "출처: src/order/register.ts:1", "근거: R1"]),
      entry("BR-X-04", "필드 없는 옛 꼴", ["근거: R1"]),
    ].join("\n"), ["R1"]).entries;
    assert.match(proposalCheck(repo, planned, DOC, options(true)).skip ?? "", /지금 트리에 없는 경로: src\/order\/cancel\.ts/);
    assert.match(proposalCheck(repo, noCode, DOC, options(true)).skip ?? "", /`- 코드:` 에 구현 경로/);
    assert.match(proposalCheck(repo, observed, "", options(true)).skip ?? "", /코드에서 관찰한 동작은 확정 정책이 아닙니다/);
    assert.deepEqual(proposalCheck(repo, confirmed, "", options(true)), { notes: [] });
    assert.match(proposalCheck(repo, watched, "", options(true)).notes.join(), /승인된 업무 정책으로 쓰이지 않습니다/);
    assert.match(proposalCheck(repo, bare, "", options(true)).skip ?? "", /구분:`\(필수·권장\)/);
    assert.equal(proposalCheck(repo, bare, "", options(false)).skip, undefined, "문서 영향 판단 전의 작업은 옛 꼴을 받는다");
  });
});

describe("문서 탐색 측정 — usage", () => {
  beforeEach(() => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-know-usage-")));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("공통 문서 읽기·검색과 knowledge find 를 스테이지별로 세고, 코드·작업 문서 읽기는 세지 않는다", () => {
    write(STAGES_LOG, `${JSON.stringify({ at: "2026-09-30T01:00:00.000Z", id: "ORD-1", target: "order", phase: "impact", by: "next" })}\n`);
    const dir = join(repo, "transcripts");
    mkdirSync(dir, { recursive: true });
    const use = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
    const at = (second: number) => `2026-09-30T02:00:0${second}.000Z`;
    const usage = { input_tokens: 10, output_tokens: 5 };
    writeFileSync(join(dir, "s1.jsonl"), [
      use("t1", "Read", { file_path: join(repo, "doc", "knowledge", "features.md") }),
      use("t2", "Grep", { pattern: "주문", path: "doc/conventions.md" }),
      use("t3", "Bash", { command: "code-agent knowledge find 주문" }),
      use("t4", "Read", { file_path: join(repo, "src", "order.ts") }),
      use("t5", "Read", { file_path: join(repo, "doc", "work", "ORD-1", "02-analysis.md") }),
    ].map((block, index) => JSON.stringify({ type: "assistant", timestamp: at(index), message: { id: `m${index}`, model: "claude-opus-5", usage, content: [block] } })).join("\n") + "\n");
    const [section] = usageReport(repo, { transcripts: dir }).sections;
    assert.deepEqual(section.docReads, { impact: 3 });
  });
});

// ---- 접수부터 반영까지 ----

const PRESENCE = { channel: "tty" as const, verified: true, detail: "테스트" };
const LEGACY = `${stage.ORDER}/legacy/OrderList.java`;

/** 지식 문서를 심고 확정한 뒤 시작한다 — BR-ORDER-01 은 주문 폴더 전체가 범위인 필수 정책이다 */
function seedKnowledge(): void {
  stage.write(LEGACY, "class OrderList {}\n");
  stage.write("doc/conventions.md", `${stage.CONV}\n- [필수] 금액은 BigDecimal 로 다룬다\n`);
  stage.write("doc/knowledge/features.md", ["# 기능 목록", "", "## 기능", "", entry("FEAT-ORDER-LIST", "주문 목록", ["목적: 주문을 나열한다", `코드: ${LEGACY}`])].join("\n"));
  stage.write("doc/knowledge/business-rules.md", ["# 업무 규칙·용어집", "", "## 업무 규칙", "", entry("BR-ORDER-01", "주문 id 는 Long", ["구분: 필수", "상태: 확정", "출처: 사용자 결정", `범위: ${stage.ORDER}`])].join("\n"));
  stage.confirmDocs();
  stage.git("add", "-A");
  stage.git("commit", "-qm", "지식 씨앗");
}

function analysis(impactRows: string[]): string {
  return [
    "# 영향도 분석", "## 기존 시스템 분석", `- 주문 목록만 있다 (${LEGACY}:1)`,
    "## 영향 범위", "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |", "|---|---|---|---|",
    `| R1 | ${stage.ORDER}/domain/Order.java | 없음 | 없음 — 새 파일 |`, `| R2 | ${stage.ORDER}/repository/OrderRepository.java | 없음 | 없음 — 새 파일 |`,
    "## Risk", "- 없음",
    "## 문서 영향", "| 문서 | 키 | 판단 | 근거 |", "|---|---|---|---|", ...impactRows, "",
  ].join("\n");
}

const REGISTER_ROW = "| features | `FEAT-ORDER-REGISTER` | 신규 | R1 이 주문 등록을 만든다 |";
const RULE_ROW = "| business-rules | `BR-ORDER-01` | 영향 없음 | 등록은 id 형식을 그대로 쓴다 |";

/** impact 게이트를 지나 반영 스테이지까지 */
async function toDeliver(): Promise<void> {
  next(stage.repo);
  stage.write("doc/work/ORD-1/02-analysis.md", analysis([REGISTER_ROW, RULE_ROW]));
  next(stage.repo);
  next(stage.repo);
  stage.write("doc/work/ORD-1/plan.json", JSON.stringify(stage.PLAN));
  submitPlan(stage.repo, join(stage.repo, "doc/work/ORD-1/plan.json"));
  stage.approve();
  next(stage.repo);
  const implement = context(stage.repo);
  assert.match(implement, /## 이 Task 의 파일에 걸린 지식 항목[\s\S]*`BR-ORDER-01`/);
  assert.match(implement, /## 컨벤션 필수 규칙[\s\S]*doc\/conventions\.md:\d+ \[필수\] 금액은 BigDecimal/);
  stage.write(`${stage.ORDER}/domain/Order.java`, "class Order {}\n");
  next(stage.repo);
  stage.write(`${stage.ORDER}/repository/OrderRepository.java`, "interface OrderRepository {}\n");
  next(stage.repo);
  stage.write(stage.TEST_FILE, "// TC-1 · TC-2\nclass OrderTest {}\n");
  next(stage.repo);
  await check(requireValidatable(stage.repo, "check"));
  next(stage.repo);
  await runTests(requireValidatable(stage.repo, "test"));
  next(stage.repo);
  openRound(requireValidatable(stage.repo, "review"));
  stage.writeFindings();
  next(stage.repo);
  await integrate(requireValidatable(stage.repo, "integrate"));
  next(stage.repo);
  assert.equal(loadActive(stage.repo)!.phase, "deliver");
}

const PROPOSAL = () => [
  "## features",
  entry("FEAT-ORDER-REGISTER", "주문 등록", ["목적: 주문을 등록한다", `코드: ${stage.ORDER}/domain/Order.java, ${stage.ORDER}/repository/OrderRepository.java`, `테스트: ${stage.TEST_FILE}`, "정책: `BR-ORDER-01`", "근거: R1"]),
  entry("FEAT-ORDER-CANCEL", "주문 취소", ["목적: 계획만 있다", `코드: ${stage.ORDER}/cancel/OrderCancel.java`, "근거: R2"]),
  "## business-rules",
  entry("BR-ORDER-09", "관찰을 확정으로", ["구분: 필수", "상태: 확정", `출처: ${stage.ORDER}/domain/Order.java:1`, "근거: R1"]),
].join("\n");

describe("문서 영향 — impact 게이트와 반영", () => {
  beforeEach(() => {
    stage.createStageRepo("ca-know-flow-");
    seedKnowledge();
    start(stage.repo, join(stage.repo, "doc/work/ORD-1.md"));
    stage.write("doc/work/ORD-1/01-requirements.md", stage.REQUIREMENTS);
    stage.write("doc/work/ORD-1/03-design.md", stage.DESIGN);
    stage.write("doc/work/ORD-1/04-functional.md", stage.FUNCTIONAL);
    stage.write("doc/work/ORD-1/07-test-spec.md", stage.TEST_SPEC);
  });
  afterEach(() => stage.removeStageRepo());

  test("새 작업은 문서 영향 표가 있어야 하고, 영향 범위 파일을 근거로 든 항목만 빠짐없이 판단해야 넘어간다", () => {
    assert.equal(loadActive(stage.repo)!.knowledgeVersion, 1);
    next(stage.repo);
    assert.match(context(stage.repo), /`## 문서 영향` 표도 쓴다/);
    stage.write("doc/work/ORD-1/02-analysis.md", analysis([]).replace(/## 문서 영향[\s\S]*$/, ""));
    assert.throws(() => next(stage.repo), /`## 문서 영향` 표가 없습니다/);
    stage.write("doc/work/ORD-1/02-analysis.md", analysis([REGISTER_ROW]));
    // 관련 없는 FEAT-ORDER-LIST 는 요구하지 않는다 — 영향 범위 파일과 근거 경로가 겹치는 항목만
    assert.throws(() => next(stage.repo), (error: Error) => /BR-ORDER-01\(doc\/knowledge\/business-rules\.md:\d+\)/.test(error.message) && !/FEAT-ORDER-LIST/.test(error.message));
    assert.match(context(stage.repo), /## 이 작업이 닿을 파일을 근거로 든 지식 항목[^\n]*\n- doc\/knowledge\/business-rules\.md L\d+-L\d+ · `BR-ORDER-01`/);
    stage.write("doc/work/ORD-1/02-analysis.md", analysis([REGISTER_ROW, "| business-rules | `BR-ORDER-01` | 영향 없음 | |"]));
    assert.throws(() => next(stage.repo), /문서 영향의 근거가 비었습니다: BR-ORDER-01/);
    stage.write("doc/work/ORD-1/02-analysis.md", analysis([REGISTER_ROW, RULE_ROW]));
    next(stage.repo);
    assert.equal(loadActive(stage.repo)!.phase, "design");
  });

  test("문서 영향 판단 전에 시작한 작업은 표 없이 지금처럼 넘어간다", () => {
    saveActive(stage.repo, { ...loadActive(stage.repo)!, knowledgeVersion: undefined });
    next(stage.repo);
    stage.write("doc/work/ORD-1/02-analysis.md", stage.IMPACT.replace(/## 문서 영향[\s\S]*$/, ""));
    next(stage.repo);
    assert.equal(loadActive(stage.repo)!.phase, "design");
  });

  test("2-8 영수증 기록 실패는 선택한 KNOWLEDGE를 원본으로 되돌린다", async () => {
    await toDeliver();
    stage.write(proposalFile("ORD-1"), PROPOSAL()); stage.writePr();
    const file = join(stage.repo, "doc/knowledge/features.md"), before = readFileSync(file, "utf8");
    const receipts = require("../agent/consentReceipts") as typeof import("../agent/consentReceipts"), original = receipts.writeConsentReceipts;
    receipts.writeConsentReceipts = () => { assert.notEqual(readFileSync(file, "utf8"), before); throw new Error("receipt fixture failure"); };
    try {
      assert.throws(() => withInteraction({ confirm: () => PRESENCE, ask: () => "y" }, () => deliver(requireValidatable(stage.repo, "deliver"))), /receipt fixture failure/);
      assert.equal(readFileSync(file, "utf8"), before);
    } finally { receipts.writeConsentReceipts = original; }
  });

  test("반영은 선언한 키만 제안받고, 구현되지 않은 기능·관찰을 확정으로 올린 정책은 거른 뒤 고른 것만 적용한다", async () => {
    await toDeliver();
    assert.match(status(stage.repo), /^지식 제안: `FEAT-ORDER-REGISTER`\(신규\) — doc\/work\/ORD-1\/knowledge\.proposal\.md 에, 형식은 /m);
    stage.write(proposalFile("ORD-1"), PROPOSAL());
    stage.writePr();
    const out = withInteraction({ confirm: () => PRESENCE, ask: () => "y" }, () => deliver(requireValidatable(stage.repo, "deliver")));
    assert.match(out, /공통 KNOWLEDGE 갱신: doc\/knowledge\/features\.md/);
    assert.doesNotMatch(out, /문서 갱신 보류/);
    const features = readFileSync(join(stage.repo, "doc/knowledge/features.md"), "utf-8");
    assert.match(features, /### `FEAT-ORDER-REGISTER` 주문 등록/);
    assert.doesNotMatch(features, /FEAT-ORDER-CANCEL/, "계획만 있는 기능은 기록하지 않는다");
    assert.doesNotMatch(readFileSync(join(stage.repo, "doc/knowledge/business-rules.md"), "utf-8"), /BR-ORDER-09/, "관찰을 확정 정책으로 올리지 않는다");
    assert.match(readFileSync(join(stage.repo, prDocFile("ORD-1")), "utf-8"), /## 문서 영향\n\n\| 문서 \| 키 \| 판단 \| 근거 \|[\s\S]*FEAT-ORDER-REGISTER \| 신규/);

    // 반영 직후는 최신, 근거 코드를 바꾼 다음 작업 뒤에는 재검토 필요 — 관련 없는 항목은 그대로
    assert.match(knowledgeList(stage.repo), /FEAT-ORDER-REGISTER\s+ORD-1\s+\S+Order\.java {2}\[최신\]\n/);
    stage.write(`${stage.ORDER}/domain/Order.java`, "class Order { Long id; }\n");
    stage.git("add", "-A");
    stage.git("commit", "-qm", "[ORD-2] 주문 id");
    const list = knowledgeList(stage.repo);
    assert.match(list, /FEAT-ORDER-REGISTER\s+ORD-1\s+[^\n]*\[재검토 필요: ORD-2 가 [^\n]*Order\.java 를 바꿈\]/);
    assert.match(list, /FEAT-ORDER-LIST[^\n]*\[최신\]/);
    assert.match(knowledgeFind(stage.repo, "주문 등록"), /`FEAT-ORDER-REGISTER`[^\n]*재검토 필요[\s\S]*원문과 근거 코드·테스트를 직접 확인/);
  });

  test("선언한 갱신을 거부하면 문서는 그대로이고 보류로 드러난다", async () => {
    await toDeliver();
    stage.write(proposalFile("ORD-1"), PROPOSAL());
    stage.writePr();
    const out = withInteraction({ confirm: () => PRESENCE, ask: () => "n" }, () => deliver(requireValidatable(stage.repo, "deliver")));
    assert.match(out, /문서 갱신 보류\(02 문서 영향에서 선언, 적용 안 함\): FEAT-ORDER-REGISTER 신규/);
    assert.match(knowledgeList(stage.repo), /갱신을 선언하고 반영한 작업인데 문서에 없는 키[^\n]*\n {2}- FEAT-ORDER-REGISTER · ORD-1 \(신규\)/);
  });

  test("모델은 작업 중에도 knowledge find 를 부를 수 있고, 목록·정리는 열리지 않는다", () => {
    const bash = (command: string) => decide({ cwd: stage.repo, tool_name: "Bash", tool_input: { command } });
    assert.equal(bash("code-agent knowledge find 주문"), undefined);
    assert.match(bash("code-agent knowledge") ?? "", /Bash 로 code-agent 명령/);
    assert.match(bash("code-agent knowledge prune") ?? "", /Bash 로 code-agent 명령/);
  });
});
