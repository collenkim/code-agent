import { writeFixture as writeRepoFile, repoTools } from "./repoFixture";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { next, start } from "../agent/commands";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { loadManifestIfAny } from "../agent/work";
import { readRequestLedger, recordRequestDecision, requestBegin, requestFormat, requestState, requestSubmit, revisionHeads } from "../agent/request";
import { legacyDocument, readRevisions, revisionLogFile } from "../agent/requirementRevisions";
import { sourceItems } from "../agent/sourceTrace";
import { readTimeline } from "../agent/timeline";

/**
 * 같은 작업 ID 의 요구 변경 — 최초 원문과 후속 원문 보존, 안정 ID, 추가·수정·명시적 삭제·전체 교체, 누락 거부,
 * 같은 변경의 재전송 멱등, 오래된 부모의 충돌 검사, 대기 변경안 대체, 렌더 전 중단 복구, 반려 때 확정본 복원, 이전 형식 이행.
 */

const ID = "ORD-7";
const SPEC = `doc/work/${ID}/requirement.md`;
const DRAFT = `doc/work/${ID}/request.json`;
const FIRST = "결제 뒤 24시간 안에 주문을 취소한다.\n배송이 시작된 주문은 취소하지 않는다.";
const PASS = ["node", "-e", "process.exit(0)"];
const TTY = { channel: "tty" as const, verified: true, detail: "테스트 — 터미널 확정을 흉내낸다" };

let repo: string;
const write = (path: string, content: string) => writeRepoFile(repo, path, content);
const read = (path: string) => readFileSync(join(repo, path), "utf-8");
const { git } = repoTools(() => repo);
const confirm = () => recordRequestDecision(repo, { id: ID, spec: SPEC, decision: "confirmed", approver: "test", presence: TTY });
const reject = (comment: string) => recordRequestDecision(repo, { id: ID, spec: SPEC, decision: "rejected", comment, approver: "test", presence: TTY });
const items = () => sourceItems(read(SPEC)).map((item) => `${item.id} ${item.text}`);
const header = { kind: "feature", id: ID, title: "주문 취소", target: ["order"] };

