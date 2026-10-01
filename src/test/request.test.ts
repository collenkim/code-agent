import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { abort, context, next, start, status, Stop } from "../agent/commands";
import { checkProjectDocs, recordDocConfirmation } from "../agent/docs";
import { docsBegin, docsLink } from "../agent/docsCommands";
import { decide } from "../agent/hook";
import { loadActive, readStages, REQUEST_SESSION_FILE } from "../agent/layout";
import {
  decideRequest,
  loadRequestSession,
  recordRequestDecision,
  requestBegin,
  requestFormat,
  requestLedgerFile,
  requestState,
  requestSubmit,
} from "../agent/request";
import { loadManifestIfAny, readOrder } from "../agent/work";
import { loadManifest } from "../core/manifest";

/**
 * 요구사항 접수 — `/ca-request` 의 코드 쪽.
 *
 * 사람의 말 → 모델의 초안(request.json) → 코드의 렌더(requirement.md) → 사람의 터미널 확정 → start.
 * 터미널 확정은 TTY 를 흉내낼 수 없어 원장 기록 함수를 직접 부르고, TTY 가 아니면 판정이 거부되는 것만 따로 본다.
 */

const ID = "ORD-7";
const SPEC = `doc/work/${ID}/requirement.md`;
const DRAFT = `doc/work/${ID}/request.json`;

const ARCH = ["# 아키텍처", "## 기술 스택", "Node.js", "## 모듈/패키지 구조", "src/main/app", "## 계층과 책임", "- app: 코드", "## 의존 방향", "test → app", "## 공통 모듈", "없음", "## 주요 결정", "- 식별자: 문자열"].join("\n");
const CONV = ["# 코드 컨벤션", "## 명명", "- 파일은 소문자", "## 계층별 규칙", "- app 은 순수 함수로", "## 예외 처리", "- Error 를 던진다"].join("\n");
const STRATEGY = ["# 테스트 전략", "## 수준과 범위", "- Unit: 필수", "## 도구와 실행 명령", "- `test`: 전체", "## 통과 기준", "- AC 마다 1케이스"].join("\n");
const QUALITY = ["# 품질·보안 기준", "## 정적 분석", "- `build`: 컴파일", "## 보안 검사", "- 없음 — 리뷰에서 본다", "## 통과 기준과 반영 차단", "- 컴파일 실패는 반영을 막는다"].join("\n");
const PASS = ["node", "-e", "process.exit(0)"];

let repo: string;

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function read(path: string): string {
  return readFileSync(join(repo, path), "utf-8");
}

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf-8" }).trim();
}

function hook(tool: string, input: Record<string, string>): string | undefined {
  return decide({ cwd: repo, tool_name: tool, tool_input: input });
}

const TTY = { channel: "tty" as const, verified: true, detail: "테스트 — 터미널 확정을 흉내낸다" };

function confirm(id = ID, spec = SPEC): void {
  recordRequestDecision(repo, { id, spec, decision: "confirmed", approver: "test", presence: TTY });
}

