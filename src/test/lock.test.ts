/**
 * 공통 파일 잠금(lock.ts) — 회수·대기·중지.
 *
 * 같은 PC 의 죽은 주인과 주인 기록 없는 오래된 잠금(나이 회수를 허용할 때만)은 같은 호출 안에서 회수하고,
 * 살아 있는 주인은 기다린 뒤 멈추며, 다른 PC·주인 기록 없음은 경로를 알리고 사람에게 넘긴다.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { acquireLock, pidAlive } from "../agent/lock";
import { Stop } from "../agent/stop";

/** lock.js 가 부르는 fs 함수를 바꿔 끼울 수 있는 같은 모듈 객체(import * 는 읽기 전용 바인딩이다) */
const fsModule = require("node:fs") as typeof import("node:fs");

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

  test("잠금 파일을 읽지 못하면(ENOENT 밖의 오류) 주인 불명으로 보고 Stop 이다 — 원래 예외로 새지 않는다", () => {
    const path = join(dir, "folder.lock");
    mkdirSync(path);   // 열기는 EEXIST, 읽기는 EISDIR
    const message = stopMessage(() => acquireLock(path, { waitMs: 100, ageReclaim: true, label: "계획 기록" }));
    assert.match(message, /^계획 기록 잠금의 주인을 확인할 수 없습니다/);
  });

  test("해제는 자기 기록일 때만 지운다 — 그 사이 다른 주인으로 바뀐 잠금은 건드리지 않는다", () => {
    const path = join(dir, "mine.lock");
    const release = acquireLock(path, { waitMs: 100, ageReclaim: true, label: "시험" });
    const other = JSON.stringify({ pid: 1, host: "other-pc", at: "t", nonce: "n" });
    writeFileSync(path, other);
    release();
    assert.equal(readFileSync(path, "utf8"), other);
  });

  test("회수 가드 — 살아 있는 가드는 기다린 뒤 회수 중 Stop, 주인이 죽은 가드는 치우고 회수한다", () => {
    const path = join(dir, "guarded.lock");
    writeFileSync(path, JSON.stringify({ pid: deadPid(), host: hostname(), at: "t" }));
    writeFileSync(`${path}.reclaim`, JSON.stringify({ pid: process.pid, host: hostname(), at: "t" }));
    const message = stopMessage(() => acquireLock(path, { waitMs: 100, ageReclaim: true, label: "리뷰 기록" }));
    assert.match(message, /^리뷰 기록 잠금을 다른 프로세스가 회수하는 중입니다.*guarded\.lock\.reclaim 을 지운 뒤/);
    writeFileSync(`${path}.reclaim`, JSON.stringify({ pid: deadPid(), host: hostname(), at: "t" }));
    const { value: release, stderr } = captureStderr(() => acquireLock(path, { waitMs: 100, ageReclaim: true, label: "리뷰 기록" }));
    assert.match(stderr, /리뷰 기록 잠금을 회수했습니다/);
    assert.equal(existsSync(`${path}.reclaim`), false, "회수가 끝나면 가드를 지운다");
    release();
  });

  test("Windows 에서 지워지는 중인 잠금의 EPERM 은 기한까지 다시 보고, 기한이 지나면 Stop 이다", { skip: process.platform !== "win32" && "Windows 전용 판정" }, () => {
    const path = join(dir, "pending.lock");
    const original = fsModule.openSync;
    let failures = 0;
    const eperm = () => Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), { code: "EPERM" });
    fsModule.openSync = ((file: Parameters<typeof original>[0], ...rest: unknown[]) => {
      if (String(file) === path && failures > 0) { failures--; throw eperm(); }
      return (original as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof original;
    try {
      failures = 3;
      const release = acquireLock(path, { waitMs: 1_000, ageReclaim: true, label: "시험" });
      assert.equal(failures, 0);
      release();
      failures = Number.POSITIVE_INFINITY;
      assert.match(stopMessage(() => acquireLock(path, { waitMs: 100, ageReclaim: true, label: "시험" })), /주인을 확인할 수 없습니다/);
    } finally { fsModule.openSync = original; }
  });
});

