import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";

import { isPackaged } from "./assets";
import { Stop } from "./stop";
import { HostSelection } from "./hosts";
import { confirmOnTerminal } from "./tty";
import { hostMarked } from "./crossEnv";
import { installGitRelease, listReleases, npm, type RunNpm } from "./releaseStore";
import { entryScript, installedRelease, readRuntime, releaseHome, SELF_ENV } from "./runtimeSelect";
import { actorName } from "./actor";
import { storeDir } from "./plugins/store";

export interface SourceUpdateOptions {
  /** Hook CLI override, as in update(). The installed hook form is inherited otherwise. */
  cli?: string;
  host?: HostSelection;
  /** Installation overrides for embedders/tests; never inferred from the target repository. */
  sourceRoot?: string;
  packaged?: boolean;
  /** Optional binding to sourceUpdateSnapshot() captured when consent was shown. */
  expectedSourceSnapshot?: string;
  /** The consent being applied — the new release's apply does not count it as an open consent. */
  consentId?: string;
  /** Only npm is replaceable: tests still exercise real Git and fresh CLI subprocesses. */
  runNpm?: RunNpm;
}

interface Audit {
  installType: "git-source" | "npm-package" | "non-git" | "binary";
  source?: string;
  target?: string;
  branch?: string;
  remote?: string;
  remoteRef?: string;
  upstream?: string;
  // Keep URLs out of displayed summaries: configured credentials may be present.
  remoteUrls?: string;
  remoteFetch?: string;
  head?: string;
  /** 이 프로젝트의 적용 버전(runtime.json) — 없으면 진입점 번들 */
  applied?: string;
  pending?: string;
  store: string;
  blocked?: string;
}

