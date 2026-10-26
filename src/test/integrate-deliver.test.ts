import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { blockCount, readBlock, stripBlock, upsertBlock } from "../agent/blocks";
import { next, requireValidatable, Stop } from "../agent/commands";
import { commitDelivery, deliver, deliverProblems, prDocFile, traceRows } from "../agent/deliver";
import { loadEvidence, outsideChanges, runsOf, saveEvidence, validationDocFile } from "../agent/evidence";
import { applyEntry, parseProposal } from "../agent/knowledge";
import { loadActive, verifyFile } from "../agent/layout";
import { reviewDocFile } from "../agent/review";
import { checkoutKey, integrate, worktreeMarkerFile } from "../agent/validate";
import { loadWork } from "../agent/work";
import { RetryRefused } from "../agent/retryPolicy";
import { deadPid } from "./deadPid";

/** git 호출을 가로채는 자리 — validate.ts 는 호출 때마다 모듈의 execFileSync 를 찾는다 */
const childProcessModule = require("node:child_process") as typeof import("node:child_process");

/**
 * 통합 검증과 반영 — integrate·deliver·KNOWLEDGE 제안·⑩ 추적표·커밋 자리·코드 구역.
 *
 * p5.test 에서 describe 단위로 옮겼다(이름·본문 그대로 — 이력 추적용). 임시 git 저장소에 실제 함수를 그대로 부른다.
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */
import {
  ORDER, REQUIREMENTS, repo, write, git, useManifest, toIntegrate, toDeliver, writePr, createStageRepo, removeStageRepo,
} from "./stageFixture";

beforeEach(() => createStageRepo());

afterEach(() => removeStageRepo());

// ---- 10 통합 검증 ----

