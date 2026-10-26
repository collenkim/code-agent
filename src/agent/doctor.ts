import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "path";

import { MANIFEST_FILE } from "../core/manifest";
import type { Manifest } from "../core/manifest";
import {
  assetCount,
  assetKeys,
  assetText,
  CLAUDE_ASSETS,
  installedPath,
  isPackaged,
  packageVersion,
  strayInstalled,
  templateHash,
} from "./assets";
import { checkProjectDocs } from "./docs";
import { CLAUDE_HOOKS, CODEX_EVENTS, codexMatcherProblem, codexWindowsProblem, installedHook, settingsProblem, unmatchedTools } from "./init";
import { hostReadiness } from "./master/hostProfile";
import { choiceConfigProblem } from "./choiceConfig";
import { unknownCodexTools } from "./codexHook";
import { STATE_DIR } from "./layout";
import { appliedStore, entryScript, installedRelease, ownRelease, readRuntime, RUNTIME_FILE, type RuntimeState } from "./runtimeSelect";
import { AGENTS, installedClaudeModel, policySummary, workInProgress } from "./models";
import { claudeModelOf, modelDisplay } from "./modelPolicy";
import { storeWarning, STORE_LABEL, WINDOWS_ACL_NOTE } from "./plugins/store";
import { manifestCheck } from "./survey";
import { loadManifestIfAny } from "./work";
import { binHint, crossHostProblems, crossNotice, hostAssets, hostCommand, HostSelection, selectedHosts, type Host } from "./hosts";
import { crossStopStreak } from "./crossRecord";
import { CROSS_CHILD_ENV } from "./crossEnv";
import { crossFlags } from "./crossCheck";
import { aidlcBlock, aidlcWarning } from "./aidlc";
import { skill } from "./hostText";

/**
 * `code-agent doctor` — 설치와 환경을 한 화면에서 본다.
 *
 * 세 가지 표시가 있다. `✓` 는 확인된 것, `✗` 는 **막는 것**(종료 코드 1), `·` 는 알리기만 하는 것이다.
 * 버전 스큐·TTY 없음·Windows 의 키 파일 안내를 `·` 로 두는 이유: TTY 가 없는 CI 에서 doctor 가
 * 빨개지면 아무도 쓰지 않는다. 막지 않는 것은 종료 코드에 넣지 않는다.
 *
 * 저장소 게이트(git 저장소·매니페스트·문서)가 ✗ 여도 **끝까지 다 찍고** 마지막에 한 번 판정한다 —
 * 한 줄 보고 고치고 다시 도는 것을 열 번 반복하게 만들지 않는다.
 */

type Mark = "✓" | "✗" | "·";

interface Check {
  mark: Mark;
  name: string;
  observed: string;
  hint?: string;
}

/** 셸 래퍼(cmd·ps1·sh)는 몇 KB 다. 단일 실행 파일(~94MB)을 utf-8 로 읽지 않으려는 문턱 */
const SHIM_LIMIT = 1024 * 1024;

/** PATH(+ Windows 의 PATHEXT)에서 처음 만나는 code-agent */
function findOnPath(): string | undefined {
  const exts =
    process.platform === "win32" ? [...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";"), ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const path = join(dir, `code-agent${ext}`);
      try {
        if (statSync(path).isFile()) return path;
      } catch {
        // 없는 경로·권한 없는 디렉토리 — 다음 후보로
      }
    }
  }
  return undefined;
}

/**
 * PATH 에서 찾은 것이 npm 설치/링크면 그 `cli.js` 경로를, 단일 실행 파일이면 undefined.
 *
 * POSIX 의 전역 설치는 심볼릭 링크라 realpath 가 바로 `cli.js` 를 준다. Windows 의 `.cmd`·`.ps1` 과
 * Git Bash 용 `sh` 래퍼는 자기 폴더를 변수(`%dp0%` · `%~dp0` · `$basedir`)로 가리키므로 그 자리에서 푼다.
 */