function canonical(path: string): string {
  return realpathSync.native(resolve(path));
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function localGit(source: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: source, encoding: "utf8", windowsHide: true, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
    // A preview must not refresh/write the index. Never prompt invisibly for credentials.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return !result.error && result.status === 0 ? result.stdout.trim() : undefined;
}

function sourceAudit(options: SourceUpdateOptions): Audit {
  const base = { store: releaseHome() };
  if (options.packaged ?? isPackaged()) return {
    ...base, installType: "binary", source: process.execPath,
    blocked: "단일 실행 파일은 여기서 새 버전을 받을 수 없습니다. 기존 배포 경로에서 새 실행 파일을 받아 교체한 뒤 update --templates-only 를 실행하세요(진행 중인 작업이 있으면 끝난 뒤에 교체합니다).",
  };
  // 진입점의 패키지 루트(assets.ts 와 같은 자리 — npm 링크·Git worktree 포함). 위임받은 릴리스가 돌 때도 진입점의 소스를 본다
  const source = canonical(options.sourceRoot ?? join(dirname(entryScript()), "..", ".."));
  const result: Audit = { ...base, installType: source.split(/[\\/]/).includes("node_modules") ? "npm-package" : "non-git", source };
  const top = localGit(source, ["rev-parse", "--show-toplevel"]);
  if (!top || !samePath(canonical(top), source)) {
    if (existsSync(join(source, ".git"))) {
      result.installType = "git-source";
      result.blocked = "Git 소스 설치의 상태를 읽지 못했습니다. Git 실행 환경과 저장소 접근 권한을 확인하세요.";
      return result;
    }
    result.blocked = result.installType === "npm-package"
      ? "npm 패키지 설치입니다. 기존 설치에 사용한 패키지 관리자·패키지 지정·설치 범위로 새 버전을 설치하세요 — 다음 작업을 열 때(또는 update --templates-only) 그 패키지를 릴리스 저장소에 복사해 이 프로젝트에 적용합니다. 진행 중인 작업은 복사해 둔 지금 버전으로 계속 돕니다(고정 없이 시작한 작업이면 끝난 뒤에 설치합니다). 원본 Git 주소나 전역 설치 여부는 추정하지 않습니다."
      : "이 설치 폴더는 Git 소스 저장소가 아닙니다. 기존 설치/배포 방법으로 새 버전을 설치한 뒤 update --templates-only 를 실행하세요.";
    return result;
  }
  result.installType = "git-source";
  result.branch = localGit(source, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!result.branch) { result.blocked = "소스가 detached HEAD 상태입니다. upstream 이 설정된 브랜치로 전환하세요."; return result; }
  result.head = localGit(source, ["rev-parse", "HEAD"]);
  result.remote = localGit(source, ["config", "--get", `branch.${result.branch}.remote`]);
  result.remoteRef = localGit(source, ["config", "--get-all", `branch.${result.branch}.merge`]);
  result.upstream = localGit(source, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  if (result.remote) {
    result.remoteUrls = result.remote === "." ? source : localGit(source, ["remote", "get-url", "--all", result.remote]);
    result.remoteFetch = localGit(source, ["config", "--get-all", `remote.${result.remote}.fetch`]);
  }
  if (!result.remote || result.remote.startsWith("-") || !result.remoteUrls || !result.remoteRef?.startsWith("refs/heads/") || result.remoteRef.includes("\n") || !result.upstream) {
    result.blocked = "소스 브랜치에 유효한 upstream 이 필요합니다. 사용할 remote/upstream 을 직접 설정하세요.";
  }
  return result;
}

function audit(repoRoot: string, options: SourceUpdateOptions): Audit & { target: string } {
  const target = canonical(repoRoot);
  let runtime: ReturnType<typeof readRuntime>;
  try { runtime = readRuntime(target); } catch { runtime = undefined; }
  const { store, ...source } = sourceAudit(options);
  // 기존 동의 스냅샷의 직렬화 순서를 유지한다.
  return { target, store, ...(runtime?.applied ? { applied: runtime.applied } : {}), ...(runtime?.pending ? { pending: runtime.pending.id } : {}), ...source };
}

function summary(value: Audit): string {
  const releases = listReleases(value.store);
  return [
    `설치 유형: ${value.installType}`,
    `소스: ${value.source ?? "단일 실행 파일"}`,
    ...(value.target ? [`대상: ${value.target}`] : []),
    ...(value.branch ? [`브랜치: ${value.branch}`] : []),
    ...(value.remote ? [`remote: ${value.remote}`] : []),
    ...(value.upstream ? [`upstream: ${value.upstream}`] : []),
    ...(value.head ? [`소스 폴더 커밋: ${value.head} (그대로 둡니다)`] : []),
    ...(value.target ? [`이 프로젝트 적용 버전: ${value.applied ?? "진입점 번들"}${value.pending ? ` · 적용 대기 ${value.pending}` : ""}`] : []),
    `릴리스 저장소: ${value.store} (설치된 릴리스 ${releases.length}개)`,
    `소스 확인값: ${fingerprint(value)}`,
    value.blocked ? `업데이트 중단: ${value.blocked}`
      : "실행: upstream fetch → 별도 폴더에 그 커밋을 꺼내 npm ci --include=dev → npm run build → 검증 → 릴리스 등록" + (value.target ? " → 이 프로젝트에 적용(진행 중인 일이 있으면 다음 작업부터) → doctor" : " (설치만 수행하며 프로젝트에는 적용하지 않습니다)"),
    "설치하는 동안 지금 버전은 그대로 돕니다 — 실행 중인 설치 폴더·소스 폴더·다른 프로젝트를 바꾸지 않습니다. 미리보기는 로컬 검사만 수행합니다. 동의 후 fetch 와 필요 시 npm 다운로드, 받은 커밋의 설치·빌드 스크립트(prepare 포함)가 실행됩니다.",
  ].join("\n");
}

/** Read-only, network-free summary suitable for a consent prompt. */
export function previewSourceUpdate(repoRoot: string, options: SourceUpdateOptions = {}): string {
  return summary(audit(repoRoot, options));
}

function fingerprint(value: Audit): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Include this in the consent snapshot even when target and source differ. */
export function sourceUpdateSnapshot(repoRoot: string, options: SourceUpdateOptions = {}): string {
  return fingerprint(audit(repoRoot, options));
}

/** PC 신뢰와 같은 확인자 형식. 프로젝트 승인 원장과 별개인 PC 공용 실행 확인 기록이다. */
export const updateConfirmationFile = (): string => join(storeDir(), "update-confirmations.jsonl");
function recordConfirmation(action: "install" | "release" | "update", channel: "tty" | "dashboard", shownHash: string, context: { source?: string; target?: string; release?: string }): void {
  const file = updateConfirmationFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify({ version: 1, action, ...context, createdAt: new Date().toISOString(), createdBy: { actor: actorName(), channel, shownHash } })}\n`, { mode: 0o600 });
}
function shownFingerprint(domain: string, state: unknown, lines: string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ domain, state, lines })).digest("hex")}`;
}
function dashboardCaller(): void {
  if (hostMarked()) throw new Stop(`policy-forbids: ${HOST_SHELL_UPDATE}`);
}
function requireShown(shownHash: string, current: string): void {
  if (shownHash !== current) throw new Stop("stale-state: 확인한 뒤 업데이트 대상이 바뀌었습니다. 최신 미리보기를 다시 확인하세요. 설치·적용은 실행하지 않았습니다.");
}
function installPreview(options: SourceUpdateOptions) {
  const state = sourceAudit(options), lines = summary(state).split("\n");
  const shownHash = shownFingerprint("code-agent.install-only.v1", state, lines);
  return { state, preview: { source: state.source ?? null, branch: state.branch ?? null, upstream: state.upstream ?? null,
    store: state.store, lines, shownHash, canInstall: !state.blocked, reason: state.blocked ?? null } };
}
/** 프로젝트 없이 읽는 설치 전용 미리보기 — fetch·잠금·확인 기록을 만들지 않는다. */
export function previewInstallOnly(options: SourceUpdateOptions = {}) {
  dashboardCaller();
  return installPreview(options).preview;
}
export function installOnlyConfirmed(shownHash: string, options: SourceUpdateOptions = {}) {
  dashboardCaller();
  const { state, preview } = installPreview(options);
  requireShown(shownHash, preview.shownHash);
  if (state.blocked) throw new Stop(preview.lines.join("\n"));
  recordConfirmation("install", "dashboard", shownHash, { source: state.source });
  const outcome = installGitRelease({ source: state.source!, remote: state.remote!, ref: state.remoteRef! }, options.runNpm ?? npm, state.store);
  const release = installedRelease(outcome.id, state.store)!;
  if (release.info.source.kind !== "git") throw new Stop("설치 결과가 Git 릴리스가 아닙니다.");
  return { id: outcome.id, commit: release.info.source.commit, created: outcome.created, log: outcome.log };
}

/** 새 릴리스 적용의 결과 — 0 적용, 3 예약·그대로 */
export interface ReleaseApply { code: number; text: string }

/** 셸이 새 프로세스나 설치 파일 쓰기를 막았을 때(Codex 0.162.1 Windows 샌드박스 — unelevated 는 자식 프로세스를, elevated 는 `.codex/`·`.agents/` 쓰기를 막는다) */
export const SANDBOX_BLOCKED = "이 셸이 새 프로세스 실행이나 설치 파일 쓰기를 막았습니다(Codex 샌드박스 등 — 샌드박스는 .codex/·.agents/ 아래를 쓰지 못하게 합니다). " +
  "진행 중인 일이 없을 때 호스트 밖 터미널에서 code-agent update --templates-only 를 실행하면 적용합니다.";

/**
 * 설치한 릴리스가 **자기 코드로** 이 프로젝트에 적용하게 한다(update --apply-release). 이 프로세스는 다른 버전의 모듈을 읽지 않는다.
 * 진입점 경로를 넘겨 MCP 설정 등에 릴리스 폴더가 박히지 않게 한다.
 */
export function runReleaseApply(root: string, id: string, options: { trigger: "update" | "next-work" | "release" | "package"; host?: HostSelection; cli?: string; consentId?: string; home?: string }): ReleaseApply {
  const release = installedRelease(id, options.home ?? releaseHome());
  if (!release) throw new Stop(`릴리스 ${id} 가 릴리스 저장소(${options.home ?? releaseHome()})에 없습니다.`);
  const args = [release.cli, "update", "--apply-release", id, "--trigger", options.trigger,
    ...(options.host ? ["--host", options.host] : []), ...(options.cli ? ["--cli", options.cli] : []), ...(options.consentId ? ["--consent", options.consentId] : [])];
  const result = spawnSync(process.execPath, args, {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, [SELF_ENV]: "1", CODE_AGENT_ENTRY: entryScript() },
  });
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error || (result.status !== 0 && result.status !== 3)) {
    // 새 프로세스를 띄우지 못했거나(EPERM·EACCES), 그 릴리스가 설치 파일을 쓰다 거부됐다(되돌린 뒤 같은 코드를 출력에 싣는다)
    const denied = ["EPERM", "EACCES"].includes((result.error as NodeJS.ErrnoException | undefined)?.code ?? "") || /\b(?:EPERM|EACCES)\b/.test(text);
    const blocked = denied ? `\n${SANDBOX_BLOCKED}` : "";
    throw new Stop(`새 버전 ${id} 적용에 실패했습니다 — 지금 버전으로 계속 돕니다${result.error ? ` (${result.error.message})` : ""}${blocked}${text ? `\n${text}` : ""}`);
  }
  return { code: result.status ?? 1, text };
}

