import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { loadActive } from "./layout";
import { loadManifestIfAny } from "./work";
import { confirmOnTerminal } from "./tty";
import { Stop } from "./stop";
import { commitOf, mergeBase } from "./tree";
import { docPaths } from "./docs";
import { POLICY_KINDS } from "./schemas";

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
    `- 기준 커밋: ${hasBaseline(root) ? (pendingBaselineFiles(root).length ? "도입 파일 반영 필요 — 현재 세션의 setup/baseline 동의로 준비 커밋 생성" : "있음 — 도입 파일 반영됨") : "없음 — 현재 세션의 초기 준비 확인에서 생성 (직접 CLI: code-agent setup baseline)"}`,
    "", "지금 테스트를 실행하거나 러너를 다시 선택하지 않습니다. 실제 소스·실행 설정·테스트 생성은 승인된 Task에서 함께 수행합니다."].join("\n");
}

export function baselineFiles(root: string): string[] {
  const manifest = loadManifestIfAny(root);
  const roots = new Set(["code-agent.json", "CLAUDE.md", "AGENTS.md", ".gitignore", "README.md", ".claude", ".agents/skills", ".codex/agents", ".codex/hooks.json", ".codex/config.toml", "doc", ".code-agent/version", ".code-agent/hosts.json", ".code-agent/codex-models.json",
    ...(manifest?.stages.map(stage => stage.template) ?? []),
    ...POLICY_KINDS.flatMap(kind => docPaths(manifest, kind))]);
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

/** 무시된 도입 문서도 포함한다. Git diff가 줄바꿈/clean filter를 적용해 실제 커밋과 비교한다. */
export function pendingBaselineFiles(root: string, ref = "HEAD"): string[] {
  const files = baselineFiles(root);
  if (!files.length || !commitOf(root, ref)) return files;
  const changed = new Set([
    ...git(root, ["--literal-pathspecs", "diff", "--name-only", "-z", ref, "--", ...files]).split("\0"),
    ...git(root, ["--literal-pathspecs", "ls-files", "--others", "-z", "--", ...files]).split("\0"),
  ]);
  return files.filter(file => changed.has(file));
}

/** 전환 전에 검사한다. 기준에 없는 도입 파일을 삭제하거나 첫 check까지 문제를 미루지 않는다. */
export function requirePreparedBranch(root: string, branch: string, base: string): void {
  const pending = pendingBaselineFiles(root);
  if (pending.length) throw new Stop(
    `도입 파일이 아직 준비 커밋에 반영되지 않았습니다:\n${pending.map(file => `  - ${file}`).join("\n")}\n` +
    "현재 세션의 ca-answer setup/baseline 동의 절차 또는 code-agent setup baseline 으로 준비 커밋을 만든 뒤 시작하세요. 브랜치는 바꾸지 않았습니다.",
  );
  const destination = commitOf(root, branch) ? branch : base;
  if (!commitOf(root, destination)) return; // 없는 기준 브랜치의 안내는 switchToWorkBranch가 담당한다.
  const baseline = destination === branch ? mergeBase(root, base, branch) ?? destination : destination;
  const head = commitOf(root, "HEAD"), files = baselineFiles(root);
  const refs = new Set([commitOf(root, destination), commitOf(root, baseline)]);
  refs.delete(head);
  const missing = [...new Set([...refs].filter((ref): ref is string => !!ref).flatMap(ref =>
    git(root, ["--literal-pathspecs", "diff", "--name-only", "-z", ref, "HEAD", "--", ...files]).split("\0").filter(Boolean),
  ))];
  if (missing.length) throw new Stop(
    `작업 기준 ${base} 또는 작업 브랜치 ${branch} 에 현재 도입 파일이 반영되지 않았습니다:\n${missing.map(file => `  - ${file}`).join("\n")}\n` +
    "도입 커밋이 포함된 브랜치를 start --base <브랜치> 로 지정하거나 지정한 기준 브랜치에 도입 커밋을 반영하세요. 브랜치는 바꾸지 않았습니다.",
  );
}

/** 기존 저장소도 준비 파일만 확인 후 커밋한다. 작업 소스·접수 원문·기존 index는 섞지 않는다. */
export function setupBaseline(root: string): string {
  if (loadActive(root)) throw new Stop("작업 중에는 초기 기준을 만들지 않습니다.");
  const head = commitOf(root, "HEAD");
  if (!loadManifestIfAny(root)) throw new Stop("/ca-adopt로 프로젝트 설정·공통 문서를 먼저 준비하세요.");
  const files = pendingBaselineFiles(root);
  if (head && !files.length) return "기준 커밋이 이미 있습니다 — 도입 파일이 반영된 기존 기준을 유지합니다.";
  if (!files.length) throw new Stop("기준으로 저장할 준비 파일이 없습니다.");
  let branch: string | undefined;
  if (head) {
    try { branch = git(root, ["symbolic-ref", "--quiet", "HEAD"]); }
    catch { throw new Stop("현재 HEAD가 브랜치에 연결되지 않았습니다. 도입 파일을 반영할 브랜치로 이동한 뒤 setup baseline 을 다시 실행하세요."); }
  }
  const snapshot = () => createHash("sha256").update(JSON.stringify(baselineFiles(root).map(file => [file, readFileSync(join(root, file)).toString("base64")]))).digest("hex");
  const before = snapshot();
  if (existsSync(join(root, ".git")) && git(root, ["diff", "--cached", "--name-only"])) throw new Stop("이미 스테이징한 파일이 있습니다 — 먼저 그 변경을 처리하세요. 기존 index는 바꾸지 않았습니다.");
  const presence = confirmOnTerminal([setupStatus(root), "", "기준으로 저장할 준비 파일:", ...files.map(file => `- ${file}`), "", head
    ? `위 도입 파일로 현재 브랜치 ${branch} 에 로컬 준비 커밋을 추가합니다. 작업 기준 브랜치에도 이 커밋이 포함돼야 합니다.`
    : "위 파일로 로컬 최초 커밋을 만듭니다. Git 저장소가 없으면 초기화합니다."].join("\n"), "prepare");
  if (!presence.verified || snapshot() !== before) throw new Stop("확인 중 준비 파일이 바뀌었습니다 — 다시 확인하세요.");
  if (!existsSync(join(root, ".git"))) git(root, ["init", "-q", "-b", loadManifestIfAny(root)!.git.base]);
  if (commitOf(root, "HEAD") !== head || (branch && git(root, ["symbolic-ref", "--quiet", "HEAD"]) !== branch) || git(root, ["diff", "--cached", "--name-only"])) throw new Stop("확인 중 Git 상태가 바뀌었습니다 — 다시 확인하세요.");
  try { git(root, ["var", "GIT_AUTHOR_IDENT"]); git(root, ["var", "GIT_COMMITTER_IDENT"]); }
  catch { throw new Stop("Git 작성자 이름·이메일 설정이 필요합니다. 설정 후 code-agent setup baseline을 다시 실행하세요."); }
  try {
    git(root, ["--literal-pathspecs", "add", "-f", "--", ...files]);
    git(root, ["--literal-pathspecs", "commit", "-m", "chore: initialize code-agent project documents", "--", ...files]);
  } catch (error) {
    throw new Stop(`준비 커밋이 실패했습니다. 스테이지 상태를 확인하세요: ${error instanceof Error ? error.message : error}`);
  }
  return `준비 파일의 ${head ? "도입" : "최초 기준"} 커밋을 만들었습니다. 같은 세션에서 접수를 계속합니다. 중단했다면 /ca-next로 재개하세요. 실제 소스와 테스트는 승인된 Task에서 생성합니다.`;
}
