import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { next, start as startWork, status } from "../agent/commands";
import { applyConsent, finishConsent } from "../agent/consent";
import { cyclesFile, deliveredCycle, recordDeliveredCycle } from "../agent/cycles";
import { loadActive, saveActive } from "../agent/layout";
import { planningStatus, preparePlanning } from "../agent/planning";
import { observePlanner } from "../agent/planningHook";
import { pendingCompletion } from "../agent/agentRuns";
import { loadPlanning } from "../agent/planningState";
import { requestBegin, requestSubmit } from "../agent/request";
import { textHash } from "../agent/requirementRevisions";
import { stateView } from "../agent/stateView";
import { readTimeline } from "../agent/timeline";
import { changedPaths } from "../agent/tree";
import { approvalOf, loadWork } from "../agent/work";
import { confirmForTest, start } from "./confirmedStart";
import {
  approveAndApplyFixture, confirmationText, CONSENT_SPEC, CONSENT_WORK_ID, gitFixture, observeConsentFixture, preparePlanFixture, prepareConsentFixture,
  prepareDeliveryFixture, prepareReviewFixture, setupConsentProject, writeFixture,
} from "./consentFixture";
import { advance, completed, DIR, finish, REQUIREMENTS, root, serial, SPEC, throughDesign, write } from "./planningFixture";

/**
 * 확정된 요구 개정과 흐름 — 변경안 대기 중 배정 멈춤, 분석 중 개정 전환의 작업 정의 갱신, 이후 단계의 분석 되감기(브랜치·코드 보존),
 * 늦은 결과·이전 승인 응답 거부, 머리말만 바뀐 개정과 따르던 기록 없는 커서, 반영한 ID 의 새 실행 회차.
 */

const analysisTask = () => loadPlanning(loadWork(root)!).tasks.find((record) => record.task.role === "analysis")!;
const revised = (lines: string[]) => `---\nkind: feature\nid: PLAN-1\ntitle: 값 반환\ntarget: value\n---\n\n${lines.join("\n")}\n`;
const applied = (repo: string) => readTimeline(repo).filter((event) => event.type === "revision.applied");