export function npmCli(path: string): string | undefined {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // 링크가 깨졌으면 원래 경로로 본다
  }
  if (real.toLowerCase().endsWith(".js")) return real;
  let text: string;
  try {
    if (statSync(real).size > SHIM_LIMIT) return undefined;
    text = readFileSync(real, "utf-8");
  } catch {
    return undefined;
  }
  const match = /[^\s"']*code-agent[\\/]dist[\\/]agent[\\/]cli\.js/.exec(text);
  if (!match) return undefined;
  const raw = match[0].replace(/^(\$\{?basedir\}?|%[^%\s\\/]*%|%~[a-z0-9]+)[\\/]*/i, "");
  return isAbsolute(raw) ? raw : resolve(dirname(path), raw);
}

/** Windows 는 구분자도 대소문자도 흔들린다 */
function samePath(a: string, b: string): boolean {
  const fold = (path: string) => {
    let real = path;
    try {
      real = realpathSync.native(path);
    } catch {
      // 없는 경로는 문자열로 견준다
    }
    return process.platform === "win32" ? real.replace(/\\/g, "/").toLowerCase() : real;
  };
  return fold(a) === fold(b);
}

/** hook 명령이 지금 이 PC 에서 풀리는지 — 안 풀리면 이유 */
function hookProblem(command: string, onPath: string | undefined): string | undefined {
  const quoted = /^\S+\s+"([^"]+)"/.exec(command);
  if (quoted) return existsSync(quoted[1]) ? undefined : `가리키는 파일이 없습니다: ${quoted[1]}`;
  const argv0 = command.split(/\s+/)[0];
  if (/[\\/]/.test(argv0)) return existsSync(argv0) ? undefined : `가리키는 파일이 없습니다: ${argv0}`;
  if (/^code-agent(\.\w+)?$/.test(argv0)) return onPath ? undefined : "PATH 에 code-agent 가 없습니다";
  return undefined; // 사람이 제 손으로 바꿔 둔 명령 — 우리가 판정할 것이 아니다
}

/**
 * 교차 검증 점검 — 연속 중지 기록, 교차 실행 자식 표지가 셸에 남았는지, (--cross) 다른 호스트의 --help 에 교차 실행이 쓰는 옵션이
 * 모두 있는지. --help 만 돌리므로 모델 호출·비용이 없고 아무것도 쓰지 않는다.
 */