function doctorOf(root: string, id: string, host?: HostSelection): string {
  const release = installedRelease(id)!;
  const result = spawnSync(process.execPath, [release.cli, "doctor", ...(host ? ["--host", host] : [])], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, [SELF_ENV]: "1", CODE_AGENT_ENTRY: entryScript() },
  });
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return result.status === 0 ? text : `doctor (적용 완료 후 점검) — 문제가 있습니다(exit ${result.status})\n${text}`;
}

/**
 * Call only after user consent. Re-audit before the first network operation. 새 릴리스를 저장소에 설치하고(실패하면 아무것도 바뀌지 않는다),
 * 그 릴리스가 이 프로젝트에 적용하거나(진행 중인 일이 없을 때) 적용을 예약한다.
 */
export function updateFromSource(repoRoot: string, options: SourceUpdateOptions = {}): string {
  const initial = audit(repoRoot, options);
  if (initial.blocked) throw new Stop(summary(initial));
  if (options.expectedSourceSnapshot !== undefined && options.expectedSourceSnapshot !== fingerprint(initial)) {
    throw new Stop("동의 미리보기 이후 소스 상태/HEAD/remote/upstream 이 바뀌었습니다. 업데이트를 다시 확인하세요. fetch 는 실행하지 않았습니다.");
  }
  const output: string[] = [summary(initial)];
  let stage = "새 버전 설치";
  try {
    const installed = installGitRelease({ source: initial.source!, remote: initial.remote!, ref: initial.remoteRef! }, options.runNpm ?? npm);
    output.push(...installed.log.filter(Boolean));
    let runtime: ReturnType<typeof readRuntime>;
    try { runtime = readRuntime(initial.target); } catch { runtime = undefined; }
    if (runtime?.applied === installed.id) {
      output.push(`이미 적용된 버전입니다 — ${installed.id}. 원격에 새 커밋이 없습니다.`);
      return output.join("\n\n");
    }
    stage = "새 버전 적용";
    const applied = runReleaseApply(initial.target, installed.id, { trigger: "update", host: options.host, cli: options.cli, consentId: options.consentId });
    output.push(applied.text);
    if (applied.code === 0) {
      stage = "doctor";
      output.push(doctorOf(initial.target, installed.id, options.host));
    }
    return output.filter(Boolean).join("\n\n");
  } catch (error) {
    throw new Stop([...output.filter(Boolean), `${stage} 단계에서 중단했습니다. 이 프로젝트의 적용 버전은 바뀌지 않았고 지금 버전으로 계속 돕니다.`,
      error instanceof Error ? error.message : String(error)].join("\n\n"));
  }
}

