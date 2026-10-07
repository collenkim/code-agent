/**
 * 공통 파일 잠금(lock.ts) — 회수·대기·중지.
 *
 * 같은 PC 의 죽은 주인과 주인 기록 없는 오래된 잠금(나이 회수를 허용할 때만)은 같은 호출 안에서 회수하고,
 * 살아 있는 주인은 기다린 뒤 멈추며, 다른 PC·주인 기록 없음은 경로를 알리고 사람에게 넘긴다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { acquireLock, pidAlive } from "../agent/lock";
import { Stop } from "../agent/stop";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ca-lock-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function captureStderr<T>(run: () => T): { value: T; stderr: string } {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { value: run(), stderr }; } finally { process.stderr.write = original; }
}
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;
const elapsed = (run: () => void): number => { const start = Date.now(); run(); return Date.now() - start; };
const stopMessage = (run: () => void): string => {
  try { run(); } catch (error) { assert.ok(error instanceof Stop, String(error)); return error.message; }
  assert.fail("Stop 이 나야 한다");
};

describe("acquireLock", () => {
  test("주인 {pid, host, at} 을 쓰고, 해제는 한 번만 지운다", () => {
    const path = join(dir, "a.lock");
    const release = acquireLock(path, { waitMs: 100, ageReclaim: true, label: "시험" });
    const owner = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.host, hostname());
    assert.ok(!Number.isNaN(Date.parse(owner.at)));
    release();
    assert.equal(existsSync(path), false);
    const again = acquireLock(path, { waitMs: 100, ageReclaim: true, label: "시험" });
    release();   // 이미 푼 해제 함수는 새 잠금을 건드리지 않는다
    assert.equal(existsSync(path), true);
    again();
    assert.equal(existsSync(path), false);
  });

  test("같은 PC 의 죽은 주인은 같은 호출 안에서 회수한다", () => {
    const path = join(dir, "dead.lock");
    const pid = deadPid();
    writeFileSync(path, JSON.stringify({ pid, host: hostname(), at: "t" }));
    const { value: release, stderr } = captureStderr(() => acquireLock(path, { waitMs: 100, ageReclaim: false, label: "동의" }));
    assert.match(stderr, new RegExp(`code-agent: 동의 잠금을 회수했습니다 — pid ${pid} 종료`));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
    release();
  });

  test("주인 기록 없는 잠금은 나이 회수를 허용할 때만 10분 뒤 회수한다", () => {
    const path = join(dir, "old.lock");
    writeFileSync(path, "");
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(path, old, old);
    assert.throws(() => acquireLock(path, { waitMs: 100, ageReclaim: false, label: "동의" }), Stop, "나이 회수를 허용하지 않으면 회수하지 않는다");
    assert.equal(readFileSync(path, "utf8"), "");
    const { value: release, stderr } = captureStderr(() => acquireLock(path, { waitMs: 100, ageReclaim: true, label: "계획 기록" }));
    assert.match(stderr, /계획 기록 잠금을 회수했습니다 — 주인 기록 없음, 11분 경과/);
    release();
  });

  test("방금 만든 빈 잠금은 기다리지 않고 경로·자동 회수 시각을 알린다", () => {
    const path = join(dir, "fresh.lock");
    writeFileSync(path, "");
    let message = "";
    const time = elapsed(() => { message = stopMessage(() => acquireLock(path, { waitMs: 2_000, ageReclaim: true, label: "계획 기록", display: ".code-agent/work/W/x.planning.json.lock" })); });
    assert.ok(time < 1_000, `${time}ms`);
    assert.match(message, /^계획 기록 잠금의 주인을 확인할 수 없습니다\(\d+초 전 생성\)\. 10분이 지나면/);
    assert.match(message, /\.code-agent\/work\/W\/x\.planning\.json\.lock 을 지운 뒤/);
    assert.equal(existsSync(path), true, "주인을 모르는 잠금은 훔치지 않는다");
  });

  test("살아 있는 주인은 waitMs 까지 기다린 뒤 pid 와 다시 실행 안내로 멈춘다", () => {
    const path = join(dir, "busy.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), at: "2026-10-07T00:00:00Z" }));
    let message = "";
    const time = elapsed(() => { message = stopMessage(() => acquireLock(path, { waitMs: 300, ageReclaim: true, label: "리뷰 기록" })); });
    assert.ok(time >= 250, `${time}ms`);
    assert.match(message, new RegExp(`pid ${process.pid}, 2026-10-07T00:00:00Z 시작`));
    assert.match(message, /같은 명령을 한 번만 다시 실행하세요/);
  });

  test("잠금을 쥔 동안 같은 경로의 두 번째 잠금은 얻지 못한다", () => {
    const path = join(dir, "twice.lock");
    const release = acquireLock(path, { waitMs: 100, ageReclaim: true, label: "임대" });
    try { assert.throws(() => acquireLock(path, { waitMs: 50, ageReclaim: true, label: "임대" }), /다른 code-agent 프로세스가 쥐고 있습니다/); }
    finally { release(); }
  });

  test("다른 PC 의 주인은 회수하지 않고 사람에게 넘긴다", () => {
    const path = join(dir, "foreign.lock");
    writeFileSync(path, JSON.stringify({ pid: 1, host: "other-pc", at: "t" }));
    let message = "";
    const time = elapsed(() => { message = stopMessage(() => acquireLock(path, { waitMs: 2_000, ageReclaim: true, label: "계획 기록" })); });
    assert.ok(time < 1_000, `${time}ms`);
    assert.match(message, /다른 PC\(other-pc, pid 1\)/);
    assert.match(message, new RegExp(`${path.replace(/[\\.]/g, "\\$&")} 을 지운 뒤`));
  });

  test("호출자 문구를 쓰고, 나이 회수가 없는 잠금은 자동 회수를 안내하지 않는다", () => {
    const path = join(dir, "custom.lock");
    writeFileSync(path, "");
    const message = stopMessage(() => acquireLock(path, { waitMs: 100, ageReclaim: false, label: "확인·적용",
      messages: { unknown: (lock) => `사용자 문구 ${lock.display} ${lock.ageReclaim}` } }));
    assert.equal(message, `사용자 문구 ${path} false`);
    const applyLock = join(dir, "apply.lock");
    writeFileSync(applyLock, "");
    const fallback = stopMessage(() => acquireLock(applyLock, { waitMs: 100, ageReclaim: false, label: "확인·적용" }));
    assert.match(fallback, /apply\.lock 을 지운 뒤/, "기본 문구로도 기존 동의 테스트 정규식이 맞는다");
    assert.equal(fallback.includes("10분"), false);
  });

  test("잠금 폴더가 없으면 Stop 이 아니라 원래 오류다", () => {
    assert.throws(() => acquireLock(join(dir, "missing", "x.lock"), { waitMs: 50, ageReclaim: true, label: "시험" }), (error: unknown) =>
      !(error instanceof Stop) && (error as NodeJS.ErrnoException).code === "ENOENT");
  });
});

test("pidAlive — 자기 자신은 살아 있고 끝난 자식은 죽었다", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
});
