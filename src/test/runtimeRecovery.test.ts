/**
 * 버전 선택·적용 — 실제 code-agent 릴리스 둘(A·B, 이 저장소의 빌드를 격리된 릴리스 저장소에 옮긴 것)로 본다.
 * 고정 진입점(dist/agent/cli.js)이 프로젝트마다 적용 버전을 골라 같은 프로세스에서 넘기는지, 진행 중인 일이 있으면 적용을 예약했다가
 * 다음 작업을 열 때 적용하는지, 템플릿 보존·되돌리기·상태 세대·선택 UI MCP 를 실행 기록(CODE_AGENT_RUNTIME_TRACE)으로 확인한다.
 */
import { strict as assert } from "node:assert";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, test } from "node:test";
import { STATE_SCHEMA } from "../agent/runtimeSelect";
import { ENTRY, A, B, GONE, scratch, store, nextProjectNumber, env, cli, applyAs, lastRun, project, runtime, fileSnapshot, preToolUse } from "./runtimeFixture";

describe("릴리스 확인·복구", () => {
  test("대시보드 릴리스 확인 — 읽기 전용 미리보기·거부, 확인한 버전 적용과 작업 중 예약", () => {
    const root = project();
    assert.equal(applyAs(root, A).status, 0);
    const file = join(root, ".code-agent", "runtime.json");
    const journal = join(scratch, "pc-store", "update-confirmations.jsonl");
    const saved = readFileSync(file, "utf8");
    const filesBefore = fileSnapshot(root);
    const recordsBefore = existsSync(journal) ? readFileSync(journal, "utf8") : "";
    const previewArgs = ["update", "--release", B, "--preview", "--json"];
    const shown = cli(root, previewArgs);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.stdout.trim().split("\n").length, 1);
    const preview = JSON.parse(shown.stdout);
    assert.equal(preview.current, A);
    assert.equal(preview.release, B);
    assert.equal(preview.stateSchema, STATE_SCHEMA);
    assert.match(preview.lines.join("\n"), /그보다 낮은 세대의 릴리스는 적용하지 않습니다/);
    assert.deepEqual(JSON.parse(cli(root, previewArgs).stdout), preview);
    const confirmArgs = ["update", "--release", B, "--shown-hash", preview.shownHash, "--json"];
    const stale = cli(root, ["update", "--release", B, "--shown-hash", "wrong", "--json"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale-state/);
    for (const args of [previewArgs, confirmArgs]) {
      const denied = spawnSync(process.execPath, [ENTRY, ...args], { cwd: root, encoding: "utf8", env: env({ CLAUDECODE: "1" }), windowsHide: true });
      assert.equal(denied.status, 1);
      assert.match(denied.stderr, /policy-forbids/);
    }
    assert.equal(readFileSync(file, "utf8"), saved);
    assert.deepEqual(fileSnapshot(root), filesBefore, "미리보기와 거부는 프로젝트의 어떤 파일도 바꾸지 않는다");
    assert.equal(existsSync(journal) ? readFileSync(journal, "utf8") : "", recordsBefore);
    const applied = cli(root, confirmArgs);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).code, 0);
    assert.equal(runtime(root)?.applied, B);
    const again = cli(root, confirmArgs);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /stale-state/);
    const record = JSON.parse(readFileSync(journal, "utf8").trim().split("\n").at(-1)!);
    assert.equal(record.createdBy.channel, "dashboard");
    assert.equal(record.createdBy.shownHash, preview.shownHash);
    assert.equal(typeof record.createdBy.actor, "string");
    writeFileSync(join(root, ".code-agent", "docs-session.json"), JSON.stringify({ startedAt: new Date().toISOString(), version: 2, writable: ["doc"] }));
    const busyPreview = JSON.parse(cli(root, ["update", "--release", A, "--preview", "--json"]).stdout);
    const reserved = cli(root, ["update", "--release", A, "--shown-hash", busyPreview.shownHash, "--json"]);
    assert.equal(reserved.status, 3, reserved.stdout + reserved.stderr);
    assert.equal(JSON.parse(reserved.stdout).code, 3);
    assert.equal(runtime(root)?.applied, B);
    assert.equal(runtime(root)?.pending?.id, A);
  });

  test("프로젝트 없는 설치 전용 CLI 미리보기는 JSON 한 줄이며 폴더를 만들지 않는다", () => {
    const outside = join(scratch, `install-only ${nextProjectNumber()}`);
    mkdirSync(outside);
    const args = ["update", "--install-only", "--preview", "--json"];
    // 격리된 릴리스를 소스로 지정한다(non-git 안내도 정상 미리보기다). 실제 개발 저장소를 읽지 않는다.
    const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd: outside, encoding: "utf8", windowsHide: true,
      env: env({ CODE_AGENT_ENTRY: join(store, A, "dist", "agent", "cli.js") }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.canInstall, false);
    assert.match(preview.shownHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(readdirSync(outside), []);
    const isolated = { cwd: outside, encoding: "utf8" as const, windowsHide: true,
      env: env({ CODE_AGENT_ENTRY: join(store, A, "dist", "agent", "cli.js") }) };
    const invalid = spawnSync(process.execPath, [ENTRY, "update", "--install-only", "--shown-hash", "wrong", "--json"], isolated);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /stale-state/);
    for (const flags of [["--install-only"], ["--install-only", "--preview"], ["--install-only", "--preview", "--shown-hash", "wrong", "--json"], ["--templates-only", "--preview", "--json"], ["--install-only", "--preview", "--json", "--host", "both"]]) {
      assert.equal(cli(outside, ["update", ...flags]).status, 1, flags.join(" "));
    }
    assert.deepEqual(readdirSync(outside), []);
  });
  test("2-1 없어진 고정 릴리스로 새 작업·템플릿 적용을 시작하지 않고 번들 복구 뒤에도 상태 세대를 지킨다", () => {
    const root = project(), file = join(root, ".code-agent", "runtime.json");
    const pinned = { schema: 1, applied: GONE, home: store, stateSchema: STATE_SCHEMA };
    writeFileSync(file, JSON.stringify(pinned));
    const opened = cli(root, ["docs", "begin"]);
    assert.equal(opened.status, 1, opened.stdout + opened.stderr);
    assert.match(opened.stderr, /새 작업을 열지 않았습니다.*update --bundled/s);
    assert.equal(existsSync(join(root, ".code-agent", "docs-session.json")), false);
    const templates = cli(root, ["update", "--templates-only"]);
    assert.equal(templates.status, 1, templates.stdout + templates.stderr);
    assert.match(templates.stderr, /템플릿을 반영하지 않았습니다/);
    assert.deepEqual(runtime(root), pinned, "템플릿 복구가 고정을 지우지 않는다");
    const bundled = cli(root, ["update", "--bundled"]);
    assert.equal(bundled.status, 0, bundled.stderr);
    assert.equal(runtime(root)?.applied, undefined);
    assert.equal(runtime(root)?.stateSchema, STATE_SCHEMA);
    const releaseFile = join(store, A, "release.json"), original = readFileSync(releaseFile, "utf8");
    try {
      writeFileSync(releaseFile, JSON.stringify({ ...JSON.parse(original), stateSchema: STATE_SCHEMA - 1 }));
      const older = applyAs(root, A);
      assert.equal(older.status, 1);
      assert.match(older.stderr, /더 새 형식/);
      assert.equal(runtime(root)?.stateSchema, STATE_SCHEMA);
    } finally { writeFileSync(releaseFile, original); }
  });

  test("적용 버전이 없어지면 진행 중인 일은 다른 버전으로 잇지 않는다 — PreToolUse 는 막고 Stop 은 막지 않으며 조회·복구 명령만 번들로 돈다", () => {
    const root = project();
    mkdirSync(join(root, ".code-agent"), { recursive: true });
    writeFileSync(join(root, ".code-agent", "runtime.json"), JSON.stringify({ schema: 1, applied: GONE }));
    assert.equal(cli(root, ["hook"], preToolUse(root)).status, 0, "쉬는 중이면 진입점 번들로 돈다");
    assert.equal(lastRun("hook"), "bundle");
    writeFileSync(join(root, ".code-agent", "docs-session.json"), JSON.stringify({ startedAt: new Date().toISOString(), version: 2, writable: ["doc"] }));
    const blocked = cli(root, ["hook"], preToolUse(root));
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, new RegExp(`${GONE} 가 릴리스 저장소`));
    assert.equal(cli(root, ["stop"], JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "Stop" })).status, 0, "Stop 은 막지 않는다");
    const next = cli(root, ["next"]);
    assert.equal(next.status, 1);
    assert.match(next.stderr, /다른 버전으로 이어 가지 않습니다/);
    const version = cli(root, ["version"]);
    assert.equal(version.status, 0);
    assert.match(version.stderr, /상태 확인·복구 명령만 이 진입점의 번들로 실행합니다/);
    assert.match(cli(root, ["doctor"]).stdout, new RegExp(`✗ 적용 버전: ${GONE} 가 릴리스 저장소\\(.+\\)에 없습니다`));
    const aborted = cli(root, ["abort"]);
    assert.equal(lastRun("abort"), "bundle", "고정 릴리스가 없어도 abort 구현에 도달한다");
    assert.match(aborted.stderr, /진행 중인 작업도 접수 중인 요구사항도 없습니다/);
  });
  test("상태 형식 세대가 더 높은 프로젝트에는 낮은 세대의 릴리스를 적용하지 않는다(되돌리기의 한계)", () => {
    const root = project();
    mkdirSync(join(root, ".code-agent"), { recursive: true });
    const newer = STATE_SCHEMA + 1;
    writeFileSync(join(root, ".code-agent", "runtime.json"), JSON.stringify({ schema: 1, stateSchema: newer }));
    const refused = applyAs(root, A);
    assert.equal(refused.status, 1);
    assert.ok(refused.stderr.includes(`더 새 형식(세대 ${newer})`), refused.stderr);
    assert.deepEqual(runtime(root), { schema: 1, stateSchema: newer });
  });
});