export const HOST_SHELL_UPDATE =
  "호스트(Claude Code·Codex) 셸 안에서는 code-agent 새 버전 설치·적용 버전 선택을 터미널 확인으로 받지 않습니다 — 현재 세션의 ca-answer update 동의 절차를 쓰거나, " +
  "호스트 밖의 터미널에서 직접 실행하세요. 이미 설치한 적용 대기 버전을 적용하거나 지금 적용 버전의 템플릿만 다시 반영하려면 code-agent update --templates-only 를 씁니다.";
/**
 * 직접 CLI 소스 업데이트 — 미리보기를 보여 주고 터미널에서 `update` 를 입력받은 뒤에만 실행한다(비TTY 면 동의 절차를 안내하고 거부한다).
 * 확인한 미리보기와 실행 직전 상태가 다르면 fetch 전에 멈춘다(expectedSourceSnapshot). 동의 적용은 이미 확인을 받았으므로 updateFromSource 를 그대로 부른다.
 */
export function updateFromSourceConfirmed(repoRoot: string, options: SourceUpdateOptions = {}): string {
  // 호스트 셸(CLAUDECODE·Codex 표지)에서는 터미널 확인을 받지 않는다 — 모델 명령을 PTY 로 돌리고 입력을 넣을 수 있는 호스트에서는
  // TTY 가 사람의 입력을 뜻하지 않는다(consent apply 의 TTY 경로와 같은 규칙, consentTicket.terminalCaller)
  if (hostMarked(process.env)) throw new Stop(HOST_SHELL_UPDATE);
  const initial = audit(repoRoot, options), shown = summary(initial);
  if (initial.blocked) throw new Stop(shown);
  const expectedSourceSnapshot = fingerprint(initial);
  confirmOnTerminal(`${shown}\n\n위 순서로 code-agent 새 버전을 설치하고 이 프로젝트에 적용합니다(네트워크 접근·npm 스크립트 실행 포함).`, "update");
  requireShown(expectedSourceSnapshot, sourceUpdateSnapshot(repoRoot, options));
  recordConfirmation("update", "tty", `sha256:${expectedSourceSnapshot}`, { source: initial.source, target: initial.target });
  return updateFromSource(repoRoot, { ...options, expectedSourceSnapshot });
}

