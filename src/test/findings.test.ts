/**
 * 진행 중 발견 보고(findings.ts) — 같은 보고는 하나로, 근거가 다른 발견은 따로. 분류는 보고이지 권한이 아니다:
 * 범위 확대·다른 프로젝트 영향을 등록해도 hook 쓰기 경계·승인·재계획 게이트가 그대로이고, 무관한 개선은 작업을 막지 않는다.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { next, status } from "../agent/commands";
import { findingList, findingReport, loadFindings } from "../agent/findings";
import { decide } from "../agent/hook";
import { findingsFile, loadActive } from "../agent/layout";
import { stateView } from "../agent/stateView";
import { Stop } from "../agent/stop";
import { approvalOf, loadWork } from "../agent/work";
import { createStageRepo, ORDER, removeStageRepo, repo, toCheck, write } from "./stageFixture";

const DRAFT = "doc/work/ORD-1/finding.draft.json";
const base = {
  class: "c", title: "결제 서비스 응답 계약 변경 필요", detail: "주문 조회 응답 형식을 결제 서비스가 그대로 읽는다",
  evidence: [{ kind: "file", ref: `${ORDER}/domain/Order.java` }], proposal: "결제 팀과 응답 스키마를 합의한다",
};
function report(draft: Record<string, unknown>, path = DRAFT): string {
  write(path, JSON.stringify(draft));
  return findingReport(repo, join(repo, path));
}
const ledger = (): string => readFileSync(join(repo, ".code-agent/approvals/ORD-1.jsonl"), "utf8");

beforeEach(() => {
  createStageRepo("ca-finding-");
  toCheck();
});
afterEach(() => removeStageRepo());

describe("정체와 버전 — 재전송은 하나로, 근거가 다르면 따로, 갱신은 지금 버전을 대조한다", () => {
  test("같은 보고를 다시 보내면 새로 만들지 않고, 근거가 다른 같은 제목은 다른 발견이다", () => {
    const first = report(base);
    const id = /^기록: (FND-[a-f0-9]{10}) v1/.exec(first)![1];
    assert.match(first, /초안 doc\/work\/ORD-1\/finding\.draft\.json 는 지웠습니다/);
    assert.match(report(base), new RegExp(`^이미 같은 보고가 있습니다: ${id} v1 — 새로 만들지 않았습니다`));
    assert.match(report({ ...base, evidence: [{ kind: "log", ref: ".code-agent/log/check-1.log" }] }), /^기록: FND-[a-f0-9]{10} v1/);
    assert.equal(loadFindings(repo, "ORD-1")!.findings.length, 2);
    assert.throws(() => report({ ...base, proposal: "다른 제안" }), new RegExp(`같은 발견\\(${id} v1\\)이 이미 있고 내용\\(proposal\\)이 다릅니다`));
  });

  test("갱신은 id 와 지금 버전을 보내야 하고, 오래된 버전의 갱신은 거부한다", () => {
    const id = /^기록: (FND-[a-f0-9]{10})/.exec(report(base))![1];
    assert.throws(() => report({ ...base, id, proposal: "새 제안" }), /expectVersion\(지금 v1\)이 필요합니다/);
    assert.match(report({ ...base, id, expectVersion: 1, proposal: "새 제안" }), new RegExp(`^갱신: ${id} v2 \\(바뀐 칸: proposal\\)`));
    assert.throws(() => report({ ...base, id, expectVersion: 1, proposal: "더 새 제안" }), /오래된 갱신입니다 — FND-[a-f0-9]{10} 는 지금 v2 입니다\(보낸 기대 v1\)/);
    const record = loadFindings(repo, "ORD-1")!.findings[0];
    assert.deepEqual([record.version, record.proposal, record.history.map((item) => item.changed.join(","))], [2, "새 제안", ["", "proposal"]]);
    assert.throws(() => report({ ...base, id, expectVersion: 2, status: "resolved" }), /resolved 로 닫으려면 resolution/);
  });

  test("깨졌거나 모르는 버전의 기록은 새로 만들지 않고 멈춘다 — 파일은 그대로다", () => {
    report(base);
    writeFileSync(findingsFile(repo, "ORD-1"), "{ 깨짐");
    assert.throws(() => report({ ...base, title: "다른 발견" }), /발견 기록을 읽을 수 없습니다[^\n]*새로 만들지 않습니다/);
    assert.equal(readFileSync(findingsFile(repo, "ORD-1"), "utf8"), "{ 깨짐");
    assert.match(status(repo), /^발견: 기록을 읽을 수 없습니다/m);
    assert.ok(stateView(repo).unknown.some((line) => /발견 기록을 읽을 수 없습니다/.test(line)));
    writeFileSync(findingsFile(repo, "ORD-1"), JSON.stringify({ version: 9, id: "ORD-1", findings: [] }));
    assert.throws(() => findingList(repo), /형식·버전을 지원하지 않습니다[^\n]*version 9/);
    assert.throws(() => findingList(repo, { work: "../../x" }), /작업 ID 가 아닙니다/);
  });
});

describe("분류는 보고이지 권한이 아니다", () => {
  test("범위 확대·공유 계약(b·c, 차단)을 등록해도 계획 밖 쓰기는 hook 이 막고 승인은 그대로다 — 재개는 사람 판단을 기다린다", () => {
    const unplanned = `${ORDER}/service/PaymentBridge.java`;
    const deny = () => decide({ cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, unplanned) } });
    const deniedBefore = deny();
    assert.ok(deniedBefore, "등록 전에도 계획 밖이다");
    const before = { ledger: ledger(), approval: approvalOf(loadWork(repo)!).status, active: JSON.stringify(loadActive(repo)) };
    report({ ...base, class: "b", title: "결제 연동 파일이 계획에 필요", affects: { paths: [unplanned] }, blocking: true, blockingReason: "계획 밖 파일 없이는 R2 를 못 채운다" });
    report({ ...base, blocking: true, blockingReason: "계약 합의 전에는 반영할 수 없다", related: [{ name: "payment-service" }] });
    assert.equal(deny(), deniedBefore, "발견 등록이 쓰기 경계를 넓히지 않는다");
    assert.deepEqual({ ledger: ledger(), approval: approvalOf(loadWork(repo)!).status, active: JSON.stringify(loadActive(repo)) }, before);
    const view = stateView(repo);
    assert.equal(view.resume.code, "needs-human");
    assert.deepEqual(view.resume.reasons.map((reason) => reason.code), ["finding-b", "finding-c"]);
    assert.equal(view.approval?.status, "approved");
    assert.match(findingList(repo), /\[b 로컬 요구·계획 변경\] 열림 · 차단\([^)]*\) · 사람 판단 필요[\s\S]*처리: 사람이 판단한 뒤 code-agent back plan 으로 재계획·재승인합니다 — 등록만으로 계획 밖 파일을 쓸 수 없습니다/);
    assert.match(findingList(repo), /관련 프로젝트: payment-service\(미확정\)/);
  });

  test("무관한 개선(d)은 차단으로 등록할 수 없고, 등록해도 재개 코드·진행을 막지 않는다", () => {
    assert.throws(() => report({ ...base, class: "d", title: "로그 문구 정리", blocking: true, blockingReason: "x" }), /무관한 개선\(d\)은 현재 작업을 막지 않습니다/);
    const before = stateView(repo).resume.code;
    report({ ...base, class: "d", title: "로그 문구 정리" });
    assert.equal(stateView(repo).resume.code, before);
    assert.equal(loadFindings(repo, "ORD-1")!.findings[0].humanDecision, false);
    assert.match(status(repo), /^발견: 열린 1건 \/ 전체 1 — code-agent finding list$/m);
  });

  test("관련 프로젝트는 이 저장소의 파일이 그 이름을 담을 때만 확인으로 본다 — 추측해 확정하지 않는다", () => {
    write("doc/dependencies.md", "# 의존\n- payment-service: 결제\n");
    report({ ...base, related: [{ name: "payment-service", source: "doc/dependencies.md" }, { name: "billing-core", source: "doc/dependencies.md" }, { name: "ledger-api" }] });
    assert.deepEqual(loadFindings(repo, "ORD-1")!.findings[0].related.map((item) => `${item.name}:${item.state}`),
      ["payment-service:known", "billing-core:unconfirmed", "ledger-api:unconfirmed"]);
    assert.throws(() => report({ ...base, title: "밖 경로", affects: { paths: ["../payment-service/api.ts"] } }), /다른 저장소는 related 에 이름으로/);
  });

  test("리뷰 지적·질문과 같은 것은 links 로 가리키고, 없는 기록은 가리킬 수 없다. 민감 값은 쓰지 않는다", () => {
    assert.throws(() => report({ ...base, links: ["question:Q9"] }), /question:Q9 — doc\/work\/ORD-1\/questions\.md 에 없는 질문입니다/);
    write("doc/work/ORD-1/questions.md", "## Q1 결제 계약\n질문\n[Answer]:\n");
    assert.match(report({ ...base, links: ["question:Q1"] }), /연결: question:Q1/);
    assert.throws(() => report({ ...base, title: "토큰", detail: "Authorization: Bearer abcdefghijklmnop 로 호출" }), (error: unknown) =>
      error instanceof Stop && /detail: 인증 헤더로 보이는 값/.test(error.message) && !/abcdefghijklmnop/.test(error.message));
  });

  test("발견은 진행 명령을 막지 않는다 — 열린 질문처럼 게이트가 되지 않는다", async () => {
    report({ ...base, blocking: true, blockingReason: "계약 합의 필요" });
    const { check } = await import("../agent/validate");
    const { requireValidatable } = await import("../agent/commands");
    await check(requireValidatable(repo, "check"));
    next(repo);
    assert.equal(loadActive(repo)!.phase, "test", "게이트는 기존 조건만 본다 — 사람 판단은 재개 코드로 알린다");
    assert.ok(existsSync(findingsFile(repo, "ORD-1")));
  });
});