function draft(overrides: Record<string, unknown> = {}): void {
  const original = typeof overrides.original === "string" ? overrides.original
    : typeof overrides.originalFile === "string" ? read(overrides.originalFile)
    : "결제 뒤 24시간 안에는 주문을 취소할 수 있게 해 주세요.\n\n배송이 시작되면 안 됩니다.";
  write(
    DRAFT,
    JSON.stringify({
      kind: "feature",
      id: ID,
      title: "주문 취소",
      target: ["order"],
      original: "결제 뒤 24시간 안에는 주문을 취소할 수 있게 해 주세요.\n\n배송이 시작되면 안 됩니다.",
      requirements: ["결제 뒤 24시간 안의 주문을 취소한다", "배송이 시작된 주문은 취소하지 않는다"],
      clarifications: [{ question: "24시간은 결제 시각 기준인가요?", answer: "네, 결제 완료 시각부터" }],
      sourceMap: [{ quote: original, targets: ["REQ-1"], note: "접수 동작 검증용 fixture 연결" }],
      ...overrides,
    }),
  );
}

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-request-")));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  write("doc/architecture.md", ARCH);
  write("doc/conventions.md", CONV);
  write("doc/test-strategy.md", STRATEGY);
  write("doc/quality.md", QUALITY);
  write("src/main/app/order/order.js", "module.exports = {};\n");
  write("src/main/app/billing/billing.js", "module.exports = {};\n");
  write(
    "code-agent.json",
    JSON.stringify({
      language: "javascript",
      domainBase: "src/main",
      domainRoots: ["app"],
      conventions: ["doc/conventions.md"],
      docs: { architecture: "doc/architecture.md" },
      build: PASS,
      test: PASS,
      stages: [
        { key: "code", title: "코드", template: "01.md", scope: "project", outputDirs: ["src/main"] },
        { key: "test", title: "테스트", template: "02.md", kind: "test", scope: "project", outputDirs: ["src/test"] },
      ],
    }),
  );
  for (const entry of checkProjectDocs(repo, loadManifestIfAny(repo))) {
    recordDocConfirmation(repo, entry, "test", TTY);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("접수 — begin", () => {
  test("잘못된 ID와 종류는 거부한다 — 생략한 ID는 별도 자동 발급 테스트에서 확인", () => {
    assert.throws(() => requestBegin(repo, "주문 1", "feature"), /작업 ID 가 필요합니다: 주문 1/);
    assert.throws(() => requestBegin(repo, ID, undefined), /작업 종류가 필요합니다/);
    assert.throws(() => requestBegin(repo, ID, "chore"), /작업 종류가 필요합니다: chore/);
    assert.equal(existsSync(join(repo, REQUEST_SESSION_FILE)), false);
  });

  test("세션을 열고 형식 · 대상 후보를 찍고, 전이를 기록한다", () => {
    const out = requestBegin(repo, ID, "feature");
    assert.match(out, /요구사항 접수를 열었습니다: ORD-7 \(feature\)/);
    assert.match(out, /"requirements"/);
    // feature 의 대상은 이름이다 — 경로를 고르면 계획 · 증거 파일 이름이 경로로 갈라진다
    assert.match(out, /- billing \(src\/main\/app\/billing\)\n- order \(src\/main\/app\/order\)/);
    assert.deepEqual(loadRequestSession(repo)?.id, ID);
    assert.ok(existsSync(join(repo, `doc/work/${ID}`)));
    const stages = readStages(repo);
    assert.equal(stages[stages.length - 1].phase, "request");
    assert.equal(stages[stages.length - 1].by, "request");
    // context 도 같은 것을 준다 — 커서가 없어도
    assert.match(context(repo), /# code-agent request — ORD-7 접수 \(feature\)/);
  });

  test("다른 ID 를 접수 중이거나 문서 세션 · 작업이 있으면 열지 않는다", () => {
    requestBegin(repo, ID, "feature");
    assert.match(requestBegin(repo, ID, "feature"), /이미 접수 중입니다/);
    assert.throws(() => requestBegin(repo, "ORD-8", "feature"), /접수 중인 요구사항이 있습니다: ORD-7/);
    assert.throws(() => requestBegin(repo, ID, "fix"), /feature 로 접수 중입니다/);
    assert.match(docsBegin(repo), /접수한 ID·원문 초안은 유지됩니다/);
    assert.equal(loadRequestSession(repo)?.id, ID);
  });
});

describe("접수 — 세션이 없을 때도 hook 이 지키는 것", () => {
  test("작업도 세션도 없어도 지시서 · 원장 · 상태 자리는 도구로 쓰지 못한다", () => {
    // 새 요구사항을 받기 직전 — 세션이 열리기 전에 지시서와 확정 원장을 손으로 써 넣고 start 를 지나는 길
    assert.match(hook("Write", { file_path: join(repo, "doc/work/EVIL-1/requirement.md") }) ?? "", /작업 지시서\(doc\/work\/EVIL-1\/requirement\.md\)는 code-agent request submit 이 렌더합니다/);
    assert.match(hook("Write", { file_path: join(repo, ".code-agent/approvals/EVIL-1/request.jsonl") }) ?? "", /도구로 고칠 수 없습니다/);
    assert.match(hook("Edit", { file_path: join(repo, ".Code-Agent/active.json") }) ?? "", /도구로 고칠 수 없습니다/);
    assert.match(hook("Bash", { command: "node -e \"require('fs').appendFileSync('.code-agent/approvals/EVIL-1/request.jsonl','x')\"" }) ?? "", /Bash 로 건드리지 않습니다/);
    // 그 밖은 code-agent 의 일이 아니다
    assert.equal(hook("Write", { file_path: join(repo, "src/main/app/order/order.js") }), undefined);
    assert.equal(hook("Bash", { command: "npm test" }), undefined);
    assert.equal(hook("Bash", { command: "code-agent status" }), undefined);
  });

  test("대체 데이터 스트림 표기(::$DATA)로 지시서 대조를 비켜 가지 못한다", () => {
    requestBegin(repo, ID, "feature");
    assert.match(hook("Write", { file_path: join(repo, `${SPEC}::$DATA`) }) ?? "", /경로에 ':' 가 든 파일은 쓸 수 없습니다/);
  });

  test("접수 중에는 docs link 로 code-agent.json 을 바꾸지 못한다", () => {
    requestBegin(repo, ID, "feature");
    write("doc/work/ORD-7/fake-conv.md", "# x\n");
    assert.throws(() => docsLink(repo, "conventions", ["doc/work/ORD-7/fake-conv.md"]), /요구사항을 접수 중입니다 \(ORD-7\)\. 문서 연결/);
  });

  test("작업 중에도 code-agent request 는 접수 형식을 준다 — 요구사항을 고칠 때", () => {
    requestBegin(repo, ID, "feature");
    draft();
    requestSubmit(repo, DRAFT);
    confirm();
    start(repo, join(repo, SPEC));
    assert.match(requestFormat(repo), /# code-agent request — ORD-7 접수 \(feature\)[\s\S]*"requirements"[\s\S]*다음: 확정됨/);
    // context 는 스테이지 컨텍스트다
    assert.match(context(repo), /# code-agent context — ORD-7 · 요구사항 분석/);
  });

  test("extra 의 속성 이름이 머리말 규칙 밖이면 초안 탓으로 알린다", () => {
    requestBegin(repo, ID, "feature");
    draft({ extra: { 담당: "김" } });
    assert.throws(() => requestSubmit(repo, DRAFT), (error: unknown) => error instanceof Stop && /extra 의 속성 이름은 영문으로 시작하는/.test(error.message));
  });
});

describe("접수 — hook", () => {
  test("작업 폴더만 쓰고, 지시서는 코드만 쓴다", () => {
    requestBegin(repo, ID, "feature");
    assert.equal(hook("Write", { file_path: join(repo, DRAFT) }), undefined);
    assert.match(hook("Write", { file_path: join(repo, SPEC) }) ?? "", /requirement\.md 는 코드가 렌더합니다/);
    assert.match(hook("Edit", { file_path: join(repo, "src/main/app/order/order.js") }) ?? "", /요구사항 접수 중에는 작업 폴더/);
    assert.match(hook("Write", { file_path: join(repo, "doc/work/ORD-8/x.md") }) ?? "", /요구사항 접수 중에는 작업 폴더/);
    assert.match(hook("Write", { file_path: join(repo, ".code-agent/request-session.json") }) ?? "", /도구로 고칠 수 없습니다/);
  });

  test("Bash 는 접수 명령 · 읽기용 git 만 — 확정 · 반려는 사람의 것이다", () => {
    requestBegin(repo, ID, "feature");
    assert.equal(hook("Bash", { command: `code-agent request submit ${DRAFT}` }), undefined);
    assert.equal(hook("Bash", { command: "code-agent context" }), undefined);
    assert.match(hook("Bash", { command: `code-agent confirm request ${ID}` }) ?? "", /사람이 터미널에서 실행합니다/);
    assert.match(hook("Bash", { command: `code-agent reject request ${ID} --comment x` }) ?? "", /사람이 터미널에서 실행합니다/);
    assert.match(hook("Bash", { command: "code-agent abort" }) ?? "", /사람이 터미널에서 실행합니다/);
    // 돌릴 코드가 아직 없다 — 선언된 build 도 접수 중에는 닫는다
    assert.match(hook("Bash", { command: PASS.join(" ") }) ?? "", /Bash 로 code-agent 명령/);
  });
});

describe("접수 — submit", () => {
  beforeEach(() => {
    requestBegin(repo, ID, "feature");
  });

  test("초안을 지시서로 렌더한다 — 원문은 그대로, 지시서 규칙으로 다시 읽힌다", () => {
    draft();
    const out = requestSubmit(repo, join(repo, DRAFT));
    assert.match(out, /요구사항을 렌더했습니다: doc\/work\/ORD-7\/requirement\.md \(feature · 주문 취소\)/);
    assert.match(out, /code-agent confirm request ORD-7/);
    const text = read(SPEC);
    assert.match(text, /^---\nkind: feature\nid: ORD-7\ntitle: 주문 취소\ntarget:\n {2}- order\n---\n/);
    assert.match(text, /## 원문\n\n<!-- 원문: 사람이 준 글 \(접수 초안의 original\) -->\n> 결제 뒤 24시간 안에는 주문을 취소할 수 있게 해 주세요\.\n>\n> 배송이 시작되면 안 됩니다\./);
    assert.match(text, /## 요구 내용\n\n- \[REQ-1\] 결제 뒤 24시간 안의 주문을 취소한다\n- \[REQ-2\] 배송이 시작된 주문은 취소하지 않는다/);
    assert.match(text, /## 완료 조건\n\n- 원문에 없음 — 분석 단계의 수락 기준\(AC\)에서 정한다/);
    assert.match(text, /## 접수 때 정한 것\n\n- Q: 24시간은 결제 시각 기준인가요\?\n {2}- A: 네, 결제 완료 시각부터/);
    const order = readOrder(repo, SPEC, loadManifest(repo));
    assert.equal(order.id, ID);
    assert.deepEqual(order.target, ["order"]);
    assert.equal(requestState(repo, ID, SPEC).status, "none");
  });

  test("originalFile 이면 코드가 그 파일을 그대로 옮긴다", () => {
    write("doc/work/ORD-7/ticket.txt", "티켓 ORD-7\n주문 취소 버튼을 만든다\n");
    draft({ original: undefined, originalFile: "doc/work/ORD-7/ticket.txt" });
    requestSubmit(repo, DRAFT);
    assert.match(read(SPEC), /<!-- 원문: doc\/work\/ORD-7\/ticket\.txt 그대로 -->\n> 티켓 ORD-7\n> 주문 취소 버튼을 만든다/);
  });

  test("형식 · 지시서 규칙에 안 맞으면 렌더하지 않는다", () => {
    draft({ requirements: [] });
    assert.throws(() => requestSubmit(repo, DRAFT), /접수 초안의 형식이 맞지 않습니다:[\s\S]*requirements/);
    draft({ original: undefined });
    assert.throws(() => requestSubmit(repo, DRAFT), /original\(사람이 준 글 그대로\) 과 originalFile/);
    draft({ title: "두 줄\n제목" });
    assert.throws(() => requestSubmit(repo, DRAFT), /title 은 한 줄로 씁니다/);
    draft({ title: "\"따옴표\"" });
    assert.throws(() => requestSubmit(repo, DRAFT), /머리말로 옮기면 값이 달라집니다: title/);
    draft({ id: "ORD-8" });
    assert.throws(() => requestSubmit(repo, DRAFT), /초안의 id\(ORD-8\) 가 접수 중인 작업\(ORD-7\) 과 다릅니다/);
    draft({ kind: "fix" });
    assert.throws(() => requestSubmit(repo, DRAFT), /초안의 kind\(fix\) 가 접수한 종류\(feature\) 와 다릅니다/);
    draft({ extra: { team: "a" } });
    assert.throws(() => requestSubmit(repo, DRAFT), /지시서 규격에 맞지 않아[\s\S]*\[team\] 예약 속성도 아니고/);
    assert.equal(existsSync(join(repo, SPEC)), false);
  });

  test("fix 는 저장소 경로 · scope · preserve 가 있어야 한다 — 손으로 쓴 지시서와 같은 규칙", () => {
    abort(repo);
    requestBegin(repo, ID, "fix");
    draft({ kind: "fix", target: ["src/main/app/nowhere"] });
    assert.throws(
      () => requestSubmit(repo, DRAFT),
      /\[scope\] fix 에는 필수입니다[\s\S]*\[preserve\] fix 에는 필수입니다[\s\S]*\[target\] 대상 저장소에 없는 경로입니다/,
    );
    draft({ kind: "fix", target: ["src/main/app/order"], scope: ["src/main/app/order"], preserve: ["주문 API 응답 형식"] });
    requestSubmit(repo, DRAFT);
    assert.match(read(SPEC), /scope:\n {2}- src\/main\/app\/order\npreserve:\n {2}- 주문 API 응답 형식/);
  });
});

describe("접수 — 확정 · 시작", () => {
  beforeEach(() => {
    requestBegin(repo, ID, "feature");
    draft();
    requestSubmit(repo, DRAFT);
  });

  test("확정 전에는 start 가 거부한다 — 모델이 지시서를 지어내 시작하는 길이 여기서 닫힌다", () => {
    assert.throws(() => start(repo, join(repo, SPEC)), /요구사항이 확정되지 않았습니다[\s\S]*code-agent confirm request ORD-7/);
    assert.match(status(repo), /접수: ORD-7 \(feature\)[\s\S]*요구사항: 확정 대기[\s\S]*다음: 사람이 별도 터미널에서 code-agent confirm request ORD-7/);
    assert.equal(loadActive(repo), undefined);
  });

  test("판정은 TTY 에서만 — 모델의 Bash 로는 확정할 수 없다", () => {
    assert.throws(() => decideRequest(repo, ID, "confirmed"), /판정은 터미널에서 받습니다/);
    assert.throws(() => decideRequest(repo, ID, "rejected"), /반려에는 사유가 필요합니다/);
    assert.equal(existsSync(requestLedgerFile(repo, ID)), false);
  });

  test("확정하면 start 가 열리고 접수 세션이 닫힌다", () => {
    confirm();
    assert.match(status(repo), /요구사항: 확정됨[\s\S]*다음: 확정됨 — \/ca-next 또는 \/ca-analyze/);
    assert.match(start(repo, join(repo, SPEC)), /시작했습니다: ORD-7 · 주문 취소 \(feature, 대상 order\)/);
    assert.equal(loadRequestSession(repo), undefined);
    assert.equal(loadActive(repo)?.phase, "analysis");
    assert.match(status(repo), /요구사항: 확정됨/);
    // 확정 원장은 이 작업의 승인 디렉토리 안 — 반영 커밋에 함께 들어간다
    assert.ok(requestLedgerFile(repo, ID).replace(/\\/g, "/").endsWith(`.code-agent/approvals/${ID}/request.jsonl`));
  });

  test("반려하면 사유가 보이고, 고쳐 다시 내면 다시 확정을 기다린다", () => {
    recordRequestDecision(repo, { id: ID, spec: SPEC, decision: "rejected", comment: "원문에 없는 요구가 있다", approver: "test", presence: TTY });
    assert.match(status(repo), /요구사항: 반려됨 — 원문에 없는 요구가 있다[\s\S]*다음: \/ca-request — 반려됐습니다: 원문에 없는 요구가 있다/);
    assert.throws(() => start(repo, join(repo, SPEC)), /요구사항이 반려됐습니다/);
    draft({ requirements: ["결제 뒤 24시간 안의 주문을 취소한다"] });
    requestSubmit(repo, DRAFT);
    assert.equal(requestState(repo, ID, SPEC).status, "unconfirmed");
    assert.throws(() => start(repo, join(repo, SPEC)), /요구사항이 다시 제출돼 확정을 기다립니다/);
  });

  test("확정 뒤 지시서가 바뀌면 next 가 멈추고 다시 확정을 요구한다", () => {
    confirm();
    start(repo, join(repo, SPEC));
    // 사람이 고친 것이든 다시 제출한 것이든 — 확정한 바이트가 아니면 진행하지 않는다
    writeFileSync(join(repo, SPEC), `${read(SPEC)}\n- 추가 요구\n`);
    assert.throws(() => next(repo), /요구사항이 확정 뒤 바뀌었습니다[\s\S]*code-agent confirm request ORD-7/);
    assert.match(status(repo), /요구사항: 확정 뒤 바뀜 — 다시 확정 필요[\s\S]*다음: 사람이 별도 터미널에서 code-agent confirm request ORD-7/);
    confirm();
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
  });

  test("시작한 작업의 요구사항은 같은 ID 로만 다시 제출한다 — 지시서는 hook 이 막는다", () => {
    confirm();
    start(repo, join(repo, SPEC));
    assert.match(hook("Write", { file_path: join(repo, SPEC) }) ?? "", /작업 지시서\(doc\/work\/ORD-7\/requirement\.md\)는 고칠 수 없습니다/);
    draft({ requirements: ["결제 뒤 24시간 안의 주문을 취소한다", "취소 사유를 남긴다"] });
    assert.match(requestSubmit(repo, DRAFT), /확정 뒤 내용이 바뀌었습니다 — 사람이 다시 확정해야 진행합니다/);
    assert.throws(() => next(repo), /요구사항이 확정 뒤 바뀌었습니다/);
  });

  test("손으로 쓴 지시서도 확정을 거쳐야 시작한다", () => {
    write("doc/work/ORD-9/requirement.md", "---\nkind: feature\nid: ORD-9\ntitle: 손으로\ntarget: order\n---\n\n본문\n");
    abort(repo);
    assert.throws(() => start(repo, join(repo, "doc/work/ORD-9/requirement.md")), /요구사항이 확정되지 않았습니다/);
    confirm("ORD-9", "doc/work/ORD-9/requirement.md");
    assert.match(start(repo, join(repo, "doc/work/ORD-9/requirement.md")), /시작했습니다: ORD-9/);
  });

  test("접수를 닫는 것은 사람의 abort — 작업 폴더와 원장은 남는다", () => {
    confirm();
    assert.match(abort(repo), /요구사항 접수를 닫았습니다: ORD-7/);
    assert.equal(loadRequestSession(repo), undefined);
    assert.ok(existsSync(join(repo, SPEC)));
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
    assert.throws(() => abort(repo), /진행 중인 작업도 접수 중인 요구사항도 없습니다/);
  });

  test("사람이 쓴 지시서는 접수가 덮지 않는다", () => {
    abort(repo);
    write("doc/work/ORD-5/requirement.md", "---\nkind: feature\nid: ORD-5\ntitle: 손으로\ntarget: order\n---\n\n사람이 쓴 본문\n");
    requestBegin(repo, "ORD-5", "feature");
    write("doc/work/ORD-5/request.json", JSON.stringify({ kind: "feature", id: "ORD-5", title: "t", target: ["order"], original: "x", requirements: ["y"] }));
    assert.throws(() => requestSubmit(repo, "doc/work/ORD-5/request.json"), /사람이 쓴 지시서가 이미 있습니다: doc\/work\/ORD-5\/requirement\.md — 덮어쓰지 않았습니다/);
    assert.match(read("doc/work/ORD-5/requirement.md"), /사람이 쓴 본문/);
  });

  test("반려된 내용을 그대로 다시 내면 거부한다 — 사유를 읽게 한다", () => {
    recordRequestDecision(repo, { id: ID, spec: SPEC, decision: "rejected", comment: "배송 기준이 없다", approver: "test", presence: TTY });
    assert.throws(() => requestSubmit(repo, DRAFT), /반려된 내용과 같습니다 — 다시 제출하지 않았습니다\. 반려 사유: 배송 기준이 없다/);
  });

  test("다른 자리의 손으로 쓴 지시서는 경로를 받아 확정한다 — 확정과 시작이 같은 파일을 본다", () => {
    abort(repo);
    write("doc/specs/ORD-9.md", "---\nkind: feature\nid: ORD-9\ntitle: 손으로\ntarget: order\n---\n\n본문\n");
    assert.throws(() => start(repo, join(repo, "doc/specs/ORD-9.md")), /code-agent confirm request ORD-9 doc\/specs\/ORD-9\.md/);
    // 경로 없이 확정하면 정해진 자리를 찾고, 없으면 경로를 주라고 말한다
    assert.throws(() => decideRequest(repo, "ORD-9", "confirmed"), /다른 자리에 손으로 쓴 지시서면 경로를 함께 주세요: code-agent confirm request ORD-9 <지시서>/);
    // 경로를 주면 그 파일을 확정하러 간다 (TTY 가 아니라 여기서 멈춘다)
    assert.throws(() => decideRequest(repo, "ORD-9", "confirmed", undefined, join(repo, "doc/specs/ORD-9.md")), /판정은 터미널에서 받습니다/);
  });

  test("접수 때 받은 기준 브랜치 · 대상을 확정 뒤 start 가 쓴다", () => {
    abort(repo);
    git("branch", "develop");
    requestBegin(repo, ID, "feature", { base: "develop" });
    confirm();
    assert.match(status(repo), /시작할 때 기준 브랜치 develop/);
    assert.match(start(repo, join(repo, SPEC)), /작업 브랜치 feature\/ORD-7 를 develop 에서 만들었습니다/);
    assert.equal(loadActive(repo)?.base, "develop");
  });

  test("관측된 판정만 받는 프로젝트는 TTY 가 아닌 확정을 받지 않는다", () => {
    const manifest = JSON.parse(read("code-agent.json"));
    write("code-agent.json", JSON.stringify({ ...manifest, workOrder: { requireVerifiedApproval: true } }));
    for (const entry of checkProjectDocs(repo, loadManifestIfAny(repo))) {
      recordDocConfirmation(repo, entry, "test", TTY);
    }
    recordRequestDecision(repo, {
      id: ID,
      spec: SPEC,
      decision: "confirmed",
      approver: "script",
      presence: { channel: "unattended", verified: false, detail: "스크립트" },
    });
    assert.equal(requestState(repo, ID, SPEC).status, "unverified");
    assert.throws(() => start(repo, join(repo, SPEC)), /요구사항 확정에 사람이 관측되지 않았습니다/);
  });

  test("원장은 이 id · 이 지시서의 줄만 판정에 쓴다 — slug 가 같은 다른 id 가 끼어도", () => {
    confirm();
    recordRequestDecision(repo, {
      id: "ORD 7",
      spec: "doc/work/ORD 7/requirement.md",
      decision: "rejected",
      comment: "x",
      approver: "t",
      presence: TTY,
      hash: "sha256:0000000000000000",
    });
    assert.equal(requestState(repo, ID, SPEC).status, "confirmed");
  });

  test("원장의 중간 줄을 고치면 읽지 않는다", () => {
    confirm();
    recordRequestDecision(repo, { id: ID, spec: SPEC, decision: "rejected", comment: "다시", approver: "test", presence: TTY });
    const path = requestLedgerFile(repo, ID);
    const lines = readFileSync(path, "utf-8").split("\n");
    lines[0] = lines[0].replace("\"test\"", "\"someone\"");
    writeFileSync(path, lines.join("\n"));
    assert.throws(() => requestState(repo, ID, SPEC), (error: unknown) => error instanceof Stop && /요구사항 확정 원장이 나중에 고쳐졌습니다/.test(error.message));
  });
});
