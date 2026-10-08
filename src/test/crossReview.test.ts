import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { next, requireValidatable, status } from "../agent/commands";
import { crossReview, netProbeRunner } from "../agent/crossCheck";
import { codexHook, runCodexHook } from "../agent/codexHook";
import { commitDelivery, deliver, PR_BLOCK, prDocFile, renderTraceBlock } from "../agent/deliver";
import { doctor } from "../agent/doctor";
import { decide as guardTool } from "../agent/hook";
import { loadEvidence } from "../agent/evidence";
import { loadActive } from "../agent/layout";
import { runPlanningHook } from "../agent/planningHook";
import { RetryRefused } from "../agent/retryPolicy";
import { loadReview, mutateReview, openRound, reviewBudgets, reviewDocFile, reviewProblems, saveReview, type ReviewLog } from "../agent/review";
import { observeReviewer, RecordedFailure, runReviewHook } from "../agent/reviewHook";
import { previewCrossStop, previewWaiveFinding, recordCrossStop, waiveFinding } from "../agent/reviewJudgment";
import { runSessionHook } from "../agent/sessionHook";
import { runStopHook } from "../agent/stopHook";
import { upsertBlock } from "../agent/blocks";
import { withInteraction } from "../agent/tty";
import { check, integrate, runTests } from "../agent/validate";
import { loadWork } from "../agent/work";
import { CONSENT_WORK_ID, approveAndApplyFixture, gitFixture, prepareReviewFixture, setupConsentProject, writeFixture } from "./consentFixture";
import { recordReviewFixture, withCaller } from "./reviewFixture";
import { deadPid } from "./deadPid";

const ID = CONSENT_WORK_ID, TARGET = "value", CODE = "src/value.js";
let root: string, fakeDir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["CODE_AGENT_CODEX_BIN", "CODE_AGENT_CLAUDE_BIN", "CODE_AGENT_CROSS_TIMEOUT_MIN", "FAKE_CROSS", "FAKE_CALLS", "FAKE_PROMPT", "FAKE_DIST", "CLAUDE_PROJECT_DIR", "CODE_AGENT_CROSS", "CODEX_SANDBOX_NETWORK_DISABLED", "HTTPS_PROXY", "https_proxy"];
/** 사전 판정의 연결 확인 — 시험은 네트워크에 나가지 않는다. 기본은 Windows Codex 샌드박스의 거부 꼴(EACCES)이고, 바꾼 시험은 afterEach 가 되돌린다 */
const realConnect = netProbeRunner.connect;

/**
 * 리뷰 1회차까지 세운 저장소를 파일당 한 번 만들고 테스트마다 복사해 쓴다 — 계획 승인·구현·check·test 를 매번 다시 돌지 않게.
 * 복사본에 저장소 절대 경로가 남는 것은 적용이 끝난 동의 기록뿐이다(이 시험들은 그 기록을 다시 쓰지 않는다).
 */
let base: string;
before(async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-cross-base-")));
  setupConsentProject(base);
  await prepareReviewFixture(base);
});
after(() => {
  const temporary = realpathSync.native(tmpdir()), target = resolve(base);
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-cross-base-"));
  rmSync(target, { recursive: true, force: true });
});
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-cross-review-")));
  fakeDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-cross-fake-")));
  for (const key of ENV) saved[key] = process.env[key];
  delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
  netProbeRunner.connect = () => "EACCES";
  cpSync(base, root, { recursive: true });
});
afterEach(() => {
  netProbeRunner.connect = realConnect;
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  const temporary = realpathSync.native(tmpdir());
  for (const [dir, prefix] of [[root, "ca-cross-review-"], [fakeDir, "ca-cross-fake-"]] as const) {
    const target = resolve(dir);
    assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith(prefix));
    rmSync(target, { recursive: true, force: true });
  }
});

/** 한 호스트 설치의 반영 단계까지(prepareDeliveryFixture 의 리뷰 뒤 절차) */
async function toDeliver(): Promise<void> {
  writeFileSync(doc(), readFileSync(doc(), "utf8").replace("## 지적\n", "## 지적\n\n- 없음\n"));
  recordReviewFixture(root);
  next(root);
  await integrate(requireValidatable(root, "integrate")); next(root);
  writeFixture(root, prDocFile(ID), "## 요약\n값과 오류 구현\n## 확인 방법\n함수 호출\n## 위험·되돌리기\n새 파일을 되돌린다.\n");
  assert.equal(loadActive(root)?.phase, "deliver");
}

const doc = () => join(root, reviewDocFile(ID));
const lastRound = () => loadReview(root, ID, TARGET)!.rounds.at(-1)!;
const attempts = () => lastRound().crossAttempts ?? [];
const quiet = <T>(run: () => T): T => { const write = process.stderr.write; process.stderr.write = (() => true) as typeof process.stderr.write; try { return run(); } finally { process.stderr.write = write; } };

/** 두 호스트 설치 + 리뷰 1회차 + 독립 리뷰(`- 없음`) 기록. reviewer: false 면 독립 리뷰는 기록하지 않는다 */
async function crossRepo(options: { reviewer?: boolean } = {}): Promise<void> {
  writeFixture(root, ".code-agent/hosts.json", JSON.stringify(["claude", "codex"]));
  writeFileSync(doc(), readFileSync(doc(), "utf8").replace("## 지적\n", "## 지적\n\n- 없음\n"));
  if (options.reviewer !== false) recordReviewFixture(root, "claude", { cross: false });
}

/**
 * 가짜 codex — 호출 수와 마지막 프롬프트를 파일에 남기고 body 를 실행한다(a: argv, out: -o 경로, fs).
 * 기본 body 는 FAKE_CROSS 를 마지막 응답으로 남긴다.
 */
function fakeCodex(body = "fs.writeFileSync(out, process.env.FAKE_CROSS);"): void {
  const script = join(fakeDir, "codex.cjs");
  writeFileSync(script, "const fs = require('fs'), a = process.argv, out = a[a.indexOf('-o') + 1];\n" +
    "fs.appendFileSync(process.env.FAKE_CALLS, 'x'); fs.writeFileSync(process.env.FAKE_PROMPT, a[a.length - 1]);\n" + body + "\n");
  process.env.CODE_AGENT_CODEX_BIN = script;
  process.env.FAKE_CALLS = join(fakeDir, "calls.txt");
  process.env.FAKE_PROMPT = join(fakeDir, "prompt.txt");
}
const calls = () => existsSync(join(fakeDir, "calls.txt")) ? readFileSync(join(fakeDir, "calls.txt"), "utf8").length : 0;
const prompt = () => readFileSync(join(fakeDir, "prompt.txt"), "utf8");
const cross = (result?: string) => { if (result !== undefined) process.env.FAKE_CROSS = result; return withCaller("claude", () => crossReview(root, "codex")); };
const refusal = (pattern: RegExp) => (error: Error) => error instanceof RetryRefused && pattern.test(error.message);
const X1_OPEN = `| X1 | ${CODE} | 계획 안 | 열림 | 경계값 누락 |`;

