/**
 * 전체 검토(ff13950..934e5fe) 반영 — 지적마다 되돌리면 실패하는 회귀 시험. 지적 번호는 doc/reviews/2026-10-08-full-review.md 의 표다.
 * 임시 git 저장소(stageFixture — 주문 도메인 ORD-1)에 실제 함수를 그대로 부른다. 모델·호스트는 부르지 않는다.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { next, requireValidatable, status } from "../agent/commands";
import { finishConsent, prepareConsent } from "../agent/consent";
import { check, integrate, patchEvidence, runTests } from "../agent/validate";
import { loadEvidence, validationDocFile, verifyView } from "../agent/evidence";
import { loadActive, reviewFile } from "../agent/layout";
import { loadReview, openRound } from "../agent/review";
import { budgetReport, grantRetry } from "../agent/retryGrant";
import { RetryRefused, verifyRetryOf } from "../agent/retryPolicy";
import { verify } from "../agent/verificationFlow";
import { deliver, proseSectionLines, PROSE_SHOWN_LIMIT } from "../agent/deliver";
import { withInteraction } from "../agent/tty";
import { loadWork } from "../agent/work";
import { decide } from "../agent/hook";
import { init } from "../agent/init";
import { decideStop } from "../agent/stopHook";
import { createStageRepo, NOT_INSTALLED, git, ORDER, removeStageRepo, repo, toCheck, toDeliver, toIntegrate, toReview, useManifest, write, writeFileHook, writeFindings, writePr } from "./stageFixture";
import { observeConsentFixture } from "./consentFixture";
import { randomUUID } from "node:crypto";

const PRESENCE = { channel: "tty" as const, verified: true, detail: "테스트" };
const nextLine = (text: string): string => text.split("\n").find((line) => line.startsWith("다음: ")) ?? "";

beforeEach(() => createStageRepo("ca-full-review-"));
afterEach(() => removeStageRepo());

describe("E1 — 진단 노드의 다음: 은 verify 결과의 재개 명령과 같다", () => {
  test("test 커서에서 환경 오류로 진단이면 다음: 은 verify --retry 이고, 그 명령이 test 를 다시 돌린다", async () => {
    useManifest({ test: NOT_INSTALLED });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    await runTests(requireValidatable(repo, "test")).catch(() => undefined);
    const line = nextLine(status(repo));
    assert.match(line, /원인을 확인하고 code-agent verify --json --retry \(/, line);
    const plain = await verify(repo);
    assert.equal(plain.node, "diagnose");
    assert.equal(plain.resume, "code-agent verify --retry");
    assert.equal(plain.budget?.rerun.used, 0, "--retry 없는 verify 는 test 를 다시 돌리지 않는다 — 그래서 다음: 이 --retry 를 가리켜야 한다");
    const retried = await verify(repo, { retry: true });
    assert.equal(retried.budget?.rerun.used, 1, "--retry 가 같은 회차를 다시 돈다");
  });
});

describe("E2 — 진행 중 작업의 모델 변경은 계획 밖 변경이 된다고 알린다(근본 처리는 사용자 결정)", () => {
  test("작업이 있으면 동의 요약·적용 뒤 next 에 경고가 붙고, 작업이 없으면 붙지 않는다", () => {
    write(".claude/agents/ca-writer.md", "---\nname: ca-writer\nmodel: sonnet\neffort: medium\n---\n본문\n");
    const idle = JSON.parse(prepareConsent(repo, { action: "model", host: "claude", agent: "writer", model: "opus" })) as { summary: string };
    assert.doesNotMatch(idle.summary, /진행 중인 작업/);
    git("add", "-A");
    git("commit", "-qm", "agents");
    toCheck();
    const prepared = JSON.parse(prepareConsent(repo, { action: "model", host: "claude", agent: "writer", model: "opus" }));
    assert.match(prepared.summary, /진행 중인 작업 ORD-1\(check\)이 있습니다 — 에이전트 정의 파일[\s\S]*계획 밖 변경이 되고 검증·반영이 막힙니다/);
    observeConsentFixture({ root: repo, ...prepared, sessionId: `s-${randomUUID()}`, toolUseId: `t-${randomUUID()}` });
    const applied = JSON.parse(finishConsent(repo, prepared.id)) as { next: string };
    assert.match(applied.next, /^결과를 보고한다 — 새 모델은 호스트를 다시 시작한 뒤 적용된다\. 주의: 진행 중인 작업 ORD-1/);
  });
});


describe("E7 — 반영 확인 화면에 모델이 쓴 PR 본문 구역이 실린다", () => {
  test("요약·확인 방법·위험·되돌리기 본문이 코드 구역 앞에 보이고, 너무 길면 자른 사실을 적는다", async () => {
    await toDeliver();
    writePr();
    let shown = "";
    withInteraction({ confirm: (text) => { shown = text; return PRESENCE; }, ask: () => "n" }, () => deliver(loadWork(repo)!));
    assert.match(shown, /## 요약\n\n주문 도메인을 더했다\.\n\n## 확인 방법\n\nOrderRepository 를 부른다\.\n\n## 위험·되돌리기\n\n없음 — 새 도메인이라/);
    assert.ok(shown.indexOf("## 요약") < shown.indexOf("## 추적표"), "PR 본문 구역이 코드 구역 앞이다");
    const long = proseSectionLines(`## 요약\n${"가".repeat(PROSE_SHOWN_LIMIT + 50)}\n## 확인 방법\nx\n`, "doc/work/ORD-1/10-pr.md");
    assert.match(long[0], /… \(확인 화면에서 \d+자를 잘랐습니다 — 전문은 doc\/work\/ORD-1\/10-pr\.md\)$/);
  });
});

describe("E8 — 사람이 늘린 한도(judgment retry-grant)가 반영 산출물에 드러난다", () => {
  test("⑧ 사람 허용 절, ⑩ 검증 절의 사람 판단 줄, 커밋 메시지의 사람 판단 줄", async () => {
    await toDeliver();
    writePr();
    const work = loadWork(repo)!;
    patchEvidence(work, (disk) => {
      disk.retry = { ...verifyRetryOf(disk), grants: [{ key: "rerun", scope: "round:1", step: 1, consent: "08eea91f-0000-0000-0000-000000000000", at: "t", reason: "DB 를 다시 띄웠다" }] };
    });
    assert.match(readFileSync(join(repo, validationDocFile("ORD-1")), "utf8"), /## 사람 허용\n\n- 같은 코드 재실행 \+1 \(1회차\) — DB 를 다시 띄웠다 · 동의 08eea91f/);
    let shown = "";
    withInteraction({ confirm: (text) => { shown = text; return PRESENCE; }, ask: () => "n" }, () => deliver(loadWork(repo)!));
    assert.match(shown, /- 사람 판단: 한도 허용\(검증\) — 같은 코드 재실행 \+1 \(1회차\) — DB 를 다시 띄웠다 · 동의 08eea91f/);
    assert.match(git("log", "-1", "--format=%B"), /^사람 판단: 한도 허용 같은 코드 재실행 \+1$/m);
  });
});

describe("E13·E14·E10 — 통과 뒤 변경은 리뷰 회차를 쓰고, 그 한도는 검증 단계에서 사람이 늘린다", () => {
  const change = (n: number) => write(`${ORDER}/domain/Order.java`, `class Order { int v${n}; }\n`);
  const refusedBy = (key: string, origin: string) => (error: unknown) =>
    error instanceof RetryRefused && error.failure.counter?.key === key && error.failure.origin === origin;

  test("리뷰 없이 '통과 → 수정 → check' 를 되풀이하면 총 회차가 아니라 리뷰 회차 한도에서 막힌다(E13)", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    for (let n = 1; n <= 3; n++) { change(n); await check(requireValidatable(repo, "check")); }
    change(4);
    await assert.rejects(check(requireValidatable(repo, "check")), refusedBy("reviewRounds", "code-defect"));
    assert.equal(verifyView(loadWork(repo)!, loadEvidence(repo, "ORD-1", "order")!).budget.totalRounds.used, 4, "총 회차 7 에 닿기 전이다");
    // 허용은 리뷰 기록에 남는데 리뷰를 연 적이 없다 — 미리보기가 되돌리는 길을 안내한다
    assert.throws(() => budgetReport(repo, "reviewRounds"), /리뷰 회차를 연 기록이 없습니다[\s\S]*사람이 되돌려/);
    // hook 은 계획 파일 쓰기를 리뷰 회차 문구로 막는다
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /리뷰 회차 한도 3회를 모두 써서 계획 파일을 더 고칠 수 없습니다/);
  });

  test("리뷰를 연 뒤에도 같은 예산이고, 커서가 check 로 되감긴 뒤에도 사람 허용을 받는다(E14) — 다음: 에 사람 선택지가 있다(E10)", async () => {
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    for (let n = 1; n <= 3; n++) { change(n); await check(requireValidatable(repo, "check")); }
    change(4);
    await assert.rejects(check(requireValidatable(repo, "check")), refusedBy("reviewRounds", "code-defect"), "열린 지적이 없으면 원래 원인을 차단 지적으로 두지 않는다");
    assert.equal(loadActive(repo)!.phase, "check");
    assert.match(nextLine(status(repo)), /리뷰 회차 한도 3회를 모두 써서 막혔습니다[\s\S]*사람이 고릅니다: 회차 추가\(\S*ca-answer 의 judgment 동의 retry-grant reviewRounds\) · 계획을 고쳐 재승인 · 작업 종료\(abort\)/);
    assert.match(budgetReport(repo, "reviewRounds"), /사용 3 \/ 한도 3 — 소진/);
    assert.match(grantRetry(repo, "reviewRounds", "a1b2c3d4-0000-0000-0000-000000000000", "사람이 한 회차를 더 허용"), /리뷰 회차 한도를 3→4회로 늘렸습니다/);
    await check(requireValidatable(repo, "check"));
  });

  test("같은 코드 재실행을 다 쓴 환경 오류의 다음: 에 사람 선택지가 있다(E10)", async () => {
    useManifest({ test: NOT_INSTALLED });
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    for (let i = 0; i < 3; i++) await runTests(requireValidatable(repo, "test")).catch(() => undefined);
    assert.match(nextLine(status(repo)), /같은 코드 재실행 2회를 모두 썼습니다[\s\S]*사람이 고릅니다: 환경을 고친 뒤 한 번 더 허용\(\S*ca-answer 의 judgment 동의 retry-grant rerun\) · 계획을 고쳐 재승인 · 작업 종료\(abort\)/);
  });
});

describe("E15 — 검증 명령이 리뷰 기록을 지워 한도를 피하지 못한다", () => {
  test("테스트 코드가 review.json 을 지우면 되돌리고 그 실행을 받지 않는다 — 리뷰 회차·교차 지점이 그대로다", async () => {
    const DELETE_REVIEW = ["node", "-e",
      "require('fs').rmSync('.code-agent/work/ORD-1/order.review.json', { force: true }); console.log('ok 1 - TC-1'); console.log('ok 2 - TC-2')"];
    useManifest({ test: DELETE_REVIEW });
    await toReview();
    openRound(requireValidatable(repo, "review"));
    writeFindings();
    const before = readFileSync(reviewFile(repo, "ORD-1", "order"), "utf8");
    await assert.rejects(verify(repo, { retry: true }), /검증 명령이 code-agent 기록을 바꿔 실행 전 내용으로 되돌렸습니다: \.code-agent\/work\/ORD-1\/order\.review\.json — 이 실행은 증거로 받지 않습니다/);
    assert.equal(readFileSync(reviewFile(repo, "ORD-1", "order"), "utf8"), before, "지운 리뷰 기록을 되돌렸다");
    assert.equal(loadReview(repo, "ORD-1", "order")!.rounds.length, 1);
  });
});

describe("E17 — 끊긴 test 의 재실행 한도 거부도 verify 의 decision 노드다", () => {
  test("시작 표지만 남은 test 의 같은 코드 재실행을 다 썼으면 예외가 아니라 decision(failure·budget·resume)", async () => {
    toCheck();
    await check(requireValidatable(repo, "check"));
    next(repo);
    patchEvidence(loadWork(repo)!, (disk) => {
      disk.retry = { ...verifyRetryOf(disk), reruns: { "1": 2 }, started: { phase: "test", round: 1, pid: 999_999, host: hostname(), at: new Date().toISOString() } };
    });
    const result = await verify(repo);
    assert.equal(result.node, "decision");
    assert.deepEqual([result.failure?.class, result.failure?.origin, result.failure?.counter?.key], ["limit-exceeded", "interrupted", "rerun"]);
    assert.equal(result.budget?.rerun.exhausted, true);
    assert.match(result.resume, /ca-answer$/);
  });
});

describe("E25 — 하위 폴더에서 연 세션도 저장소 루트의 작업·상태로 판정한다", () => {
  test("CLAUDE_PROJECT_DIR·cwd 가 저장소 안 폴더여도 .code-agent 쓰기·계획 밖 쓰기·허용 목록 밖 셸을 막고, Stop hook 도 루트를 본다", () => {
    toCheck();
    const sub = join(repo, "doc");
    const at = (tool: string, input: Record<string, string>) => decide({ cwd: sub, tool_name: tool, tool_input: input }, sub);
    assert.match(at("Write", { file_path: join(repo, ".code-agent", "active.json") }) ?? "", /작업 상태·제출된 계획·승인과 확정 기록은 도구로 고칠 수 없습니다/);
    assert.ok(at("Write", { file_path: join(repo, "src", "main", "java", "Other.java") }), "계획 밖 쓰기");
    assert.ok(at("Bash", { command: "rm -rf ../src" }), "작업 중 셸 허용 목록");
    assert.equal(at("Bash", { command: "code-agent status" }), undefined);
    write("stray.txt", "도구 밖 변경\n");
    assert.match(decideStop({ cwd: sub }, sub) ?? "", /계획 밖의 변경이 남아 있습니다/);
  });
});

describe("E28 — 승인된 동의의 적용은 다른 창이 임대를 가져가도 동의 주인 세션이 한다", () => {
  test("다른 세션이 작업 임대를 쥐어도 응답을 관찰한 세션의 consent finish 는 임대로 막지 않고, 그 밖의 진행 명령은 막는다", () => {
    toCheck();
    const prepared = JSON.parse(prepareConsent(repo, { action: "abort" }));
    observeConsentFixture({ root: repo, ...prepared, sessionId: "S1", toolUseId: `t-${randomUUID()}` });
    const bash = (command: string, session: string) => decide({ cwd: repo, tool_name: "Bash", tool_input: { command }, session_id: session, host: "claude" });
    assert.equal(bash("code-agent status", "S2"), undefined);
    assert.equal(bash("code-agent next", "S2"), undefined, "S2 가 임대를 잡는다");
    assert.match(bash("code-agent next", "S1") ?? "", /다른 세션이 이 작업을 진행 중입니다/);
    assert.equal(bash(`code-agent consent finish ${prepared.id}`, "S1"), undefined, "동의 주인은 임대와 무관하게 적용한다");
    assert.match(bash(`code-agent consent finish ${prepared.id}`, "S2") ?? "", /현재 세션에서 확인한 요청만/);
  });
});

describe("DOC-14 — Codex 설치 안내의 수는 실제로 쓴 자원에서 센다", () => {
  test("스킬·에이전트·훅 수가 설치된 폴더·hooks.json 과 같고, 소스에 수를 박아 두지 않는다", () => {
    const text = init(repo, { host: "codex" });
    const skills = readdirSync(join(repo, ".agents", "skills")).length;
    const agents = readdirSync(join(repo, ".codex", "agents")).filter((name) => name.endsWith(".toml")).length;
    const events = Object.keys(JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8")).hooks).length;
    assert.match(text, new RegExp(`스킬 ${skills}개: \\.agents/skills/ca-\\* · 에이전트 ${agents}개: \\.codex/agents/ca-\\*\\.toml`));
    assert.match(text, new RegExp(`훅 ${events}종: \\.codex/hooks\\.json`));
    assert.doesNotMatch(readFileSync(join(__dirname, "..", "..", "src", "agent", "init.ts"), "utf8"), /스킬 \d+개: \.agents/);
  });
});

describe("E11 — 통합 검증이 실패한 뒤의 다음: 은 원인과 남은 재실행을 싣는다", () => {
  test("prepare 가 환경 문제로 실패하면 진입 문구가 아니라 integrate 변형 안내(같은 회차 재실행·남은 수)다", async () => {
    useManifest({ prepare: NOT_INSTALLED });
    await toIntegrate();
    await integrate(requireValidatable(repo, "integrate")).catch(() => undefined);
    const line = nextLine(status(repo));
    assert.match(line, /^다음: \S*ca-integrate[\s\S]* — prepare\(\w+\) — 환경 문제로 통합 검증을 마치지 못했습니다[\s\S]*code-agent integrate 로 같은 회차를 다시 돌리세요[\s\S]*남은 통합 검증 재실행 \d회/, line);
    assert.doesNotMatch(line, /기준 커밋 위의 깨끗한 worktree 에서 전체 build/);
  });
});
