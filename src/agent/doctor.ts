import { execFileSync } from "child_process";
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
import { codexMatcherProblem, installedHook, settingsProblem, unmatchedTools } from "./init";
import { STATE_DIR } from "./layout";
import { storeWarning, STORE_LABEL, WINDOWS_ACL_NOTE } from "./plugins/store";
import { manifestCheck } from "./survey";
import { loadManifestIfAny } from "./work";
import { hostAssets, HostSelection, selectedHosts } from "./hosts";

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

export function doctor(repoRoot: string, host?: HostSelection): { text: string; ok: boolean } {
  const hosts = selectedHosts(repoRoot, host);
  const checks: Check[] = [];
  const add = (mark: Mark, name: string, observed: string, hint?: string) => checks.push({ mark, name, observed, hint });
  const win = process.platform === "win32";

  // 1. 런타임
  const major = Number(process.versions.node.split(".")[0]);
  if (isPackaged()) {
    add("✓", "런타임", `단일 실행 파일 (Node ${process.version} 내장)`);
  } else if (major >= 22) {
    add("✓", "런타임", `Node ${process.version}`);
  } else {
    add("✗", "런타임", `Node ${process.version} 은 지원 범위 밖입니다 (22 이상)`, "nodejs.org 에서 Node 를 올리거나 단일 실행 파일을 쓰세요");
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

  // 3b. 지금 도는 것과 PATH 의 것이 같은가 — 막지는 않는다
  const running = isPackaged() ? process.execPath : join(__dirname, "cli.js");
  if (onPath && !samePath(onPathCli ?? onPath, running)) {
    add("·", "지금 도는 것", `${running} — PATH 의 code-agent 는 다른 설치본입니다 (${onPathCli ?? onPath})`);
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
    for (const [event, subcommand] of [["PreToolUse", "hook"], ["PreToolUse", "consent-event"], ["PostToolUse", "consent-event"], ["Stop", "stop"], ["SubagentStart", "review-event"], ["SubagentStop", "review-event"], ["SubagentStart", "planning-event"], ["SubagentStop", "planning-event"], ["SessionStart", "session-event"]] as const) {
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
      "단일 실행 파일이라면 Node 24.8 이상에서 npm run build:bin 을 다시 돌리세요",
    );
  }

  }
  if (hosts.includes("codex")) {
    const problem = settingsProblem(repoRoot, "codex");
    if (problem) add("✗", "Codex 훅 설정", problem, "code-agent init --host codex");
    else for (const event of ["PreToolUse", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop"]) {
      const command = installedHook(repoRoot, event, "codex-event", "codex");
      const error = command ? hookProblem(command, onPath) ?? codexMatcherProblem(repoRoot, event) : "설치되지 않았습니다";
      add(error ? "✗" : "✓", `Codex ${event}`, error ?? command!, "code-agent init --host codex");
    }
    try {
      const codexAssets = [...hostAssets("codex", repoRoot)];
      const changed = codexAssets.filter(([path, text]) => !existsSync(join(repoRoot, path)) || readFileSync(join(repoRoot, path), "utf8").replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")).map(([path]) => path);
      add(changed.length ? "✗" : "✓", "Codex 스킬·에이전트", changed.length ? changed.join(" · ") : `${assetCount(codexAssets.map(([path]) => path))} 모두 번들과 같습니다`, "code-agent update --templates-only --host codex");
      const instructions = join(repoRoot, "AGENTS.md");
      const ok = existsSync(instructions) && readFileSync(instructions, "utf8").includes(assetText("template/CODEX.block.md").trim());
      add(ok ? "✓" : "✗", "Codex 프로젝트 지침", ok ? "AGENTS.md 블록 확인" : "블록 누락 또는 변경", "code-agent init --host codex");
    } catch (error) { add("✗", "Codex 번들", String(error)); }
    add("·", "Codex 훅 실행", "파일 설치만 검사했습니다. Codex에서 프로젝트 훅 신뢰가 필요하며 실제 실행·클라이언트 기능은 별도로 확인하세요.");
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
    add("·", "매니페스트", `${MANIFEST_FILE} 이 없습니다 — 아직 도입 전입니다 (/ca-adopt)`);
  }

  // 9. 공통 POLICY 4종
  for (const doc of checkProjectDocs(repoRoot, manifest)) {
    if (doc.ok) add("✓", doc.label, "확정됨");
    else add("✗", doc.label, doc.state, doc.problem);
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
      "Claude는 선택 도구, Codex는 ca-answer가 안내한 사용자 메시지를 훅으로 관찰합니다.",
    );
  }

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