function crossChecks(repoRoot: string, add: (mark: Mark, name: string, observed: string, hint?: string) => void, cross: boolean): void {
  let hosts: Host[];
  try { hosts = selectedHosts(repoRoot); } catch { return; }
  const both = hosts.length > 1;
  if (both) {
    const streak = crossStopStreak(repoRoot);
    if (streak.count >= 1) {
      add("·", "교차 검증 기록", `최근 ${streak.count}개 지점이 연속 중지 — 마지막: ${streak.last?.host ?? "?"} — ${(streak.last?.detail ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  if (process.env[CROSS_CHILD_ENV]) {
    add("·", "교차 실행 표지", `${CROSS_CHILD_ENV} 가 설정돼 있습니다 — 교차 실행 자식의 표지라 Stop·SessionStart hook 이 꺼집니다. 셸 설정에서 지우세요`);
  }
  if (!both) return;
  if (!cross) {
    add("·", "교차 실행 옵션", "점검하려면 code-agent doctor --cross (다른 호스트의 --help 만 실행한다)");
    return;
  }
  for (const target of ["claude", "codex"] as Host[]) {
    const name = `교차 실행 옵션(${target})`;
    const resolved = hostCommand(target);
    if (typeof resolved === "string") { add("·", name, `점검하지 못했습니다 — ${resolved}`); continue; }
    const help = spawnSync(resolved.file, [...resolved.prefix, ...(target === "codex" ? ["exec", "--help"] : ["--help"])],
      { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
    if (help.error || help.status !== 0) {
      add("·", name, `--help 를 실행하지 못했습니다 — ${help.error?.message ?? `종료 코드 ${help.status}`}`);
      continue;
    }
    let flags: string[];
    try { flags = crossFlags(repoRoot, target); }
    catch (error) { add("·", name, `점검하지 못했습니다 — ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`); continue; }
    const missing = flags.filter((flag) => !new RegExp(`(^|[\\s,=\\[])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text));
    if (missing.length === 0) add("✓", name, "사용하는 옵션이 모두 있습니다");
    else add("✗", name, `없는 옵션: ${missing.join(", ")} — 이 버전에서는 교차 검증이 설정 오류로 막힙니다`,
      `${target} CLI 를 업데이트하거나 CODE_AGENT_${target.toUpperCase()}_BIN 을 확인하세요`);
  }
}

export function doctor(repoRoot: string, host?: HostSelection, options: { cross?: boolean } = {}): { text: string; ok: boolean } {
  const hosts = selectedHosts(repoRoot, host);
  const checks: Check[] = [];
  const add = (mark: Mark, name: string, observed: string, hint?: string) => checks.push({ mark, name, observed, hint });
  // 진행 중인 작업 — 정의 파일은 커밋되는 설치 파일이라 다시 쓰는 것도 그 작업이 끝난 뒤다(역할 모델 변경과 같은 규칙, D1).
  // 상태를 읽지 못하면 없는 것으로 본다(안내만 바뀐다 — 다른 줄이 상태 오류를 알린다)
  let work: ReturnType<typeof workInProgress>;
  try { work = workInProgress(repoRoot); } catch { work = undefined; }
  /** 정의 파일을 다시 쓰는 명령의 안내 — 진행 중인 작업이 있으면 그 작업이 끝난 뒤(반영 deliver 또는 종료 abort) 실행하라고 한다 */
  const afterWork = (command: string) => work
    ? `진행 중인 작업 ${work.id}(${work.phase})이 끝난 뒤(반영 deliver 또는 종료 abort) ${command}`
    : command;
  const win = process.platform === "win32";

  // 1. 런타임
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 19 || process.versions.node.includes("-")) {
    add("✗", "런타임", `Node ${process.version} 은 지원 범위 밖입니다 (>=24.19.0 <25)`, "Node 24.19.0 이상 24.x 를 설치하거나 그 버전으로 만든 단일 실행 파일을 쓰세요");
  } else if (isPackaged()) {
    add("✓", "런타임", `단일 실행 파일 (Node ${process.version} 내장)`);
  } else {
    add("✓", "런타임", `Node ${process.version}`);
  }

  // 2. git
  try {
    add("✓", "git", execFileSync("git", ["--version"], { encoding: "utf-8" }).trim());
  } catch {
    add("✗", "git", "찾지 못했습니다", "PATH 에 git 을 넣으세요 — code-agent 는 브랜치·기준 커밋·반영에 git 을 씁니다");
  }

  // 3. PATH 의 code-agent — hook 명령이 여기서 풀린다
  const onPath = findOnPath();
  const onPathCli = onPath ? npmCli(onPath) : undefined;
  if (!onPath) {
    add("✗", "PATH 의 code-agent", "없습니다", "npm i -g <저장소> 또는 단일 실행 파일을 PATH 에 두세요 — 없으면 hook 명령이 풀리지 않습니다");
  } else if (onPathCli) {
    add("✓", "PATH 의 code-agent", `npm 설치/링크 ${onPath} → ${onPathCli}`);
  } else {
    add("✓", "PATH 의 code-agent", `단일 실행 파일 ${onPath}`);
  }

  // 3b. 지금 도는 진입점과 PATH 의 것이 같은가 — 막지는 않는다. 적용 버전(릴리스)으로 넘겨 돌 때도 진입점을 견준다
  const running = isPackaged() ? process.execPath : entryScript();
  if (onPath && !samePath(onPathCli ?? onPath, running)) {
    add("·", "지금 도는 것", `${running} — PATH 의 code-agent 는 다른 설치본입니다 (${onPathCli ?? onPath})`);
  }

  // 3c. 이 프로젝트의 적용 버전 — 고정이 없으면 진입점 번들. 적용 버전이 저장소에 없으면 진행 중인 일의 hook 이 멈춘다
  {
    let applied: string | undefined, pending: string | undefined, problem: string | undefined, state: RuntimeState | undefined;
    try { state = readRuntime(repoRoot); applied = state?.applied; pending = state?.pending?.id; }
    catch (error) { problem = error instanceof Error ? error.message : String(error); }
    const own = ownRelease()?.id;
    if (problem) add("✗", "적용 버전", `${RUNTIME_FILE}: ${problem}`, "사람이 파일을 확인하세요 — 지우면 진입점 번들로 돕니다(진행 중인 일이 없을 때)");
    else if (applied && !installedRelease(applied, appliedStore(state))) add("✗", "적용 버전", `${applied} 가 릴리스 저장소(${appliedStore(state)})에 없습니다`, "code-agent version 으로 확인하고 해당 릴리스를 다시 설치하세요. 새 작업은 열지 않습니다. 진행 중인 작업은 abort 로 정리할 수 있고, 진행 중인 일이 없으면 update --bundled 로 고정을 풉니다(상태 세대는 유지).");
    else add("✓", "적용 버전", `${applied ?? "진입점 번들(고정 없음)"}${own ? ` · 이 점검은 ${own}` : ""}${pending ? ` · 적용 대기 ${pending}(다음 작업부터)` : ""}`);
  }

  // 4. git 저장소
  if (existsSync(join(repoRoot, ".git"))) {
    add("✓", "git 저장소", repoRoot);
  } else {
    add("✗", "git 저장소", `아닙니다 (${repoRoot})`, "git init 후 다시 도세요 — 브랜치·기준 커밋이 없으면 검증 스테이지가 거부합니다");
  }

  // 5. hook 설치 — 있는지와 **풀리는지**를 함께 본다.
  // 파일 자체가 깨져 있으면 먼저 그것을 말한다: 그 경우 `installedHook` 은 "없다" 와 구분되지 않고,
  // "없다" 의 처방인 `code-agent init` 은 같은 파일에서 멈춘다.
  if (hosts.includes("claude")) {
  const settings = settingsProblem(repoRoot);
  if (settings) {
    add("✗", "hook 설정 파일", settings, "이 파일을 고친 뒤 code-agent init — 고치기 전에는 init·update 도 멈춥니다");
  } else {
    for (const [event, subcommand] of CLAUDE_HOOKS) {
      const command = installedHook(repoRoot, event, subcommand);
      if (!command) {
        add("✗", `${event} hook`, "없습니다", "code-agent init");
        continue;
      }
      const problem = hookProblem(command, onPath);
      const unmatched = subcommand === "planning-event" ? unmatchedTools(repoRoot, event, "ca-analyst|ca-explorer|ca-writer|ca-critic", subcommand) : subcommand === "consent-event" ? unmatchedTools(repoRoot, event, "AskUserQuestion") : event === "PreToolUse" ? unmatchedTools(repoRoot) : event.startsWith("Subagent") ? unmatchedTools(repoRoot, event, "ca-reviewer") : [];
      if (problem) add("✗", `${event} hook`, `${command} — ${problem}`, "code-agent init [--cli <경로>]");
      else if (unmatched.length > 0) {
        add("✗", `${event} hook`, `${command} — matcher 가 ${unmatched.join(" · ")} 를 넘기지 않습니다`, "code-agent update");
      } else add("✓", `${event} hook`, command);
    }
  }

  // 6·7. 번들을 읽어야 하는 검사 둘. **묶어서 감싼다** — 자원을 못 읽는 바이너리에서 던지면
  // doctor 가 한 줄도 찍지 못하고 죽는데, 그 바이너리를 설명할 유일한 명령이 doctor 다.
  try {
    // 6. 버전 스큐 — 알리기만 한다
    const versionFile = join(repoRoot, STATE_DIR, "version");
    const installedVersion = existsSync(versionFile) ? readFileSync(versionFile, "utf-8").trim() : undefined;
    const version = packageVersion();
    const keys = assetKeys(CLAUDE_ASSETS);
    const missing = keys.filter((key) => !existsSync(installedPath(repoRoot, key)));

    if (!installedVersion) {
      // 한 번도 깔지 않은 저장소다 — 검사 7 과 같은 처방(init)을 준다
      add("·", "설치 버전", `${STATE_DIR}/version 이 없습니다 (지금 도는 버전 ${version})`, "code-agent init");
    } else if (installedVersion !== version) {
      add("·", "설치 버전", `${installedVersion} ≠ 지금 도는 버전 ${version}`, "code-agent update");
    } else {
      add("✓", "설치 버전", version);
    }

    // 7. 스킬·에이전트가 지금 버전의 번들과 같은가.
    // 하나도 없는 것과 몇 개가 다른 것은 처방이 다르다 — 앞은 init, 뒤는 update 다.
    const differing = keys.filter((key) => {
      const path = installedPath(repoRoot, key);
      return existsSync(path) && templateHash(readFileSync(path, "utf-8")) !== templateHash(assetText(key));
    });
    const shown = (paths: string[]) =>
      `${paths.slice(0, 5).join(" · ")}${paths.length > 5 ? ` (+${paths.length - 5})` : ""}`;
    const asPath = (key: string) => `.claude/${key.slice(CLAUDE_ASSETS.length + 1)}`;
    if (missing.length === keys.length) {
      add("✗", "스킬·에이전트", "설치되지 않았습니다 (.claude/skills/ca-*, .claude/agents/ca-*)", "code-agent init");
    } else if (missing.length + differing.length === 0) {
      add("✓", "스킬·에이전트", `${assetCount(keys)} 모두 번들과 같습니다`);
    } else {
      const parts = [
        ...(missing.length > 0 ? [`없는 것 ${missing.length}개: ${shown(missing.map(asPath))}`] : []),
        ...(differing.length > 0 ? [`다른 것 ${differing.length}개: ${shown(differing.map(asPath))}`] : []),
      ];
      add("✗", "스킬·에이전트", parts.join(" / "), "code-agent update");
    }

    // 이 버전이 더는 담지 않는 `ca-*`. 막지는 않는다 — 사람이 만든 ca- 스킬과 가릴 수 없다
    const stray = strayInstalled(repoRoot, keys);
    if (stray.length > 0) {
      add("·", "이 버전에 없는 스킬·에이전트", `${stray.length}개: ${shown(stray)} — 필요 없으면 손으로 지우세요`);
    }
  } catch (error) {
    add(
      "✗",
      "번들 자원",
      error instanceof Error ? error.message : String(error),
      "단일 실행 파일이라면 Node 24.19.0 이상 24.x 에서 npm run build:bin 을 다시 돌리세요",
    );
  }

  // 정의 파일 머리말의 model·effort 가 설정(models.json, 없으면 역할 기본값)과 같은가. 스킬·에이전트 해시는 이 두 줄을
  // 빼고 보므로 여기서 따로 본다 — 손으로 고친 머리말이면 하위 에이전트(머리말)와 교차 실행(설정)이 갈라진다
  try {
    let installed = 0;
    const mismatches = AGENTS.flatMap((agent) => {
      const file = installedClaudeModel(repoRoot, agent), setting = claudeModelOf(repoRoot, agent);
      if (file) installed++;
      return file && (file.model !== setting.model || file.effort !== setting.effort)
        ? [`${agent} 파일 ${file.model ?? "(없음)"}${file.effort ? `/${file.effort}` : ""} ≠ 설정 ${modelDisplay(setting)}`] : [];
    });
    if (mismatches.length > 0) {
      add("✗", "에이전트 모델", `정의 파일이 설정과 다릅니다 — ${mismatches.slice(0, 5).join(" · ")}${mismatches.length > 5 ? ` (+${mismatches.length - 5})` : ""}`,
        `${afterWork("code-agent update --templates-only")} — 정의 파일의 model·effort 줄을 설정(.code-agent/models.json)대로 다시 씁니다. ` +
          (work ? "작업 중에 다시 쓰면 그 작업의 계획 밖 변경이 됩니다. 모델 변경도 작업이 끝난 뒤 요청하세요" : "바꾸려면 모델 변경을 요청하세요"));
    } else if (installed === 0) {
      // 대조할 정의 파일이 없으면 ✓ 로 찍지 않는다 — 설치 여부는 "스킬·에이전트" 줄이 알린다
      add("·", "에이전트 모델", `대조할 정의 파일이 없습니다 (.claude/agents/ca-*.md) — 설정: ${policySummary(repoRoot, "claude")}`);
    } else {
      add("✓", "에이전트 모델", `${policySummary(repoRoot, "claude")}${installed < AGENTS.length ? ` — 설치된 정의 파일 ${installed}개 일치` : ""}`);
    }
  } catch (error) {
    add("✗", "에이전트 모델", error instanceof Error ? error.message : String(error), ".code-agent/models.json 을 고치거나 지운 뒤 code-agent update --templates-only");
  }

  }
  if (hosts.includes("codex")) {
    const choiceProblem = choiceConfigProblem(repoRoot);
    add(choiceProblem ? "✗" : "✓", "Codex 선택 UI", choiceProblem ?? "MCP 폼 입력 설정 확인 — 방향키·Enter 선택은 대화형 세션에서 확인", choiceProblem ? "code-agent update --templates-only --host codex 후 Codex 재시작" : undefined);
    const problem = settingsProblem(repoRoot, "codex");
    if (problem) add("✗", "Codex 훅 설정", problem, "code-agent init");
    else {
      const installed = new Map(CODEX_EVENTS.map((event) => [event, installedHook(repoRoot, event, "codex-event", "codex")]));
      // 다른 이벤트는 있는데 일부만 없으면 이벤트가 늘기 전의 옛 설치다(SessionStart 없는 설치 등) — 옛 Windows 명령과 같이 번들을 다시
      // 적용하면 고쳐진다(update 가 init 으로 모든 이벤트를 다시 쓴다 — .codex/hooks.json 을 다시 쓰므로 작업 중이면 계획 밖 변경)
      const partial = [...installed.values()].some((command) => command !== undefined);
      const reapply = work
        ? `${afterWork("code-agent update --templates-only --host codex")} — 작업 중에 다시 쓰면 그 작업의 계획 밖 변경이 됩니다`
        : "code-agent update --templates-only --host codex";
      for (const event of CODEX_EVENTS) {
        const command = installed.get(event);
        const windows = command ? codexWindowsProblem(repoRoot, event) : undefined;
        const error = command ? hookProblem(command, onPath) ?? codexMatcherProblem(repoRoot, event) ?? windows : "설치되지 않았습니다";
        const old = error !== undefined && (command ? error === windows : partial);
        add(error ? "✗" : "✓", `Codex ${event}`, error ?? command!, old ? reapply : "code-agent init");
      }
    }
    try {
      const codexAssets = [...hostAssets("codex", repoRoot)];
      const changed = codexAssets.filter(([path, text]) => !existsSync(join(repoRoot, path)) || readFileSync(join(repoRoot, path), "utf8").replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")).map(([path]) => path);
      // TOML 의 model·model_reasoning_effort 어긋남도 이 줄이 잡는다(번들에 설정값이 들어 있다) — 다시 쓰는 것은 작업이 끝난 뒤다(D1, "에이전트 모델" 과 같다)
      add(changed.length ? "✗" : "✓", "Codex 스킬·에이전트", changed.length ? changed.join(" · ") : `${assetCount(codexAssets.map(([path]) => path))} 모두 번들과 같습니다`,
        work ? `${afterWork("code-agent update --templates-only --host codex")} — 작업 중에 다시 쓰면 그 작업의 계획 밖 변경이 됩니다` : "code-agent update --templates-only --host codex");
      add("✓", "Codex 에이전트 모델", policySummary(repoRoot, "codex"));
      const instructions = join(repoRoot, "AGENTS.md");
      const ok = existsSync(instructions) && readFileSync(instructions, "utf8").includes(assetText("template/CODEX.block.md").trim());
      add(ok ? "✓" : "✗", "Codex 프로젝트 지침", ok ? "AGENTS.md 블록 확인" : "블록 누락 또는 변경", "code-agent init");
    } catch (error) { add("✗", "Codex 번들", String(error)); }
    // 프로젝트 hook 은 프로젝트 신뢰와 hook 검토·신뢰가 둘 다 있어야 돈다 — codex exec 는 신뢰되지 않은 hook 을 알리지 않고 건너뛴다.
    // 관리 실행과 같은 실행 파일·계정으로 Codex app-server 에 지금 묻는다(codexReadiness — 접수·감독과 같은 판정). 이 PC·계정의 상태라
    // doctor 를 막지 않는다(·) — 막는 것은 master 접수·감독이다. 앞 단계가 막히면 뒤 줄은 경고하지 않고 '그 뒤 확인'으로 둔다
    const codex = hostReadiness(repoRoot, "codex", { codex: "fresh" });
    const codexText = codex.problems.map((problem) => problem.message).join(" · ");
    const codes = new Set(codex.problems.map((problem) => problem.code));
    // 어느 실행 파일·계정에 물었는지 — 관리 실행(같은 master 호스트 설정)과 다른 환경에서 돌린 doctor 를 사람이 가려낸다
    const target = codex.target ? ` (조회: Codex${codex.target.version ? ` ${codex.target.version}` : ""} · ${codex.target.executable} · CODEX_HOME ${codex.target.codexHome})` : "";
    const trusted = `신뢰됨 — Codex app-server(config/read)가 이 저장소의 프로젝트 설정·hook 을 켭니다${target}`;
    const [projectLine, hookLine]: [Mark, string, string?][] =
      codex.state === "ready" ? [["✓", trusted], ["✓", `신뢰됨 — code-agent hook ${CODEX_EVENTS.length}종이 신뢰·켜짐 상태로 로드됩니다(hooks/list)`]]
      : codex.state === "project-untrusted" ? [["·", `${codes.has("codex-project-disabled") ? "프로젝트 설정 꺼짐" : "신뢰 필요"} — ${codexText}${target}`],
        ["·", "프로젝트 신뢰 뒤 확인 — Codex 가 프로젝트 hook 을 읽지 않는 동안에는 검토할 hook 을 알 수 없습니다"]]
      : codex.state === "hooks-review" ? [["✓", trusted], ["·", `검토 필요 — ${codexText}`]]
      : codes.has("codex-sandboxed") ? [["·", `터미널에서 확인 — ${codexText}`], ["·", "터미널에서 확인합니다"]]
      : codex.state === "query-failed" || codex.state === "checking" ? [["·", `조회 실패 — ${codexText}${target}`], ["·", "조회가 되면 확인합니다"]]
      : codes.has("codex-not-found") ? [["·", `Codex 실행 파일 없음 — ${codexText}`], ["·", "Codex 를 실행할 수 있게 된 뒤 확인합니다"]]
      : codes.has("codex-unsupported") ? [["·", `Codex 갱신 필요 — ${codexText}${target}`], ["·", "Codex 를 갱신한 뒤 확인합니다"]]
      : codes.has("codex-hooks-disabled") ? [["✓", trusted], ["·", `hook 기능 꺼짐 — ${codexText}`]]
      : codes.has("codex-hooks-invalid") || codes.has("codex-hooks-not-loaded") ? [["✓", trusted], ["✗", codexText, "code-agent init"]]
      : [["·", "설치 복구 뒤 확인 — 위의 Codex 설치 줄을 먼저 고칩니다"], ["·", "설치 복구 뒤 확인합니다"]];
    add(projectLine[0], "Codex 프로젝트 신뢰", projectLine[1], projectLine[2]);
    add(hookLine[0], "Codex 훅 신뢰", hookLine[1], hookLine[2]);
    // PreToolUse 가 판정하지 않은 Codex 도구 이름(작업·세션 중에만 기록) — 파일을 쓰는 도구라면 hook 판정 밖이다
    const unknown = unknownCodexTools(repoRoot);
    if (unknown.length) {
      add("·", "Codex 미판정 도구", `${unknown.slice(0, 8).map((tool) => `${tool.name}(${tool.count}회)`).join(" · ")}${unknown.length > 8 ? ` 외 ${unknown.length - 8}개` : ""} — 파일을 쓰는 도구라면 hook 판정 밖입니다. code-agent 를 갱신하거나 사람에게 알리세요`);
    }
  }

  // 8. 매니페스트 — 있을 때만 본다 (도입 전에는 없는 것이 정상)
  //
  // 형식 오류의 첫 줄은 머리말(`code-agent.json 형식 오류:`)뿐이라 **버리지 않는다** — 어느 키가
  // 왜 틀렸는지가 그 아래 줄에 있고, 그것을 버리면 사람은 무엇을 고칠지 모른 채 다른 명령으로 보내진다.
  const manifestProblem = (error: unknown): void => {
    const detail = error instanceof Error ? error.message.split("\n").map((line) => line.trim()) : [String(error)];
    add("✗", "매니페스트", detail[0], [...detail.slice(1), "code-agent manifest check"].filter(Boolean).join(" "));
  };
  let manifest: Manifest | undefined;
  try {
    manifest = loadManifestIfAny(repoRoot);
  } catch (error) {
    manifestProblem(error);
  }
  if (manifest) {
    try {
      const result = manifestCheck(repoRoot);
      const summary = (result.text.trim().split("\n").pop() ?? "").replace(/^[✓✗]\s*/, "");
      add(result.ok ? "✓" : "✗", "매니페스트", summary, result.ok ? undefined : "code-agent manifest check");
    } catch (error) {
      manifestProblem(error);
    }
  } else if (!existsSync(join(repoRoot, MANIFEST_FILE))) {
    add("·", "매니페스트", `${MANIFEST_FILE} 이 없습니다 — 아직 도입 전입니다 (${skill("ca-adopt")})`);
  }

  // 9. 공통 POLICY 4종 — 확정 원장이 깨져 있어도 진단은 끝까지 낸다
  try {
    for (const doc of checkProjectDocs(repoRoot, manifest)) {
      if (doc.ok) add("✓", doc.label, "확정됨");
      else add("✗", doc.label, doc.state, doc.problem);
    }
  } catch (error) {
    add("✗", "공통 문서 확정", (error instanceof Error ? error.message : String(error)).split("\n")[0], "원장 파일의 변경 이력(git log)을 확인하세요");
  }

  // 10. 사용자 키 파일 — 등록된 플러그인의 키가 사는 자리
  if (win) {
    add("·", "사용자 키 파일", `${STORE_LABEL} — ${WINDOWS_ACL_NOTE}`);
  } else {
    const warning = storeWarning();
    if (warning) add("✗", "사용자 키 파일", warning, `chmod 700 ~/.code-agent && chmod 600 ${STORE_LABEL}`);
    else add("✓", "사용자 키 파일", STORE_LABEL);
  }

  // 11. 직접 CLI 확인은 선택 사항이다. 기본 경로는 Claude Code의 질문 응답이다.
  if (process.stdin.isTTY) {
    add("✓", "터미널", "stdin 이 TTY 입니다 — approve · confirm · deliver · plugin add 가 열립니다");
  } else {
    add(
      "·",
      "터미널",
      "stdin 이 TTY 가 아닙니다 — 직접 CLI 확인은 닫혀 있지만 호스트 세션에서 관찰한 동의를 사용할 수 있습니다",
      "Claude는 선택 도구, Codex는 MCP 폼 선택 UI와 같은 세션의 훅 티켓으로 동의를 관찰합니다.",
    );
  }

  // AI-DLC 공존 — 설치 문제는 아니라 실패로 세지 않는다. 진행 중이면 code-agent 가 멈추고, 훅이 기록할 수 있으면 경고한다
  const aidlc = aidlcBlock(repoRoot) ?? aidlcWarning(repoRoot);
  if (aidlc) add("·", "AWS AI-DLC", aidlc.replace(/\n\s*/g, " "));
  // 교차 검증 — 두 호스트를 모두 실행할 수 있을 때만 돈다. 미설치(실행 불가)는 그 지점을 중지로 기록하고 진행하므로 실패로 세지 않는다.
  // 설정 오류(실행 파일 변수가 없는 파일을 가리킴·PATH 에 셸 스크립트뿐 — hostCommandConfigError)는 중지가 아니라 그 지점의 게이트를
  // 막으므로 막는 문제(✗)다 — --cross 의 없는 옵션(설정 오류로 막힘)과 같다
  const cross = crossNotice(repoRoot);
  if (cross) {
    const config = (crossHostProblems(repoRoot)?.config.length ?? 0) > 0;
    add(cross.includes("켜짐") ? "✓" : config ? "✗" : "·", "교차 검증", cross.replace(/^교차 검증: /, ""),
      config ? `셸에서 CODE_AGENT_CLAUDE_BIN·CODE_AGENT_CODEX_BIN 을 있는 ${binHint()}로 고치거나 지우세요(PATH 에 셸 스크립트뿐이면 실행 파일을 지정) — 단독 실행은 호스트 밖 터미널에서 code-agent execution claude 또는 codex로 선택하세요` : undefined);
  }
  crossChecks(repoRoot, add, options.cross === true);

  const failed = checks.filter((check) => check.mark === "✗");
  return {
    text: [
      `code-agent doctor — ${repoRoot}`,
      "",
      ...checks.flatMap((check) => [
        `  ${check.mark} ${check.name}: ${check.observed}`,
        ...(check.mark === "✗" && check.hint ? [`      → ${check.hint}`] : []),
      ]),
      "",
      failed.length === 0
        ? "✓ 막는 문제가 없습니다."
        : `✗ ${failed.length}개: ${failed.map((check) => check.name).join(" · ")} — 위의 → 를 따라 고치세요.`,
    ].join("\n"),
    ok: failed.length === 0,
  };
}