/** 코드를 고치고 check·test 를 통과시켜 다음 리뷰 회차를 연다(독립 리뷰 `- 없음` 기록) */
async function nextRound(code: string): Promise<void> {
  writeFixture(root, CODE, code);
  await check(requireValidatable(root, "check")); next(root);
  await runTests(requireValidatable(root, "test")); next(root);
  openRound(requireValidatable(root, "review"));
  writeFileSync(doc(), readFileSync(doc(), "utf8").replace(/(## 지적\s*\n)[\s\S]*?(?=^## |$(?![\s\S]))/m, "$1\n- 없음\n\n"));
  recordReviewFixture(root, "claude", { cross: false });
}

// ---- 완료 지점·원인별 실패 ----

test("PVR-1: 완료된 교차 지점은 다시 실행하지 않는다 — 다른 결과로 지적을 지우는 길이 없다", async () => {
  await crossRepo(); fakeCodex();
  assert.match(cross(X1_OPEN), /열린 지적 1개/);
  assert.throws(() => cross("- 없음"), refusal(/이미 기록했습니다\(완료, 열린 지적 1개\)/));
  assert.equal(calls(), 1);
  assert.equal(attempts().length, 1);
  assert.throws(() => next(root), /열린 지적: X1/);
});

test("설정 오류는 중지가 아니라 게이트를 막고, 첫 오류 뒤 1회만 다시 실행한다 — CLI 는 exit 1", async () => {
  await crossRepo(); fakeCodex("process.stderr.write(\"error: unexpected argument '--ephemeral' found\\n\"); process.exit(2);");
  assert.throws(() => cross(), refusal(/교차 호출 설정 오류[\s\S]*unexpected argument[\s\S]*출력 원문: [\s\S]*남은 1회/));
  assert.deepEqual([attempts()[0].class, attempts()[0].kind], ["cross-config-error", "config"]);
  assert.ok(existsSync(join(root, attempts()[0].logPath!)), "설정 오류는 원문 출력을 handoff 에 남긴다");
  assert.doesNotMatch(readFileSync(doc(), "utf8"), /교차 검증 중지/);
  assert.throws(() => next(root), /교차 리뷰가 필요합니다[\s\S]*막힘\(설정 오류\)/);
  // 한도를 다 쓴 실패는 '한 번 더 실행할 수 있습니다(남은 0회)' 가 아니라 사람 판단을 안내한다(E3 — 안내대로 다시 실행하면 한도 거부다)
  assert.throws(() => cross(), (error: Error) => refusal(/재실행 한도를 다 써서 같은 명령은 다시 실행되지 않습니다[\s\S]*retry-grant crossError/)(error) &&
    !/한 번 더 실행할 수 있습니다/.test(error.message));
  // 게이트·status 의 교차 줄도 거부될 명령을 앞세우지 않고 사람 판단만 낸다(E4)
  const line = reviewProblems(loadWork(root)!).find((problem) => /교차 리뷰가 필요합니다/.test(problem))!;
  assert.doesNotMatch(line, /review cross --by codex \(실행할 수 없으면/);
  assert.match(line, /^두 호스트가 설치된 프로젝트라 교차 리뷰가 필요합니다 — 직전 실행: [\s\S]*한도 1회를 썼습니다[\s\S]*사람 판단/);
  assert.doesNotMatch(status(root), /review cross --by codex \(실행할 수 없으면/);
  const cli = spawnSync(process.execPath, [join(__dirname, "../agent/cli.js"), "review", "cross", "--by", "codex"],
    { cwd: root, encoding: "utf8", env: { ...process.env, CLAUDECODE: "1", CODEX_CI: "" } });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr + cli.stdout, /교차 설정 오류 재실행 한도 1회를 썼습니다/);
  assert.equal(calls(), 2, "한도 거부는 다른 호스트를 띄우지 않는다");
});

test("모델 설정 파일 형식 오류는 시도를 남기기 전에 고치는 법과 함께 멈춘다", async () => {
  await crossRepo(); fakeCodex();
  writeFixture(root, ".code-agent/codex-models.json", "{");
  assert.throws(() => cross("- 없음"), /codex-models\.json`을 JSON으로 읽을 수 없습니다/);
  assert.deepEqual([attempts().length, calls()], [0, 0]);
});

test("모델 없음·알 수 없는 종료·Claude 의 JSON 아닌 출력은 모두 설정 오류로 막힌다", async () => {
  await crossRepo();
  fakeCodex("process.stderr.write('ERROR: stream error: model gpt-x does not exist\\n'); process.exit(1);");
  assert.throws(() => cross(), refusal(/설정 오류/));
  assert.equal(attempts()[0].class, "cross-config-error");
  fakeCodex("process.stderr.write('panic: something odd\\n'); process.exit(101);");
  assert.throws(() => cross(), refusal(/분류되지 않은 종료/));
  assert.equal(attempts()[1].kind, "unclassified");
  assert.ok(reviewProblems(loadWork(root)!).some((problem) => /교차 리뷰가 필요합니다/.test(problem)));
  // Claude 방향 — 다른 회차·다른 호스트 지점에서
  await nextRound("module.exports=n=>{if(n<0)throw Error('negative');return 1;};// claude\n");
  const claude = join(fakeDir, "claude.cjs");
  writeFileSync(claude, "process.stdout.write('not json at all');\n");
  process.env.CODE_AGENT_CLAUDE_BIN = claude;
  assert.throws(() => withCaller("codex", () => crossReview(root, "claude")), refusal(/설정 오류/));
  assert.equal(attempts()[0].class, "cross-config-error");
});

test("사람 중지(cross-stop)는 막힌 지점에만 기록하고, 기록하면 게이트가 그 지점의 교차 결과 없이 진행한다", async () => {
  await crossRepo();
  assert.throws(() => previewCrossStop(root, "review"), /막힌 지점만 사람이 중지를 결정합니다[\s\S]*상태: 없음/);
  assert.throws(() => previewCrossStop(root, "planning"), /planning 교차 지점은 plan 단계에서 기록합니다/);
  fakeCodex("process.stderr.write(\"error: unexpected argument '--ephemeral' found\\n\"); process.exit(2);");
  assert.throws(() => cross(), RetryRefused);
  assert.throws(() => cross(), RetryRefused);
  assert.match(previewCrossStop(root, "review"), /지점: 리뷰 1회차 · codex · 시도 2회\(cross-config-error: [\s\S]*사람이 중지로 기록합니다/);
  assert.match(recordCrossStop(root, "review", "a1b2c3d4-0000-0000-0000-000000000000", "설정을 고칠 수 없음"), /리뷰 1회차 의 교차 검증을 사람 판단으로 중지했습니다/);
  const stop = attempts().at(-1)!;
  assert.deepEqual([stop.class, stop.mode, stop.consent], ["cross-stop", "human", "a1b2c3d4-0000-0000-0000-000000000000"]);
  assert.match(readFileSync(doc(), "utf8"), /## 교차 지적[\s\S]*- 교차 검증 중지 — 사람 판단\(동의 a1b2c3d4\): 설정을 고칠 수 없음/);
  assert.match(readFileSync(doc(), "utf8"), /### 사람 판단\n\n- 1회차 교차 리뷰 중지 — 설정을 고칠 수 없음 · 동의 a1b2c3d4/);
  assert.throws(() => cross(), refusal(/사람 판단으로 중지했습니다/));
  assert.equal(calls(), 2);
  next(root);
  assert.equal(loadActive(root)!.phase, "integrate");
});

test("시간 초과 — 첫 번째는 한 번 더 실행할 수 있고, 두 번째 제한 시간은 중지로 기록하고 진행한다", async () => {
  await crossRepo();
  process.env.CODE_AGENT_CROSS_TIMEOUT_MIN = "0.005";
  fakeCodex("setTimeout(() => fs.writeFileSync(out, '- 없음'), 3000);");
  assert.throws(() => cross(), refusal(/0\.005분 제한을 넘겨 중단했습니다[\s\S]*한 번 더/));
  assert.deepEqual([attempts()[0].class, attempts()[0].kind], ["cross-timeout", "timeout"]);
  assert.match(cross(), /교차 검증 중지[\s\S]*두 번 연속 0\.005분 제한/);
  assert.match(readFileSync(doc(), "utf8"), /- 교차 검증 중지 — codex 가 두 번 연속/);
  next(root);
  assert.equal(loadActive(root)!.phase, "integrate");
});

test("끊긴 실행 — 다음 실행이 기록 없이 끝난 시도를 끊긴 실행으로 닫고, 끊긴 실행은 중지가 아니라 지점 한도에 든다", async () => {
  await crossRepo(); fakeCodex();
  const dead = deadPid();
  mutateReview(root, ID, TARGET, (log) => {
    log!.rounds.at(-1)!.crossAttempts = [{ n: 1, host: "codex", mode: "review", startedAt: new Date().toISOString(), pid: dead, machine: hostname() }];
    return { log: log!, value: 0 };
  });
  assert.throws(() => next(root), /직전 실행: 막힘\(끊긴 실행\)/, "게이트 쪽 고아 보기 — 실행 중으로 막아 두지 않는다");
  const output = cross("- 없음");
  assert.match(output.split("\n")[0], new RegExp(`이전 교차 실행\\(시작 \\d\\d:\\d\\d, pid ${dead}\\)이 기록 없이 끊겨 중단으로 기록했습니다`));
  assert.deepEqual(attempts().map((attempt) => [attempt.class, attempt.kind]), [["cross-timeout", "interrupted"], ["completed", undefined]]);
});

test("끊긴 실행 세 번은 중지가 아니라 지점 한도 — 다른 호스트를 띄우지 않고 게이트가 막힌다. 닫은 시도는 거부 문구 앞에 알린다", async () => {
  await crossRepo(); fakeCodex();
  const dead = deadPid();
  mutateReview(root, ID, TARGET, (log) => {
    log!.rounds.at(-1)!.crossAttempts = [
      ...[1, 2].map((n) => ({ n, host: "codex" as const, mode: "review" as const, startedAt: "2026-10-07T00:00:00.000Z",
        endedAt: "2026-10-07T00:10:00.000Z", class: "cross-timeout" as const, kind: "interrupted", detail: "기록 없이 끊긴 실행" })),
      { n: 3, host: "codex", mode: "review", startedAt: new Date().toISOString(), pid: dead, machine: hostname() },
    ];
    return { log: log!, value: 0 };
  });
  assert.throws(() => cross("- 없음"), refusal(new RegExp(`^이전 교차 실행\\(시작 \\d\\d:\\d\\d, pid ${dead}\\)이 기록 없이 끊겨 중단으로 기록했습니다\\.\\n` +
    "이 지점의 교차 실행 한도 3회를 모두 썼습니다\\(끊긴 실행 3\\)[\\s\\S]*judgment cross-stop 또는 retry-grant crossPoint")));
  assert.equal(calls(), 0);
  assert.deepEqual([attempts()[2].class, attempts()[2].kind, typeof attempts()[2].endedAt], ["cross-timeout", "interrupted", "string"], "닫은 시도는 거부해도 저장한다");
  assert.throws(() => next(root), /교차 리뷰가 필요합니다/);
});

test("게이트 쪽 고아 보기 — 사람이 아닌 중지 지점에 끝 기록 없는 시도(죽은 pid)가 남아도 실행 중으로 막지 않고 중지대로 진행한다", async () => {
  await crossRepo();
  fakeCodex("process.stderr.write('ERROR: You hit your spend cap set by the owner of your workspace.'); process.exit(1);");
  assert.match(cross(), /교차 검증 중지/);
  const dead = deadPid();
  mutateReview(root, ID, TARGET, (log) => {
    const last = log!.rounds.at(-1)!;
    last.crossAttempts = [...last.crossAttempts!, { n: 2, host: "codex", mode: "review", startedAt: new Date().toISOString(), pid: dead, machine: hostname() }];
    return { log: log!, value: 0 };
  });
  assert.equal(reviewProblems(loadWork(root)!).filter((problem) => /교차/.test(problem)).length, 0);
  assert.equal(attempts()[1].endedAt, undefined, "게이트는 고아 보기를 저장하지 않는다");
  next(root);
  assert.equal(loadActive(root)!.phase, "integrate");
});

test("다른 교차 실행이 진행 중이면 기다리게 하고 시도를 더하지 않는다", async () => {
  await crossRepo(); fakeCodex();
  mutateReview(root, ID, TARGET, (log) => {
    log!.rounds.at(-1)!.crossAttempts = [{ n: 1, host: "codex", mode: "review", startedAt: new Date().toISOString(), pid: process.pid, machine: hostname() }];
    return { log: log!, value: 0 };
  });
  assert.throws(() => cross("- 없음"), refusal(new RegExp(`다른 교차 실행이 진행 중입니다\\(pid ${process.pid}`)));
  assert.equal(attempts().length, 1);
  assert.throws(() => next(root), /교차 리뷰가 실행 중입니다/);
});

test("형식 오류 — 원문을 보존하고 같은 명령이 원문의 형식만 교정한다(HP-13), 교정한 지점도 완료면 다시 실행하지 않는다", async () => {
  await crossRepo(); fakeCodex();
  assert.throws(() => cross("설명문만 있는 응답"), refusal(/형식이 맞지 않습니다[\s\S]*형식만 교정합니다\(남은 1회\)\.\n설명문만 있는 응답/));
  const first = attempts()[0];
  assert.deepEqual([first.class, first.kind], ["cross-result-invalid", "format"]);
  assert.equal(readFileSync(join(root, first.rawPath!), "utf8"), "설명문만 있는 응답");
  assert.match(cross("- 없음"), /지적 없음 \(형식 교정\)/);
  assert.match(prompt(), new RegExp(`형식 교정[\\s\\S]*${first.rawPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 는 직전 교차 리뷰의 원문 응답이다`));
  assert.equal(attempts()[1].mode, "correct");
  assert.throws(() => cross("- 없음"), refusal(/이미 기록했습니다/));
});

test("형식 교정도 다시 형식 오류면 '남은 0회' 재실행 대신 사람 판단을 안내한다(E3)", async () => {
  await crossRepo(); fakeCodex();
  assert.throws(() => cross("설명문만 있는 응답"), refusal(/형식만 교정합니다\(남은 1회\)/));
  assert.throws(() => cross("또 설명문"), (error: Error) =>
    refusal(/형식 교정 재실행 한도를 다 써서 같은 명령은 다시 실행되지 않습니다[\s\S]*retry-grant crossFormat/)(error) && !/남은 0회/.test(error.message));
  assert.throws(() => cross("- 없음"), refusal(/한도 1회를 썼습니다/), "안내대로 다시 실행하지 않는다 — 실행하면 한도 거부다");
});

test("내용 오류(상태·경로·범위)도 기록 전에 걸러 형식만 교정한다 — 교정 프롬프트가 표 규칙을 다시 준다", async () => {
  await crossRepo(); fakeCodex();
  assert.throws(() => cross(`| X1 | ${CODE}:3 | 계획 안 | 미해결 | x |`), refusal(/형식이 맞지 않습니다[\s\S]*상태 칸[\s\S]*계획 파일 칸/));
  assert.equal(attempts()[0].kind, "content");
  assert.match(cross(`| X1 | ${CODE} | 계획 안 | 열림 | x (3줄) |`), /열린 지적 1개 \(형식 교정\)/);
  assert.match(prompt(), /상태는 `열림`·`해결` 둘 중 원문의 뜻대로/);
  assert.throws(() => next(root), /열린 지적: X1/);
});

test("F→X — 교차 결과의 F 번호를 X 로 다시 매겨 기록하고 독립 리뷰 지적으로 세지 않는다", async () => {
  await crossRepo(); fakeCodex();
  assert.match(cross(`| F1 | ${CODE} | 계획 안 | 열림 | x |`), /F 번호를 X 로 바꿔 기록했습니다/);
  assert.match(readFileSync(doc(), "utf8"), /## 교차 지적[\s\S]*\| X1 \| src\/value\.js/);
  assert.equal(attempts()[0].normalized, true);
  assert.throws(() => next(root), /열린 지적: X1\(src\/value\.js\)/);
  assert.match(prompt(), /역할 지침의 F 번호 대신 X 를 쓴다/);
});

// ---- 사람 판단: 지적 기각 ----

test("PVR-6: 사람이 기각한 지적은 표에 남고 게이트가 그 회차에서 세지 않는다 — ⑨·⑩ 에 기록이 남는다", async () => {
  await crossRepo(); fakeCodex();
  cross(X1_OPEN);
  assert.throws(() => previewWaiveFinding(root, "X9"), /기록된 교차 리뷰 결과에 X9 가 없습니다/);
  assert.throws(() => previewWaiveFinding(root, "C1"), /F<번호>\(독립 리뷰\) 또는 X<번호>/);
  assert.match(previewWaiveFinding(root, "X1"), /대상: X1 · 교차 리뷰\(codex\) · 1회차 · 계획 안 · src\/value\.js\n지적: 경계값 누락\n판단: 기각 — 이번 작업에서 고치지 않습니다/);
  assert.match(waiveFinding(root, "X1", "c0ffee00-1111-2222-3333-444444444444", "범위 밖으로 확인"), /X1 를 사람 판단으로 기록했습니다\(기각\)/);
  assert.throws(() => previewWaiveFinding(root, "X1"), /이미 사람 판단으로 기록했습니다/);
  const log = loadReview(root, ID, TARGET)!;
  assert.deepEqual([log.waivers![0].source, log.waivers![0].id, log.waivers![0].path], ["cross", "X1", CODE]);
  assert.match(readFileSync(doc(), "utf8"), /### 사람 판단\n\n- X1 \(src\/value\.js\) 기각 — 범위 밖으로 확인 · 1회차 · 동의 c0ffee00/);
  assert.match(readFileSync(doc(), "utf8"), new RegExp(X1_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "지적 줄은 그대로 남는다");
  next(root);
  assert.equal(loadActive(root)!.phase, "integrate");
  const block = renderTraceBlock(loadWork(root)!, loadEvidence(root, ID, TARGET));
  assert.match(block, /- 교차 리뷰: 1회차 completed\(열린 1\)/);
  assert.match(block, /- 사람 판단: X1\(src\/value\.js\) 기각 — 범위 밖으로 확인 · 1회차 · 동의 c0ffee00/);
  assert.doesNotMatch(renderTraceBlock(loadWork(root)!, loadEvidence(root, ID, TARGET), { legacy: true }), /교차 리뷰|사람 판단/);
});

test("기각할 것이 없는 지적(해결)은 거부하고, 다음 회차에는 지적 내용이 같을 때만 기각이 이어진다", async () => {
  await crossRepo(); fakeCodex();
  cross(`| X1 | ${CODE} | 계획 안 | 열림 | 경계값 누락 |\n| X2 | ${CODE} | 계획 안 | 해결 | 이미 고침 |`);
  assert.throws(() => previewWaiveFinding(root, "X2"), /X2 는 게이트를 막는 지적이 아닙니다\(해결·계획 안\)/);
  waiveFinding(root, "X1", "d00dfeed-0000-0000-0000-000000000000", "범위 밖");
  next(root); // integrate
  require("../agent/layout").saveActive(root, { ...loadActive(root)!, phase: "review" });
  await nextRound("module.exports=n=>{if(n<0)throw Error('negative!');return 1;};\n");
  // 같은 경로·같은 번호지만 다른 지적 — 다시 판단한다
  assert.match(cross(`| X1 | ${CODE} | 계획 안 | 열림 | 오류 메시지 오타 |`), /열린 지적 1개/);
  assert.match(prompt(), /참고 — 사람이 이번 작업에서 다루지 않기로 한 교차 지적이다[\s\S]*X1\(src\/value\.js\) 기각 — 범위 밖/);
  assert.doesNotMatch(prompt(), /게이트는 세지 않는다/);
  assert.throws(() => next(root), /열린 지적: X1\(src\/value\.js\) \(1회차 사람 판단과 지적 내용이 다릅니다 — 다시 판단\)/);
  require("../agent/layout").saveActive(root, { ...loadActive(root)!, phase: "review" });
  await nextRound("module.exports=n=>{if(n<0)throw Error('negative!!');return 1;};\n");
  // 같은 지적(공백만 다름)이면 이어진다
  cross(`| X1 | ${CODE} | 계획 안 | 열림 | 경계값   누락 |`);
  next(root);
  assert.equal(loadActive(root)!.phase, "integrate");
});

// ---- 리뷰어 실행 기록 ----

test("PVR-2: 완료된 회차의 리뷰어 재호출은 무시 기록만 하고 결과를 바꾸지 않는다", async () => {
  await crossRepo({ reviewer: false });
  const event = (agent: string) => ({ cwd: root, session_id: "s", agent_id: agent, agent_type: "ca-reviewer" });
  observeReviewer({ ...event("r1"), hook_event_name: "SubagentStart" });
  observeReviewer({ ...event("r1"), hook_event_name: "SubagentStop", last_assistant_message: `| F1 | ${CODE} | 계획 안 | 열림 | x |` });
  observeReviewer({ ...event("r2"), hook_event_name: "SubagentStart" });
  assert.equal(lastRound().reviewers![1].ignored!.reason, "completed-round");
  assert.throws(() => observeReviewer({ ...event("r2"), hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), RecordedFailure);
  process.env.CLAUDE_PROJECT_DIR = root;
  assert.equal(quiet(() => runReviewHook(JSON.stringify({ ...event("r2"), hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }))), 0);
  assert.equal(lastRound().reviewers![1].ignored!.result, "- 없음");
  assert.match(readFileSync(doc(), "utf8"), /## 지적\n\n\| F1 \|/);
  assert.match(readFileSync(doc(), "utf8"), /### 실행 기록\n\n- 1회차 리뷰어: 2회 호출 — 완료, 완료 뒤 재호출 무시/);
  assert.throws(() => next(root), /열린 지적: F1/);
});

test("동시 호출 — 먼저 시작한 실행만 결과가 되고, 먼저 끝난 나중 실행은 무시된다", async () => {
  await crossRepo({ reviewer: false });
  const event = (agent: string) => ({ cwd: root, session_id: "s", agent_id: agent, agent_type: "ca-reviewer" });
  observeReviewer({ ...event("r1"), hook_event_name: "SubagentStart" });
  observeReviewer({ ...event("r2"), hook_event_name: "SubagentStart" });
  assert.equal(lastRound().reviewers![1].ignored!.reason, "concurrent");
  assert.throws(() => observeReviewer({ ...event("r2"), hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }),
    (error: Error) => error instanceof RecordedFailure && /먼저 시작한 리뷰어/.test(error.message));
  observeReviewer({ ...event("r1"), hook_event_name: "SubagentStop", last_assistant_message: `| F1 | ${CODE} | 계획 안 | 열림 | x |` });
  assert.equal(lastRound().reviewer!.agentId, "r1");
  assert.throws(() => next(root), /열린 지적: F1/);
});

test("동시 호출(순서를 바꿔) — 먼저 시작한 실행이 먼저 끝나도 결과는 그 실행이고, 나중 실행의 결과는 무시된다", async () => {
  await crossRepo({ reviewer: false });
  const event = (agent: string) => ({ cwd: root, session_id: "s", agent_id: agent, agent_type: "ca-reviewer" });
  observeReviewer({ ...event("r1"), hook_event_name: "SubagentStart" });
  observeReviewer({ ...event("r2"), hook_event_name: "SubagentStart" });
  observeReviewer({ ...event("r1"), hook_event_name: "SubagentStop", last_assistant_message: `| F1 | ${CODE} | 계획 안 | 열림 | x |` });
  assert.throws(() => observeReviewer({ ...event("r2"), hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), RecordedFailure);
  assert.deepEqual([lastRound().reviewers![1].ignored!.reason, lastRound().reviewers![1].ignored!.result], ["concurrent", "- 없음"]);
  assert.equal(lastRound().reviewer!.agentId, "r1");
  assert.match(readFileSync(doc(), "utf8"), /## 지적\n\n\| F1 \|/);
  assert.throws(() => next(root), /열린 지적: F1/);
});

test("리뷰어 내용 오류를 고치지 않고 stop_hook_active 로 끝내면 형식 오류로 기록하고, 새 리뷰어를 부를 수 있다(남은 1회)", async () => {
  await crossRepo({ reviewer: false });
  const event = (agent: string) => ({ cwd: root, session_id: "s", agent_id: agent, agent_type: "ca-reviewer" });
  process.env.CLAUDE_PROJECT_DIR = root;
  const bad = `| F1 | ${CODE}:12 | 계획 안 | 열림(경미) | x |`;
  const stop = (agent: string, extra = {}) => quiet(() => runReviewHook(JSON.stringify({ ...event(agent), hook_event_name: "SubagentStop", last_assistant_message: bad, ...extra })));
  observeReviewer({ ...event("r1"), hook_event_name: "SubagentStart" });
  assert.equal(stop("r1"), 2);
  assert.equal(stop("r1", { stop_hook_active: true }), 0);
  assert.equal(lastRound().reviewers![0].failure!.class, "agent-format-error");
  assert.throws(() => next(root), /형식 오류 1회 기록\) — ca-reviewer 를 새로 호출하세요\(이 회차 남은 호출 1회\)/);
  observeReviewer({ ...event("r2"), hook_event_name: "SubagentStart" });
  assert.equal(lastRound().reviewers![1].ignored, undefined, "새 호출을 받아들인다");
  observeReviewer({ ...event("r2"), hook_event_name: "SubagentStop", last_assistant_message: "- 없음" });
  assert.equal(lastRound().reviewer!.agentId, "r2");
});

test("리뷰 도중 계획 파일이 바뀌면 완료 hook 은 같은 리뷰어에게 되돌리지 않고 hook 판정 실패로 기록한다 — 게이트가 '실행 중' 에 갇히지 않는다(E19)", async () => {
  await crossRepo({ reviewer: false });
  const event = { cwd: root, session_id: "s", agent_id: "r1", agent_type: "ca-reviewer" };
  process.env.CLAUDE_PROJECT_DIR = root;
  observeReviewer({ ...event, hook_event_name: "SubagentStart" });
  writeFixture(root, CODE, "module.exports = () => 2; // 사람이 리뷰 중에 고쳤다\n");
  assert.equal(quiet(() => runReviewHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }))), 0);
  const run = lastRound().reviewers![0];
  assert.deepEqual([run.failure?.class, run.completedAt], ["hook-failure", undefined]);
  assert.match(run.failure!.detail, /리뷰 도중 코드·계획·경계가 바뀌었습니다/);
  const problems = reviewProblems(loadWork(root)!).join("\n");
  assert.doesNotMatch(problems, /독립 리뷰어가 실행 중입니다/);
  assert.match(problems, /1회차 뒤 계획 파일이 바뀌었습니다/);
});

test("멈춘 리뷰어 — 15분이 지나면 고아로 보고 새 호출을 받으며, 형식 오류로 끝난 같은 agent 의 재개는 새 실행이다", async () => {
  await crossRepo({ reviewer: false });
  const event = (agent: string) => ({ cwd: root, session_id: "s", agent_id: agent, agent_type: "ca-reviewer" });
  observeReviewer({ ...event("r1"), hook_event_name: "SubagentStart" });
  assert.throws(() => next(root), /독립 리뷰어가 실행 중입니다[\s\S]*15분 뒤부터[\s\S]*남은 호출 1회/);
  mutateReview(root, ID, TARGET, (log) => { log!.rounds.at(-1)!.reviewers![0].startedAt = new Date(Date.now() - 16 * 60_000).toISOString(); return { log: log!, value: 0 }; });
  assert.throws(() => next(root), /멈춘 실행으로 보고 ca-reviewer 를 새로 호출하세요\(남은 1회\)/);
  observeReviewer({ ...event("r2"), hook_event_name: "SubagentStart" });
  assert.equal(lastRound().reviewers![0].ignored!.reason, "orphaned");
  assert.equal(lastRound().reviewers![1].ignored, undefined);
  assert.throws(() => observeReviewer({ ...event("r1"), hook_event_name: "SubagentStop", last_assistant_message: "- 없음" }), /멈춘 실행으로 처리한 리뷰어/);
  // r2 는 형식 오류로 기록 → 같은 agent 의 재개 Start 는 새 실행(호출 한도 2 를 넘으면 무시)
  assert.throws(() => observeReviewer({ ...event("r2"), hook_event_name: "SubagentStop", last_assistant_message: "검토 완료", stop_hook_active: true }),
    (error: Error) => error instanceof RecordedFailure && /형식 오류를 기록했습니다[\s\S]*남은 호출 0회/.test(error.message));
  assert.equal(lastRound().reviewers![1].failure!.class, "agent-format-error");
  observeReviewer({ ...event("r2"), hook_event_name: "SubagentStart" });
  assert.deepEqual([lastRound().reviewers![2].resumed, lastRound().reviewers![2].ignored?.reason], [true, "run-limit"]);
  assert.throws(() => next(root), /리뷰어 호출 한도 2회를 모두 썼습니다\(형식 오류 1회\)[\s\S]*retry-grant reviewerRuns/);
});

test("리뷰어 형식·내용 오류(Claude) — 한 번 같은 담당에게 돌려보내고, 고치면 같은 실행이 완료한다", async () => {
  await crossRepo({ reviewer: false });
  const event = { cwd: root, session_id: "s", agent_id: "r1", agent_type: "ca-reviewer" };
  process.env.CLAUDE_PROJECT_DIR = root;
  observeReviewer({ ...event, hook_event_name: "SubagentStart" });
  const stop = (message: string, extra = {}) => quiet(() => runReviewHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: message, ...extra })));
  assert.equal(stop(`| F1 | ${CODE}:12 | 계획 안 | 열림(경미) | x |`), 2);
  assert.equal(lastRound().reviewers![0].returns, 1);
  assert.equal(lastRound().reviewers![0].result, undefined);
  assert.equal(stop(`| F1 | ${CODE} | 계획 안 | 열림 | x (12줄) |`), 0);
  assert.equal(lastRound().reviewer!.result, `| F1 | ${CODE} | 계획 안 | 열림 | x (12줄) |`);
});

test("Codex 리뷰어의 형식 오류는 되돌리지 않고 바로 기록한다 — hook 은 {} 와 0", async () => {
  await crossRepo({ reviewer: false });
  const event = { cwd: root, session_id: "s", agent_id: "r1", agent_type: "ca_reviewer" };
  codexHook({ ...event, hook_event_name: "SubagentStart" });
  const saved = process.stdout.write; let out = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  let code: number;
  try { code = quiet(() => runCodexHook(JSON.stringify({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "검토 완료" }))); }
  finally { process.stdout.write = saved; }
  assert.equal(code, 0);
  assert.equal(out, "{}");
  assert.deepEqual([lastRound().reviewers![0].host, lastRound().reviewers![0].failure!.class], ["codex", "agent-format-error"]);
});

test("옛 기록 출구 — 표 규칙에 어긋난 옛 리뷰어 완료 결과는 유효하지 않아 새로 부를 수 있고, 옛 교차 결과는 원문을 옮겨 형식만 교정한다", async () => {
  await crossRepo({ reviewer: false });
  const bad = `| F1 | ${CODE} | 계획 안 | 미해결 | x |`;
  const oldCross = "| X1 | `src/value.js` | 계획 안 | 열림 | 음수 경계 누락(실제 결함) |";
  mutateReview(root, ID, TARGET, (log) => {
    const last = log!.rounds.at(-1)!;
    delete last.reviewers;
    last.reviewer = { sessionId: "old", agentId: "old", startedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:01:00.000Z", result: bad };
    last.cross = { host: "codex", model: "m", startedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:01:00.000Z", result: oldCross };
    delete last.crossAttempts;
    return { log: log!, value: 0 };
  }, { document: (text) => text.replace("## 지적\n\n- 없음", `## 지적\n\n${bad}`) });
  const problems = reviewProblems(loadWork(root)!).join("\n");
  assert.match(problems, /기록된 리뷰어 결과가 표 규칙\(상태·범위·경로\)에 맞지 않습니다[\s\S]*새로 호출하세요\(남은 1회\)/);
  assert.match(problems, /직전 실행: 막힘\(형식 오류\)[\s\S]*옛 기록의 교차 결과\(같은 명령이 handoff 로 옮긴다\)[\s\S]*형식만 교정합니다\(남은 1회\)/);
  const event = { cwd: root, session_id: "s", agent_id: "new", agent_type: "ca-reviewer" };
  observeReviewer({ ...event, hook_event_name: "SubagentStart" });
  observeReviewer({ ...event, hook_event_name: "SubagentStop", last_assistant_message: "- 없음" });
  assert.equal(lastRound().reviewer!.agentId, "new");
  fakeCodex();
  // 처음부터 다시 실행하지 않는다 — 옛 결과 원문을 handoff 로 옮기고, 판단은 그대로 둔 채 형식만 교정한다
  assert.match(cross(`| X1 | ${CODE} | 계획 안 | 열림 | 음수 경계 누락(실제 결함) |`), /열린 지적 1개 \(형식 교정\)/);
  const [legacy, corrected] = attempts();
  assert.deepEqual([legacy.class, legacy.result, corrected.mode, corrected.class], ["cross-result-invalid", oldCross, "correct", "completed"], "옛 추정 1 + 형식 교정 1");
  assert.equal(readFileSync(join(root, legacy.rawPath!), "utf8"), oldCross, "옛 결과 원문을 handoff 에 보존한다");
  assert.match(prompt(), new RegExp(`형식 교정[\\s\\S]*${legacy.rawPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 는 직전 교차 리뷰의 원문 응답이다`));
  assert.throws(() => next(root), /열린 지적: X1/);
});

// ---- 잠금·마지막 회차 ----

test("VER-M1: 다른 호스트를 실행하는 동안 기록된 리뷰어 결과와 used 가 끝 기록에 덮이지 않는다", async () => {
  await crossRepo({ reviewer: false });
  process.env.FAKE_DIST = resolve(__dirname, "..");
  fakeCodex([
    "const { observeReviewer } = require(process.env.FAKE_DIST + '/agent/reviewHook');",
    "const { mutateReview } = require(process.env.FAKE_DIST + '/agent/review');",
    "const { loadActive } = require(process.env.FAKE_DIST + '/agent/layout');",
    "const root = process.cwd(), active = loadActive(root);",
    "const event = { cwd: root, session_id: 'race', agent_id: 'race', agent_type: 'ca-reviewer' };",
    "observeReviewer({ ...event, hook_event_name: 'SubagentStart' });",
    "observeReviewer({ ...event, hook_event_name: 'SubagentStop', last_assistant_message: '- 없음' });",
    "mutateReview(root, active.id, active.target, (log) => { log.used = [...(log.used || []), { id: 'F9', path: 'tests/value.test.js', round: 1 }]; return { log, value: 0 }; });",
    "fs.writeFileSync(out, '- 없음');",
  ].join("\n"));
  assert.match(cross(), /지적 없음/);
  const log = loadReview(root, ID, TARGET)!;
  assert.equal(log.rounds[0].reviewer!.result, "- 없음");
  assert.deepEqual(log.used, [{ id: "F9", path: "tests/value.test.js", round: 1 }]);
  assert.equal(log.rounds[0].crossAttempts![0].class, "completed");
});

test("⑨ 는 마지막 회차의 교차 결과만 쓴다 — 실행 중 다음 회차가 열리면 이전 회차 결과는 기록만 남긴다", async () => {
  await crossRepo(); process.env.FAKE_DIST = resolve(__dirname, "..");
  fakeCodex([
    "const { mutateReview } = require(process.env.FAKE_DIST + '/agent/review');",
    "const { loadActive } = require(process.env.FAKE_DIST + '/agent/layout');",
    "const root = process.cwd(), active = loadActive(root);",
    "mutateReview(root, active.id, active.target, (log) => { const last = log.rounds[log.rounds.length - 1];",
    "  log.rounds.push({ round: 2, at: new Date().toISOString(), treeHash: 'sha256:other', baseCommit: last.baseCommit, planHash: last.planHash, manifestHash: last.manifestHash }); return { log, value: 0 }; });",
    `fs.writeFileSync(out, ${JSON.stringify(X1_OPEN)});`,
  ].join("\n"));
  assert.match(cross(), /지금은 2회차라 ⑨ 는 바꾸지 않았습니다/);
  const log = loadReview(root, ID, TARGET)!;
  assert.equal(log.rounds[0].crossAttempts![0].class, "completed");
  assert.doesNotMatch(readFileSync(doc(), "utf8"), /\| X1 \|/);
});

test("리뷰 회차를 열 때 이전 묶임의 사람 판단·허용·교차 기록·used·limit 를 보존하고, 묶임이 바뀌면 함께 버린다", async () => {
  await crossRepo(); fakeCodex();
  cross(X1_OPEN);
  waiveFinding(root, "X1", "keep0000-0000-0000-0000-000000000000", "범위 밖");
  mutateReview(root, ID, TARGET, (log) => {
    log!.grants = [{ key: "reviewerRuns", scope: "round:1", step: 1, consent: "g", at: "t", reason: "r" }];
    log!.used = [{ id: "F9", path: "tests/value.test.js", round: 1 }];
    return { log: log!, value: 0 };
  });
  writeFixture(root, CODE, "module.exports=n=>{if(n<0)throw Error('negative');return 1;}; // 2\n");
  await check(requireValidatable(root, "check")); next(root);
  await runTests(requireValidatable(root, "test")); next(root);
  openRound(requireValidatable(root, "review"));
  const log = loadReview(root, ID, TARGET)!;
  assert.equal(log.rounds.length, 2);
  assert.deepEqual([log.limit, log.grants!.length, log.waivers!.length, log.used!.length, log.rounds[0].crossAttempts!.length], [3, 1, 1, 1, 1]);
  // 묶임 변경(stale) — 같은 함수가 쓰는 꼴을 확인한다
  saveReview(root, { ...log, rounds: log.rounds.map((round) => ({ ...round, planHash: "sha256:old-plan" })) });
  writeFixture(root, CODE, "module.exports=n=>{if(n<0)throw Error('negative');return 1;}; // 3\n");
  await check(requireValidatable(root, "check")); next(root);
  await runTests(requireValidatable(root, "test")); next(root);
  openRound(requireValidatable(root, "review"));
  const reset = loadReview(root, ID, TARGET)!;
  assert.deepEqual([reset.rounds.length, reset.limit, reset.grants, reset.waivers, reset.used], [1, 3, [], [], []]);
});

// ---- 호스트·자식·샌드박스 ----

test("PVR-11: 같은 호스트의 --by 를 거부하고, 교차 자식 안에서는 다시 실행하지 않으며, 지점의 호스트는 첫 시도로 고정한다", async () => {
  await crossRepo(); fakeCodex("process.stderr.write(\"error: unexpected argument '--x' found\\n\"); process.exit(2);");
  assert.throws(() => withCaller("claude", () => crossReview(root, "claude")), refusal(/지금 작업 중인 호스트가 claude 입니다 — 교차 검증은 다른 호스트가 맡습니다: --by codex/));
  assert.throws(() => withCaller("codex", () => crossReview(root, "codex")), refusal(/--by claude/));
  assert.throws(() => withCaller(undefined, () => { process.env.CODE_AGENT_CROSS = "codex"; return crossReview(root, "codex"); }), refusal(/교차 실행 안에서는 교차 검증을 다시 실행하지 않습니다/));
  delete process.env.CODE_AGENT_CROSS;
  assert.throws(() => cross(), RetryRefused);
  assert.equal(attempts()[0].caller, "claude");
  assert.throws(() => withCaller(undefined, () => crossReview(root, "claude")), refusal(/이 회차의 교차 검증은 codex 로 시작했습니다/));
  assert.throws(() => withCaller(undefined, () => crossReview(root, "gemini")), /--by claude 또는 --by codex/);
});

test("HP-12: 교차 자식(CODE_AGENT_CROSS) 안에서는 Stop·SessionStart·리뷰어·계획 담당·Codex 진행 이벤트가 아무것도 하지 않고, PreToolUse 판정은 그대로다", async () => {
  await crossRepo({ reviewer: false });
  writeFixture(root, `doc/work/${ID}/questions.md`, "# 질문\n\n## Q9 · 확인\n범위?\n[Answer]:\n");
  process.env.CLAUDE_PROJECT_DIR = root;
  const before = readFileSync(join(root, `.code-agent/work/${ID}/${TARGET}.review.json`), "utf8");
  process.env.CODE_AGENT_CROSS = "claude";
  const saved = process.stdout.write; let out = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try {
    assert.equal(runStopHook(JSON.stringify({ cwd: root, hook_event_name: "Stop" })), 0);
    assert.equal(runSessionHook(JSON.stringify({ cwd: root, source: "startup" })), 0);
    assert.equal(runReviewHook(JSON.stringify({ cwd: root, hook_event_name: "SubagentStart", session_id: "s", agent_id: "r", agent_type: "ca-reviewer" })), 0);
    assert.equal(runPlanningHook(JSON.stringify({ cwd: root, hook_event_name: "SubagentStart", session_id: "s", agent_id: "p", agent_type: "ca-analyst" })), 0);
  } finally { process.stdout.write = saved; }
  assert.equal(out, "", "stdout 에 아무것도 내지 않는다");
  assert.equal(readFileSync(join(root, `.code-agent/work/${ID}/${TARGET}.review.json`), "utf8"), before);
  assert.deepEqual(codexHook({ cwd: root, hook_event_name: "Stop", session_id: "s" }), {});
  assert.deepEqual(codexHook({ cwd: root, hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "t", prompt: `code-agent consent respond ${"0".repeat(8)}-0000-0000-0000-000000000000 1` }), {});
  const denied = codexHook({ cwd: root, hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "cat ~/.code-agent/credentials.json" } }) as { hookSpecificOutput?: { permissionDecision: string } };
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny", "PreToolUse 판정은 교차 자식에서도 그대로다");
  // 교차 자식은 진행 명령·쓰기를 하지 않는다 — 읽기 전용 명령만 연다(Claude·Codex 같은 판정)
  const child = /교차 실행\(CODE_AGENT_CROSS\) 안에서는 작업을 진행하거나 파일을 고치지 않습니다/;
  for (const command of ["code-agent next", "code-agent check", "code-agent review", "code-agent planning advance", "code-agent read src/value.js && code-agent next"]) {
    assert.match(guardTool({ cwd: root, tool_name: "Bash", tool_input: { command } }) ?? "", child, command);
  }
  assert.match(guardTool({ cwd: root, tool_name: "Write", tool_input: { file_path: join(root, CODE) } }) ?? "", child);
  assert.equal(guardTool({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent read src/value.js" } }), undefined, "읽기는 연다");
  assert.equal(guardTool({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent status" } }), undefined);
  assert.equal(guardTool({ cwd: root, tool_name: "Read", tool_input: { file_path: join(root, CODE) } }), undefined);
  const codexDeny = (input: Record<string, unknown>) => (codexHook({ cwd: root, hook_event_name: "PreToolUse", session_id: "s", ...input }) as { hookSpecificOutput?: { permissionDecisionReason: string } }).hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.match(codexDeny({ tool_name: "Bash", tool_input: { command: "code-agent check" } }), child);
  assert.match(codexDeny({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${CODE}\n@@\n-a\n+b\n*** End Patch` } }), child);
  assert.equal(codexDeny({ tool_name: "Bash", tool_input: { command: "code-agent read src/value.js" } }), "");
  delete process.env.CODE_AGENT_CROSS;
  assert.ok(guardTool({ cwd: root, tool_name: "Bash", tool_input: { command: "cat ~/.code-agent/credentials.json" } }));
  assert.equal(guardTool({ cwd: root, tool_name: "Bash", tool_input: { command: "code-agent next" } }), undefined, "교차 자식이 아니면 그대로다");
});

test("HP-8·VER-M2: Codex 샌드박스 표지가 있으면 claude 를 띄우기 전에 멈추고 권한 상승을 안내한다 — 중지가 아니라 막힘", async () => {
  await crossRepo();
  const claude = join(fakeDir, "claude.cjs");
  writeFileSync(claude, "require('fs').appendFileSync(process.env.FAKE_CALLS, 'x'); process.stdout.write(JSON.stringify({ result: '- 없음' }));\n");
  process.env.CODE_AGENT_CLAUDE_BIN = claude; process.env.FAKE_CALLS = join(fakeDir, "calls.txt");
  assert.throws(() => withCaller("codex", () => { process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1"; return crossReview(root, "claude"); }),
    refusal(/Codex 샌드박스가 claude 실행을 막았습니다[\s\S]*권한 상승/));
  assert.equal(calls(), 0);
  assert.deepEqual([attempts()[0].mode, attempts()[0].class, attempts()[0].kind], ["preflight", "host-sandbox-denied", "preflight"]);
  // 같은 사전 거부를 되풀이해도 같은 거부만 내고 기록은 한 번이다(E18 — 지점 시도에 세지 않는 거부가 끝없이 쌓이지 않는다)
  for (let i = 0; i < 3; i++) {
    assert.throws(() => withCaller("codex", () => { process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1"; return crossReview(root, "claude"); }), refusal(/권한 상승/));
  }
  assert.equal(attempts().length, 1);
  assert.throws(() => next(root), /교차 리뷰가 필요합니다[\s\S]*막힘\(샌드박스\)/);
  assert.match(previewCrossStop(root, "review"), /시도 1회\(host-sandbox-denied/, "사용자가 권한 상승을 거절하면 사람 중지를 고를 수 있다");
  // 사전 판정은 다른 호스트를 띄우지 않았으므로 지점 호스트를 고정하지 않는다 — Claude Code 로 옮겨 --by codex 로 이어 간다
  delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  assert.ok(withCaller("claude", () => reviewProblems(loadWork(root)!)).some((problem) => /review cross --by codex/.test(problem)), "게이트 안내도 고정되지 않은 호스트를 권한다");
  fakeCodex();
  assert.match(cross("- 없음"), /codex\([^)]*\) 교차 리뷰를 1회차에 기록했습니다 — 지적 없음/);
  assert.deepEqual(attempts().map((attempt) => [attempt.host, attempt.mode, attempt.class]), [["claude", "preflight", "host-sandbox-denied"], ["codex", "review", "completed"]]);
  assert.throws(() => withCaller("codex", () => crossReview(root, "claude")), refusal(/이 회차의 교차 검증은 codex 로 시작했습니다/), "실제로 띄운 첫 시도가 호스트를 고정한다");
  assert.match(readFileSync(doc(), "utf8"), /- 1회차 [^\n]*교차\(codex\): 샌드박스, completed/);
});

/** 가짜 claude — 호출 수를 남기고 stderr 에 text 를 쓰고 exit 1 로 끝난다 */
function failingClaude(text: string): void {
  const claude = join(fakeDir, "claude.cjs");
  writeFileSync(claude, `require('fs').appendFileSync(process.env.FAKE_CALLS, 'x'); process.stderr.write(${JSON.stringify(text)}); process.exit(1);\n`);
  process.env.CODE_AGENT_CLAUDE_BIN = claude; process.env.FAKE_CALLS = join(fakeDir, "calls.txt");
}
const NETWORK_ERROR = "Error: getaddrinfo ENOTFOUND api.anthropic.com\n";
const byClaude = () => withCaller("codex", () => crossReview(root, "claude"));
const crossGate = () => withCaller("codex", () => reviewProblems(loadWork(root)!)).find((problem) => /교차 리뷰가 필요합니다/.test(problem)) ?? "";
const rejects = (pattern: RegExp, absent?: RegExp) => (error: Error) => error instanceof RetryRefused && pattern.test(error.message) && !(absent?.test(error.message) ?? false);

test("H2 Windows Codex 의 권한 상승한 셸(표지가 남는다) — 연결 확인이 되면 사전 거부하지 않고 claude 를 띄운다. 사전 거부 뒤 권한 상승한 재실행이 같은 거부에 갇히지 않는다", async () => {
  await crossRepo();
  const claude = join(fakeDir, "claude.cjs");
  writeFileSync(claude, "require('fs').appendFileSync(process.env.FAKE_CALLS, 'x'); process.stdout.write(JSON.stringify({ result: '- 없음' }));\n");
  process.env.CODE_AGENT_CLAUDE_BIN = claude; process.env.FAKE_CALLS = join(fakeDir, "calls.txt");
  const seen: string[] = [];
  const marked = () => withCaller("codex", () => { process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1"; return crossReview(root, "claude"); });
  netProbeRunner.connect = (host, port) => { seen.push(`${host}:${port}`); return "EACCES"; };
  assert.throws(marked, refusal(/샌드박스가 claude 실행을 막았습니다[\s\S]*연결 확인 api\.anthropic\.com:443 EACCES\)[\s\S]*권한 상승/));
  assert.equal(calls(), 0);
  // 게이트 줄 — 안내 문구가 사유를 싣으므로 '직전 실행:' 뒤에는 라벨만 둔다(같은 사유가 한 줄에 두 번 나오지 않는다)
  const gate = crossGate();
  assert.match(gate, /직전 실행: 막힘\(샌드박스\)\. Codex 샌드박스가 claude 실행을 막았습니다\(/);
  assert.equal(gate.split("연결 확인 api.anthropic.com:443 EACCES").length, 2, gate);
  netProbeRunner.connect = (host, port) => { seen.push(`${host}:${port}`); return "ok"; };
  assert.match(marked(), /claude\([^)]*\) 교차 리뷰를 1회차에 기록했습니다 — 지적 없음/);
  assert.equal(calls(), 1);
  assert.deepEqual(attempts().map((attempt) => [attempt.mode, attempt.class]), [["preflight", "host-sandbox-denied"], ["review", "completed"]]);
  assert.deepEqual(seen, ["api.anthropic.com:443", "api.anthropic.com:443"]);
});

test("H2 연결 확인을 지난 셸의 claude 네트워크 오류는 그대로 샌드박스 네트워크 차단이다 — 시간 초과·연결 거부는 사전 거부하지 않지만 중지도 기록하지 않는다(D2 유지)", async () => {
  await crossRepo(); failingClaude(NETWORK_ERROR);
  for (const result of ["timeout", "ECONNREFUSED"]) {
    netProbeRunner.connect = () => result;
    assert.throws(() => withCaller("codex", () => { process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1"; return crossReview(root, "claude"); }), rejects(/./));
  }
  assert.equal(calls(), 2, "두 번 모두 claude 를 띄웠다");
  assert.deepEqual(attempts().map((attempt) => [attempt.mode, attempt.class, attempt.kind]),
    [["review", "host-sandbox-denied", "sandbox-network"], ["review", "host-sandbox-denied", "sandbox-network"]]);
  assert.doesNotMatch(readFileSync(doc(), "utf8"), /교차 검증 중지/);
  // 표지가 없는 셸·--by codex 는 연결 확인을 하지 않는다
  netProbeRunner.connect = () => { throw new Error("연결 확인을 하면 안 된다"); };
  fakeCodex();
  assert.throws(() => withCaller("claude", () => crossReview(root, "codex")), /claude 로 시작했습니다/);
});

test("D2(E16): Codex 에서 부른 --by claude 의 네트워크 오류는 같은 지점에서 몇 번째든 샌드박스 거부로 막는다 — 첫 번째는 권한 상승, 두 번째부터 사람에게 넘기고, 지점 시도 한도에서 멈춘다(2026-10-08 사용자 결정)", async () => {
  await crossRepo(); failingClaude(NETWORK_ERROR);
  // 1번째 — 셸에 표지가 없어도 샌드박스 차단으로 보고 권한 상승해 같은 명령을 안내한다
  assert.throws(byClaude, rejects(/Codex 샌드박스가 claude 실행을 막았습니다[\s\S]*샌드박스 표지는 없지만[\s\S]*실행 불가로 기록하지 않습니다[\s\S]*권한 상승/));
  assert.match(crossGate(), /막힘\(샌드박스\)/, "중지가 아니라 막힘 — 필수 교차 검증이 조용히 빠지지 않는다");
  // 2번째 — 권한 상승 뒤에도 같으면 실제 네트워크 문제일 수 있다: 사람이 네트워크를 확인해 다시 실행하거나 중지를 정한다
  const REPEAT = /다시 네트워크 오류로 끝났습니다[\s\S]*실제 네트워크 문제일 수 있습니다[\s\S]*남은 지점 시도 1회[\s\S]*judgment cross-stop[\s\S]*사용자 확인 없이 중지를 기록하지 않습니다/;
  assert.throws(byClaude, rejects(REPEAT, /교차 검증 중지/));
  assert.match(crossGate(), /막힘\(샌드박스\)[\s\S]*다시 네트워크 오류로 끝났습니다[\s\S]*남은 지점 시도 1회/, "게이트 줄도 같은 변형을 싣는다");
  assert.throws(() => withCaller("codex", () => next(root)), /교차 리뷰가 필요합니다/);
  // 3번째 — 지점 시도 한도를 다 썼다: 같은 명령을 다시 권하지 않는다
  assert.throws(byClaude, rejects(/다시 네트워크 오류로 끝났습니다[\s\S]*교차 실행 한도를 다 써서[\s\S]*retry-grant crossPoint[\s\S]*사용자 확인 없이 중지를 기록하지 않습니다/, /남은 지점 시도|교차 검증 중지/));
  assert.match(crossGate(), /이 지점의 교차 실행 한도 3회를 모두 썼습니다[\s\S]*judgment cross-stop 또는 retry-grant crossPoint/, "한도를 다 쓴 게이트 줄은 사람 판단만 낸다");
  // 4번째 — 실행 전 지점 한도 거부, claude 를 띄우지 않고 기록도 늘지 않는다
  assert.throws(byClaude, rejects(/이 지점의 교차 실행 한도 3회를 모두 썼습니다[\s\S]*judgment cross-stop 또는 retry-grant crossPoint/));
  assert.equal(calls(), 3);
  assert.deepEqual(attempts().map((attempt) => [attempt.class, attempt.kind]), Array.from({ length: 3 }, () => ["host-sandbox-denied", "sandbox-network"]));
  assert.doesNotMatch(readFileSync(doc(), "utf8"), /교차 검증 중지/, "모델이 혼자 중지를 기록하지 않는다");
  assert.throws(() => withCaller("codex", () => next(root)), /교차 리뷰가 필요합니다/);
});

test("D2(E16): 네트워크 오류가 되풀이된 지점은 사람의 judgment cross-stop 동의로 중지를 기록하고 진행한다", async () => {
  await crossRepo(); failingClaude(NETWORK_ERROR);
  assert.throws(byClaude, RetryRefused);
  assert.throws(byClaude, RetryRefused);
  assert.match(previewCrossStop(root, "review"), /지점: 리뷰 1회차 · claude · 시도 2회\(host-sandbox-denied[\s\S]*사람이 중지로 기록합니다/);
  const { result } = approveAndApplyFixture(root, { action: "judgment", kind: "cross-stop", name: "review", comment: "사용자가 네트워크를 확인했지만 claude 에 닿지 않음" });
  assert.match(result, /사람 판단으로 중지했습니다/);
  assert.deepEqual([attempts().at(-1)!.class, attempts().at(-1)!.mode], ["cross-stop", "human"]);
  assert.match(readFileSync(doc(), "utf8"), /- 교차 검증 중지 — 사람 판단\(동의 [0-9a-f]{8}\): 사용자가 네트워크를 확인했지만 claude 에 닿지 않음/);
  assert.equal(calls(), 2);
  withCaller("codex", () => next(root));
  assert.equal(loadActive(root)!.phase, "integrate");
});

test("D2(E16): 바꾸지 않는 갈래 — Claude 메인이 부른 codex 의 네트워크 오류는 실행 불가로 중지를 기록하고 진행한다", async () => {
  await crossRepo();
  fakeCodex("process.stderr.write('ERROR: network error: Could not resolve host api.openai.com'); process.exit(1);");
  assert.match(cross(), /교차 검증 중지[\s\S]*네트워크/);
  assert.deepEqual([attempts()[0].class, attempts()[0].kind], ["cross-unavailable", "network"]);
  assert.equal(reviewProblems(loadWork(root)!).filter((problem) => /교차/.test(problem)).length, 0, "중지 지점 — 게이트는 막히지 않는다");
});

test("D2(E16) 반박 검증: Codex 에서 부른 적이 있는 지점은 호스트 표지가 없는 셸(사람의 터미널)이나 두 호스트 표지가 섞인 셸에서 다시 실행해도 네트워크 오류를 막힘으로 둔다 — 그 지점의 중지는 사람 판단으로만 기록한다", async () => {
  await crossRepo(); failingClaude(NETWORK_ERROR);
  assert.throws(byClaude, rejects(/샌드박스 표지는 없지만 Codex 가 부른 claude 의 네트워크 오류라/));
  // 표지 없는 셸 — 부른 쪽을 판별하지 못해도 지점 이력(앞선 시도의 부른 쪽 codex)으로 샌드박스 의심을 이어 간다
  assert.throws(() => withCaller(undefined, () => crossReview(root, "claude")),
    rejects(/다시 네트워크 오류로 끝났습니다[\s\S]*샌드박스 표지는 없지만 Codex 에서 부른 claude 지점의 네트워크 오류라[\s\S]*남은 지점 시도 1회/, /교차 검증 중지/));
  // 두 호스트 표지가 섞인 셸(runtimeHost 판별 불가)도 같다
  assert.throws(() => withCaller("codex", () => { process.env.CLAUDECODE = "1"; return crossReview(root, "claude"); }),
    rejects(/Codex 에서 부른 claude 지점의 네트워크 오류라[\s\S]*교차 실행 한도를 다 써서/, /교차 검증 중지/));
  assert.deepEqual(attempts().map((attempt) => [attempt.class, attempt.kind, attempt.caller ?? "-"]),
    [["host-sandbox-denied", "sandbox-network", "codex"], ["host-sandbox-denied", "sandbox-network", "-"], ["host-sandbox-denied", "sandbox-network", "-"]]);
  assert.doesNotMatch(readFileSync(doc(), "utf8"), /교차 검증 중지/, "사람 판단 없이 중지를 기록하지 않는다");
  for (const caller of ["codex", undefined] as const) assert.throws(() => withCaller(caller, () => next(root)), /교차 리뷰가 필요합니다/);
});

test("D2(E16) 바꾸지 않는 갈래(반박 검증) — Codex 에서 부른 적이 없는 지점을 표지 없는 셸에서 실행한 claude 의 네트워크 오류는 실행 불가로 중지를 기록하고 진행한다", async () => {
  await crossRepo(); failingClaude(NETWORK_ERROR);
  assert.match(withCaller(undefined, () => crossReview(root, "claude")), /교차 검증 중지[\s\S]*네트워크/);
  assert.deepEqual([attempts()[0].class, attempts()[0].kind], ["cross-unavailable", "network"]);
  assert.equal(crossGate(), "");
});

test("D2(E16) 반박 검증: 사전 판정 거부(샌드박스 표지) 뒤 표지 없이 실행한 첫 네트워크 오류는 권한 상승 뒤의 오류로 보고 사람에게 넘긴다", async () => {
  await crossRepo(); failingClaude(NETWORK_ERROR);
  assert.throws(() => withCaller("codex", () => { process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1"; return crossReview(root, "claude"); }), rejects(/셸 도구의 권한 상승\(샌드박스 밖 실행\)을 요청해/));
  assert.equal(calls(), 0);
  // 권한 상승 안내는 사전 거부가 이미 냈다 — 같은 안내를 되풀이하지 않고 사용자에게 넘긴다(지점 시도 3회 중 2회가 남는다)
  assert.throws(byClaude, rejects(/다시 네트워크 오류로 끝났습니다[\s\S]*권한 상승\(샌드박스 밖 실행\)으로 실행했는데도 같다면[\s\S]*남은 지점 시도 2회[\s\S]*사용자 확인 없이 중지를 기록하지 않습니다/,
    /셸 도구의 권한 상승\(샌드박스 밖 실행\)을 요청해/));
  assert.match(crossGate(), /다시 네트워크 오류로 끝났습니다[\s\S]*남은 지점 시도 2회/);
  assert.deepEqual(attempts().map((attempt) => [attempt.mode, attempt.kind]), [["preflight", "preflight"], ["review", "sandbox-network"]]);
});

test("D2(E16) 반박 검증: 사람에게 넘긴 네트워크 지점의 게이트 줄과 status 다음: 은 실행 명령을 앞세우지 않고, 사용자 확인 뒤의 재실행 명령을 안내 뒤에 싣는다", async () => {
  await crossRepo(); failingClaude(NETWORK_ERROR);
  assert.throws(byClaude, RetryRefused);
  assert.match(crossGate(), /^두 호스트가 설치된 프로젝트라 교차 리뷰가 필요합니다 — code-agent review cross --by claude — 직전 실행: /, "첫 번째(권한 상승 안내)는 명령을 앞세운다");
  assert.throws(byClaude, RetryRefused);
  const gate = crossGate();
  assert.match(gate, /^두 호스트가 설치된 프로젝트라 교차 리뷰가 필요합니다 — 직전 실행: 막힘\(샌드박스\)/);
  assert.match(gate, /사용자에게 알리고 지시를 받으세요[\s\S]*사용자 확인 없이 중지를 기록하지 않습니다\. \(사용자가 네트워크를 확인한 뒤 다시 실행할 명령: code-agent review cross --by claude\)$/);
  const line = withCaller("codex", () => status(root)).split("\n").find((row) => row.startsWith("다음: ")) ?? "";
  assert.doesNotMatch(line, /교차 리뷰가 필요합니다 — code-agent review cross/);
  assert.match(line, /\(사용자가 네트워크를 확인한 뒤 다시 실행할 명령: code-agent review cross --by claude\)/);
  // 지점 시도를 다 쓰면 명령을 싣지 않는다(한도 거부와 같다)
  assert.throws(byClaude, RetryRefused);
  assert.doesNotMatch(crossGate(), /code-agent review cross --by/);
});

test("D2(E16) 반박 검증: 사람이 아닌 중지 지점을 다시 실행해 네트워크 오류가 되풀이돼도 사람 판단을 싣지 않고 이전 중지대로 진행한다고만 안내한다", async () => {
  await crossRepo(); failingClaude("Not logged in · Please run /login\n");
  assert.match(byClaude(), /교차 검증 중지[\s\S]*인증/);
  failingClaude(NETWORK_ERROR);
  for (const left of [1, 0]) {
    assert.throws(byClaude, rejects(new RegExp(`이미 중지로 기록되어 있어 다시 기록하지 않았습니다[\\s\\S]*남은 ${left}회\\)\\. — 이 지점은 이전 중지 기록대로 교차 검증 없이 진행합니다\\(게이트는 막히지 않습니다\\)`),
      /judgment cross-stop|retry-grant|지시를 받으세요/));
  }
  assert.deepEqual(attempts().map((attempt) => [attempt.class, attempt.kind]), [["cross-unavailable", "auth"], ["host-sandbox-denied", "sandbox-network"], ["host-sandbox-denied", "sandbox-network"]]);
  assert.equal(crossGate(), "", "중지 지점 — 게이트는 막히지 않는다");
  assert.match(readFileSync(doc(), "utf8"), /- 교차 검증 중지 — claude 를 실행할 수 없습니다: 인증/, "중지 줄은 그대로다");
  withCaller("codex", () => next(root));
  assert.equal(loadActive(root)!.phase, "integrate");
});

test("D2(E16): 바꾸지 않는 갈래 — Codex 메인이 부른 claude 라도 네트워크가 아닌 실행 불가(인증)는 중지를 기록하고 진행한다", async () => {
  await crossRepo(); failingClaude("Not logged in · Please run /login\n");
  assert.match(byClaude(), /교차 검증 중지[\s\S]*인증/);
  assert.deepEqual([attempts()[0].class, attempts()[0].kind], ["cross-unavailable", "auth"]);
  assert.equal(crossGate(), "", "중지 지점 — 게이트는 막히지 않는다");
  withCaller("codex", () => next(root));
  assert.equal(loadActive(root)!.phase, "integrate");
});

// ---- 중지 지점의 재실행·연속 중지·doctor ----

test("사람이 아닌 중지 지점은 다시 실행할 수 있다 — 완료면 결과로 바꾸고, 다른 원인으로 실패하면 이전 중지대로 진행한다", async () => {
  await crossRepo();
  fakeCodex("process.stderr.write('ERROR: You hit your spend cap set by the owner of your workspace.'); process.exit(1);");
  assert.match(cross(), /교차 검증 중지[\s\S]*spend cap[\s\S]*남은 2회/);
  fakeCodex("process.stderr.write(\"error: unexpected argument '--x' found\\n\"); process.exit(2);");
  assert.throws(() => cross(), refusal(/설정 오류[\s\S]*이전 중지 기록대로 교차 검증 없이 진행합니다/));
  assert.match(readFileSync(doc(), "utf8"), /- 교차 검증 중지 — codex 를 실행할 수 없습니다: 사용 한도/, "중지 줄은 그대로다");
  assert.equal(reviewProblems(loadWork(root)!).filter((problem) => /교차/.test(problem)).length, 0);
  fakeCodex();
  assert.match(cross("- 없음"), /지적 없음/);
  assert.equal(calls(), 3, "중지 · 설정 오류 · 완료 — 지점 한도 3회 안");
  assert.match(readFileSync(doc(), "utf8"), /## 교차 지적[\s\S]*-->\n\n- 없음\n/);
  assert.doesNotMatch(readFileSync(doc(), "utf8"), /교차 검증 중지/);
  next(root);
  assert.equal(loadActive(root)!.phase, "integrate");
});

test("연속 중지 경고 — status·doctor 가 다른 호스트의 설치·로그인·한도를 확인하라고 알린다", async () => {
  await crossRepo();
  mutateReview(root, ID, TARGET, (log) => {
    const last = log!.rounds.at(-1)!;
    log!.rounds = [{ ...last, round: 1, treeHash: "sha256:a", crossAttempts: [{ n: 1, host: "codex", mode: "review", startedAt: "2026-10-07T00:00:00.000Z", endedAt: "2026-10-07T00:01:00.000Z", class: "cross-unavailable", detail: "사용 한도(quota): spend cap" }] },
      { ...last, round: 2, crossAttempts: [{ n: 1, host: "codex", mode: "review", startedAt: "2026-10-07T01:00:00.000Z", endedAt: "2026-10-07T01:01:00.000Z", class: "cross-unavailable", detail: "사용 한도(quota): spend cap" }] }];
    return { log: log!, value: 0 };
  });
  assert.match(status(root), /교차 검증: 최근 2개 지점이 연속 중지로 기록됐습니다\(마지막: codex — 사용 한도\(quota\): spend cap\)/);
  assert.match(status(root), /리뷰: 2회차[\s\S]*· 회차 2\/3 · 리뷰어 [^·]+ · 교차 중지\(실행 불가\)/);
  assert.match(doctor(root).text, /· 교차 검증 기록: 최근 2개 지점이 연속 중지/);
  assert.match(doctor(root).text, /· 교차 실행 옵션: 점검하려면 code-agent doctor --cross/);
});

test("doctor --cross — 다른 호스트의 --help 에 교차 실행 옵션이 모두 있는지 점검한다(모델 호출 없음)", async () => {
  await crossRepo();
  const help = (flags: string[]) => `process.stdout.write(${JSON.stringify(`Usage\n${flags.map((flag) => `  ${flag} <v>  설명`).join("\n")}\n`)});\n`;
  const claude = join(fakeDir, "claude.cjs"), codex = join(fakeDir, "codex.cjs");
  writeFileSync(claude, help(["-p, --print", "--agent", "--model", "--effort", "--output-format", "--setting-sources", "--allowedTools"]));
  writeFileSync(codex, help(["-s, --sandbox", "-C, --cd", "--ephemeral", "-m, --model", "-c, --config", "-o, --output-last-message"]));
  process.env.CODE_AGENT_CLAUDE_BIN = claude; process.env.CODE_AGENT_CODEX_BIN = codex;
  const text = doctor(root, undefined, { cross: true }).text;
  assert.match(text, /✗ 교차 실행 옵션\(claude\): 없는 옵션: --permission-prompts/);
  assert.match(text, /✓ 교차 실행 옵션\(codex\): 사용하는 옵션이 모두 있습니다/);
});

// ---- 사람 허용의 대상(C5 judgment retry-grant 가 읽는다) ----

test("reviewBudgets — 리뷰 회차(reviewRoundUsage)·리뷰어 호출(고아 포함)·교차 지점·원인별 예산을 사람 허용과 함께 읽기만 하고, 묶임이 바뀌면 리뷰 회차 행만 낸다", async () => {
  await crossRepo({ reviewer: false });
  const rows = () => Object.fromEntries(reviewBudgets(loadWork(root)!).map((row) => [row.key, row]));
  let now = rows();
  assert.deepEqual(Object.keys(now), ["reviewRounds", "reviewerRuns", "crossPoint", "crossError", "crossFormat"]);
  assert.deepEqual([now.reviewRounds.used, now.reviewRounds.limit, now.reviewRounds.exhausted, now.reviewRounds.scope, now.reviewRounds.point], [1, 3, false, "", "리뷰 회차"]);
  assert.deepEqual([now.reviewerRuns.used, now.reviewerRuns.limit, now.reviewerRuns.scope, now.reviewerRuns.point], [0, 2, "round:1", "리뷰 1회차"]);
  assert.deepEqual([now.crossPoint.used, now.crossPoint.limit, now.crossPoint.scope, now.crossPoint.point], [0, 3, "round:1", "리뷰 1회차 교차"]);
  const dead = deadPid();
  const ended = { startedAt: "2026-10-07T00:00:00.000Z", endedAt: "2026-10-07T00:01:00.000Z" };
  mutateReview(root, ID, TARGET, (log) => {
    const last = log!.rounds.at(-1)!;
    // 고아로 처리한 리뷰어 실행도 호출로 센다
    last.reviewers = [{ sessionId: "s", agentId: "r1", startedAt: "2026-10-07T00:00:00.000Z", ignored: { at: "2026-10-07T00:20:00.000Z", reason: "orphaned" } },
      { sessionId: "s", agentId: "r2", startedAt: new Date().toISOString() }];
    last.crossAttempts = [
      { n: 1, host: "codex", mode: "review", ...ended, class: "cross-config-error", kind: "config", detail: "x" },
      { n: 2, host: "codex", mode: "review", ...ended, class: "cross-config-error", kind: "config", detail: "x" },
      // 끝 기록 없는 시도(죽은 pid) — 게이트 쪽 고아 보기로 센다
      { n: 3, host: "codex", mode: "review", startedAt: new Date().toISOString(), pid: dead, machine: hostname() },
    ];
    log!.grants = [{ key: "crossError", scope: "round:1", step: 1, consent: "c1", at: "t", reason: "r" }, { key: "reviewRounds", scope: "", step: 1, consent: "c2", at: "t", reason: "r" },
      { key: "crossError", scope: "round:2", step: 1, consent: "c3", at: "t", reason: "다른 회차 — 세지 않는다" }];
    return { log: log!, value: 0 };
  });
  now = rows();
  assert.deepEqual([now.reviewRounds.used, now.reviewRounds.limit, now.reviewRounds.left], [1, 4, 3]);
  assert.deepEqual([now.reviewerRuns.used, now.reviewerRuns.left, now.reviewerRuns.exhausted], [2, 0, true]);
  assert.deepEqual([now.crossPoint.used, now.crossPoint.limit, now.crossPoint.exhausted], [3, 3, true]);
  assert.deepEqual([now.crossError.used, now.crossError.limit, now.crossError.left, now.crossError.exhausted], [1, 2, 1, false], "설정 오류 두 번 + 허용 1 — 첫 오류 뒤 1회 재실행을 썼다");
  assert.deepEqual([now.crossFormat.used, now.crossFormat.limit], [0, 1]);
  assert.equal(lastRound().crossAttempts![2].endedAt, undefined, "읽기만 한다 — 고아 보기를 저장하지 않는다");
  // 묶임이 바뀌면(stale) 리뷰 회차 행만 — 다음 openRound 가 회차·허용을 버린다
  const log = loadReview(root, ID, TARGET)!;
  saveReview(root, { ...log, rounds: log.rounds.map((round) => ({ ...round, planHash: "sha256:old-plan" })) });
  assert.deepEqual(reviewBudgets(loadWork(root)!).map((row) => [row.key, row.used, row.limit, row.scope]), [["reviewRounds", 0, 3, ""]]);
});

test("reviewBudgets — 한 호스트 설치는 교차 행이 없다", async () => {
  writeFileSync(doc(), readFileSync(doc(), "utf8").replace("## 지적\n", "## 지적\n\n- 없음\n"));
  recordReviewFixture(root);
  assert.deepEqual(reviewBudgets(loadWork(root)!).map((row) => [row.key, row.used]), [["reviewRounds", 1], ["reviewerRuns", 1]]);
});

// ---- 반영(PVR-16) ----

test("PVR-16 (b): 커밋이 실패하면 고른 KNOWLEDGE 갱신을 스테이지에서 내리고 원래 내용으로 되돌린다", async () => {
  await toDeliver();
  const knowledge = "doc/knowledge/business-rules.md";
  const original = readFileSync(join(root, knowledge), "utf8");
  writeFixture(root, knowledge, `${original}\n## 새 규칙\n음수는 거부한다\n`);
  // hook 은 저장소 밖에 둔다(계획 밖 변경이 되지 않게)
  mkdirSync(join(fakeDir, "hooks"), { recursive: true });
  writeFileSync(join(fakeDir, "hooks/pre-commit"), "#!/bin/sh\nexit 1\n");
  gitFixture(root, "config", "core.hooksPath", join(fakeDir, "hooks").replace(/\\/g, "/"));
  const work = loadWork(root)!;
  assert.throws(() => commitDelivery(work, loadEvidence(root, ID, TARGET)!, [knowledge], new Map([[knowledge, original]])),
    /git commit 이 실패했습니다 — 선택한 KNOWLEDGE 갱신은 되돌렸습니다/);
  assert.equal(readFileSync(join(root, knowledge), "utf8"), original);
  assert.ok(!gitFixture(root, "diff", "--cached", "--name-only").split("\n").includes(knowledge));
});

test("PVR-16 (a): 커밋 중 계획 파일이 바뀌면(pre-commit hook) 반영 결과에 경고한다 — 되돌리지 않는다", async () => {
  await toDeliver();
  mkdirSync(join(fakeDir, "hooks"), { recursive: true });
  writeFileSync(join(fakeDir, "hooks/pre-commit"), "#!/bin/sh\necho '// hook' >> src/value.js\ngit add src/value.js\n");
  gitFixture(root, "config", "core.hooksPath", join(fakeDir, "hooks").replace(/\\/g, "/"));
  const { result } = approveAndApplyFixture(root, { action: "deliver" });
  assert.match(result, /주의: 커밋 중 계획 파일 내용이 바뀌었습니다\(pre-commit hook 등\)/);
  assert.equal(loadActive(root), undefined, "반영은 그대로 끝난다");
});

test("갱신 전 판이 렌더한 ⑩ 구역은 손 수정으로 보지 않는다 — 실제로 고친 구역은 그대로 경고한다", async () => {
  await crossRepo(); fakeCodex();
  cross("- 없음");
  next(root);
  await integrate(requireValidatable(root, "integrate")); next(root);
  assert.equal(loadActive(root)!.phase, "deliver");
  const pr = join(root, prDocFile(ID)), work = loadWork(root)!, evidence = loadEvidence(root, ID, TARGET);
  const prose = "# 보고\n\n## 요약\n값 구현\n## 확인 방법\n호출\n## 위험·되돌리기\n되돌린다.\n";
  const shown = () => {
    let text = "";
    try { withInteraction({ confirm: (screen) => { text = screen; throw new Error("captured"); }, ask: () => "n" }, () => deliver(loadWork(root)!)); }
    catch (error) { if ((error as Error).message !== "captured") throw error; }
    return text;
  };
  // 갱신 전 판의 deliver 가 렌더한 꼴 — 보고서가 있는 상태에서 렌더했다(변경 요약에 보고서 자신이 든다)
  writeFileSync(pr, prose);
  const legacy = renderTraceBlock(work, evidence, { legacy: true });
  writeFileSync(pr, upsertBlock(prose, PR_BLOCK, legacy));
  const first = shown();
  assert.match(first, /- 교차 리뷰: 1회차 completed\(열린 0\)/);
  assert.doesNotMatch(first, /!!/);
  writeFileSync(pr, upsertBlock(prose, PR_BLOCK, legacy.replace("## 추적표", "## 추적 표")));
  assert.match(shown(), /손으로 고쳐져 있어 다시 렌더했습니다/);
});
