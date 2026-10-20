/** 호스트 원본은 읽기만 한다. 알려진 주 세션의 ID·cwd만 대조하며 대화 본문을 가져오지 않는다. */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { ControlError, sha256 } from "./protocol";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function within(base: string, file: string): boolean {
  const rel = relative(realpathSync(base), realpathSync(file));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
export function nativeSession(root: string, host: "claude" | "codex", session: string, explicit?: string) {
  if (!uuid.test(session)) throw new ControlError("invalid-state", "복원할 원래 세션 UUID를 확인할 수 없습니다");
  const base = host === "codex" ? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")
    : join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const candidates: string[] = [];
  const matches = (name: string) => host === "claude" ? name === `${session}.jsonl` : name.startsWith("rollout-") && name.endsWith(`-${session}.jsonl`);
  function walk(dir: string, depth = 0): void {
    if (depth > 6 || candidates.length > 1) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else if (e.isFile() && matches(e.name)) candidates.push(join(dir, e.name));
    }
  }
  if (!existsSync(base)) throw new ControlError("not-found", "호스트의 원래 세션 기록 폴더가 없습니다. 대화 기록 없이 새 세션으로 대체하지 않습니다");
  if (explicit) candidates.push(resolve(explicit)); else walk(base);
  if (candidates.length !== 1) throw new ControlError("not-found", "원래 세션 기록을 하나로 확인할 수 없습니다. --transcript로 호스트 원본 파일을 지정하세요");
  const file = candidates[0];
  if (!existsSync(file) || !within(base, file) || !matches(basename(file))) throw new ControlError("invalid-request", "호스트 기록 폴더 안의 해당 세션 원본만 복원할 수 있습니다");
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new ControlError("invalid-state", "세션 기록 크기·파일 형식을 확인하세요(상한 64 MiB)");
  const text = readFileSync(file, "utf8"), rows = text.split(/\r?\n/).filter(Boolean).map(line => {
    try { const row = JSON.parse(line); if (!row || typeof row !== "object" || Array.isArray(row)) throw Error(); return row; }
    catch { throw new ControlError("invalid-state", "미완성·손상된 세션 기록은 복원하지 않습니다"); }
  });
  const meta = host === "codex" ? rows.find(r => r.type === "session_meta")?.payload : rows.find(r => r.sessionId && r.cwd);
  const id = host === "codex" ? meta?.id : meta?.sessionId;
  if (id !== session || typeof meta?.cwd !== "string" || !existsSync(meta.cwd) || realpathSync(meta.cwd) !== realpathSync(root) ||
      (host === "codex" ? !["cli", "exec", "vscode"].includes(meta?.source) : meta?.isSidechain === true)) {
    throw new ControlError("invalid-state", "원래 주 세션 ID·프로젝트 경로가 일치하지 않습니다. 다른 프로젝트·하위 담당 세션은 복원하지 않습니다");
  }
  if (!rows.some(r => host === "codex" ? r.type === "response_item" || r.type === "event_msg" : r.type === "user" || r.type === "assistant")) {
    throw new ControlError("invalid-state", "대화가 없는 세션 메타데이터만으로 복원하지 않습니다");
  }
  return { file: realpathSync(file), hash: `sha256:${sha256(text)}`, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}
