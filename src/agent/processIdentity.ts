/** PID 재사용을 구분하는 OS의 프로세스 시작 식별값. 확인 실패는 undefined로 남겨 살아 있는 잠금을 회수하지 않는다. */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

export function processIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
      return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
    }
    if (process.platform === "win32") {
      const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const start = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command",
        `[Console]::Out.Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString())`],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
      return /^\d+$/.test(start) ? start : undefined;
    }
    const start = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
    return start || undefined;
  } catch { return undefined; }
}

let own: string | undefined, attempted = false;
export function ownProcessIdentity(): string | undefined {
  if (!attempted) { attempted = true; own = processIdentity(process.pid); }
  return own;
}