describe("계획 흐름 — 손으로 쓴 지시서", () => {
  test("확정 전 바뀐 지시서로는 준비·배정하지 않고, 분석 중 확정되면 분석 작업의 요구 범위를 그 개정에 맞춘다 — 같은 확정본 위 재준비는 정의를 바꾸지 않는다", () => {
    preparePlanning(root);
    assert.deepEqual(analysisTask().task.requirements, ["REQ-1"]);
    write(SPEC, revised(["값을 반환한다.", "추가 값을 반환한다."]));
    assert.throws(() => preparePlanning(root), /요구사항이 확정 뒤 바뀌었습니다/);
    assert.deepEqual(analysisTask().task.requirements, ["REQ-1"], "확정 전에는 작업 정의를 바꾸지 않는다");
    confirmForTest(root, join(root, SPEC));
    assert.equal(loadActive(root)!.phase, "analysis");
    assert.deepEqual(JSON.parse(preparePlanning(root)).aligned, ["analysis"]);
    assert.deepEqual(analysisTask().task.requirements, ["REQ-1", "REQ-2"]);
    const basis = analysisTask().basis;
    assert.equal(basis, loadActive(root)!.request!.hash);
    assert.equal(JSON.parse(preparePlanning(root)).aligned, undefined);
    assert.equal(analysisTask().basis, basis);
    const [event] = applied(root);
    assert.deepEqual([event.phase, event.detail?.rewound, event.detail?.from, event.reason], ["analysis", false, "analysis", "바뀐 요구 확정 — 분석 중 반영"]);
  });

  test("늦은 결과 — 이전 확정본으로 배정한 담당의 완료는 받지 않고 새 요구 범위로 다시 배정한다. 같은 완료의 재알림은 효과가 없다", async () => {
    const [item] = (await advance()).assignments;
    write(SPEC, revised(["값을 반환한다.", "추가 값을 반환한다."]));
    confirmForTest(root, join(root, SPEC));
    assert.throws(() => finish(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS }), /실행 중 입력이 바뀌었습니다/);
    assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false, "늦은 결과의 문서는 쓰지 않는다");
    const [view] = JSON.parse(planningStatus(root)).tasks;
    assert.notEqual(view.state, "completed");
    const workId = loadWork(root)!.active.id, late = pendingCompletion(root, workId);
    assert.ok(late, "다음 행동(재배정)을 낼 완료 한 번으로 남는다");
    const attemptsOf = () => { const [task] = JSON.parse(planningStatus(root)).tasks; return [task.attempts, task.last?.status, task.last?.dispatchId]; };
    const resend = () => {
      try {
        observePlanner({ cwd: root, session_id: "s", agent_id: `agent-${serial}`, agent_type: item.hostAgents.claude, hook_event_name: "SubagentStop",
          last_assistant_message: JSON.stringify(completed(item, { [`${DIR}/01-requirements.md`]: REQUIREMENTS })) });
      } catch { /* 기록한 실패는 예외로 알린다 — 효과는 상태로 본다 */ }
    };
    const before = attemptsOf();
    resend();
    assert.equal(pendingCompletion(root, workId)?.completion.eventId, late!.completion.eventId, "중복 알림은 새 완료를 만들지 않는다");
    assert.deepEqual(attemptsOf(), before);
    const again = await advance();
    assert.equal(again.action, "dispatch");
    assert.equal(again.assignments.length, 1);
    assert.notEqual(again.assignments[0].resultShape.dispatchId, item.resultShape.dispatchId);
    assert.deepEqual(again.assignments[0].task.requirements, ["REQ-1", "REQ-2"]);
    const redispatched = attemptsOf();
    resend();
    assert.deepEqual(attemptsOf(), redispatched, "재배정 뒤 온 이전 개정 완료는 새 배정을 건드리지 않는다");
    assert.equal(existsSync(join(root, DIR, "01-requirements.md")), false);
  });

  test("분석 뒤 단계에서 요구 항목이 바뀌어 확정되면 분석으로 되감고 문서·브랜치를 보존한다 — 재개·같은 확정은 다시 되감지 않는다", () => {
    throughDesign();
    const before = loadActive(root)!;
    assert.equal(before.phase, "plan");
    write(SPEC, revised(["값을 반환한다.", "추가 값을 반환한다."]));
    assert.throws(() => next(root), /요구사항이 확정 뒤 바뀌었습니다/);
    assert.equal(loadActive(root)!.phase, "plan", "확정 전에는 커서를 움직이지 않는다");
    confirmForTest(root, join(root, SPEC));
    const after = loadActive(root)!;
    assert.deepEqual([after.phase, after.branch, after.baseCommit], ["analysis", before.branch, before.baseCommit]);
    assert.notEqual(after.request!.hash, before.request!.hash);
    for (const doc of ["01-requirements.md", "02-analysis.md", "03-design.md", "04-functional.md"]) assert.ok(existsSync(join(root, DIR, doc)), doc);
    const [event] = applied(root);
    assert.deepEqual([event.detail?.from, event.detail?.to, event.detail?.rewound], ["plan", "analysis", true]);
    assert.match(start(root, join(root, SPEC)), /^이미 진행 중입니다: PLAN-1 · 요구사항 분석\n\n/);
    // 분석 게이트가 새 항목의 추적을 요구한다 — 같은 개정으로는 다시 되감지 않는다
    assert.throws(() => next(root), /REQ-2/);
    assert.equal(loadActive(root)!.phase, "analysis");
    assert.equal(applied(root).length, 1);
  });

  test("따르던 기록이 없는 커서(이 기능 전 작업)는 첫 진행에서 지금 확정본을 기록만 하고, 머리말만 바뀐 개정은 되감지 않는다", () => {
    throughDesign();
    const { request: _none, ...legacy } = loadActive(root)!;
    saveActive(root, legacy);
    assert.throws(() => next(root));
    assert.equal(loadActive(root)!.phase, "plan");
    assert.ok(loadActive(root)!.request, "지금 확정본을 기록한다");
    assert.equal(applied(root).length, 0);
    write(SPEC, readFileSync(join(root, SPEC), "utf8").replace("title: 값 반환", "title: 값 반환 — 고침"));
    confirmForTest(root, join(root, SPEC));
    assert.equal(loadActive(root)!.phase, "plan");
    const [event] = applied(root);
    assert.deepEqual([event.detail?.rewound, event.reason], [false, "바뀐 요구 확정 — 요구 항목은 그대로"]);
  });
});

