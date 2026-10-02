import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { loadActive } from "./layout";
import { loadManifestIfAny } from "./work";
import { confirmOnTerminal } from "./tty";
import { Stop } from "./stop";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function hasBaseline(root: string): boolean {
  try { return !!git(root, ["rev-parse", "--verify", "HEAD"]); } catch { return false; }
}

/** 준비 단계에서는 설정과 실행 환경만 확인한다. 테스트 실행은 구현 이후다. */
export function setupStatus(root: string): string {
  const manifest = loadManifestIfAny(root);
  const runtime = /python/i.test(manifest?.language ?? "") ? "python" : /javascript|typescript|node/i.test(manifest?.language ?? "") ? "node" : /java|kotlin/i.test(manifest?.language ?? "") ? "java" : undefined;
  const available = runtime ? spawnSync(runtime, [runtime === "java" ? "-version" : "--version"], { encoding: "utf8", windowsHide: true }) : undefined;
  return ["프로젝트 준비", "",
    `- 설정: ${manifest ? `${manifest.language} — 기존 언어·도구 유지` : "없음 — /ca-adopt로 준비"}`,
    `- 실행 환경: ${runtime ? `${runtime} ${available?.status === 0 ? "확인됨" : "확인 필요 — 설치 또는 PATH 확인"}` : "프로젝트의 기존 실행 환경 사용"}`,
    `- 빌드: ${manifest?.build?.join(" ") ?? "미정 — 기존 빌드 설정에서 연결"}`,
    `- 테스트: ${manifest?.test?.join(" ") ?? "미정 — 기존 테스트 도구·명령에서 연결"}`,
    `- 의존성 준비: ${manifest?.prepare?.join(" ") ?? "선언 없음 — 외부 의존성이 없으면 추가 불필요"}`,
    `- 기준 커밋: ${hasBaseline(root) ? "있음" : "없음 — 현재 세션의 초기 준비 확인에서 생성 (직접 CLI: code-agent setup baseline)"}`,
    "", "지금 테스트를 실행하거나 러너를 다시 선택하지 않습니다. 실제 소스·실행 설정·테스트 생성은 승인된 Task에서 함께 수행합니다."].join("\n");
}

export function baselineFiles(root: string): string[] {
  const manifest = loadManifestIfAny(root);
  const roots = new Set(["code-agent.json", "CLAUDE.md", ".gitignore", "README.md", ".claude", "doc", ".code-agent/version",
    ...(manifest?.stages.map(stage => stage.template) ?? [])]);
  const found = new Set<string>();
  function walk(file: string) {
    const full = resolve(root, file);
    const rel = relative(root, full).replace(/\\/g, "/");
    if (isAbsolute(rel) || rel.startsWith("../") || rel === ".." || rel === ".git" || rel.startsWith(".git/") || rel === "doc/work" || rel.startsWith("doc/work/") || rel === ".claude/settings.local.json") return;
    if (!existsSync(full) || lstatSync(full).isSymbolicLink()) return;
    if (lstatSync(full).isDirectory()) for (const name of readdirSync(full)) walk(`${rel}/${name}`);
    else found.add(rel);
  }
  for (const file of roots) if (file) walk(file);
  return [...found].sort();
}

/** 최초 준비 파일만 명시적으로 커밋한다. 작업 소스·접수 원문·기존 index를 끼워 넣지 않는다. */
export function setupBaseline(root: string): string {
  if (loadActive(root)) throw new Stop("작업 중에는 초기 기준을 만들지 않습니다.");
  if (hasBaseline(root)) return "기준 커밋이 이미 있습니다 — 기존 기준을 유지합니다.";
  if (!loadManifestIfAny(root)) throw new Stop("/ca-adopt로 프로젝트 설정·공통 문서를 먼저 준비하세요.");
  const files = baselineFiles(root);
  if (!files.length) throw new Stop("기준으로 저장할 준비 파일이 없습니다.");
  const snapshot = () => createHash("sha256").update(JSON.stringify(baselineFiles(root).map(file => [file, readFileSync(join(root, file)).toString("base64")]))).digest("hex");
  const before = snapshot();
  if (existsSync(join(root, ".git")) && git(root, ["diff", "--cached", "--name-only"])) throw new Stop("이미 스테이징한 파일이 있습니다 — 먼저 그 변경을 처리하세요. 기존 index는 바꾸지 않았습니다.");
  const presence = confirmOnTerminal([setupStatus(root), "", "최초 기준으로 저장할 준비 파일:", ...files.map(file => `- ${file}`), "", "위 파일로 로컬 최초 커밋을 만듭니다. Git 저장소가 없으면 초기화합니다."].join("\n"), "prepare");
  if (!presence.verified || snapshot() !== before) throw new Stop("확인 중 준비 파일이 바뀌었습니다 — 다시 확인하세요.");
  if (!existsSync(join(root, ".git"))) git(root, ["init", "-q", "-b", loadManifestIfAny(root)!.git.base]);
  if (hasBaseline(root) || git(root, ["diff", "--cached", "--name-only"])) throw new Stop("확인 중 Git 상태가 바뀌었습니다 — 다시 확인하세요.");
  try { git(root, ["var", "GIT_AUTHOR_IDENT"]); git(root, ["var", "GIT_COMMITTER_IDENT"]); }
  catch { throw new Stop("Git 작성자 이름·이메일 설정이 필요합니다. 설정 후 code-agent setup baseline을 다시 실행하세요."); }
  git(root, ["add", "--", ...files]);
  git(root, ["commit", "-m", "chore: initialize code-agent project documents"]);
  return "준비 파일의 최초 기준 커밋을 만들었습니다. 같은 세션에서 접수를 계속합니다. 중단했다면 /ca-next로 재개하세요. 실제 소스와 테스트는 승인된 Task에서 생성합니다.";
}