describe("code-agent integrate", () => {
  test("기준 커밋 위의 깨끗한 worktree 에서 돌린다 — 작업 트리의 산출물은 끼지 않는다", async () => {
    // build 는 계획 파일이 얹혔는지, test 는 gitignore 된 산출물이 따라왔는지 본다
    useManifest({
      build: ["node", "-e", `process.exit(require('fs').existsSync('${ORDER}/domain/Order.java') ? 0 : 7)`],
      test: ["node", "-e", "console.log('ok 1 - TC-1\\nok 2 - TC-2'); process.exit(require('fs').existsSync('build/stray.txt') ? 0 : 7)"],
    });
    // .gitignore 된 산출물이라 changedPaths 에 잡히지 않는다 — 작업 트리에서는 test 가 통과한다
    write("build/stray.txt", "작업 트리에만 있는 산출물\n");
    await toIntegrate();

    const out = await integrate(requireValidatable(repo, "integrate"));
    const runs = new Map(runsOf(loadEvidence(repo, "ORD-1", "order")!, "integrate").map((run) => [run.kind, run.outcome]));
    assert.equal(runs.get("build"), "passed", "계획 파일은 worktree 에 얹힌다");
    assert.equal(runs.get("test"), "failed", "작업 트리에만 있던 산출물은 따라오지 않는다");
    assert.match(out, /깨끗한 worktree/);
    assert.throws(() => next(repo), /test: failed/);
  });

  test("전부 통과하면 ⑧ 에 남고 next 가 deliver 로 넘긴다", async () => {
    await toIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    assert.equal(runsOf(loadEvidence(repo, "ORD-1", "order")!, "integrate").length, 2);
    assert.match(readFileSync(join(repo, validationDocFile("ORD-1")), "utf-8"), /\| integrate \|/);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "deliver");
  });

  test("임시 worktree 를 지우지 못해도 끝난 결과는 남긴다 — 남은 프로세스가 디렉토리를 잡는 경우", async () => {
    // test 명령이 worktree 를 작업 디렉토리로 잡은 자식을 남긴다(빌드 데몬 모사). Windows 는 그동안 지울 수 없다
    const hold = "if(process.cwd().includes('code-agent-integrate-'))require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},6000)'],{detached:true,stdio:'ignore',windowsHide:true,cwd:process.cwd()}).unref();";
    useManifest({ test: ["node", "-e", `${hold}console.log('ok 1 - TC-1\\nok 2 - TC-2')`] });
    await toIntegrate();
    const warnings: string[] = [], original = process.stderr.write;
    process.stderr.write = ((chunk: string) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { await integrate(requireValidatable(repo, "integrate")); } finally { process.stderr.write = original; }
    assert.equal(runsOf(loadEvidence(repo, "ORD-1", "order")!, "integrate").length, 2, "정리 실패가 build·test 결과를 지우지 않는다");
    // 임시 worktree 이름에 체크아웃 키가 들어간다(code-agent-integrate-<키 8자>-XXXXXX)
    const left = /: (.+?code-agent-integrate-[\w-]+) \(/.exec(warnings.join(""))?.[1];
    if (process.platform === "win32") assert.ok(left, "잡힌 디렉토리는 경고로 알린다");
    for (let tries = 0; left; tries++) {
      try { rmSync(left, { recursive: true, force: true }); break; }
      catch (error) { if (tries > 60) throw error; await new Promise((done) => setTimeout(done, 250)); }
    }
  });

  test("코드 결함으로 실패한 통합 검증은 같은 코드로 다시 돌리지 않는다", async () => {
    useManifest({ test: ["node", "-e", "console.log('ok 1 - TC-1\\nok 2 - TC-2'); process.exit(require('fs').existsSync('build/stray.txt') ? 0 : 7)"] });
    write("build/stray.txt", "작업 트리에만 있는 산출물\n");
    await toIntegrate();
    await integrate(requireValidatable(repo, "integrate"));
    assert.equal(runsOf(loadEvidence(repo, "ORD-1", "order")!, "integrate").find((run) => run.kind === "test")!.outcome, "failed");
    await assert.rejects(() => integrate(requireValidatable(repo, "integrate")),
      (error: Error) => error instanceof RetryRefused && /코드 결함으로 실패한 트리입니다/.test(error.message));
  });

  test("끊긴 통합 검증은 다음 실행이 자기 체크아웃의 임시 worktree 를 정리하고 같은 회차로 다시 돈다 (PVR-8)", async () => {
    await toIntegrate();
    const leftover = join(tmpdir(), `code-agent-integrate-${checkoutKey(repo)}-test01`);
    rmSync(leftover, { recursive: true, force: true });
    git("worktree", "add", "--detach", leftover, "HEAD");
    try {
      const dead = deadPid();
      const at = new Date().toISOString();
      const evidence = loadEvidence(repo, "ORD-1", "order")!;
      mkdirSync(dirname(worktreeMarkerFile(repo)), { recursive: true });
      writeFileSync(worktreeMarkerFile(repo), JSON.stringify({ pid: dead, host: hostname(), at, id: "ORD-1", target: "order", phase: "integrate", round: evidence.rounds, worktree: leftover }));
      saveEvidence(repo, { ...evidence, retry: { ...evidence.retry!, started: { phase: "integrate", round: evidence.rounds, pid: dead, host: hostname(), at } } });
      const out = await integrate(requireValidatable(repo, "integrate"));
      assert.match(out, /임시 worktree 1개를 정리했습니다/);
      assert.match(out, /끝 기록 없이 끊겼습니다/);
      assert.equal(git("worktree", "list", "--porcelain").includes(basename(leftover)), false);
      const after = loadEvidence(repo, "ORD-1", "order")!;
      assert.equal(after.retry!.integrateReruns[String(after.rounds)], 1);
      assert.equal(after.retry!.started, undefined);
      assert.equal(existsSync(worktreeMarkerFile(repo)), false, "끝나면 표지를 지운다");
    } finally {
      rmSync(leftover, { recursive: true, force: true });
    }
  });

  test("이 체크아웃에서 다른 통합 검증이 실행 중이면 아무것도 기록하지 않고 멈춘다 (PVR-8)", async () => {
    await toIntegrate();
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: "ignore" });
    try {
      mkdirSync(dirname(worktreeMarkerFile(repo)), { recursive: true });
      writeFileSync(worktreeMarkerFile(repo), JSON.stringify({ pid: child.pid, host: hostname(), at: new Date().toISOString(), id: "ORD-1", target: "order", phase: "integrate", round: 1, worktree: join(tmpdir(), "x") }));
      const before = readFileSync(verifyFile(repo, "ORD-1", "order"), "utf-8");
      await assert.rejects(() => integrate(requireValidatable(repo, "integrate")),
        (error: Error) => error instanceof Stop && /다른 통합 검증이 이 체크아웃에서 실행 중입니다/.test(error.message));
      assert.equal(readFileSync(verifyFile(repo, "ORD-1", "order"), "utf-8"), before, "카운터·표지를 쓰지 않았다");
    } finally {
      child.kill();
    }
  });

  test("다른 체크아웃·이전 버전 이름의 임시 worktree 는 지우지 않고 보고한다 (PVR-8)", async () => {
    await toIntegrate();
    const sibling = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-sibling-")));
    rmSync(sibling, { recursive: true, force: true });
    git("worktree", "add", "--detach", sibling, "HEAD");
    const theirs = join(tmpdir(), `code-agent-integrate-${checkoutKey(sibling)}-abc123`);
    const legacy = join(tmpdir(), "code-agent-integrate-aB3xYz");
    try {
      for (const path of [theirs, legacy]) rmSync(path, { recursive: true, force: true });
      execFileSync("git", ["worktree", "add", "--detach", theirs, "HEAD"], { cwd: sibling });
      git("worktree", "add", "--detach", legacy, "HEAD");
      const out = await integrate(requireValidatable(repo, "integrate"));
      const listed = git("worktree", "list", "--porcelain");
      assert.ok(listed.includes(basename(theirs)) && listed.includes(basename(legacy)), "다른 체크아웃·이전 버전의 것은 지우지 않는다");
      assert.match(out, /지우지 않았습니다/);
      assert.ok(out.includes(basename(theirs)) && out.includes(basename(legacy)));
      assert.equal(existsSync(join(sibling, ".code-agent/log/worktree.lock")), false, "형제 체크아웃의 상태는 건드리지 않는다");
    } finally {
      for (const path of [theirs, legacy, sibling]) {
        try { git("worktree", "remove", "--force", path); } catch { /* 이미 없다 */ }
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  test("임시 worktree 를 만들지 못한 통합 검증은 재실행 카운터·시작 표지를 남기지 않는다 — 인프라 실패를 끊긴 실행으로 세지 않는다", async () => {
    await toIntegrate();
    const before = readFileSync(verifyFile(repo, "ORD-1", "order"), "utf-8");
    const original = childProcessModule.execFileSync;
    childProcessModule.execFileSync = ((file: string, args?: readonly string[], options?: object) => {
      if (file === "git" && args?.[0] === "worktree" && args[1] === "add") throw new Error("worktree add 실패 모사");
      return (original as (...rest: unknown[]) => unknown)(file, args, options);
    }) as typeof original;
    try {
      await assert.rejects(() => integrate(requireValidatable(repo, "integrate")),
        (error: Error) => error instanceof Stop && /임시 worktree 를 만들지 못했습니다/.test(error.message));
    } finally {
      childProcessModule.execFileSync = original;
    }
    assert.equal(readFileSync(verifyFile(repo, "ORD-1", "order"), "utf-8"), before, "카운터·시작 표지를 쓰지 않았다");
    assert.equal(existsSync(worktreeMarkerFile(repo)), false, "표지는 풀었다");
    const out = await integrate(requireValidatable(repo, "integrate"));
    assert.doesNotMatch(out, /끝 기록 없이 끊겼습니다/);
    const after = loadEvidence(repo, "ORD-1", "order")!;
    assert.equal(after.retry!.integrateReruns[String(after.rounds)] ?? 0, 0);
  });

  test("2-8 같은 PC의 실행 중 통합 표지는 나이로 회수하지 않는다", async () => {
    await toIntegrate();
    const file = worktreeMarkerFile(repo);
    mkdirSync(dirname(file), { recursive: true });
    const marker = JSON.stringify({ pid: process.ppid, host: hostname(), at: "2000-01-01T00:00:00.000Z", id: "ORD-1", target: "order", phase: "integrate", round: 1, worktree: join(tmpdir(), "active-worktree") });
    writeFileSync(file, marker);
    await assert.rejects(() => integrate(requireValidatable(repo, "integrate")), /실행 중/);
    assert.equal(readFileSync(file, "utf8"), marker);
  });

  test("낡은 표지의 worktree 가 이미 없으면 정리했다고 보고하지 않는다 (PVR-8)", async () => {
    await toIntegrate();
    const dead = deadPid();
    // worktree add 전에 끊긴 실행 — 표지만 남고 worktree 는 만들어지지 않았다
    const never = join(tmpdir(), `code-agent-integrate-${checkoutKey(repo)}-never1`);
    rmSync(never, { recursive: true, force: true });
    mkdirSync(dirname(worktreeMarkerFile(repo)), { recursive: true });
    writeFileSync(worktreeMarkerFile(repo), JSON.stringify({ pid: dead, host: hostname(), at: new Date().toISOString(), id: "ORD-1", target: "order", phase: "integrate", round: 1, worktree: never }));
    const out = await integrate(requireValidatable(repo, "integrate"));
    assert.doesNotMatch(out, /정리했습니다/);
    assert.equal(existsSync(worktreeMarkerFile(repo)), false, "낡은 표지는 회수하고 끝나면 지운다");
  });

  test("낡은 표지는 회수 가드를 쥔 한 실행만 회수한다 — 다른 실행이 회수 중이면 아무것도 쓰지 않고 멈춘다 (PVR-8)", async () => {
    await toIntegrate();
    const dead = deadPid();
    const other = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { stdio: "ignore" });
    const marker = worktreeMarkerFile(repo);
    try {
      mkdirSync(dirname(marker), { recursive: true });
      const stale = JSON.stringify({ pid: dead, host: hostname(), at: new Date().toISOString(), id: "ORD-1", target: "order", phase: "integrate", round: 1, worktree: join(tmpdir(), "x") });
      writeFileSync(marker, stale);
      writeFileSync(`${marker}.reclaim`, JSON.stringify({ pid: other.pid, host: hostname(), at: new Date().toISOString(), nonce: "other" }));
      const before = readFileSync(verifyFile(repo, "ORD-1", "order"), "utf-8");
      await assert.rejects(() => integrate(requireValidatable(repo, "integrate")),
        (error: Error) => error instanceof Stop && /표지 회수 잠금을 다른 code-agent 프로세스가 쥐고 있습니다/.test(error.message));
      assert.equal(readFileSync(marker, "utf-8"), stale, "가드 없이 표지를 지우지 않는다");
      assert.equal(readFileSync(verifyFile(repo, "ORD-1", "order"), "utf-8"), before);
    } finally {
      other.kill();
      rmSync(`${marker}.reclaim`, { force: true });
    }
  });

  test("리뷰가 지금 트리 위에서 닫혀 있지 않으면 돌리지 않는다", async () => {
    await toIntegrate();
    write(`${ORDER}/domain/Order.java`, "class Order { }\n");
    await assert.rejects(
      () => integrate(requireValidatable(repo, "integrate")),
      (error: Error) => error instanceof Stop && /코드 리뷰가 지금 트리 위에서 닫혀 있지 않아/.test(error.message),
    );
  });
});

// ---- 11 반영 ----

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
