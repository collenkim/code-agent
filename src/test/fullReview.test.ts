/** 게이트·동의·검증·반영의 회귀 시험. 임시 Git 저장소에서 실제 함수를 부르며 모델·호스트는 실행하지 않는다. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { abort, next, requireValidatable, status } from "../agent/commands";
import { finishConsent, loadConsent, prepareConsent } from "../agent/consent";
import { doctor } from "../agent/doctor";
import { modelsTable, setModel } from "../agent/models";
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
import { deadPid } from "./deadPid";
import { withCaller } from "./reviewFixture";
import { stubCodexProbe } from "./codexProbeFixture";

const PRESENCE = { channel: "tty" as const, verified: true, detail: "테스트" };
const nextLine = (text: string): string => text.split("\n").find((line) => line.startsWith("다음: ")) ?? "";

// doctor 는 Codex 준비를 지금 묻는다 — 실제 Codex·사용자 CODEX_HOME 대신 신뢰하지 않은 새 프로젝트의 응답으로 답한다
let probe: { restore(): void };
beforeEach(() => { createStageRepo("ca-full-review-"); probe = stubCodexProbe("project-untrusted", { bin: false }); });
afterEach(() => { probe.restore(); removeStageRepo(); });

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

describe("D1(E2) — 작업 중에는 역할 모델을 바꾸지 않는다: 접수부터 반영(deliver)·종료(abort) 전까지 거부(2026-10-08 사용자 결정)", () => {
  const AGENT = ".claude/agents/ca-writer.md";
  const REFUSED = /진행 중인 작업 ORD-1\(check\)이 있어 역할 모델·추론 강도를 바꾸지 않습니다 — [\s\S]*작업을 반영\(deliver\)하거나 종료\(abort\)한 뒤 바꾸세요/;
  const TTY = { confirm: () => PRESENCE, ask: () => "y" };
  const modelLine = () => /^model: .*$/m.exec(readFileSync(join(repo, AGENT), "utf8"))![0];
  // 동의 기록(UUID 이름)만 센다 — 같은 폴더의 snapshot-cache.json(스냅샷 해시 캐시)은 준비 전 스냅샷 계산이 시각에 따라 쓴다
  const consentFiles = () => existsSync(join(repo, ".code-agent/consents"))
    ? readdirSync(join(repo, ".code-agent/consents")).filter((name) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(name)) : [];
  const installAgent = () => {
    write(AGENT, "---\nname: ca-writer\nmodel: sonnet\neffort: medium\n---\n본문\n");
    git("add", "-A");
    git("commit", "-qm", "agents");
  };
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, "..", "agent", "cli.js"), "model", ...args], { cwd: repo, encoding: "utf8" });

  test("D1 준비 거부 — 작업 중이면 model 동의(모델·강도·기본값 복원)를 질문을 내기 전에 거부하고 동의 기록을 남기지 않는다", () => {
    installAgent();
    toCheck();
    const before = consentFiles();
    for (const action of [{ model: "opus" }, { model: "sonnet", reasoning: "high" }, { model: "default" }, { agent: "all", model: "haiku" }]) {
      assert.throws(() => prepareConsent(repo, { action: "model", host: "claude", agent: "writer", ...action }), REFUSED, JSON.stringify(action));
      assert.deepEqual(consentFiles(), before, `거부한 준비는 동의 기록·질문을 만들지 않는다 — ${JSON.stringify(action)}`);
    }
    assert.equal(modelLine(), "model: sonnet");
  });

  test("D1 준비 거부 — 접수 세션(start 전)도 진행 중인 작업이다", () => {
    installAgent();
    write(".code-agent/request-session.json", JSON.stringify({ id: "ORD-9", kind: "feature", startedAt: new Date().toISOString() }));
    assert.throws(() => prepareConsent(repo, { action: "model", host: "claude", agent: "writer", model: "opus" }), /진행 중인 작업 ORD-9\(접수\)이 있어 역할 모델·추론 강도를 바꾸지 않습니다/);
    assert.throws(() => withInteraction(TTY, () => setModel(repo, "writer", "opus", { host: "claude" })), /ORD-9\(접수\)/);
    assert.equal(modelLine(), "model: sonnet");
  });

  test("D1 적용 시점 재확인 — 작업이 없을 때 준비·승인한 동의도 그 뒤 작업이 시작되면 적용하지 않고 대상 변경으로 폐기한다", () => {
    installAgent();
    const prepared = JSON.parse(prepareConsent(repo, { action: "model", host: "claude", agent: "writer", model: "opus" }));
    assert.doesNotMatch(prepared.summary, /진행 중인 작업/);
    observeConsentFixture({ root: repo, ...prepared, sessionId: `s-${randomUUID()}`, toolUseId: `t-${randomUUID()}` });
    toCheck();
    assert.throws(() => finishConsent(repo, prepared.id), REFUSED);
    const record = loadConsent(repo, prepared.id);
    assert.deepEqual([record.status, record.failure?.class, record.failure?.kind], ["failed", "consent-target-changed", "target"]);
    assert.match(record.failure!.detail, /^확인 대상 변경: 진행 중인 작업 ORD-1\(check\) — 작업 중에는 역할 모델을 바꾸지 않습니다/);
    assert.equal(modelLine(), "model: sonnet", "정의 파일을 바꾸지 않았다");
    assert.equal(existsSync(join(repo, ".code-agent/models.json")), false, "변경값 파일도 만들지 않았다");
    // 폐기한 동의는 다시 적용하지 않는다 — finish 는 실패 상태와 안내만 돌려준다
    const again = JSON.parse(finishConsent(repo, prepared.id)) as { status: string; failure: { class: string; guide: string } };
    assert.deepEqual([again.status, again.failure.class], ["failed", "consent-target-changed"]);
    assert.match(again.failure.guide, /진행 중인 작업 ORD-1\(check\) — 작업 중에는 역할 모델을 바꾸지 않습니다\. 작업을 반영\(deliver\)하거나 종료\(abort\)한 뒤 새로 준비하세요/);
    assert.equal(modelLine(), "model: sonnet");
  });

  test("D1 CLI 거부·표 보기 허용 — 작업 중 code-agent model <역할> <모델> 은 TTY 를 묻기 전에 거부하고(강도만 바꿔도), 값 없는 code-agent model 은 표를 연다", () => {
    installAgent();
    toCheck();
    const shown = cli("--host", "claude");
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /writer\s+sonnet \/ medium/);
    for (const args of [["writer", "opus", "--host", "claude"], ["writer", "sonnet", "--host", "claude", "--effort", "high"], ["all", "default", "--host", "claude"]]) {
      const denied = cli(...args);
      assert.equal(denied.status, 1, `${args.join(" ")}: ${denied.stderr}`);
      assert.match(denied.stderr, REFUSED, "TTY 확인보다 먼저 작업 중 거부를 낸다");
      assert.doesNotMatch(denied.stderr, /터미널에서만/);
    }
    // TTY 로 확인한 사람의 실행(setModel)도 같은 검사로 막힌다 — 동의 적용과 터미널 경로가 한 함수를 쓴다
    assert.throws(() => withInteraction(TTY, () => setModel(repo, "writer", "opus", { host: "claude" })), REFUSED);
    assert.throws(() => withInteraction(TTY, () => setModel(repo, "writer", "sonnet", { host: "claude", reasoning: "high" })), REFUSED);
    assert.equal(modelLine(), "model: sonnet");
    assert.equal(existsSync(join(repo, ".code-agent/models.json")), false);
  });

  test("D1 종료 뒤 허용 — abort 로 작업을 끝내면 동의 준비와 직접 변경이 다시 열린다", () => {
    installAgent();
    toCheck();
    assert.throws(() => withInteraction(TTY, () => setModel(repo, "writer", "opus", { host: "claude" })), REFUSED);
    abort(repo);
    assert.equal(loadActive(repo), undefined);
    assert.equal(JSON.parse(prepareConsent(repo, { action: "model", host: "claude", agent: "writer", model: "opus" })).status, "pending");
    withInteraction(TTY, () => setModel(repo, "writer", "opus", { host: "claude" }));
    assert.equal(modelLine(), "model: opus");
  });

  test("D1 반영 뒤 허용 — deliver 로 작업이 끝나면 동의 준비·적용과 직접 변경이 다시 열린다", async () => {
    installAgent();
    await toDeliver();
    writePr();
    assert.throws(() => prepareConsent(repo, { action: "model", host: "claude", agent: "writer", model: "opus" }), /진행 중인 작업 ORD-1\(deliver\)/);
    withInteraction({ confirm: () => PRESENCE, ask: () => "n" }, () => deliver(loadWork(repo)!));
    assert.equal(loadActive(repo), undefined, "반영이 작업 커서를 지웠다");
    const prepared = JSON.parse(prepareConsent(repo, { action: "model", host: "claude", agent: "writer", model: "opus" }));
    observeConsentFixture({ root: repo, ...prepared, sessionId: `s-${randomUUID()}`, toolUseId: `t-${randomUUID()}` });
    const applied = JSON.parse(finishConsent(repo, prepared.id)) as { status: string; next: string };
    assert.equal(applied.status, "applied");
    assert.equal(applied.next, "결과를 보고한다 — 새 모델은 호스트를 다시 시작한 뒤 적용된다", "작업이 없으면 경고 꼬리가 없다");
    assert.equal(modelLine(), "model: opus");
    withInteraction(TTY, () => setModel(repo, "writer", "haiku", { host: "claude" }));
    assert.equal(modelLine(), "model: haiku");
  });

  test("D1 doctor — 정의 파일이 설정과 달라 update --templates-only 를 안내할 때 작업 중이면 '작업이 끝난 뒤' 실행하라고 한다", () => {
    write(AGENT, "---\nname: ca-writer\nmodel: sonnet\neffort: max\n---\n본문\n");
    git("add", "-A");
    git("commit", "-qm", "agents");
    const hintOf = (text: string) => {
      const rows = text.split("\n"), index = rows.findIndex((row) => row.trim().startsWith("✗ 에이전트 모델:"));
      assert.ok(index >= 0, text);
      return rows[index + 1].trim();
    };
    const idle = hintOf(doctor(repo).text);
    assert.match(idle, /code-agent update --templates-only — 정의 파일의 model·effort 줄을 설정/);
    assert.doesNotMatch(idle, /끝난 뒤/);
    toCheck();
    const working = hintOf(doctor(repo).text);
    assert.match(working, /진행 중인 작업 ORD-1\(check\)이 끝난 뒤\(반영 deliver 또는 종료 abort\) code-agent update --templates-only — [\s\S]*작업 중에 다시 쓰면 그 작업의 계획 밖 변경이 됩니다/);
  });

  test("D1 doctor(Codex, 반박 검증) — TOML 의 model 줄이 설정과 달라 'Codex 스킬·에이전트' 가 update --templates-only --host codex 를 안내할 때도 작업 중이면 '작업이 끝난 뒤' 실행하라고 한다", () => withCaller(undefined, () => {
    init(repo, { host: "codex" });
    const toml = join(repo, ".codex/agents/ca-writer.toml");
    write(".codex/agents/ca-writer.toml", readFileSync(toml, "utf8").replace(/^model = .*$/m, 'model = "gpt-test-other"'));
    git("add", "-A");
    git("commit", "-qm", "codex");
    const rowOf = (text: string) => {
      const rows = text.split("\n"), index = rows.findIndex((row) => row.trim().startsWith("✗ Codex 스킬·에이전트:"));
      assert.ok(index >= 0, text);
      return { observed: rows[index].trim(), hint: rows[index + 1].trim() };
    };
    const idle = rowOf(doctor(repo).text);
    assert.match(idle.observed, /\.codex\/agents\/ca-writer\.toml/);
    assert.equal(idle.hint, "→ code-agent update --templates-only --host codex");
    toCheck();
    const working = rowOf(doctor(repo).text);
    assert.match(working.hint, /^→ 진행 중인 작업 ORD-1\(check\)이 끝난 뒤\(반영 deliver 또는 종료 abort\) code-agent update --templates-only --host codex — 작업 중에 다시 쓰면 그 작업의 계획 밖 변경이 됩니다$/);
  }));

  test("D1 doctor(Codex 옛 설치) — 다른 이벤트는 있는데 SessionStart 만 없으면 update --templates-only --host codex 를(작업 중이면 끝난 뒤) 안내하고, 하나도 없으면 init 이다", () => withCaller(undefined, () => {
    init(repo, { host: "codex" });
    const hooksFile = join(repo, ".codex/hooks.json");
    const settings = JSON.parse(readFileSync(hooksFile, "utf8")) as { hooks: Record<string, unknown> };
    delete settings.hooks.SessionStart;
    write(".codex/hooks.json", JSON.stringify(settings, null, 2));
    git("add", "-A");
    git("commit", "-qm", "codex");
    const rowOf = (text: string) => {
      const rows = text.split("\n"), index = rows.findIndex((row) => row.trim().startsWith("✗ Codex SessionStart:"));
      assert.ok(index >= 0, text);
      return { observed: rows[index].trim(), hint: rows[index + 1].trim() };
    };
    const idle = rowOf(doctor(repo).text);
    assert.equal(idle.observed, "✗ Codex SessionStart: 설치되지 않았습니다");
    assert.equal(idle.hint, "→ code-agent update --templates-only --host codex");
    toCheck();
    const working = rowOf(doctor(repo).text);
    assert.match(working.hint, /^→ 진행 중인 작업 ORD-1\(check\)이 끝난 뒤\(반영 deliver 또는 종료 abort\) code-agent update --templates-only --host codex — 작업 중에 다시 쓰면 그 작업의 계획 밖 변경이 됩니다$/);
    // 우리 이벤트가 하나도 없으면 옛 설치가 아니라 설치가 빠진 것이다
    write(".codex/hooks.json", JSON.stringify({ hooks: {} }, null, 2));
    assert.equal(rowOf(doctor(repo).text).hint, "→ code-agent init");
  }));

  test("D1 모델 표(반박 검증) — 작업 중에도 표는 열리고, 변경 줄은 작업 중 거부와 작업이 끝난 뒤의 방법을 싣는다", () => {
    installAgent();
    const changeLine = (text: string) => text.split("\n").find((line) => line.startsWith("변경: ")) ?? "";
    assert.match(changeLine(modelsTable(repo, "claude")), /^변경: 현재 세션에서 역할·모델·추론 강도 변경을 요청하세요\. 수동 TTY: code-agent model /);
    toCheck();
    const table = modelsTable(repo, "claude");
    assert.match(table, /writer\s+sonnet \/ medium/, "조회는 작업 중에도 연다");
    const line = changeLine(table);
    assert.match(line, REFUSED);
    assert.match(line, /작업이 끝난 뒤: 현재 세션에서 변경을 요청하거나 수동 TTY: code-agent model <역할\|all> <모델\|default> --host claude/);
    assert.doesNotMatch(line, /^변경: 현재 세션에서 역할·모델·추론 강도 변경을 요청하세요/, "작업 중에 변경을 요청하라고 하지 않는다");
    const shown = cli("--host", "claude");
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, REFUSED, "터미널의 표 보기도 같은 변경 줄이다");
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
      disk.retry = { ...verifyRetryOf(disk), reruns: { "1": 2 }, started: { phase: "test", round: 1, pid: deadPid(), host: hostname(), at: new Date().toISOString() } };
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