/**
 * 설치된 릴리스 하나를 골라 적용한다(되돌리기·다시 앞으로) — 사람의 터미널 확인 뒤. 상태 형식 세대가 낮은 릴리스는 새 릴리스 자신이 거부한다.
 * 진행 중인 일이 있으면 예약한다(다음 작업부터).
 */
function releasePreview(repoRoot: string, id: string, options: { host?: HostSelection; cli?: string }) {
  const root = canonical(repoRoot);
  const release = installedRelease(id);
  if (!release) {
    const known = listReleases().map((info) => info.id);
    throw new Stop(`릴리스 ${id} 가 설치되어 있지 않습니다. 설치된 릴리스: ${known.length ? known.join(" · ") : "없음"}`);
  }
  let runtime: ReturnType<typeof readRuntime>;
  try { runtime = readRuntime(root); } catch (error) { throw new Stop(`${error instanceof Error ? error.message : String(error)}`); }
  const lines = [`대상: ${root}`, `이 프로젝트 적용 버전: ${runtime?.applied ?? "진입점 번들(고정 없음)"}`,
    `고를 릴리스: ${id} (${release.info.source.kind === "git" ? `커밋 ${release.info.source.commit}` : `내용 ${release.info.contentHash.slice(0, 12)}`} · 상태 세대 ${release.info.stateSchema} · ${release.info.installedAt} 설치)`,
    `이 프로젝트의 상태 세대: ${runtime?.stateSchema ?? 1} — 그보다 낮은 세대의 릴리스는 적용하지 않습니다`,
    ...(options.host ? [`적용 호스트: ${options.host}`] : []), ...(options.cli ? [`hook 실행 경로: ${options.cli}`] : []),
    "진행 중인 일이 있으면 다음 작업부터 적용합니다. 템플릿은 그 릴리스의 것으로 다시 반영합니다(사람이 고친 사본은 보존)."];
  const store = releaseHome();
  const shownHash = shownFingerprint("code-agent.release-apply.v1", { root, store, runtime: runtime ?? null, release: release.info, options }, lines);
  return { target: root, current: runtime?.applied ?? null, release: id, stateSchema: runtime?.stateSchema ?? 1, releaseStateSchema: release.info.stateSchema, store, lines, shownHash };
}
export function previewReleaseApply(repoRoot: string, id: string, options: { host?: HostSelection; cli?: string } = {}) {
  dashboardCaller();
  return releasePreview(repoRoot, id, options);
}
export function releaseApplyConfirmed(repoRoot: string, id: string, shownHash: string, options: { host?: HostSelection; cli?: string } = {}): ReleaseApply {
  dashboardCaller();
  const preview = releasePreview(repoRoot, id, options);
  requireShown(shownHash, preview.shownHash);
  recordConfirmation("release", "dashboard", shownHash, { target: preview.target, release: id });
  return runReleaseApply(preview.target, id, { trigger: "release", ...options });
}
export function updateToReleaseConfirmed(repoRoot: string, id: string, options: { host?: HostSelection; cli?: string } = {}): string {
  if (hostMarked(process.env)) throw new Stop(HOST_SHELL_UPDATE);
  const preview = releasePreview(repoRoot, id, options), root = preview.target;
  confirmOnTerminal(`${preview.lines.join("\n")}\n\n위 릴리스로 이 프로젝트의 적용 버전을 바꿉니다.`, "update");
  requireShown(preview.shownHash, releasePreview(root, id, options).shownHash);
  recordConfirmation("release", "tty", preview.shownHash, { target: root, release: id });
  return runReleaseApply(root, id, { trigger: "release", host: options.host, cli: options.cli }).text;
}
