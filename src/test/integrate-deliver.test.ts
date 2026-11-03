import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { next, requireValidatable, Stop } from "../agent/commands";

import { loadEvidence, runsOf, saveEvidence, validationDocFile } from "../agent/evidence";
import { loadActive, verifyFile } from "../agent/layout";
import { checkoutKey, integrate, worktreeMarkerFile } from "../agent/validate";
import { RetryRefused } from "../agent/retryPolicy";
import { deadPid } from "./deadPid";
import { ORDER, repo, write, git, useManifest, toIntegrate, createStageRepo, removeStageRepo } from "./stageFixture";

/** git 호출을 가로채는 자리 — validate.ts 는 호출 때마다 모듈의 execFileSync 를 찾는다 */
const childProcessModule = require("node:child_process") as typeof import("node:child_process");

/**
 * 통합 검증과 반영 — integrate·deliver·KNOWLEDGE 제안·⑩ 추적표·커밋 자리·코드 구역.
 *
 * 검증 명령은 node 한 줄짜리 스크립트라 통과·실패·없는 실행 파일 세 경우를 이 머신에서 재현할 수 있다.
 */

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