/**
 * 여러 프로세스가 같은 죽은 주인 잠금을 동시에 회수한다. 일꾼은 잠금을 얻으면 wx 표지 파일을 만들고(이미 있으면 상호 배제 위반),
 * 카운터를 읽고 150ms 뒤 1 을 더해 쓴다. 한 일꾼은 잠금 파일 unlink 를 30ms 늦춰 "다시 읽기 → 지우기" 사이의 경합 창을 넓힌다.
 */
const WORKER = String.raw`
const fs = require("fs"), path = require("path");
const [lockJs, lockPath, dataDir, id, startAt, delay] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (Number(delay) > 0) {
  const original = fs.unlinkSync;
  fs.unlinkSync = function (p, ...rest) { if (String(p) === lockPath) sleep(Number(delay)); return original.call(this, p, ...rest); };
}
const { acquireLock } = require(lockJs);
const out = { ok: 0, stop: 0, raw: [], violations: 0, reclaimLines: 0 };
process.stderr.write = (chunk) => { if (String(chunk).includes("회수했습니다")) out.reclaimLines++; return true; };
while (Date.now() < Number(startAt)) { /* 동시 출발 */ }
let release;
try { release = acquireLock(lockPath, { waitMs: 5000, ageReclaim: true, label: "시험" }); }
catch (error) { if (error && error.constructor && error.constructor.name === "Stop") out.stop++; else out.raw.push(String(error && error.code || error)); }
if (release) {
  const marker = path.join(dataDir, "inside.marker");
  let fd;
  try { fd = fs.openSync(marker, "wx"); } catch (error) { if (error.code === "EEXIST") out.violations++; else out.raw.push("marker " + error.code); }
  const counter = path.join(dataDir, "counter.txt");
  const n = Number(fs.readFileSync(counter, "utf8") || "0");
  sleep(150);
  fs.writeFileSync(counter, String(n + 1));
  if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(marker); }
  out.ok++;
  release();
}
fs.writeFileSync(path.join(dataDir, "result-" + id + ".json"), JSON.stringify(out));
`;

describe("acquireLock — 다중 프로세스 회수", () => {
  const lockJs = join(__dirname, "..", "agent", "lock.js");
  const runWorker = (worker: string, args: string[]) => new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [worker, ...args], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code));
  });
  async function trial(delays: number[]): Promise<{ ok: number; counter: number; violations: number; reclaimLines: number; raw: string[]; stop: number }> {
    const data = mkdtempSync(join(tmpdir(), "ca-lock-race-"));
    try {
      const worker = join(data, "worker.cjs");
      writeFileSync(worker, WORKER);
      writeFileSync(join(data, "counter.txt"), "0");
      const lockPath = join(data, "x.lock");
      writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), host: hostname(), at: "t" }));
      const startAt = String(Date.now() + 700);
      const codes = await Promise.all(delays.map((delay, i) => runWorker(worker, [lockJs, lockPath, data, String(i), startAt, String(delay)])));
      assert.deepEqual(codes, delays.map(() => 0), "일꾼 비정상 종료");
      const results = delays.map((_, i) => JSON.parse(readFileSync(join(data, `result-${i}.json`), "utf8")) as { ok: number; stop: number; raw: string[]; violations: number; reclaimLines: number });
      const sum = (key: "ok" | "stop" | "violations" | "reclaimLines") => results.reduce((total, result) => total + result[key], 0);
      return { ok: sum("ok"), stop: sum("stop"), violations: sum("violations"), reclaimLines: sum("reclaimLines"), raw: results.flatMap((result) => result.raw),
        counter: Number(readFileSync(join(data, "counter.txt"), "utf8")) };
    } finally { rmSync(data, { recursive: true, force: true }); }
  }

  test("같은 죽은 주인 잠금을 동시에 회수해도 한 번에 하나만 잠금을 얻는다(한쪽 unlink 지연 주입·자연 타이밍)", async () => {
    for (const delays of [[0, 30], [30, 0], [0, 30], [0, 0, 0, 0]]) {
      const result = await trial(delays);
      const label = `지연 ${delays.join("/")}: ${JSON.stringify(result)}`;
      assert.equal(result.violations, 0, label);
      assert.deepEqual(result.raw, [], label);
      assert.equal(result.ok, delays.length, label);
      assert.equal(result.counter, result.ok, label);
      assert.equal(result.reclaimLines, 1, `죽은 잠금은 한 번만 회수한다 — ${label}`);
    }
  });
});

test("pidAlive — 자기 자신은 살아 있고 끝난 자식은 죽었다", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
});
