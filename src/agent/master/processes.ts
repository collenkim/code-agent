/**
 * 실행 프로세스 확인·정리 — 기록한 pid 가 살아 있는지와 **그 실행의 프로세스인지**(명령줄 표지)를 함께 본다. pid 는 재사용되므로
 * 생존만으로 같은 프로세스라고 보지 않는다. 종료는 확인된 pid 의 프로세스 트리에만 한다(이름으로 찾아 죽이지 않는다).
 *
 * - Windows: Get-CimInstance Win32_Process(명령줄·부모)로 확인하고 `taskkill /PID <pid> /T /F` 로 트리를 끝낸다.
 * - Linux: /proc/<pid>/cmdline, macOS: `ps -o command=`. 종료는 프로세스 그룹(감독이 detached 로 띄운 호스트)부터.
 */
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";

import { pidAlive } from "../lock";

export type Liveness = "alive" | "dead" | "reused" | "unknown";

function commandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [Console]::Out.Write($p.CommandLine) } else { [Console]::Out.Write('<none>') }`],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
      return out === "<none>" ? undefined : out;
    }
    if (process.platform === "linux") {
      const file = `/proc/${pid}/cmdline`;
      return existsSync(file) ? readFileSync(file, "utf8").split("\0").join(" ") : undefined;
    }
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** pid 가 살아 있고 명령줄에 표지가 있는가. 명령줄을 읽지 못하면 unknown(살아 있다고도 죽었다고도 하지 않는다) */
export function liveness(pid: number | undefined, marker: string): Liveness {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return "dead";
  if (!pidAlive(pid)) return "dead";
  const line = commandLine(pid);
  if (line === undefined) return pidAlive(pid) ? "unknown" : "dead";
  if (!line.trim()) return "unknown";
  return line.includes(marker) ? "alive" : "reused";
}

/** 확인된 프로세스 트리를 강제로 끝낸다 — 표지가 맞지 않으면 아무것도 하지 않는다. 끝났는지는 호출자가 liveness 로 다시 본다 */
export function killVerified(pid: number, marker: string): { killed: boolean; detail: string } {
  const before = liveness(pid, marker);
  if (before === "dead") return { killed: false, detail: "이미 끝났습니다" };
  if (before === "reused") return { killed: false, detail: "pid 가 다른 프로세스에 재사용됐습니다 — 끝내지 않습니다" };
  if (before === "unknown") return { killed: false, detail: "명령줄을 확인하지 못해 끝내지 않습니다" };
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    return { killed: result.status === 0, detail: (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] ?? "" };
  }
  try { process.kill(-pid, "SIGKILL"); return { killed: true, detail: "프로세스 그룹 SIGKILL" }; }
  catch {
    try { process.kill(pid, "SIGKILL"); return { killed: true, detail: "SIGKILL" }; }
    catch (error) { return { killed: false, detail: error instanceof Error ? error.message : String(error) }; }
  }
}

/** 기다리며 끝났는지 본다 — 기한 안에 끝나면 true */
export function waitDead(pid: number, marker: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = liveness(pid, marker);
    if (state === "dead" || state === "reused") return true;
    if (Date.now() >= deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}