function initial(): void {
  requestBegin(repo, ID, "feature");
  write(DRAFT, JSON.stringify({ ...header, original: FIRST, requirements: ["결제 뒤 24시간 안에 주문을 취소한다.", "배송이 시작된 주문은 취소하지 않는다."] }));
  requestSubmit(repo, DRAFT);
  confirm();
}
function amend(parent: number, original: string, changes: object[], extra: Record<string, unknown> = {}): string {
  write(DRAFT, JSON.stringify({ ...header, original, revision: { parent, mode: "amend" }, changes, ...extra }));
  return requestSubmit(repo, DRAFT);
}

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-revision-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  write("doc/architecture.md", ["# 아키텍처", "## 기술 스택", "Node.js", "## 모듈/패키지 구조", "src/main/app", "## 계층과 책임", "- app", "## 의존 방향", "test → app", "## 공통 모듈", "없음", "## 주요 결정", "- 없음"].join("\n"));
  write("doc/conventions.md", ["# 코드 컨벤션", "## 명명", "- 소문자", "## 계층별 규칙", "- 순수 함수", "## 예외 처리", "- Error"].join("\n"));
  write("doc/test-strategy.md", ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체", "## 통과 기준", "- AC 마다 1케이스"].join("\n"));
  write("doc/quality.md", ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "## 보안 검사", "- 없음 — 리뷰", "## 통과 기준과 반영 차단", "- 컴파일 실패"].join("\n"));
  write("src/main/app/order/order.js", "module.exports = {};\n");
  write("code-agent.json", JSON.stringify({ language: "javascript", domainBase: "src/main", domainRoots: ["app"], conventions: ["doc/conventions.md"],
    docs: { architecture: "doc/architecture.md" }, build: PASS, test: PASS,
    stages: [{ key: "code", title: "코드", template: "01.md", scope: "project", outputDirs: ["src/main"] }, { key: "test", title: "테스트", template: "02.md", kind: "test", scope: "project", outputDirs: ["src/test"] }] }));
  for (const entry of checkProjectDocs(repo, loadManifestIfAny(repo))) recordDocConfirmation(repo, entry, "test", TTY);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  initial();
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("요구 개정 — 추가·수정·삭제", () => {
  test("A,B 확정 뒤 C 추가 → A,B,C — 기존 ID·내용은 그대로, 최초 원문과 후속 원문을 함께 보존한다", () => {
    const added = "취소 사유를 저장해 주세요.";
    const out = amend(1, added, [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }], { sourceMap: [{ quote: added, targets: ["REQ-3"] }] });
    assert.match(out, /요구 변경안을 렌더했습니다: doc\/work\/ORD-7\/requirement\.md — 개정 2\(부모 1 · 추가 1\)/);
    assert.match(out, /추가 \[REQ-3\] 취소 사유를 저장한다\./);
    assert.deepEqual(items(), ["REQ-1 결제 뒤 24시간 안에 주문을 취소한다.", "REQ-2 배송이 시작된 주문은 취소하지 않는다.", "REQ-3 취소 사유를 저장한다."]);
    const text = read(SPEC);
    assert.match(text, /## 원문\n\n<!-- [^\n]+ -->\n> 결제 뒤 24시간 안에 주문을 취소한다\./);
    assert.match(text, /## 후속 원문 — 개정 2\n\n<!-- [^\n]+ -->\n> 취소 사유를 저장해 주세요\./);
    assert.match(text, /## 이번 개정의 변경\n\n- 추가 \[REQ-3\]/);
    assert.match(text, /## 개정 이력\n\n- 개정 1 · 최초 접수 · \d{4}-\d\d-\d\d\n- 개정 2 · 변경 1건 · 이 문서/);
    // 변경안은 확정 전까지 진행을 멈춘다 — 확정본의 결과는 그대로 둔다
    assert.equal(requestState(repo, ID, SPEC).status, "unconfirmed");
    assert.equal(revisionHeads(repo, ID, SPEC).pending?.revision, 2);
    confirm();
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
    assert.equal(readRequestLedger(repo, ID).at(-1)?.revision, 2);
    assert.equal(revisionHeads(repo, ID, SPEC).confirmed?.revision, 2);
  });

  test("B 수정 → A,B',C — 같은 ID 를 유지하고 다른 항목의 ID·출처 개정은 그대로다", () => {
    amend(1, "취소 사유를 저장해 주세요.", [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }], { sourceMap: [{ quote: "취소 사유를 저장해 주세요.", targets: ["REQ-3"] }] });
    confirm();
    const said = "배송 출발 전까지는 취소할 수 있게 바꿔 주세요.";
    amend(2, said, [{ op: "modify", id: "REQ-2", text: "배송 출발 전까지는 주문을 취소할 수 있다." }], { sourceMap: [{ quote: said, targets: ["REQ-2"] }] });
    confirm();
    assert.deepEqual(items(), ["REQ-1 결제 뒤 24시간 안에 주문을 취소한다.", "REQ-2 배송 출발 전까지는 주문을 취소할 수 있다.", "REQ-3 취소 사유를 저장한다."]);
    const snapshot = revisionHeads(repo, ID, SPEC).confirmed!.snapshot;
    assert.deepEqual(snapshot.items.REQ.map((item) => [item.id, item.since, item.updated ?? null]), [["REQ-1", 1, null], ["REQ-2", 1, 3], ["REQ-3", 2, null]]);
    assert.match(read(SPEC), /- 수정 \[REQ-2\] 배송이 시작된 주문은 취소하지 않는다\. → 배송 출발 전까지는 주문을 취소할 수 있다\./);
  });

  test("B 명시적 삭제 → A,C 와 삭제 사유·개정 이력 — 삭제한 ID 는 다시 쓰지 않는다", () => {
    amend(1, "취소 사유를 저장해 주세요.", [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }], { sourceMap: [{ quote: "취소 사유를 저장해 주세요.", targets: ["REQ-3"] }] });
    confirm();
    const said = "배송 제한은 빼 주세요.";
    amend(2, said, [{ op: "remove", id: "REQ-2", reason: "사용자가 배송 제한을 빼 달라고 함" }], { sourceMap: [{ quote: said, targets: ["REQ-2"] }] });
    confirm();
    assert.deepEqual(items(), ["REQ-1 결제 뒤 24시간 안에 주문을 취소한다.", "REQ-3 취소 사유를 저장한다."]);
    assert.match(read(SPEC), /## 삭제된 요구\n\n- \[REQ-2\] 배송이 시작된 주문은 취소하지 않는다\. — 개정 3에서 삭제: 사용자가 배송 제한을 빼 달라고 함/);
    // 삭제한 번호는 다시 발급하지 않는다
    assert.throws(() => amend(3, "환불 알림을 보내 주세요.", [{ op: "add", section: "REQ", id: "REQ-2", text: "환불 알림을 보낸다." }]), /REQ-2: 이미 쓴 ID 입니다 — 새 ID 는 REQ-4 부터입니다/);
    assert.throws(() => amend(3, "배송 제한 다시", [{ op: "modify", id: "REQ-2", text: "x" }]), /REQ-2: 개정 3 에서 이미 삭제한 항목입니다/);
  });

  test("전체 목록 초안에서 B 가 빠지면 지우지 않고 거부한다 — 개정 형식과 빠진 ID 를 알린다", () => {
    const before = read(SPEC);
    write(DRAFT, JSON.stringify({ ...header, original: "취소 사유를 저장해 주세요.", requirements: ["취소 사유를 저장한다."] }));
    assert.throws(() => requestSubmit(repo, DRAFT), /확정된 요구 개정 1 이 있습니다 — 후속 요청은 요구 변경 형식으로[\s\S]*이 초안에 없는 확정 항목: REQ-1, REQ-2 — 초안에서 빠졌다는 이유로 지우지 않습니다/);
    assert.equal(read(SPEC), before);
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
    assert.equal(readRevisions(repo, ID).length, 1);
  });
});

describe("요구 개정 — 멱등·순서·충돌", () => {
  test("같은 변경안을 두 번 내면 한 번만 반영한다 — 대기 중이든 확정 뒤든 새 개정을 만들지 않는다", () => {
    const said = "취소 사유를 저장해 주세요.";
    const change = [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }];
    amend(1, said, change, { sourceMap: [{ quote: said, targets: ["REQ-3"] }] });
    assert.match(amend(1, said, change, { sourceMap: [{ quote: said, targets: ["REQ-3"] }] }), /같은 변경안 개정 2\(부모 1 · 추가 1\)이 이미 제출돼 확정을 기다립니다 — 새 개정을 만들지 않았습니다/);
    confirm();
    assert.match(amend(1, said, change, { sourceMap: [{ quote: said, targets: ["REQ-3"] }] }), /같은 변경안이 이미 개정 2 으로 확정돼 있습니다/);
    // 같은 원문을 다른 초안으로 다시 내도 같은 요청은 한 번만 반영한다
    assert.match(amend(2, said, [{ op: "add", section: "DONE", text: "사유가 저장된다." }]), /같은 원문이 이미 개정 2 에 반영돼 있습니다 — 새 개정을 만들지 않았습니다/);
    assert.equal(readRevisions(repo, ID).length, 2);
    assert.equal(readRequestLedger(repo, ID).length, 2);
    // 이미 있는 요구를 다시 추가하지 않는다
    assert.throws(() => amend(2, "취소 사유도 남겨 주세요.", [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }]), /추가하려는 내용이 이미 REQ-3 에 있습니다/);
  });

  test("목록 순서만 바꾼 초안은 바뀐 것이 없고, 전체 교체도 글자가 같은 항목의 ID 를 유지한다", () => {
    write(DRAFT, JSON.stringify({ ...header, original: FIRST, requirements: ["배송이 시작된 주문은 취소하지 않는다.", "결제 뒤 24시간 안에 주문을 취소한다."] }));
    assert.match(requestSubmit(repo, DRAFT), /바뀐 것이 없습니다 — 확정 개정 1 그대로입니다\(항목 순서가 달라도 ID 는 그대로입니다\)/);
    // 머리말만 바꾼 전체 초안은 바뀐 것이 없다고 넘기지 않는다 — 변경안으로 내게 한다
    write(DRAFT, JSON.stringify({ ...header, title: "주문 취소 — 고침", original: FIRST, requirements: ["결제 뒤 24시간 안에 주문을 취소한다.", "배송이 시작된 주문은 취소하지 않는다."] }));
    assert.throws(() => requestSubmit(repo, DRAFT), /바뀐 머리말: title — 변경안에 그 값과 바꾸라고 한 원문을 함께 씁니다/);
    const said = "요구를 전부 이것으로 바꿔 주세요: 배송이 시작된 주문은 취소하지 않는다. 결제 뒤 24시간 안에 주문을 취소한다. 취소 알림을 보낸다.";
    write(DRAFT, JSON.stringify({ ...header, original: said, revision: { parent: 1, mode: "replace", replaceQuote: "요구를 전부 이것으로 바꿔 주세요" },
      requirements: ["배송이 시작된 주문은 취소하지 않는다.", "결제 뒤 24시간 안에 주문을 취소한다.", "취소 알림을 보낸다."] }));
    assert.match(requestSubmit(repo, DRAFT), /개정 2\(부모 1 · 전체 교체 · 추가 1\)/);
    assert.deepEqual(items(), ["REQ-2 배송이 시작된 주문은 취소하지 않는다.", "REQ-1 결제 뒤 24시간 안에 주문을 취소한다.", "REQ-3 취소 알림을 보낸다."]);
  });

  test("전체 교체는 사람이 그 뜻으로 말한 원문 인용이 있어야 한다", () => {
    write(DRAFT, JSON.stringify({ ...header, original: "취소 알림을 보내 주세요.", revision: { parent: 1, mode: "replace" }, requirements: ["취소 알림을 보낸다."] }));
    assert.throws(() => requestSubmit(repo, DRAFT), /전체 교체는 사람이 그 뜻으로 요청한 원문 인용\(replaceQuote\)이 필요합니다/);
    write(DRAFT, JSON.stringify({ ...header, original: "취소 알림을 보내 주세요.", revision: { parent: 1, mode: "replace", replaceQuote: "전부 바꿔" }, requirements: ["취소 알림을 보낸다."] }));
    assert.throws(() => requestSubmit(repo, DRAFT), /replaceQuote 가 이번 원문에 없습니다: 전부 바꿔/);
  });

  test("오래된 부모의 변경안 — 그 뒤 확정된 개정과 겹치면 거부하고, 겹치지 않으면 최신 개정 위에 적용한다", () => {
    amend(1, "배송 제한 문구를 고쳐 주세요.", [{ op: "modify", id: "REQ-2", text: "배송 출발 뒤에는 취소하지 않는다." }], { sourceMap: [{ quote: "배송 제한 문구를 고쳐 주세요.", targets: ["REQ-2"] }] });
    confirm();
    assert.throws(() => amend(1, "배송 제한을 빼 주세요.", [{ op: "remove", id: "REQ-2", reason: "빼 달라고 함" }]),
      /개정 1 기준 변경안이 그 뒤 확정된 개정 2 과 겹칩니다\(REQ-2\) — 적용하지 않았습니다/);
    const said = "취소 사유를 저장해 주세요.";
    const out = amend(1, said, [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }]);
    assert.match(out, /개정 1 기준 변경안을 그 뒤 확정된 개정 2 위에 적용했습니다 — 겹치는 항목이 없습니다/);
    assert.match(out, /개정 3\(부모 2 · 추가 1\)/);
    assert.deepEqual(items(), ["REQ-1 결제 뒤 24시간 안에 주문을 취소한다.", "REQ-2 배송 출발 뒤에는 취소하지 않는다.", "REQ-3 취소 사유를 저장한다."]);
    assert.throws(() => amend(5, said, []), /개정 5 은 확정되지 않았습니다 — 지금 확정 개정은 2 입니다/);
  });

  test("대기 중 변경안을 다른 변경안이 대체하면 앞 원문을 함께 남겨 빠뜨린 변경이 미연결로 드러난다", () => {
    const first = "취소 사유를 저장해 주세요.";
    amend(1, first, [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }], { sourceMap: [{ quote: first, targets: ["REQ-3"] }] });
    const second = "취소 알림도 보내 주세요.";
    const out = amend(1, second, [{ op: "add", section: "REQ", text: "취소 알림을 보낸다." }], { sourceMap: [{ quote: second, targets: ["REQ-3"] }] });
    assert.match(out, /대기 중이던 변경안 개정 2\(부모 1 · 추가 1\) 을 이 변경안으로 대체합니다 — 그 원문 1개를 함께 남겼습니다/);
    assert.match(out, /원문 대조에 미연결 내용이 있습니다: 취소 사유를 저장해 주세요\./);
    const text = read(SPEC);
    assert.match(text, /## 후속 원문 — 개정 2\n\n<!-- [^\n]+ -->\n> 취소 사유를 저장해 주세요\.\n\n## 후속 원문 — 개정 2\n\n<!-- [^\n]+ -->\n> 취소 알림도 보내 주세요\./);
    // 두 요청을 함께 담아 다시 내면 연결이 끝난다
    const both = amend(1, second, [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }, { op: "add", section: "REQ", text: "취소 알림을 보낸다." }],
      { sourceMap: [{ quote: first, targets: ["REQ-3"] }, { quote: second, targets: ["REQ-4"] }] });
    assert.doesNotMatch(both, /미연결/);
    assert.deepEqual(items().slice(2), ["REQ-3 취소 사유를 저장한다.", "REQ-4 취소 알림을 보낸다."]);
  });
});

