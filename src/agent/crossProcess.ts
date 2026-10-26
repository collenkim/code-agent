/** 동기 CLI의 교차 호출을 worker에서 감독한다. 제한 시간이 되면 래퍼와 자식을 함께 끝낸다. */
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Worker } from "worker_threads";

interface Result { stdout: string; stderr: string; status: number | null; error?: { code?: string; message: string } }
const WORKER = String.raw`
const { workerData } = require('worker_threads');
const { spawn, spawnSync } = require('child_process');
const { writeFileSync } = require('fs');
const { join } = require('path');
const { file, args, cwd, env, timeout, output, shared } = workerData;
const state = new Int32Array(shared);
let child, timer, drain, ended = false, stdout = '', stderr = '', error;
const finish = status => {
  if (ended) return; ended = true; clearTimeout(timer); clearTimeout(drain);
  try { writeFileSync(output, JSON.stringify({ stdout, stderr, status, ...(error ? { error } : {}) })); }
  finally { Atomics.store(state, 0, 1); Atomics.notify(state, 0); }
};
const kill = () => {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T','/F','/PID',String(child.pid)], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
};
const stop = code => {
  if (error) return;
  error = { code, message: code === 'ETIMEDOUT' ? 'cross command timed out' : 'cross command output exceeded maxBuffer' };
  kill(); drain = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(null); }, 2000);
};
try {
  child = spawn(file, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });
  Atomics.store(state, 1, child.pid || 0);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-16*1024*1024); if (stdout.length >= 16*1024*1024) stop('ENOBUFS'); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16*1024*1024); if (stderr.length >= 16*1024*1024) stop('ENOBUFS'); });
  child.on('error', value => { error = { code: value.code, message: value.message }; finish(null); });
  child.on('close', finish);
  timer = setTimeout(() => stop('ETIMEDOUT'), timeout);
} catch (value) { error = { code: value.code, message: value.message }; finish(null); }
`;

export function runCrossProcess(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Result {
  const scratch = mkdtempSync(join(tmpdir(), "code-agent-cross-process-")), output = join(scratch, "result.json");
  const shared = new SharedArrayBuffer(8), state = new Int32Array(shared);
  let worker: Worker | undefined;
  try {
    worker = new Worker(WORKER, { eval: true, workerData: { file, args, cwd, env, timeout, output, shared } });
    worker.on("error", () => {});
    Atomics.wait(state, 0, 0, timeout + 15000);
    if (Atomics.load(state, 0) === 1) return JSON.parse(readFileSync(output, "utf8")) as Result;
    // worker 자체가 끝나지 않아도 그 worker가 띄운 자식을 남기지 않는다.
    const pid = Atomics.load(state, 1);
    if (pid) {
      if (process.platform === "win32") spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { windowsHide: true, timeout: 5000, stdio: "ignore" });
      else { try { process.kill(-pid, "SIGKILL"); } catch { /* 이미 끝남 */ } }
    }
    return { stdout: "", stderr: "", status: null, error: { code: "ETIMEDOUT", message: "cross supervisor timed out" } };
  } finally {
    void worker?.terminate();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
