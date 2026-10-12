/**
 * 단계 전이·CLI 안내·반영 범위(C4) — deliver 의 쓰기·되감기(FLOW-02), 승인 무효의 재진입(FLOW-03), start 사전 검사(FLOW-07),
 * 작업당 대상 하나(FLOW-08), 준비 동의 선택(FLOW-09), doctor 허용(FLOW-10), 관찰 흐름·검증의 `다음:`(FLOW-12),
 * 처리 주체 없는 상태(FLOW-13), approve·reject·confirm 인자(FLOW-17), 반영 커밋의 handoff·staging·잠금 제외(PVR-7).
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { abort, back, decide as decideApproval, next, requireValidatable, start as startUnconfirmed, status, Stop } from "../agent/commands";
import { prepareConsent } from "../agent/consent";
import { commitDelivery, deliver, deliveryPathspecs, isDeliveryExcluded } from "../agent/deliver";
import { docsBegin, docsEnd } from "../agent/docsCommands";
import { bindingProblems, loadEvidence } from "../agent/evidence";
import { contextHandoff } from "../agent/handoff";
import { decide } from "../agent/hook";
import { loadActive, saveActive } from "../agent/layout";
import { preparationHint, recordRequestDecision, requestBegin, requestSubmit, startBlockers } from "../agent/request";
import { reentryHint } from "../agent/reentry";
import { decideStop } from "../agent/stopHook";
import { withInteraction } from "../agent/tty";
import { check } from "../agent/validate";
import { update } from "../agent/update";
import { verify, verificationFlowFile, type VerificationHistory } from "../agent/verificationFlow";
import { approvalOf, loadWork, type Work } from "../agent/work";
import { confirmForTest, start } from "./confirmedStart";
import {
  approveAndApplyFixture, CONSENT_SPEC, CONSENT_WORK_ID, preparePlanFixture, setupConsentProject, writeFixture,
} from "./consentFixture";
import {
  createStageRepo, DESIGN, FAIL, git, manifest, ORDER, removeStageRepo, repo, toCheck, toDeliver, useManifest, write, writeFileHook, writePr,
} from "./stageFixture";

const SPEC = "doc/work/ORD-1.md";
const PRESENCE = { channel: "tty" as const, verified: true, detail: "테스트" };
const nextLine = (text: string): string => text.split("\n").find((line) => line.startsWith("다음: ")) ?? "";
const bash = (command: string): string | undefined => decide({ cwd: repo, tool_name: "Bash", tool_input: { command } });

beforeEach(() => createStageRepo("ca-stage-"));
afterEach(() => removeStageRepo());

describe("FLOW-02 — deliver 의 쓰기와 되감기", () => {
  test("작업 폴더 밖 쓰기는 거부하고 ⑩·지식 제안은 쓴다", async () => {
    await toDeliver();
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /반영\(deliver\) 단계라 작업 폴더/);
    assert.equal(writeFileHook("doc/work/ORD-1/10-pr.md"), undefined);
    assert.equal(writeFileHook("doc/work/ORD-1/knowledge.proposal.md"), undefined);
    write("anywhere.txt", "도구 밖 변경\n");
    assert.match(decideStop({ cwd: repo }) ?? "", /계획 밖의 변경이 남아 있습니다/, "deliver 도 턴 끝에 알린다");
  });

  test("증거가 맞으면 check 를 다시 돌리지 않고, 사람이 계획 파일을 고치면 check·verify 가 되감는다", async () => {
    await toDeliver();
    assert.throws(() => requireValidatable(repo, "check"), (error: Error) =>
      error instanceof Stop && /지금: deliver/.test(error.message) && /사용자 확인 뒤 code-agent back check/.test(error.message));
    assert.equal(loadActive(repo)!.phase, "deliver");
    write(`${ORDER}/domain/Order.java`, "class Order { int fixed; }\n");
    const result = await verify(repo);
    const history = JSON.parse(readFileSync(verificationFlowFile(loadWork(repo)!), "utf8")) as VerificationHistory;
    assert.equal(history.attempts.at(-1)!.events[0].node, "check.execute");
    assert.equal(result.node, "review");
  });

  test("증거가 깨진 deliver 에서는 requireValidatable(check) 가 되감는다", async () => {
    await toDeliver();
    write(`${ORDER}/domain/Order.java`, "class Order { int changed; }\n");
    requireValidatable(repo, "check");
    assert.equal(loadActive(repo)!.phase, "check");
  });

  test("증거가 깨진 deliver 의 다음: 은 반영 동의가 아니라 verify 로 되감는 길이다", async () => {
    await toDeliver();
    assert.match(nextLine(status(repo)), /ca-answer의 deliver 동의 절차로 확인하고 반영합니다/);
    write(`${ORDER}/domain/Order.java`, "class Order { int changed; }\n");
    const line = nextLine(status(repo));
    assert.match(line, /^다음: \/ca-check \(또는 \/ca-next 로 사이클\) — 반영할 트리가 검증 뒤 바뀌었습니다[\s\S]*code-agent verify --json 이 check 로 되감아 다시 검증합니다/);
    assert.doesNotMatch(line, /deliver 동의/);
    assert.equal(loadActive(repo)!.phase, "deliver", "status 는 커서를 옮기지 않는다");
  });

  test("back 은 deliver 에서도 되감고 반영 동의 무효를 알린다", async () => {
    await toDeliver();
    assert.match(back(repo, "check"), /반영 확인\(deliver 동의\)을 준비해 두었다면/);
    assert.equal(loadActive(repo)!.phase, "check");
  });

  test("확인하는 동안 커서가 바뀌면 커밋하지 않는다", async () => {
    await toDeliver();
    writePr();
    const head = git("rev-parse", "HEAD");
    const work = requireValidatable(repo, "deliver");
    assert.throws(() => withInteraction({
      confirm: () => { saveActive(repo, { ...loadActive(repo)!, phase: "check" }); return PRESENCE; },
      ask: () => "n",
    }, () => deliver(work)), /확인하는 동안 작업 커서가 바뀌었습니다/);
    assert.equal(git("rev-parse", "HEAD"), head);
  });
});

describe("FLOW-03 — 승인 무효의 재진입", () => {
  test("옛 흐름 stale-docs: 두 갈래 안내, 그 자리 재승인은 증거를 그대로 쓴다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    write("doc/work/ORD-1/03-design.md", `${DESIGN}\n- 추가 결정\n`);
    assert.equal(approvalOf(loadWork(repo)!).status, "stale-docs");
    const line = nextLine(status(repo));
    for (const part of ["승인 무효(stale-docs", "계획을 바꿔야 하면", "code-agent back plan", "계획이 그대로면: 지금 자리에서", "plan 동의"]) assert.ok(line.includes(part), part);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /승인되지 않았습니다 \(stale-docs\)\. 승인 무효\(stale-docs[\s\S]*계획이 그대로면/);
    assert.throws(() => requireValidatable(repo, "check"), /승인되지 않았습니다 \(stale-docs\)[\s\S]*승인 무효\(stale-docs/);
    // 계획이 그대로인 갈래 — 커서를 옮기지 않고 그 자리에서 다시 승인한다
    withInteraction({ confirm: () => PRESENCE, ask: () => "" }, () => decideApproval(repo, "approved"));
    const work = loadWork(repo)!;
    assert.equal(approvalOf(work).status, "approved");
    assert.equal(work.active.phase, "check");
    assert.deepEqual(bindingProblems(work, loadEvidence(repo, "ORD-1", "order")!), [], "증거 묶임은 문서 해시를 보지 않는다");
  });

  test("next 도 check·test·review 에서 승인 무효면 게이트 목록보다 먼저 같은 재진입 문장으로 멈춘다", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    write("doc/work/ORD-1/03-design.md", `${DESIGN}\n- 추가 결정\n`);
    const expected = `계획이 승인되지 않았습니다 (stale-docs). ${reentryHint(loadWork(repo)!)}`;
    for (const phase of ["check", "test", "review"] as const) {
      saveActive(repo, { ...loadActive(repo)!, phase });
      assert.throws(() => next(repo), (error: Error) => error.message === expected && !/로 다시 돌리세요|리뷰 회차가 없습니다/.test(error.message), phase);
      assert.equal(loadActive(repo)!.phase, phase);
    }
  });

  test("옛 흐름 stale-manifest·unverified 는 그 자리 재승인만 안내한다", () => {
    toCheck();
    write("code-agent.json", manifest({ environmentErrors: ["ENV-DOWN"] }));
    const line = nextLine(status(repo));
    assert.match(line, /승인 무효\(stale-manifest[\s\S]*지금 자리에서 현재 호스트 세션에서 ca-answer의 plan 동의 절차/);
    assert.doesNotMatch(line, /code-agent back/);
    const work = loadWork(repo)!;
    const state = approvalOf(work);
    assert.equal(state.status, "stale-manifest");
    const record = (state as Extract<typeof state, { status: "stale-manifest" }>).record;
    assert.match(reentryHint(work, { status: "unverified", record })!, /^승인 무효\(unverified: 승인에 사람이 관측되지 않았습니다\) — 지금 자리에서/);
  });

  test("관찰 흐름: 승인 뒤 지시서가 바뀌면 낡은 계획 작업의 단계로 되감는 순서를 안내한다", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-stage-obs-")));
    try {
      setupConsentProject(root);
      preparePlanFixture(root);
      approveAndApplyFixture(root, { action: "plan" });
      next(root);
      assert.equal(loadActive(root)!.phase, "implement");
      const draft = `doc/work/${CONSENT_WORK_ID}/request.json`;
      const request = JSON.parse(readFileSync(join(root, draft), "utf8"));
      writeFixture(root, draft, JSON.stringify({ ...request, title: "값과 오류 — 고침" }));
      requestSubmit(root, join(root, draft));
      confirmForTest(root, join(root, CONSENT_SPEC));
      const line = nextLine(status(root));
      assert.match(line, /승인 무효\(stale-order/);
      assert.match(line, /code-agent back analysis \(승인 무효의 재진입이라 사용자 지시 없이 되감습니다\)/);
      assert.match(line, /code-agent planning advance[\s\S]*code-agent plan submit[\s\S]*plan 동의/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FLOW-07 — start 전 미커밋 변경", () => {
  beforeEach(() => {
    write("src/current.ts", "export const value = 1;\n");
    git("add", "src/current.ts");
    git("commit", "-qm", "current");
  });

  test("접수는 미리 알리고 start 는 거부한다 — 브랜치·커서는 그대로", () => {
    write("src/current.ts", "export const value = 2;\n");
    write("unrelated-notes.txt", "메모\n");
    assert.match(requestBegin(repo, "ORD-2", "feature"), /시작 전 정리 필요: 커밋하지 않은 변경 2개\(\[M\] src\/current\.ts, \[A\] unrelated-notes\.txt\)/);
    const text = status(repo);
    assert.match(text, /시작 전 정리 필요: \[M\] src\/current\.ts, \[A\] unrelated-notes\.txt — 사람이 커밋·stash 한 뒤 시작합니다/);
    assert.doesNotMatch(nextLine(text), /정리/, "다음: 은 접수 안내 그대로다");
    abort(repo);
    assert.throws(() => start(repo, join(repo, SPEC)), /커밋하지 않은 변경이 있어 시작하지 않았습니다[\s\S]*\[M\] src\/current\.ts[\s\S]*\[A\] unrelated-notes\.txt/);
    assert.equal(git("branch", "--list", "feature/ORD-1"), "");
    assert.equal(loadActive(repo), undefined);
  });

  test("지시서·작업 폴더·.code-agent 는 빼고, 이미 있는 작업 브랜치와 HEAD 없는 저장소는 보지 않는다", () => {
    write("doc/work/ORD-3.md", "---\nkind: feature\nid: ORD-3\ntitle: 새 지시서\ntarget: order\n---\n\n본문\n");
    write("doc/work/ORD-3/request.json", "{}\n");
    write(".code-agent/scratch.json", "{}\n");
    assert.deepEqual(startBlockers(repo, "ORD-3", "doc/work/ORD-3.md"), []);
    assert.match(start(repo, join(repo, "doc/work/ORD-3.md")), /시작했습니다: ORD-3/);
    abort(repo);
    git("switch", "-q", "master");
    rmSync(join(repo, "doc/work/ORD-3.md"));
    rmSync(join(repo, "doc/work/ORD-3"), { recursive: true, force: true });
    git("branch", "feature/ORD-1");
    write("src/current.ts", "export const value = 3;\n");
    assert.match(start(repo, join(repo, SPEC)), /시작했습니다: ORD-1/, "중단 뒤 재시작(브랜치가 이미 있다)은 검사하지 않는다");
    assert.match(status(repo), /계획 밖 변경: \[M\] src\/current\.ts/, "analysis 에서도 계획 밖 변경 줄을 낸다");
    const empty = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-stage-nohead-")));
    try {
      execFileSync("git", ["init", "-q"], { cwd: empty });
      writeFileSync(join(empty, "a.txt"), "x\n");
      assert.deepEqual(startBlockers(empty, "X-1"), []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("FLOW-08 — 작업 하나에 대상 하나", () => {
  test("초안은 대상 하나만 받고, 진행 중이 아닌 다중 대상 지시서는 start 가 거부한다", () => {
    requestBegin(repo, "MULTI-1", "feature");
    write("doc/work/MULTI-1/request.json", JSON.stringify({ kind: "feature", id: "MULTI-1", title: "둘", target: ["a", "b"], original: "x", requirements: ["x"] }));
    assert.throws(() => requestSubmit(repo, join(repo, "doc/work/MULTI-1/request.json")), /target: target 은 하나만 — 대상마다 별도 ID 로 접수합니다/);
    abort(repo);
    const multi = (id: string) => `---\nkind: feature\nid: ${id}\ntitle: 두 대상\ntarget: [a, b]\n---\n\n본문\n`;
    write("doc/work/MULTI-2/requirement.md", multi("MULTI-2"));
    write("doc/work/MULTI-2/request.json", "{}\n");
    assert.throws(() => start(repo, join(repo, "doc/work/MULTI-2/requirement.md")), /대상이 2개입니다\(a, b\)[\s\S]*request\.json 의 target 을 하나로 고쳐/);
    write("doc/work/MULTI-3.md", multi("MULTI-3"));
    assert.throws(() => start(repo, join(repo, "doc/work/MULTI-3.md")), /대상이 2개입니다[\s\S]*지시서 doc\/work\/MULTI-3\.md 의 target 을 하나로 고치고/);
    assert.equal(loadActive(repo), undefined);
    assert.equal(git("branch", "--list", "feature/MULTI-3"), "");
    // 대상 여럿인 지시서로 이미 시작한 작업은 그대로 잇는다
    saveActive(repo, { id: "MULTI-3", spec: "doc/work/MULTI-3.md", target: "a", phase: "analysis" });
    assert.match(start(repo, join(repo, "doc/work/MULTI-3.md")), /이미 진행 중입니다: MULTI-3/);
  });

  test("진행 중인 다중 대상 작업의 재제출은 진행 중인 대상 하나만 남기라고 안내한다", () => {
    write("doc/work/MULTI-4/request.json", JSON.stringify({ kind: "feature", id: "MULTI-4", title: "둘", target: ["a", "b"], original: "x", requirements: ["x"] }));
    saveActive(repo, { id: "MULTI-4", spec: "doc/work/MULTI-4/requirement.md", target: "a", phase: "implement" });
    assert.throws(() => requestSubmit(repo, join(repo, "doc/work/MULTI-4/request.json")), (error: Error) =>
      /target: target 은 하나만/.test(error.message) &&
      /진행 중인 작업\(MULTI-4\)의 요구사항을 고치는 중이면 target 에 진행 중인 대상\(a\) 하나만 남겨 다시 제출합니다/.test(error.message));
    // 다른 작업의 초안·다른 형식 오류에는 붙이지 않는다
    write("doc/work/MULTI-4/request.json", JSON.stringify({ kind: "feature", id: "MULTI-4", title: "", target: ["a"], original: "x", requirements: ["x"] }));
    assert.throws(() => requestSubmit(repo, join(repo, "doc/work/MULTI-4/request.json")), (error: Error) => !/진행 중인 대상/.test(error.message));
  });

  test("--target 은 지시서의 대상과 같아야 한다", () => {
    assert.throws(() => start(repo, join(repo, SPEC), { target: "payment" }), /지시서의 대상이 아닙니다: payment/);
  });
});

describe("FLOW-09 — 준비 단계 안내", () => {
  test("기준 커밋과 문서 상태로 setup·docs·baseline 동의 하나를 고른다", () => {
    const fresh = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-stage-prep-")));
    try {
      setupConsentProject(fresh);
      assert.match(preparationHint(fresh) ?? "", /setup 동의 절차로 공통 문서 확정과 준비 커밋을/, "문서 미확정 + HEAD 없음");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
    // 문서만 — 고친 문서를 커밋했지만 다시 확정하지 않았다
    write("doc/architecture.md", `${readFileSync(join(repo, "doc/architecture.md"), "utf8")}\n- 추가\n`);
    git("add", "-A"); git("commit", "-qm", "doc");
    assert.match(preparationHint(repo) ?? "", /docs 동의 절차로 공통 문서를 확정하고/);
    assert.throws(() => start(repo, join(repo, SPEC)), (error: Error) =>
      /공통 문서의 사람 확정이 필요합니다 — 현재 호스트 세션에서 ca-answer의 docs 동의 절차로 확정합니다 \(최초 준비면 setup/.test(error.message) &&
      !/ca-docs 로 작성하세요/.test(error.message));
    assert.match(status(repo), /같은 세션의 ca-answer docs 동의로 다시 확정 \(직접 CLI: TTY 의 code-agent confirm doc architecture\)/);
    rmSync(join(repo, "doc/quality.md"));
    assert.throws(() => start(repo, join(repo, SPEC)), /\/ca-docs 로 작성하세요/);
    assert.throws(() => start(repo, join(repo, SPEC)), /선택: 문서 작성 \/ 기존 문서 연결 \/ 보류/);
    assert.match(preparationHint(repo) ?? "", /선택: 문서 작성 \/ 기존 문서 연결 \/ 보류/);
  });

  test("기준 커밋만 필요하면 baseline, 문서 세션이 열려 있으면 docs end 부터", () => {
    write("code-agent.json", manifest({ environmentErrors: ["ENV-DOWN-X"] }));
    assert.match(preparationHint(repo) ?? "", /baseline 동의 절차로 준비 커밋\(도입 파일 1개\)을 확인받고[\s\S]*start 가 거부합니다/);
    git("add", "-A"); git("commit", "-qm", "manifest");
    assert.equal(preparationHint(repo), undefined);
    docsBegin(repo);
    assert.match(preparationHint(repo) ?? "", /^code-agent docs end 로 문서 세션을 닫은 뒤/);
    assert.match(nextLine(status(repo)), /code-agent docs end/, "작업·접수 없이 문서 세션만 열려 있으면 그것부터(FLOW-13)");
    assert.doesNotMatch(nextLine(status(repo)), /\/ca-request/);
    docsEnd(repo);
  });
});

describe("FLOW-10 — doctor 는 작업 중에도 조회", () => {
  test("작업·접수 중 doctor [--host] [--cross] 는 열고 연결·다른 인자는 막는다", () => {
    const check = () => {
      for (const command of ["code-agent doctor", "code-agent doctor --host codex", "code-agent doctor --cross", "code-agent doctor --host both --cross", "code-agent doctor --host codex --cross", "code-agent doctor --cross --host codex"]) {
        assert.equal(bash(command), undefined, command);
      }
      for (const command of ["code-agent doctor --fix", "code-agent doctor && git add .", "code-agent doctor --cross; rm x", "code-agent doctor --cross && git add ."]) {
        assert.ok(bash(command), command);
      }
    };
    requestBegin(repo, "ORD-9", "feature");
    check();
    abort(repo);
    toCheck();
    check();
  });
});

describe("FLOW-12 — 관찰 흐름과 검증의 다음:", () => {
  test("관찰 흐름의 문서 칸·계획 칸은 planning advance 를 안내한다", () => {
    start(repo, join(repo, SPEC), { planning: true });
    assert.match(nextLine(status(repo)), /\/ca-analyze \(또는 \/ca-next 로 사이클\) — code-agent planning advance 로 담당을 배정하고/);
    saveActive(repo, { ...loadActive(repo)!, phase: "plan" });
    const line = nextLine(status(repo));
    assert.match(line, /code-agent planning advance 로 계획·검토 담당을 배정하고/);
    assert.doesNotMatch(line, /plan\.json 에 쓰고/);
  });

  test("check·test 의 진입 명령은 verify --json 이고 직전 명령과 무관하게 같다", async () => {
    useManifest({ build: FAIL });
    toCheck();
    assert.match(nextLine(status(repo)), /code-agent verify --json \(전체 흐름 · 단계만 돌릴 때는 code-agent check\)/);
    await check(requireValidatable(repo, "check"));
    const line = nextLine(status(repo));
    assert.match(line, /계획 안에서 고치고 code-agent verify --json/);
    // verify 기록이 있어도(마지막 시도의 실패) 다음: 은 증거로만 정한다
    const file = verificationFlowFile(loadWork(repo)!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, id: "ORD-1", target: "order", attempts: [{ at: new Date().toISOString(), input: {}, events: [],
      result: { node: "diagnose", failure: { class: "environment", at: new Date().toISOString(), detail: "x" } } }] }));
    assert.equal(nextLine(status(repo)), line);
  });
});

describe("FLOW-13 — 처리 주체가 없는 상태", () => {
  test("AI-DLC 가 진행 중이면 다음: 은 그 안내 하나다", () => {
    write("aidlc-docs/aidlc-state.md", "**Status**: Running\n");
    assert.match(nextLine(status(repo)), /^다음: AI-DLC 작업이 진행 중이라 code-agent 를 진행하지 않습니다/);
    rmSync(join(repo, "aidlc-docs"), { recursive: true, force: true });
    toCheck();
    write("aidlc-docs/aidlc-state.md", "**Status**: Running\n");
    assert.match(nextLine(status(repo)), /^다음: AI-DLC 작업이 진행 중이라/);
  });

  test("매니페스트 없이 문서 세션만 열렸으면(ca-adopt 도중) 막히는 접수가 아니라 ca-adopt 로 잇는다", () => {
    const bare = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-stage-adopt-")));
    try {
      assert.match(nextLine(status(bare)), /^다음: \/ca-request <요구사항> 으로 접수/);
      docsBegin(bare);
      const line = nextLine(status(bare));
      assert.equal(line, "다음: /ca-adopt 로 설정(code-agent.json)·공통 문서를 마저 준비합니다 — 문서 세션이 열려 있습니다. 다 쓰면 code-agent docs end");
      assert.throws(() => requestBegin(bare, undefined, "feature"), /문서 작성 세션이 열려 있습니다/, "그 안내가 가리키면 막히는 명령이었다");
      assert.equal(preparationHint(bare), line.slice("다음: ".length), "접수 안내(preparationHint)도 같은 자리를 가리킨다");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("FLOW-17 — approve·reject·confirm 의 남는 인자", () => {
  const cli = join(__dirname, "..", "agent", "cli.js");
  const run = (...args: string[]) => {
    const env = { ...process.env };
    for (const key of ["CLAUDECODE", "CODEX_CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "CODE_AGENT_HOST", "CODE_AGENT_CROSS", "CLAUDE_PROJECT_DIR"]) delete env[key];
    return spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" });
  };
  test("사용법 오류로 거부한다", () => {
    const request = run("approve", "request", "X");
    assert.equal(request.status, 1);
    assert.match(request.stderr, /요구사항 확정은 code-agent confirm request <ID> \[<지시서>\] 입니다/);
    assert.match(run("approve", "extra").stderr, /사용법: code-agent approve \[--comment <메모>\] — 받지 않는 인자: extra/);
    assert.match(run("reject", "foo").stderr, /사용법: code-agent reject --comment <사유>/);
    assert.match(run("reject", "request", "X", "a.md", "b").stderr, /받지 않는 인자: b/);
    assert.match(run("confirm").stderr, /code-agent confirm request <ID> \[<지시서>\]/);
    assert.match(run("confirm", "request", "X", "a.md", "b").stderr, /받지 않는 인자: b/);
    assert.match(run("takeover", "x").stderr, /사용법: code-agent takeover/);
  });
});

describe("update --templates-only — 진행 중인 작업의 설치 파일 변경", () => {
  test("갱신이 만든 계획 밖 변경만 알리고 길을 보인다(막지는 않는다)", () => {
    toCheck();
    write("notes.txt", "갱신 전부터 있던 변경\n");
    const report = update(repo);
    const notice = report.split("!! 이번 갱신이 바꾼 설치 파일이")[1] ?? "";
    assert.match(notice, /^ 진행 중인 작업\(ORD-1 · check\)의 계획 밖 변경이 됐습니다: /);
    assert.match(notice, /커밋해도 풀리지 않습니다[\s\S]*작업을 반영하거나 끝낸 뒤 다시 갱신합니다/);
    assert.doesNotMatch(notice, /notes\.txt/, "갱신 전부터 있던 변경은 이 갱신 탓이 아니다");
    assert.match(status(repo), /계획 밖 변경: [^\n]*\.gitignore/);
    assert.doesNotMatch(update(repo), /이번 갱신이 바꾼 설치 파일/, "새로 생긴 것이 없으면 알리지 않는다");
  });
});

describe("PVR-7 — 반영 커밋의 handoff·staging·잠금 파일", () => {
  test("커밋에서 빼고, 작업 트리에는 남기며, hook 이 더한 것은 드러낸다", async () => {
    await toDeliver();
    writePr();
    contextHandoff(repo);
    write("doc/work/ORD-1/.staging/x/02-analysis.md", "임시\n");
    write("doc/work/ORD-1/.staging/y.md", "hook 이 더한다\n");
    write(".code-agent/work/ORD-1/order.review.json.lock", "{}");
    write(".code-agent/work/ORD-1/order.planning.json.lock", "{}");
    write(".code-agent/work/ORD-1/sub/keep.lock", "남는다\n");
    const work = loadWork(repo)!;
    assert.ok(isDeliveryExcluded(work, ".code-agent/work/ORD-1/handoff/context.md"));
    assert.ok(isDeliveryExcluded(work, ".code-agent/work/ORD-1/order.review.json.lock"));
    assert.ok(!isDeliveryExcluded(work, ".code-agent/work/ORD-1/sub/keep.lock"));
    assert.ok(!isDeliveryExcluded(work, "src/x.lock"), "계획 파일 이름의 .lock 은 반영한다");
    // 동의 미리보기의 커밋 대상 목록도 같은 규칙
    const full = JSON.parse(prepareConsent(repo, { action: "deliver" })).summary as string;
    // 커밋 대상 목록 절만 본다(⑩ 의 변경 요약은 기준 커밋과의 차이 전부를 보인다)
    const summary = full.slice(full.indexOf("커밋 대상"), full.indexOf("\n\n", full.indexOf("커밋 대상")));
    assert.doesNotMatch(summary, /handoff\/|\.staging\/|json\.lock/);
    assert.match(summary, /order\.verify\.json/);
    // pre-commit hook 이 staging 을 강제로 더하면 반영 목록 밖으로 드러난다
    write(".git/hooks/pre-commit", "#!/bin/sh\ngit add -f doc/work/ORD-1/.staging/y.md\n");
    chmodSync(join(repo, ".git/hooks/pre-commit"), 0o755);
    const { outside } = commitDelivery(work, loadEvidence(repo, "ORD-1", "order")!, []);
    const committed = git("show", "--name-only", "--format=", "HEAD").split("\n");
    assert.ok(committed.includes(".code-agent/work/ORD-1/order.verify.json"));
    assert.ok(committed.includes(".code-agent/work/ORD-1/sub/keep.lock"));
    for (const path of [".code-agent/work/ORD-1/handoff/context.md", "doc/work/ORD-1/.staging/x/02-analysis.md",
      ".code-agent/work/ORD-1/order.review.json.lock", ".code-agent/work/ORD-1/order.planning.json.lock"]) {
      assert.ok(!committed.includes(path), path);
      assert.ok(existsSync(join(repo, path)), `${path} 는 작업 트리에 남는다`);
    }
    assert.deepEqual(outside, ["doc/work/ORD-1/.staging/y.md"]);
  });

  test("글롭 문자가 든 작업 ID 의 잠금 파일도 뺀다", () => {
    const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-stage-glob-")));
    try {
      const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: scratch, encoding: "utf8" });
      run("init", "-q");
      const dir = join(scratch, ".code-agent", "work", "W[1]");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "o.review.json.lock"), "{}");
      writeFileSync(join(dir, "o.verify.json"), "{}");
      run("add", "-f", "--", ...deliveryPathspecs({ active: { id: "W[1]" } } as Work, [".code-agent/work/W[1]"]));
      const indexed = run("ls-files").split("\n").filter(Boolean);
      assert.deepEqual(indexed, [".code-agent/work/W[1]/o.verify.json"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("start — 예전 사용법", () => {
  test("확정되지 않은 지시서는 사전 검사 전에 거부한다", () => {
    assert.throws(() => startUnconfirmed(repo, join(repo, SPEC)), /요구사항이 확정되지 않았습니다/);
    recordRequestDecision(repo, { id: "ORD-1", spec: SPEC, decision: "confirmed", approver: "t", presence: PRESENCE });
    assert.match(startUnconfirmed(repo, join(repo, SPEC)), /시작했습니다: ORD-1/);
  });
});