describe("요구 개정 — 복구·반려·이행", () => {
  test("기록 뒤 렌더 전에 멈춘 제출 — 확정본은 그대로 진행되고, 같은 제출이 지시서를 다시 렌더하며 새 개정을 만들지 않는다", () => {
    const confirmedText = read(SPEC);
    const said = "취소 사유를 저장해 주세요.";
    const change = [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }];
    amend(1, said, change, { sourceMap: [{ quote: said, targets: ["REQ-3"] }] });
    // 기록은 남고 지시서는 아직 확정본인 자리 — 프로세스가 기록 직후 멈췄다
    write(SPEC, confirmedText);
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
    assert.equal(revisionHeads(repo, ID, SPEC).pending, undefined);
    const count = readRevisions(repo, ID).length;
    assert.match(amend(1, said, change, { sourceMap: [{ quote: said, targets: ["REQ-3"] }] }),
      /이전 제출이 지시서 렌더 전에 멈췄습니다 — 기록된 변경안 개정 2\(부모 1 · 추가 1\) 으로 doc\/work\/ORD-7\/requirement\.md 를 다시 렌더했습니다\. 새 개정을 만들지 않았습니다/);
    assert.equal(readRevisions(repo, ID).length, count);
    assert.equal(revisionHeads(repo, ID, SPEC).pending?.revision, 2);
    assert.match(read(SPEC), /\[REQ-3\] 취소 사유를 저장한다\./);
  });

  test("변경안을 반려하면 지시서를 직전 확정본으로 되돌리고 확정 상태로 이어간다 — 같은 변경안은 다시 받지 않는다", () => {
    const confirmedText = read(SPEC);
    const said = "배송 제한은 빼 주세요.";
    amend(1, said, [{ op: "remove", id: "REQ-2", reason: "빼 달라고 함" }], { sourceMap: [{ quote: said, targets: ["REQ-2"] }] });
    assert.notEqual(read(SPEC), confirmedText);
    reject("배송 제한은 유지한다");
    assert.equal(read(SPEC), confirmedText);
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
    assert.ok(readTimeline(repo).some((event) => event.type === "request.restored" && event.detail?.restored === 1 && event.detail?.rejected === 2));
    assert.throws(() => amend(1, said, [{ op: "remove", id: "REQ-2", reason: "빼 달라고 함" }], { sourceMap: [{ quote: said, targets: ["REQ-2"] }] }),
      /반려된 내용과 같습니다 — 다시 제출하지 않았습니다\. 반려 사유: 배송 제한은 유지한다/);
  });

  test("이전 형식으로 확정한 지시서는 표시된 ID 그대로 개정 기록으로 옮기고 변경안을 받는다", () => {
    // 개정 기록 없이 렌더·확정된 지시서 — 이전 릴리스가 남긴 자리
    rmSync(revisionLogFile(repo, ID));
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
    assert.match(requestFormat(repo), /## 확정된 요구 — 개정 1 \(후속 요청은 이 개정 기준의 변경안으로 낸다\)\n- 요구 내용: \[REQ-1\] 결제 뒤 24시간 안에 주문을 취소한다\. · \[REQ-2\] 배송이 시작된 주문은 취소하지 않는다\.\n- 새 ID 는 REQ-3 · DONE-1 · CON-1 · OUT-1 부터/);
    const said = "취소 사유를 저장해 주세요.";
    const out = amend(1, said, [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }], { sourceMap: [{ quote: said, targets: ["REQ-3"] }] });
    assert.match(out, /이전 형식으로 확정된 지시서를 개정 1 으로 옮겼습니다 — 표시된 ID 를 그대로 씁니다/);
    const [migrated, proposal] = readRevisions(repo, ID);
    assert.equal(migrated.mode, "migrated");
    assert.ok(migrated.legacyText);
    assert.equal(proposal.parent, 1);
    assert.deepEqual(items(), ["REQ-1 결제 뒤 24시간 안에 주문을 취소한다.", "REQ-2 배송이 시작된 주문은 취소하지 않는다.", "REQ-3 취소 사유를 저장한다."]);
    assert.match(read(SPEC), /## 원문\n\n<!-- [^\n]+ -->\n> 결제 뒤 24시간 안에 주문을 취소한다\./);
    // 반려하면 이전 형식 그대로 되돌린다
    reject("보류");
    assert.equal(read(SPEC), migrated.legacyText);
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
  });

  test("이전 형식 읽기 — 표시된 REQ·DONE·CON ID 와 범위 밖의 위치 ID, 원문·오류 로그·접수 때 정한 것을 그대로 읽는다", () => {
    const fence = "```";
    const legacy = ["---", "kind: fix", "id: ORD-7", "title: t", "target:", "  - src/main/app/order", "---", "", "<!-- 이 파일은 code-agent request submit 이 x -->", "",
      "# ORD-7 요구사항 — t", "", "## 원문", "", "<!-- 원문: 사람이 준 글 -->", "> 첫 줄", ">", "> 둘째 줄", "", "## 오류 로그", "", "<!-- 오류 로그: 그대로 -->",
      `${fence}text`, "Error: boom", fence, "", "## 배경", "", "- 없음", "", "## 요구 내용", "", "- [REQ-1] 하나", "- [REQ-3] 셋", "  이어진 줄", "",
      "## 완료 조건", "", "- 원문에 없음 — 분석 단계의 수락 기준(AC)에서 정한다", "", "## 범위 밖", "", "- 부분 취소", "", "## 제약", "", "- [CON-1] 제약", "",
      "## 접수 때 정한 것", "", "- Q: 질문", "  - A: 답", ""].join("\n");
    const { snapshot, document } = legacyDocument(legacy, 2);
    assert.deepEqual(snapshot.items.REQ.map((item) => [item.id, item.text]), [["REQ-1", "하나"], ["REQ-3", "셋\n이어진 줄"]]);
    assert.deepEqual(snapshot.items.OUT, [{ id: "OUT-1", text: "부분 취소", since: 2 }]);
    assert.deepEqual(snapshot.next, { REQ: 4, DONE: 1, CON: 2, OUT: 2 });
    assert.equal(document.originals[0].text, "첫 줄\n\n둘째 줄");
    assert.equal(document.errorLog?.text, "Error: boom");
    assert.deepEqual(document.clarifications, [{ question: "질문", answer: "답" }]);
    assert.equal(document.background, "");
    assert.deepEqual([document.kind, document.target], ["fix", ["src/main/app/order"]]);
  });

  test("진행 중 작업의 변경안은 확정 전까지 next 를 멈추고, 대상 변경은 같은 작업의 요구 변경으로 받지 않는다", () => {
    start(repo, join(repo, SPEC));
    const said = "취소 사유를 저장해 주세요.";
    amend(1, said, [{ op: "add", section: "REQ", text: "취소 사유를 저장한다." }], { sourceMap: [{ quote: said, targets: ["REQ-3"] }] });
    assert.throws(() => next(repo), /요구사항이 확정 뒤 바뀌었습니다 — 변경안 개정 2\(부모 1 · 추가 1\)이 확정을 기다립니다[\s\S]*확정 전에는 진행·계획 배정을 하지 않습니다/);
    write(DRAFT, JSON.stringify({ ...header, target: ["billing"], original: "결제 쪽도 바꿔 주세요.", revision: { parent: 1, mode: "amend" }, changes: [] }));
    assert.throws(() => requestSubmit(repo, DRAFT), /진행 중인 작업\(ORD-7\)의 대상은 order 입니다 — 대상 변경\(billing\)은 같은 작업의 요구 변경으로 받지 않습니다/);
    assert.ok(existsSync(join(repo, SPEC)));
  });
});
