/**
 * 버전 선택·적용 — 실제 code-agent 릴리스 둘(A·B, 이 저장소의 빌드를 격리된 릴리스 저장소에 옮긴 것)로 본다.
 * 고정 진입점(dist/agent/cli.js)이 프로젝트마다 적용 버전을 골라 같은 프로세스에서 넘기는지, 진행 중인 일이 있으면 적용을 예약했다가
 * 다음 작업을 열 때 적용하는지, 템플릿 보존·되돌리기·상태 세대·선택 UI MCP 를 실행 기록(CODE_AGENT_RUNTIME_TRACE)으로 확인한다.
 */
import { strict as assert } from "node:assert";

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { after, before, describe, test } from "node:test";

import { packageRelease } from "../agent/releaseStore";

import { count, REPO, A, scratch, store, nextProjectNumber, env, applyAs, lastRun, project, runtime, preToolUse } from "./runtimeFixture";

describe("npm 패키지 진입점 — 사람이 패키지 관리자로 설치한 패키지를 릴리스로 들인다", () => {
  const PKG_MARK = "\n<!-- package reinstalled -->\n";
  let pkgRoot: string;
  const hoisted: string[] = [];
  const pkgCli = (root: string, args: string[], input = "", extra: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, [join(pkgRoot, "dist", "agent", "cli.js"), ...args], { cwd: root, input, encoding: "utf8", env: env(extra), timeout: 120_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const endSession = (root: string) => rmSync(join(root, ".code-agent", "docs-session.json"));
  const reinstall = (mark: string) => appendFileSync(join(pkgRoot, "template", "claude", "skills", "ca-status", "SKILL.md"), mark);

  before(() => {
    const global = join(scratch, "global", "node_modules");
    pkgRoot = join(global, "code-agent");
    for (const part of ["agent", "core"]) cpSync(join(REPO, "dist", part), join(pkgRoot, "dist", part), { recursive: true });
    cpSync(join(REPO, "template"), join(pkgRoot, "template"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(pkgRoot, "package.json"));
    // 의존성은 위 폴더에 끌어올려져 있다(npm 의 평탄한 설치). 링크라서 복사는 실제 내용을 따라가야 한다
    const dependencies = Object.keys(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).dependencies);
    for (const name of dependencies) {
      const target = join(global, name);
      mkdirSync(join(target, ".."), { recursive: true });
      symlinkSync(join(REPO, "node_modules", name), target, "junction");
      hoisted.push(target);
    }
  });
  after(() => {
    for (const path of hoisted) unlinkSync(path);
    // 복사본이 링크를 그대로 옮겼다면 바깥 정리가 이 저장소의 의존성을 따라 지우지 않게 먼저 끊는다
    for (const name of readdirSync(store)) {
      const dep = join(store, name, "node_modules", "zod");
      try { if (lstatSync(dep).isSymbolicLink()) unlinkSync(dep); } catch { /* 없다 */ }
    }
  });

  test("다음 작업을 열 때 그 패키지를 릴리스로 복사해 적용하고, 패키지를 다시 설치해도 진행 중인 작업은 사본으로 돈다", () => {
    const root = project();
    const first = packageRelease(pkgRoot).id;
    const opened = pkgCli(root, ["docs", "begin"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.ok(opened.stdout.includes(`npm 패키지 1.0.0 을 ${first} 로 복사했습니다`), opened.stdout);
    assert.match(opened.stdout, new RegExp(`적용 버전: 번들 → ${first}`));
    assert.match(opened.stdout, /문서 작성 세션을 열었습니다/);
    assert.equal(lastRun("docs"), first, "작업은 패키지의 사본(릴리스)이 연다");
    assert.deepEqual([runtime(root)?.applied, runtime(root)?.adopted], [first, first]);
    const copied = JSON.parse(readFileSync(join(store, first, "release.json"), "utf8")) as { source: unknown; contentHash: string };
    assert.deepEqual(copied.source, { kind: "package", contentHash: copied.contentHash });
    assert.ok(!lstatSync(join(store, first, "node_modules", "zod")).isSymbolicLink(), "의존성은 실제 내용으로 복사한다");

    // 사람이 npm 으로 새 버전을 설치했다 — 진입점 패키지가 통째로 바뀐다
    reinstall(PKG_MARK);
    const second = packageRelease(pkgRoot).id;
    assert.notEqual(second, first);
    pkgCli(root, ["hook"], preToolUse(root));
    assert.equal(lastRun("hook"), first, "진행 중인 작업의 hook 은 복사해 둔 이전 버전 그대로");
    const view = JSON.parse(pkgCli(root, ["version", "--json"]).stdout) as { running: { entryPackage: { id: string } }; project: { applied: string } };
    assert.deepEqual([view.running.entryPackage.id, view.project.applied], [second, first]);
    assert.ok(pkgCli(root, ["version"]).stdout.includes(`진입점 npm 패키지: ${second} — 다음 작업을 열 때 이 패키지의 사본을 적용합니다`));

    endSession(root);   // 지금 일이 끝났다
    const next = pkgCli(root, ["docs", "begin"]);
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, new RegExp(`적용 버전: ${first} → ${second}`));
    assert.equal(lastRun("docs"), second);
    assert.ok(readFileSync(join(root, ".claude", "skills", "ca-status", "SKILL.md"), "utf8").includes(PKG_MARK.trim()));
  });

  test("사람이 고른 릴리스(--release)는 같은 패키지로 되돌리지 않고, 새 패키지를 설치하면 다음 작업부터 그 패키지로 간다", () => {
    const root = project();
    assert.equal(pkgCli(root, ["docs", "begin"]).status, 0);
    endSession(root);
    const current = packageRelease(pkgRoot).id;
    assert.equal(runtime(root)?.applied, current);
    // update --release A — 터미널 확인 뒤 그 릴리스가 스스로 적용한다
    assert.equal(applyAs(root, A, "release").status, 0);
    const kept = pkgCli(root, ["docs", "begin"]);
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(lastRun("docs"), A, "같은 패키지로는 되돌리지 않는다");
    assert.deepEqual([runtime(root)?.applied, runtime(root)?.adopted], [A, current]);
    assert.ok(pkgCli(root, ["version"]).stdout.includes(`진입점 npm 패키지: ${current} — 사람이 고른 적용 버전을 둡니다`));
    endSession(root);
    reinstall("\n<!-- package 3 -->\n");
    const third = packageRelease(pkgRoot).id;
    const moved = pkgCli(root, ["docs", "begin"]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, new RegExp(`적용 버전: ${A} → ${third}`));
  });

  test("설치되지 않은 폴더에는 패키지를 들이지 않는다 — 다음 작업을 여는 명령도, update --templates-only 도", () => {
    const bare = join(scratch, `bare package repo ${nextProjectNumber()}`);
    mkdirSync(bare, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: bare });
    const releases = readdirSync(store).sort();
    reinstall(`\n<!-- not installed ${count} -->\n`);   // 아직 아무 프로젝트도 들이지 않은 패키지
    pkgCli(bare, ["docs", "begin"]);
    const refused = pkgCli(bare, ["update", "--templates-only"]);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout + refused.stderr, /code-agent 가 설치되어 있지 않아 갱신하지 않습니다/);
    assert.ok(!existsSync(join(bare, ".claude")), "스킬·hook 을 새로 쓰지 않는다");
    assert.ok(!existsSync(join(bare, ".code-agent", "runtime.json")));
    assert.ok(!existsSync(join(bare, ".code-agent", "templates.json")));
    assert.deepEqual(readdirSync(store).sort(), releases, "패키지를 복사하지 않는다");
  });

  test("update --templates-only 는 지금 패키지를 들인다 — 진행 중이면 예약(종료 코드 3)하고 일이 끝난 뒤 다시 실행하면 적용한다", () => {
    const root = project();
    mkdirSync(join(root, ".code-agent"), { recursive: true });
    writeFileSync(join(root, ".code-agent", "docs-session.json"), JSON.stringify({ startedAt: new Date().toISOString(), version: 2, writable: ["doc"] }));
    const id = packageRelease(pkgRoot).id;
    const reserved = pkgCli(root, ["update", "--templates-only"]);
    assert.equal(reserved.status, 3, reserved.stderr);
    assert.ok(reserved.stdout.includes(`새 버전 ${id} 설치 완료. 현재 작업은 기존 버전(번들)으로 계속 진행하며`), reserved.stdout);
    assert.equal(runtime(root)?.pending?.id, id);
    endSession(root);
    const applied = pkgCli(root, ["update", "--templates-only"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual([runtime(root)?.applied, runtime(root)?.pending, runtime(root)?.adopted], [id, undefined, id]);
  });

  test("복사·검증에 실패하거나 저장소를 쓸 수 없으면 아무것도 등록하지 않고 지금 버전으로 작업을 연다", () => {
    const root = project();
    const broken = join(pkgRoot, "dist", "agent", "zzBroken.js");
    writeFileSync(broken, "throw new Error('broken package');\n");
    try {
      const id = packageRelease(pkgRoot).id;
      const opened = pkgCli(root, ["docs", "begin"]);
      assert.equal(opened.status, 0, opened.stderr);
      assert.match(opened.stdout, /진입점 npm 패키지를 이 프로젝트에 적용하지 못했습니다 — 새 버전 모듈 로드 검사 실패/);
      assert.match(opened.stdout, /문서 작성 세션을 열었습니다/);
      assert.equal(runtime(root)?.applied, undefined);
      assert.ok(!existsSync(join(store, id)), "검증하지 못한 사본은 등록하지 않는다");
      assert.deepEqual(readdirSync(store).filter((name) => name.startsWith(".staging-")), [], "임시 폴더도 남기지 않는다");
    } finally { rmSync(broken); }
    endSession(root);
    const notAStore = join(scratch, "not a store");
    writeFileSync(notAStore, "");
    const refused = pkgCli(root, ["docs", "begin"], "", { CODE_AGENT_RELEASE_HOME: notAStore });
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stdout, /진입점 npm 패키지를 이 프로젝트에 적용하지 못했습니다/);
    assert.equal(runtime(root)?.applied, undefined);
  });
});