describe("동의 흐름 — 렌더한 지시서의 변경안", () => {
  function consentRepo(run: (repo: string) => void | Promise<void>): () => Promise<void> {
    return async () => {
      const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-revision-flow-")));
      try { setupConsentProject(repo); await run(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
    };
  }
  function amend(repo: string, said: string, text: string): string {
    const draft = `doc/work/${CONSENT_WORK_ID}/request.json`;
    const { requirements: _listed, ...request } = JSON.parse(readFileSync(join(repo, draft), "utf8"));
    writeFixture(repo, draft, JSON.stringify({ ...request, original: said, revision: { parent: 1, mode: "amend" },
      changes: [{ op: "add", section: "REQ", text }], sourceMap: [{ quote: said, targets: ["REQ-3"] }] }));
    return requestSubmit(repo, join(repo, draft));
  }

  test("리뷰 중 추가 요구 — 변경안 대기 중에는 진행을 멈추고, 확정하면 분석으로 되감아 코드·브랜치를 보존하며 확정 결과에 바뀐 요구가 보인다", consentRepo(async (repo) => {
    await prepareReviewFixture(repo);
    const before = loadActive(repo)!;
    assert.deepEqual([before.phase, before.request?.revision], ["review", 1]);
    const code = readFileSync(join(repo, "src/value.js"), "utf8");
    assert.match(amend(repo, "0이면 0을 반환해 주세요.", "0이면 0을 반환한다."), /개정 2\(부모 1 · 추가 1\)/);
    assert.throws(() => next(repo), /변경안 개정 2\(부모 1 · 추가 1\)이 확정을 기다립니다/);
    assert.match(status(repo), /요구사항: 변경안 확정 대기 — 개정 2\(부모 1 · 추가 1\)/);
    const { result } = approveAndApplyFixture(repo, { action: "request", id: CONSENT_WORK_ID });
    assert.match(result, /요구 변경안을 개정 2 으로 확정했습니다[\s\S]*요구 개정 2 확정 — 흐름을 코드 리뷰 에서 요구사항 분석 으로 되감았습니다 \(따르던 개정 1\)[\s\S]*추가 \[REQ-3\] 0이면 0을 반환한다\./);
    const after = loadActive(repo)!;
    assert.deepEqual([after.phase, after.branch, after.baseCommit, after.request?.revision, after.stage, after.task], ["analysis", before.branch, before.baseCommit, 2, undefined, undefined]);
    assert.equal(readFileSync(join(repo, "src/value.js"), "utf8"), code, "구현 결과를 그대로 둔다");
    assert.match(status(repo), /요구사항: 확정됨 \(개정 2 · /);
    const [event] = applied(repo);
    assert.deepEqual([event.revision, event.detail?.previous, event.detail?.changes, event.detail?.conservative], [2, 1, "추가 1", true]);
    assert.match(after.request!.impacts!.at(-1)!.conservative.join(" "), /새 항목 REQ-3/, "새 항목은 범위를 입증하지 못해 전체로 본다");
  }));

  test("리뷰 중 권한 요구 수정 — 흐름이 개정을 따르며 바뀐 항목의 R·Task·AC·TC·파일과 보안 영향을 커서·사건·status 에 남긴다", consentRepo(async (repo) => {
    await prepareReviewFixture(repo);
    const draft = `doc/work/${CONSENT_WORK_ID}/request.json`;
    const { requirements: _listed, ...request } = JSON.parse(readFileSync(join(repo, draft), "utf8"));
    const said = "JWT 로 인증된 사용자에게만 값 1을 반환해 주세요.";
    writeFixture(repo, draft, JSON.stringify({ ...request, original: said, revision: { parent: 1, mode: "amend" },
      changes: [{ op: "modify", id: "REQ-1", text: "JWT 로 인증된 사용자에게만 값 1을 반환한다." }], sourceMap: [{ quote: said, targets: ["REQ-1"] }] }));
    requestSubmit(repo, join(repo, draft));
    const { result } = approveAndApplyFixture(repo, { action: "request", id: CONSENT_WORK_ID });
    assert.match(result, /영향 — 요구 개정 2: 항목 REQ-1 · R R1 · Task T1, T2 · TC 1개 · 파일 2개 · 보안 영향\(인증·JWT·토큰\)/);
    const impact = loadActive(repo)!.request!.impacts!.at(-1)!;
    assert.deepEqual([impact.items, impact.requirements, impact.tasks, impact.acceptance, impact.cases, impact.files, impact.security, impact.conservative],
      [["REQ-1"], ["R1"], ["T1", "T2"], ["AC-R1-1"], ["TC-1"], ["src/value.js", "tests/value.test.js"], ["인증", "JWT·토큰"], []]);
    const [event] = applied(repo);
    assert.deepEqual([event.detail?.security, event.detail?.impactFiles, event.detail?.conservative], [true, 2, false]);
    assert.match(status(repo), /요구 변경 영향 — 요구 개정 2: 항목 REQ-1[\s\S]*- AC: AC-R1-1[\s\S]*- TC: TC-1/);
    assert.deepEqual(stateView(repo).request?.impact?.files, ["src/value.js", "tests/value.test.js"]);
  }));

  test("계획 승인 응답이 적용되기 전에 요구 변경안이 확정되면 그 승인은 적용되지 않는다", consentRepo((repo) => {
    preparePlanFixture(repo);
    const approval = prepareConsentFixture(repo, { action: "plan" });
    observeConsentFixture(approval);
    amend(repo, "0이면 0을 반환해 주세요.", "0이면 0을 반환한다.");
    approveAndApplyFixture(repo, { action: "request", id: CONSENT_WORK_ID });
    assert.equal(loadActive(repo)!.phase, "analysis");
    assert.throws(() => applyConsent(repo, approval.id));
    assert.notEqual(approvalOf(loadWork(repo)!).status, "approved");
    assert.ok(existsSync(join(repo, CONSENT_SPEC)));
  }));

  test("반영한 ID — 같은 요구로는 다시 시작하지 않고, 후속 변경안을 확정하면 반영 커밋을 기준으로 새 실행 회차를 연다(이전 회차의 변경·증거를 세지 않는다)", consentRepo(async (repo) => {
    await prepareDeliveryFixture(repo);
    assert.match(approveAndApplyFixture(repo, { action: "deliver" }).result, /반영했습니다/);
    const delivered = gitFixture(repo, "rev-parse", "HEAD");
    assert.ok(gitFixture(repo, "show", "--name-only", "--format=", "HEAD").split("\n").includes(cyclesFile(CONSENT_WORK_ID)), "회차 기록은 반영 커밋에 들어간다");
    assert.equal(loadActive(repo), undefined);
    assert.throws(() => startWork(repo, join(repo, CONSENT_SPEC)), /이 요구로 이미 반영했습니다 \(회차 1, 반영 커밋 [0-9a-f]{12}\)/);
    assert.deepEqual([gitFixture(repo, "rev-parse", "HEAD"), loadActive(repo)], [delivered, undefined]);

    assert.match(requestBegin(repo, CONSENT_WORK_ID, "feature"), /회차 1 에서 반영했습니다 \(커밋 [0-9a-f]{12}\) — [^\n]*실행 회차 2 로 시작합니다/);
    amend(repo, "0이면 0을 반환해 주세요.", "0이면 0을 반환한다.");
    const confirm = prepareConsentFixture(repo, { action: "request", id: CONSENT_WORK_ID });
    assert.match(confirmationText(confirm), /확정을 적용하면 실행 회차 2 로 작업을 시작합니다 — 이미 있는 작업 브랜치 feature\/CONSENT-1 로 전환하고/);
    observeConsentFixture(confirm);
    const finished = JSON.parse(finishConsent(repo, confirm.id));
    assert.match(finished.started, /실행 회차 2 를 엽니다 — 회차 1 반영 커밋 [0-9a-f]{12} 뒤의 변경만 이번 회차의 변경입니다/);
    const active = loadActive(repo)!;
    assert.deepEqual([active.phase, active.baseCommit, active.cycle, active.request?.revision], ["analysis", delivered, { number: 2, delivered, revision: 1 }, 2]);
    assert.deepEqual(changedPaths(repo, delivered).filter((change) => /^(src|tests)\//.test(change.path)), [], "이전 회차의 구현은 이번 회차의 변경이 아니다");
    const view = stateView(repo);
    assert.deepEqual([view.work?.cycle, view.request?.revision, view.request?.followed], [active.cycle, 2, 2]);
    assert.notEqual(view.verification?.bound.valid, true, "이전 회차의 증거는 새 기준 커밋에 묶이지 않는다");
    const text = status(repo);
    assert.match(text, /흐름이 따르는 개정: 2 — 변경 추가 1\n {2}- 추가 \[REQ-3\] 0이면 0을 반환한다\./);
    assert.match(text, /실행 회차: 2 \(회차 1 반영 커밋 [0-9a-f]{12} · 개정 1\)/);
    const opened = readTimeline(repo).filter((event) => event.type === "cycle.opened");
    assert.deepEqual(opened.map((event) => [event.workId, event.cycle, event.revision, event.phase]), [[CONSENT_WORK_ID, 2, 2, "analysis"]]);
  }));
});

describe("이전 회차 찾기", () => {
  test("커밋된 회차 기록을 읽고, 기록 전 반영은 반영 커밋 제목으로 찾는다 — 비슷한 ID·커밋하지 않은 기록은 회차가 아니다", () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-cycles-")));
    try {
      const git = (...args: string[]) => gitFixture(repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args);
      const spec = "doc/work/W-1/requirement.md";
      git("init", "-q", "-b", "master");
      writeFixture(repo, spec, "요구 1\r\n");
      git("add", "-A"); git("commit", "-q", "-m", "준비");
      assert.equal(deliveredCycle(repo, "W-1", spec, "HEAD"), undefined);
      writeFixture(repo, "doc/work/W-10/requirement.md", "다른 작업\n");
      git("add", "-A"); git("commit", "-q", "-m", "[W-10] 다른 작업");
      assert.equal(deliveredCycle(repo, "W-1", spec, "HEAD"), undefined, "W-10 의 반영은 W-1 이 아니다");
      writeFixture(repo, "doc/work/W-1/10-pr.md", "PR\n");
      git("add", "-A"); git("commit", "-q", "-m", "[W-1] 값 반환");
      const legacy = gitFixture(repo, "rev-parse", "HEAD");
      assert.deepEqual(deliveredCycle(repo, "W-1", spec, "HEAD"), { commit: legacy, cycle: 1, requestHash: textHash("요구 1\n") });
      const active = { id: "W-1", spec, target: "value", phase: "deliver" as const, cycle: { number: 2, delivered: legacy }, request: { hash: "h", items: "i", revision: 3 } };
      recordDeliveredCycle(repo, active, { requestHash: "a", baseCommit: legacy, treeHash: "t" });
      assert.equal(deliveredCycle(repo, "W-1", spec, "HEAD")?.commit, legacy, "커밋하지 않은 회차 기록은 읽지 않는다");
      writeFixture(repo, spec, "요구 2\n");
      recordDeliveredCycle(repo, active, { requestHash: "b", baseCommit: legacy, treeHash: "t" });
      git("add", "-A"); git("commit", "-q", "-m", "[W-1] 값 반환 — 회차 2");
      const cycles = JSON.parse(readFileSync(join(repo, cyclesFile("W-1")), "utf8")).cycles;
      assert.deepEqual(cycles.map((record: { cycle: number; requestHash: string }) => [record.cycle, record.requestHash]), [[2, "b"]], "같은 회차를 다시 반영하면 그 줄을 바꾼다");
      assert.deepEqual(deliveredCycle(repo, "W-1", spec, "HEAD"), { commit: gitFixture(repo, "rev-parse", "HEAD"), cycle: 2, revision: 3, requestHash: textHash("요구 2\n") });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
