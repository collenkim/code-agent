import { basename, dirname, isAbsolute, relative, resolve } from "path";

import { existsSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

import { hashPlan } from "../core/approval";
import { loadPlanning, requiredOutputs, TASK_AGENTS } from "./planningState";
import { checkPaths, unplannedFiles } from "../core/gate";
import { MANIFEST_FILE, type Manifest, type StageDef } from "../core/manifest";
import { docPaths } from "./docs";
import {
  collectWindowOpen,
  loadEvidence,
  reproMissing,
  testFrozen,
  testRoots,
  trackedTestFiles,
  validationDocFile,
  verifyView,
} from "./evidence";
import { TIMING, writeBlockReason } from "./retryPolicy";
import { storeDir } from "./plugins/store";
import { findingOpensFile } from "./review";
import { KNOWLEDGE_KINDS, POLICY_KINDS } from "./schemas";
import { canonical, DOCS_SESSION_FILE, findRepoRoot, foldWindowsAlias, loadDocsSession, questionsFile, shareInside, STATE_DIR, workDocsDir } from "./layout";
import { loadRequestSession, requirementFile } from "./request";
import type { RequestSession } from "./request";
import { approvalOf, loadManifestIfAny, loadWork } from "./work";
import type { Work } from "./work";
import { planDocFile } from "./workDocs";
import { CONSENT_LOCK, consentLockHeld, openConsent } from "./consentState";
import { consentCommandOf, issueTicket } from "./consentTicket";
import { mentionsAidlc } from "./aidlc";
import { CROSS_CHILD_DENY, crossChild } from "./crossEnv";
import { editVia, fileToolsHint, readToolVia, readVia, skill, viaShell, withNotation } from "./hostText";
import { reentryHint } from "./reentry";
import { leaseGuard } from "./lease";

/**
 * Claude Code PreToolUse hook 의 판정.
 *
 * 규칙 대조라 모델에게 맡기지 않는다. 거부 사유는 모델에게 그대로 보이므로, 무엇을 하면 풀리는지까지 적는다.
 * 진행 중인 작업도 세션도 없으면 거의 관여하지 않는다 — code-agent 로 하는 작업이 아닐 때까지 막을 이유는 없다.
 * 셋만은 언제나 지킨다: `.code-agent/`(상태 · 원장) · 작업 지시서 · 키 자리 (`decideOutside`).
 */
export interface HookInput {
  cwd: string;
  session_id?: string;
  /** 서브에이전트 안의 도구 호출에만 있다 — 메인과 계획 담당을 가른다 */
  agent_id?: string;
  /** 명령을 실제로 해석하는 셸. Windows 의 Codex 셸 명령은 PowerShell 로 돈다 */
  shell?: "powershell";
  /** 이벤트를 보낸 호스트 — 없으면 claude(runHook 이 claude, codexHook 이 codex 를 넣는다) */
  host?: "claude" | "codex";
  tool_name: string;
  /** Grep 은 pattern·path·glob, Glob 은 pattern·path. MCP 도구는 인자 객체 전체가 온다 */
  tool_input: { file_path?: string; notebook_path?: string; path?: string; command?: string; glob?: string; pattern?: string; [key: string]: unknown };
}

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** 경로를 받아 파일 내용을 모델에게 주는 도구들 */
const READ_TOOLS = ["Read", "Grep", "Glob"];

/** 셸 연결·리다이렉트·치환. 허용 목록의 명령 뒤에 무엇이든 붙일 수 있게 되는 자리다 */
const SHELL_META = /[;&|<>`\r\n]|\$\(/;

/**
 * PowerShell 은 인자 자리의 ( ) · @( ) · { } 와 $ 를 먼저 평가한다 — `git status (Remove-Item src)` 가 읽기용 git 으로 통과하면
 * 괄호 안이 실행된다. 작은따옴표 안만 글자 그대로이고, 큰따옴표 안에서는 $ 가 여전히 펼쳐진다.
 */
function powershellMeta(command: string): boolean {
  let quote: string | undefined;
  for (const ch of command) {
    if (quote === "'") { if (ch === "'") quote = undefined; continue; }
    if (quote === '"') { if (ch === '"') quote = undefined; else if (ch === "$") return true; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if ("(){}@$".includes(ch)) return true;
  }
  return false;
}

const READONLY_GIT = /^git (status|diff|log|show)(\s|$)/;

/**
 * 읽기용 git 도 `-o`·`--output` 을 받으면 파일을 쓴다 — `git show HEAD:<경로> --output=<아무 곳>` 은
 * 커밋된 내용을 바이트 그대로 아무 자리에 떨군다. 셸 메타 문자가 없어 SHELL_META 에도 걸리지 않는다.
 */
const WRITES_FILE = /(^|\s)(-o|--output)(=|\s|$)/;

/** `git diff --no-index` 는 저장소 밖 아무 파일이나 읽어 보여 준다 — 상대 경로로 키 자리를 가리켜도 지나간다 */
const READS_OUTSIDE = /(^|\s)--no-index(=|\s|$)/;

/**
 * 모델이 셸에서 직접 부를 수 있는 서브명령. 승인·반영·설정 변경은 아래 목록으로
 * 직접 열지 않는다. 별도로 검사하는 consent apply가 관찰된 같은 세션 응답을 적용한다.
 * 독립 CLI에서는 TTY 확인을 유지하고, init의 임의 CLI 교체로 hook을 바꾸는 길도 막는다.
 */
const MODEL_SUBCOMMANDS = [
  "start",
  "next",
  // 되감기는 열어 둔다 — 앞으로는 못 가고 지우는 것도 없어 건너뛸 수 있는 것이 없다.
  // 승인·증거가 전부 해시에 묶여 있어, 되감아도 통과가 되살아나거나 회차가 줄지 않는다.
  "back",
  "context",
  "read",
  "status",
  "plan submit",
  "planning prepare", "planning advance", "planning status", "planning result", "planning dispatch", "planning repair", "planning cancel", "planning cross",
  "docs",
  "survey",
  "manifest check",
  // 요구사항 접수 — begin · submit · 상태. 확정·반려는 `confirm request` · `reject request` 라 여기 걸리지 않는다
  "request",
  // `plugin list` **만** 연다. `"plugin"` 을 넣으면 isModelCommand 의 접두어 일치로 add·remove 까지
  // 열려, 모델이 "어디로 코드가 나가는가" 를 제 손으로 정하게 된다.
  "plugin list",
  "repro",
  "check",
  "test",
  "verify",
  "review",
  "integrate",
  // 다른 세션이 쥔 작업 임대를 푼다 — 사용자 확인 뒤(스킬 규칙). 임대는 사고 방지 장치이지 권한 경계가 아니다(lease.ts)
  "takeover",
];

/**
 * 작업 임대를 보지 않는 읽기 전용 code-agent 명령 — 상태를 바꾸지 않으므로 다른 세션이 진행 중이어도 연다.
 * 연결·리다이렉트는 decideBash 가 먼저 거부한다.
 */
const LEASE_FREE = /^code-agent(?:$| (?:help|--help|status|context(?: --file)?|read .+|survey|manifest check|plugin list|planning (?:status|result \S+)|model(?: --host (?:claude|codex))?|setup|doctor(?: --host (?:claude|codex|both)| --cross){0,2}|consent status \S+|takeover|docs(?: skeleton \S+| interview .+| recommend)?|request)$)/;
/** 작업 임대를 보는 셸 명령 — 모델이 부를 수 있는 code-agent 명령 중 읽기 전용이 아닌 것 */
function leaseGated(command: string): boolean {
  return isModelCommand(command) && !LEASE_FREE.test(command);
}

function isModelCommand(command: string): boolean {
  if (command === "code-agent") {
    return true;
  }
  if (!command.startsWith("code-agent ")) {
    return false;
  }
  const rest = command.slice("code-agent ".length);
  if (rest === "help" || rest === "--help") return true;
  if (/^model(?: --host (?:claude|codex))?$/.test(rest)) return true; // 조회만 허용한다. 변경은 관찰된 동의로 적용한다.
  if (/^consent (prepare\s+\S.*|(?:status|apply|finish) [a-f0-9-]+)$/.test(rest)) return true;
  if (rest === "setup") return true; // baseline은 사람의 TTY 확인 전용
  // doctor 는 읽기 전용이다(상태 파일을 쓰지 않는다). --cross 는 다른 호스트 CLI 의 --help 만 실행한다 — 두 옵션은 순서와 무관하게 받는다
  if (/^doctor(?: --host (?:claude|codex|both)| --cross){0,2}$/.test(rest)) return true;
  return MODEL_SUBCOMMANDS.some((sub) => rest === sub || rest.startsWith(`${sub} `));
}

/**
 * `git branch` 는 목록 보기만. 인자를 열어 두면 `-D`·`-m`·`<새 브랜치>` 로 작업 브랜치를 지우거나 바꾼다 —
 * 작업 브랜치는 start 만 딴다.
 */
const READONLY_BRANCH = /^git branch(\s+(--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current))*$/;

/**
 * 등록된 키가 사는 자리 — **모델은 여기를 읽지 못한다.**
 *
 * P7 이 사용자 키를 평문으로 디스크에 두면서 생긴 자리다. 등록·제거는 TTY 로 막았지만, 막은 것은
 * *쓰는* 길뿐이었다 — `Read ~/.code-agent/credentials.json` 한 번이면 그 키가 모델의 화면에 그대로
 * 온다. 경로 비교는 구분자와 대소문자를 접어 본다 (Windows 는 둘 다 흔들린다).
 */
function normalized(path: string): string {
  // 로컬 관리 공유·장치 경로(`\\localhost\C$\…`·`\\?\C:\…`)는 드라이브 경로로 접고, NTFS 스트림 표기
  // (`credentials.json::$DATA`·`.code-agent::$INDEX_ALLOCATION\…`)·이름 끝 점·공백은 본 이름으로 접는다(win32)
  const folded = foldStreams(foldWindowsAlias(path));
  // `\\?\C:\…`·`\\?\UNC\…` 는 같은 파일의 긴 경로 표기다 — 접두를 걷고 견준다
  const plain = folded.replace(/^[\\/]{2}\?[\\/](UNC[\\/])?/i, (_, unc?: string) => (unc ? "//" : ""));
  return resolve(plain).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 맨 앞의 `~`(뒤가 끝이거나 구분자)를 홈 폴더로 푼다. Claude Code 의 Read·Write·Grep·Glob 은 경로의 `~` 를 홈으로 풀어 실행하는데,
 * 호스트가 PreToolUse 입력을 정규화하는 것은 일부 필드뿐이라(Grep·Glob 의 path 는 원문) hook 이 스스로 푼다 — 그러지 않으면
 * `~/.code-agent` 가 작업 경로 아래 `~` 폴더로 해석돼 키 자리·상태 판정을 비켜 간다. MCP 파일 서버도 `~` 를 홈으로 푼다.
 * `~user` 꼴은 풀지 않는다.
 */
export function expandTilde(path: string, home: string = homedir()): string {
  return /^~(?=$|[\\/])/.test(path) ? home + path.slice(1) : path;
}

/** 8.3 짧은 이름·링크·접합점은 실제 경로로 접는다. 없는 경로는 그대로 */
function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** 키 파일 이름 — 경로를 어떻게 적든(상대·UNC 공유·폴더 스트림 표기 등) 이 이름이면 키 자리다 */
const STORE_FILE_NAME = /(^|[\\/])\.code-agent(?::[^\\/]*)?[\\/]+credentials\.json/i;

function insideStore(target: string): boolean {
  if (target.trim() === "") {
    return false;
  }
  target = expandTilde(target);
  if (STORE_FILE_NAME.test(target)) {
    return true;
  }
  const roots = [storeDir(), realOrSelf(storeDir())].map(normalized);
  const paths = [target, realOrSelf(target)].map(normalized);
  return paths.some((path) => roots.some((root) => path === root || path.startsWith(`${root}/`)));
}

const STORE_DENIED =
  "등록된 플러그인 키가 있는 자리는 읽을 수 없습니다. " +
  "무엇이 등록돼 있는지는 code-agent plugin list 가 값을 빼고 보여 줍니다 — 키가 필요하면 사람에게 물으세요.";

/** 키 저장소의 상위 폴더인가 — 그 폴더를 통째로 검색하면 키 파일까지 읽힌다 */
function ancestorOfStore(path: string): boolean {
  if (path.trim() === "") return false;
  path = expandTilde(path);
  const roots = [storeDir(), realOrSelf(storeDir())].map(normalized);
  const bases = [path, realOrSelf(path)].map(normalized);
  return bases.some((base) => roots.some((root) => root.startsWith(`${base}/`)));
}
const storeAncestorDenied = (path: string): string =>
  `등록된 플러그인 키가 들어 있는 상위 폴더(${path})는 검색하지 않습니다 — 저장소 안에서 검색하세요. 키 저장소를 프로젝트 안에 두었다면(CODE_AGENT_HOME) 프로젝트 밖으로 옮기세요.`;

/** glob 의 정적 접두 — 첫 와일드카드(`*?[{`)가 든 구성요소 앞까지 */
function staticPrefix(glob: string): string {
  const parts = glob.split(/[\\/]/);
  const cut = parts.findIndex((part) => /[*?[{]/.test(part));
  return (cut < 0 ? parts : parts.slice(0, cut)).join("/");
}

/**
 * 읽기 도구(Read·Grep·Glob)의 판정 — 키 자리만 닫는다. 경로뿐 아니라 Grep 의 glob·Glob 의 pattern 정적 접두와 검색 루트도 본다.
 * 검색(Grep·Glob)은 키 저장소의 상위 폴더 자체도 거부한다(그 아래를 통째로 훑는다). 모든 모드(작업·세션 밖·상태 읽기 실패)에 같다.
 */
function readDenied(input: HookInput): string | undefined {
  const raw = expandTilde(input.tool_input.path ?? input.tool_input.file_path ?? input.cwd ?? "");
  const base = raw && !isAbsolute(foldWindowsAlias(raw)) && input.cwd ? resolve(input.cwd, raw) : raw;
  const roots = [base];
  const pattern = typeof input.tool_input.pattern === "string" ? expandTilde(input.tool_input.pattern) : undefined;
  const glob = typeof input.tool_input.glob === "string" ? expandTilde(input.tool_input.glob) : undefined;
  if (input.tool_name === "Glob" && pattern) roots.push(resolve(base || ".", staticPrefix(pattern)));
  if (input.tool_name === "Grep" && glob) roots.push(resolve(base || ".", staticPrefix(glob)));
  const texts = [glob, input.tool_name === "Glob" ? pattern : undefined].filter((text): text is string => !!text);
  if (roots.some(insideStore) || texts.some((text) => STORE_FILE_NAME.test(text))) return STORE_DENIED;
  if (input.tool_name !== "Read") {
    const ancestor = roots.find((root) => ancestorOfStore(root));
    if (ancestor) return storeAncestorDenied(ancestor);
  }
  return undefined;
}

/**
 * Windows 에서 이름 끝의 점·공백은 다른 이름의 같은 파일이 된다(`.code-agent.`·`requirement.md `) — 경로 대조를 비켜 가므로 거부한다.
 * 모든 모드의 쓰기 판정 맨 앞에서 부른다(win32 전용).
 */
function aliasGuard(target: string): string | undefined {
  if (process.platform !== "win32" || !target) return undefined;
  const parts = target.split(/[\\/]/).filter((part) => part !== "" && part !== "." && part !== ".." && !/^[A-Za-z]:$/.test(part) && part !== "?");
  return parts.some((part) => /[. ]$/.test(part))
    ? `Windows 에서 이름 끝의 점·공백은 다른 이름의 같은 파일이 됩니다: ${target} — 이름 끝의 점·공백을 빼고 쓰세요.`
    : undefined;
}

// ---- 다른 이름의 도구(MCP) ----

const MCP_PATH_KEYS = /^(?:file_?path|filePath|path|paths|file|files|filename|target(?:_?path)?|destination|dest|source|src|new_?path|old_?path|directory|dir|root|uri|relative_?path|relativePath|path_?in_?project|pathInProject|project_?path|projectPath|notebook_?path|notebookPath)$/i;
/** 프로젝트 상대 경로 키 — 코딩 MCP(Serena relative_path, JetBrains pathInProject 등)는 서버 이름과 무관하게 저장소 기준으로 판정한다 */
const MCP_PROJECT_KEYS = /^(?:relative_?path|relativePath|path_?in_?project|pathInProject|project_?path|projectPath)$/i;
/** 쓰기 동사 — 도구 이름을 _·-·camelCase 경계로 나눈 **낱말**로 맞춘다(compute 의 put, read_output_file 의 put 처럼 부분 문자열로 걸리지 않게) */
const MCP_WRITE_VERBS = new Set(["write", "edit", "create", "delete", "remove", "move", "rename", "copy", "patch", "replace", "insert", "append", "mkdir", "save", "put", "apply", "update", "overwrite", "truncate", "unlink", "rm"]);
function mcpWrites(tool: string): boolean {
  return tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split(/[_\-\s.]+/).some((word) => MCP_WRITE_VERBS.has(word.toLowerCase()));
}
/** 로컬 파일 시스템 서버로 보는 이름 — 이 서버만 상대 경로를 저장소 기준으로 판정한다 */
const LOCAL_FS_SERVERS = /^(?:fs|filesystem|files|file-system|local-?files?)$/i;

/** 저장소 안이거나 키 저장소 안인가 */
function localTarget(repoRoot: string, path: string): boolean {
  if (insideStore(path)) return true;
  const rel = relative(repoRoot, canonical(foldWindowsAlias(path)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
/**
 * MCP 도구 인자에서 판정할 로컬 경로 — 경로 키(최상위와 한 단계 아래 객체)의 문자열·문자열 배열. `file://` 은 경로로 바꾸고 그 밖의 URI 는 버린다.
 * 로컬 파일 서버는 모든 경로를, 그 밖의 서버는 저장소·키 저장소 안을 가리키는 절대 경로만 남긴다 — 원격 서비스의 경로 인자
 * (예: GitHub 의 `path`, 드라이브 서비스의 `/My Drive/x`)를 잘못 막지 않는다.
 */
function mcpPaths(toolInput: Record<string, unknown>, local: boolean, repoRoot: string): string[] {
  const values: { value: string; project: boolean }[] = [];
  const collect = (object: Record<string, unknown>, depth: number) => {
    for (const [key, value] of Object.entries(object)) {
      if (MCP_PATH_KEYS.test(key)) {
        const project = MCP_PROJECT_KEYS.test(key);
        if (typeof value === "string") values.push({ value, project });
        else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === "string").map((item) => ({ value: item, project })));
      }
      if (depth === 0 && value && typeof value === "object" && !Array.isArray(value)) collect(value as Record<string, unknown>, 1);
    }
  };
  collect(toolInput, 0);
  const paths: string[] = [];
  for (const { value: raw, project } of values) {
    const value = raw.trim();
    if (!value) continue;
    // 로컬 파일 서버(예: server-filesystem)는 `~` 를 홈으로 푼다
    let path = expandTilde(value);
    if (/^file:\/\//i.test(value)) {
      try { path = fileURLToPath(value); } catch { continue; }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:([\\/]|$)/i.test(value)) continue;
    if (isAbsolute(foldWindowsAlias(path))) { if (local || localTarget(repoRoot, path)) paths.push(path); }
    else if (local || project) paths.push(resolve(repoRoot, path));
  }
  return paths;
}
/** MCP 도구 — 경로마다 Write·Read 로 같은 판정을 다시 탄다(작업·세션·세션 밖·상태 읽기 실패 모두). 경로 인자가 없는 도구는 판정하지 않는다 */
function decideMcp(input: HookInput, projectDir?: string): string | undefined {
  const [, server = "", ...rest] = input.tool_name.split("__");
  const tool = rest.join("__");
  // 하위 폴더에서 연 세션(CLAUDE_PROJECT_DIR·cwd 가 저장소 안 폴더)도 저장소 루트로 판정한다 — CLI·티켓·Codex 와 같은 루트
  const repoRoot = findRepoRoot(projectDir ?? input.cwd);
  const paths = mcpPaths(input.tool_input as Record<string, unknown>, LOCAL_FS_SERVERS.test(server), repoRoot);
  if (!paths.length) return undefined;
  const write = mcpWrites(tool);
  for (const path of paths) {
    const reason = decideTool({ ...input, tool_name: write ? "Write" : "Read", tool_input: { file_path: path } }, projectDir);
    if (reason) return `MCP 도구 ${input.tool_name}: ${reason}`;
  }
  return undefined;
}

/** 쓰기 대상이 저장소 안인가(경로 없음은 안으로 본다 — 막는 쪽). 판정하지 못하면 안으로 본다 */
function targetInsideRepo(repoRoot: string, target: string): boolean {
  if (!target) return true;
  try { const path = repoPath(repoRoot, target); return !(path.startsWith("..") || isAbsolute(path)); } catch { return true; }
}

/** 동의 적용 중의 쓰기 — 확인한 대상과 실제 반영이 갈라진다. 잠금 주인이 죽었거나 없으면 통과한다 */
function consentWriteGuard(repoRoot: string): string | undefined {
  const held = consentLockHeld(repoRoot);
  return held ? `확인·적용이 진행 중입니다(pid ${held.pid}) — 끝난 뒤 다시 쓰세요. 그 사이의 쓰기는 확인한 대상과 실제 반영을 갈라 놓습니다. ` +
    `실행 중인 code-agent 가 없는데 계속 막히면(pid 재사용) 사람이 별도 터미널에서 ${CONSENT_LOCK} 을 지웁니다.` : undefined;
}

/**
 * 세션 밖 셸이 호스트 hook 설정을 가리키는가 — settings.local.json 에는 disableAllHooks 를 둘 수 있다.
 * Windows 는 이름 끝의 점·공백을 버리고(`.claude./settings.json`) 8.3 짧은 이름(`CLAUDE~1\SETTIN~1.JSO`)도 같은 파일이며 `./` 는 같은 폴더다 —
 * 폴더 이름 뒤의 NTFS 스트림 표기(`.claude::$INDEX_ALLOCATION\settings.json` — 같은 폴더)와 `<이름>\..\`(겹친 `a\b\..\..\` 까지 — mentionsHostConfig)도 같은 자리다.
 * 글자 그대로 쓴 이 별칭들도 본다. 와일드카드·변수로 조립한 이름은 잡지 못한다(가리키는 것만 막는다).
 */
const HOST_DIR_TAIL = String.raw`(?::[^\\/\s"'\x60]*)?[\\/]+(?:\.[\\/]+)*`;
const HOST_CONFIG = new RegExp(
  String.raw`(?:(?:^|[^A-Za-z0-9_.-])\.claude[. ]*|(?:^|[^A-Za-z0-9_.~-])claude~\d)${HOST_DIR_TAIL}(?:settings(?:\.local)?\.json|settin~\d\.jso)` +
  String.raw`|(?:(?:^|[^A-Za-z0-9_.-])\.codex[. ]*|(?:^|[^A-Za-z0-9_.~-])codex~\d)${HOST_DIR_TAIL}(?:hooks\.json|config\.toml|hooks~\d\.jso|config~\d\.tom)`, "i");
/** 구분자 뒤의 `<이름>/..` 한 짝 — `.`·`..` 는 이름이 아니다 */
const PARENT_PAIR = /(?<=[\\/])(?!\.\.?(?:[\\/]|$))[^\\/\s"'`]+[\\/]+\.\.(?=[\\/]|$|[\s"'`])/;
/**
 * 셸 명령이 호스트 hook 설정을 가리키는가 — 글자 그대로의 `<이름>/..` 짝을 겹친 것까지 되풀이해 접은 꼴도 본다
 * (`.claude/a/b/../../settings.json` 은 `.claude/settings.json` 이다). 접으면 사라지는 언급도 있어 접기 전·후 둘 다 본다.
 */
function mentionsHostConfig(command: string): boolean {
  if (HOST_CONFIG.test(command)) return true;
  let text = command;
  for (let previous = ""; previous !== text;) { previous = text; text = text.replace(PARENT_PAIR, ""); }
  return text !== command && HOST_CONFIG.test(text);
}
/** 읽기 도구 이름은 호스트 표기다(Claude 는 `Read 도구로`, Codex 는 전용 읽기 도구가 없어 `code-agent read 로` — 그 명령은 decideOutside 가 연다) */
const hostConfigBashDenied = (): string => `호스트 hook 설정(.claude/settings.json · .claude/settings.local.json · .codex/hooks.json · .codex/config.toml)은 셸로 다루지 않습니다 — 읽기는 ${readToolVia()} 하고, 설치·갱신은 사람이 code-agent init 또는 code-agent update --templates-only 로 합니다. 설정이 지워지면 code-agent 의 모든 판정이 꺼집니다.`;
/**
 * 파일 읽기 명령 `code-agent read <파일> [시작 줄] [줄 수]` 하나 — 연결·리다이렉트·치환 없이(PowerShell 은 작은따옴표 밖의 ( ) { } @ $ 도 없이).
 * Codex 에는 전용 읽기 도구가 없어 이 명령이 유일한 읽기 길이다. 읽기 자체는 그 명령이 Read 판정(readDenied — 키 자리)을 다시 거친다.
 */
function readCommand(command: string, powershell: boolean): boolean {
  return /^code-agent read \S/.test(command) && !SHELL_META.test(command) && !(powershell && powershellMeta(command));
}
/**
 * 소스 update 명령 — `code-agent update` 를 어떻게 부르든(공백 여러 칸, `npx`, 경로·`.cmd`, `node <dist>/cli.js update`) 본다.
 * 진짜 관문은 CLI 쪽(updateFromSourceConfirmed — 호스트 셸 거부·TTY 확인)이고, 이 판정은 그 앞의 안내다.
 */
const SOURCE_UPDATE = /(?:^|[\s&;|("'\\/])code-agent(?:\.cmd|\.ps1)?["']?\s+update(?=\s|$)|\bcli\.js["']?\s+update(?=\s|$)/i;
const SOURCE_UPDATE_DENIED = "code-agent 소스 업데이트(fetch · pull · npm ci · build)는 사람의 확인이 필요합니다 — 현재 세션의 ca-answer update 동의 절차를 쓰거나, 사람이 호스트 밖의 터미널에서 직접 실행합니다(미리보기 뒤 update 입력). 번들 템플릿만 다시 적용하려면 code-agent update --templates-only 를 씁니다.";

/**
 * 교차 실행이 띄운 다른 호스트 안(CODE_AGENT_CROSS)에서 여는 code-agent 명령 — 읽기 전용 검토에 필요한 것만(파일 읽기·상태·조사).
 * 셸 연결·리다이렉트·치환 문자가 섞이면 열지 않는다.
 */
const CROSS_CHILD_READONLY = /^code-agent(?: (?:help|--help|status|survey|planning status|read(?: [^;&|<>`$()\r\n]+)?))?$/;

/**
 * 교차 실행 자식의 진행 명령·쓰기 거부 — 다른 호스트의 읽기 전용 실행(Claude `--allowedTools Read,Grep,Glob`, Codex `-s read-only`)과
 * 별개로 hook 이 한 번 더 막는다(샌드박스가 쓰기를 막는 정도는 플랫폼마다 다르다). 작업 임대보다 먼저 보며 임대를 읽거나 쓰지 않는다.
 * 그 밖(읽기·키 자리·셸 허용 목록)은 decide 가 그대로 판정한다.
 */
export function crossChildGuard(input: HookInput): string | undefined {
  if (!crossChild()) return undefined;
  const reason = `${CROSS_CHILD_DENY} 교차 실행이 아닌데 이 문구가 보이면 셸 설정에서 CODE_AGENT_CROSS 를 지우세요(code-agent doctor 가 알린다).`;
  if (WRITE_TOOLS.includes(input.tool_name)) return reason;
  if (["Bash", "PowerShell"].includes(input.tool_name)) {
    const command = (input.tool_input.command ?? "").trim();
    if (/\bcode-agent\b/.test(command) && !CROSS_CHILD_READONLY.test(command)) return reason;
  }
  return undefined;
}

/**
 * PreToolUse 판정. 허용한 셸 명령이 동의 준비·적용(정확한 꼴)이면 이 세션의 티켓을 낸다 — CLI 는 그 티켓이 있어야 준비·적용한다(CON-1·2).
 * 연결자·리디렉션·치환이 든 명령은 티켓을 내지 않는다. 티켓을 쓰지 못해도 판정은 바꾸지 않는다(CLI 가 거부한다).
 */
export function decide(input: HookInput, projectDir?: string): string | undefined {
  const reason = decideTool(input, projectDir);
  if (reason === undefined && ["Bash", "PowerShell"].includes(input.tool_name) && input.session_id) {
    const text = (input.tool_input.command ?? "").trim();
    const powershell = input.tool_name === "PowerShell" || input.shell === "powershell";
    const command = SHELL_META.test(text) || (powershell && powershellMeta(text)) ? undefined : consentCommandOf(text);
    if (command) {
      try {
        // CLI 의 findRepoRoot(process.cwd()) 와 같은 루트 — 하위 폴더에서 연 세션도 저장소 루트에 낸다
        const root = findRepoRoot(projectDir ?? input.cwd);
        issueTicket(root, { kind: command.kind, ...(command.kind === "apply" ? { id: command.id } : {}),
          sessionId: input.session_id, host: input.host ?? "claude", cwd: input.cwd, command: text.slice(0, 200) });
      } catch { /* 티켓을 쓰지 못하면 CLI 가 준비·적용을 거부한다 */ }
    }
  }
  return reason;
}

function decideTool(input: HookInput, projectDir?: string): string | undefined {
  const child = crossChildGuard(input);
  if (child) return child;
  // 다른 이름의 도구 — 경로 인자를 Write·Read 로 다시 판정한다(상태를 읽기 전에, 모든 모드가 같은 규칙)
  if (input.tool_name.startsWith("mcp__")) return decideMcp(input, projectDir);
  // 모드·상태 경로는 저장소 루트(findRepoRoot)에서 본다 — Claude 를 하위 폴더에서 열면 CLAUDE_PROJECT_DIR 가 그 폴더라, 그대로 쓰면
  // 작업·세션·열린 동의·적용 잠금을 보지 못하고 루트의 .code-agent 가 저장소 밖으로 풀린다(CLI·티켓 발급·codexHook 과 같은 루트)
  const repoRoot = findRepoRoot(projectDir ?? input.cwd);
  if (WRITE_TOOLS.includes(input.tool_name)) {
    const target = input.tool_input.file_path ?? input.tool_input.notebook_path ?? "";
    // 동의 적용 잠금은 저장소 안 쓰기만 본다 — 저장소 밖 쓰기는 동의 스냅샷과 무관하다(잠금 pid 가 재사용돼도 저장소 밖은 막지 않는다)
    const early = (targetInsideRepo(repoRoot, target) ? consentWriteGuard(repoRoot) : undefined) ?? aliasGuard(target);
    if (early) return early;
  }
  /** 동의 주인(응답을 관찰한 세션)으로 확인된 `consent apply|finish <id>` — 사람이 그 세션에서 그 동작을 승인했다(임대를 보지 않는다) */
  let consentOwner = false;
  if (["Bash", "PowerShell"].includes(input.tool_name)) {
    const command = input.tool_input.command ?? "";
    if (/\b(?:consent-event|planning-event|review-event|codex-event)\b/.test(command)) return "실행 관찰 명령은 호스트 hook만 호출합니다.";
    // consent.ts 는 무겁다(commands·deliver·validate·sourceUpdate 그래프) — 적용 명령 꼴일 때만 읽는다. 접두어가 가드의 정규식보다
    // 넓어 가드가 보던 명령은 모두 가드를 지난다(hookLoad.test 가 그래프와 지연 로드를 본다)
    const denied = /^code-agent consent (?:apply|finish) /.test(command.trim())
      ? (require("./consent") as typeof import("./consent")).consentCommandGuard(repoRoot, command, input.session_id)
      : undefined;
    if (denied) return denied;
    consentOwner = /^code-agent consent (?:apply|finish) [a-f0-9-]+$/.test(command.trim());
  }
  let work: Work | undefined, documenting: boolean, requesting: RequestSession | undefined, manifest: Manifest | undefined;
  let docsSession: { writable?: string[] } = {};
  try {
    work = loadWork(repoRoot);
    documenting = !work && existsSync(join(repoRoot, DOCS_SESSION_FILE));
    if (documenting) docsSession = loadDocsSession(repoRoot) ?? {};
    // 접수 세션 — 작업 커서가 생기기 전이다. 작업 · 문서 세션이 있으면 그쪽 규칙이 이긴다
    requesting = !work && !documenting ? loadRequestSession(repoRoot) : undefined;
    manifest = work ? work.manifest : documenting || requesting ? loadManifestIfAny(repoRoot) : undefined;
  } catch (error) {
    return decideUnreadable(input, repoRoot, error);
  }
  if (!work && !documenting && !requesting) {
    return decideOutside(input, repoRoot);
  }
  if (["Bash", "PowerShell"].includes(input.tool_name)) {
    // 세션 동안에는 선언된 빌드·테스트 명령을 열지 않는다 — 돌릴 코드가 아직 없는 자리다
    const command = (input.tool_input.command ?? "").trim();
    const reason = decideBash(manifest, command, documenting || requesting !== undefined,
      input.tool_name === "PowerShell" || input.shell === "powershell");
    // 작업 임대 — 기존 거부가 먼저이고, 상태를 바꾸는 code-agent 명령만 본다(읽기 명령·선언된 명령·읽기용 git 은 보지 않는다).
    // 거부되면 바깥 decide 가 동의 티켓을 내지 않는다
    if (reason || !work) return reason;
    // 승인된 동의의 적용은 그 동의의 주인 세션이 한다 — 다른 창이 SessionStart 로 임대를 가져가도 적용이 막히지 않게(사람 확인 지점이 늘지 않는다)
    // 임대가 비었거나 이 세션 것이면 평소처럼 잡거나 touch 하고, 다른 세션이 쥐었으면 그 거부만 무시한다
    if (consentOwner) { leaseGuard(work, input.host ?? "claude", input.session_id); return undefined; }
    return leaseGated(command) ? leaseGuard(work, input.host ?? "claude", input.session_id) : undefined;
  }
  // 읽기는 저장소 밖도 열려 있다 — 딱 한 자리만 닫는다
  if (READ_TOOLS.includes(input.tool_name)) {
    return readDenied(input);
  }
  if (!WRITE_TOOLS.includes(input.tool_name)) {
    return undefined;
  }
  const target = input.tool_input.file_path ?? input.tool_input.notebook_path ?? "";
  const path = repoPath(repoRoot, target);
  const outside = guardRepo(path, target) ?? streamGuard(path);
  if (outside) {
    return outside;
  }
  if (work) {
    const planner = decidePlanner(work, path, input);
    const reason = planner === undefined ? decideWrite(work, path) : planner || undefined;
    return reason ?? leaseGuard(work, input.host ?? "claude", input.session_id);
  }
  return requesting ? decideRequestWrite(requesting, path) : decideDocWrite(docsSession, manifest, path);
}

/**
 * 상태·설정을 읽지 못했을 때. 모든 도구를 막으면 고칠 길까지 막힌다 — 문서 세션에서 잘못 쓴 code-agent.json
 * 하나가 Read 와 그 파일을 고칠 Edit 까지 막았다. 읽기, code-agent.json 고치기, 고친 것을 확인하는 명령만 열고
 * 나머지는 원인과 함께 막는다. 상태 원장(.code-agent/)과 지시서는 여기서도 쓰지 못한다.
 */
function decideUnreadable(input: HookInput, repoRoot: string, error: unknown): string | undefined {
  const reason = `code-agent 상태·설정을 읽지 못했습니다: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` +
    ` — ${readVia()} 원인을 확인하고 ${editVia()} ${MANIFEST_FILE} 을 고친 뒤 code-agent manifest check 로 확인하세요.`;
  if (READ_TOOLS.includes(input.tool_name)) {
    return readDenied(input);
  }
  if (["Bash", "PowerShell"].includes(input.tool_name)) {
    // Codex 는 읽기 도구가 없다 — code-agent read 로 원인을 읽는다(읽기는 그 명령이 Read 판정을 다시 거친다)
    const command = (input.tool_input.command ?? "").trim();
    const powershell = input.tool_name === "PowerShell" || input.shell === "powershell";
    return /^code-agent (?:manifest check|status|help)$/.test(command) || readCommand(command, powershell) ? undefined : reason;
  }
  if (!WRITE_TOOLS.includes(input.tool_name)) {
    return undefined;
  }
  const target = input.tool_input.file_path ?? input.tool_input.notebook_path ?? "";
  return repoPath(repoRoot, target) === MANIFEST_FILE ? undefined : reason;
}

/**
 * 작업도 세션도 없을 때. 대부분은 code-agent 의 일이 아니라 관여하지 않지만, 셋은 **언제나** 지킨다 —
 * 상태 · 원장(`.code-agent/`)은 code-agent 명령만 쓰고, 지시서(`doc/work/<ID>/requirement.md`)는 접수가 렌더하고,
 * 키 자리(`~/.code-agent/`)는 읽지도 않는다. 이 틈을 열어 두면 새 요구사항을 받기 직전 — 세션이 열리기 전 —
 * 에 모델이 지시서와 확정 원장을 손으로 써 넣고 사람의 확정 없이 `start` 를 지날 수 있다.
 *
 * Bash 는 그 자리를 **가리키는 것**만 막는다. 글자를 쪼개 돌려 쓰는 셸 명령까지는 막지 못한다 —
 * hook 은 사고 방지 장치이지 보안 경계가 아니다.
 */
function decideOutside(input: HookInput, repoRoot: string): string | undefined {
  if (["Bash", "PowerShell"].includes(input.tool_name)) {
    const command = (input.tool_input.command ?? "").trim();
    if (mentionsStore(command)) return STORE_DENIED;
    // 응답·적용을 기다리는 동의가 있으면 그동안 셸을 code-agent 명령과 읽기용 git 으로 좁힌다 — 준비부터 적용까지 대상을 바꾸지 않는다
    // 그 동의를 준비·응답한 세션만 좁힌다 — 다른 세션은 그 동의에 답할 수 없고, 그 세션의 쓰기는 동의 스냅샷 대조가 폐기로 잡는다
    const open = openConsent(repoRoot, Date.now(), input.session_id);
    if (open && decideBash(undefined, command, true, input.tool_name === "PowerShell" || input.shell === "powershell")) {
      return `확인 요청 ${open.id.slice(0, 8)}(${open.title})이 응답·적용을 기다리는 동안에는 셸에서 code-agent 명령과 읽기용 git 만 실행합니다 — 준비부터 적용까지 확인 대상을 바꾸지 않습니다. 진행하지 않을 거면 그 확인 질문에서 '보류'를 고르게 하세요(${Math.round(TIMING.consentOpenWindowMs / 60_000)}분이 지나면 풀립니다).`;
    }
    if (mentionsState(command)) return stateBashDenied();
    // 읽기 명령(code-agent read)은 연다 — Codex 의 유일한 읽기 길이고, 설정을 바꾸지 않는다
    if (mentionsHostConfig(command) && !readCommand(command, input.tool_name === "PowerShell" || input.shell === "powershell")) return hostConfigBashDenied();
    // 소스 업데이트는 네트워크·npm 스크립트를 돌린다 — 사람의 확인(동의 update 또는 터미널 직접 실행)으로만 한다
    if (SOURCE_UPDATE.test(command) && !/(^|\s)--templates-only(\s|$)/.test(command)) return SOURCE_UPDATE_DENIED;
    return undefined;
  }
  if (READ_TOOLS.includes(input.tool_name)) {
    return readDenied(input);
  }
  if (!WRITE_TOOLS.includes(input.tool_name)) {
    return undefined;
  }
  const target = input.tool_input.file_path ?? input.tool_input.notebook_path ?? "";
  if (insideStore(target)) return STORE_DENIED;
  // 사용자 수준 hook 설정(disableAllHooks·hook 덮어쓰기는 모든 프로젝트의 판정을 끈다) — 셸 언급(HOST_CONFIG)과 같은 파일을 쓰기 도구로도 막는다
  if (userHostConfig(target, [input.cwd, repoRoot])) return USER_HOST_CONFIG_DENIED;
  const path = repoPath(repoRoot, target);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) {
    return undefined; // 저장소 밖 — code-agent 의 일이 아니다
  }
  return streamGuard(path) ?? stateGuard(path) ?? requirementGuard(path);
}

/**
 * win32 전용 — 이름 대조 전에 같은 파일의 다른 표기를 접는다. NTFS 스트림 표기(`settings.json::$DATA`·`:이름`, 폴더의
 * `.claude::$INDEX_ALLOCATION\…`)는 콜론 앞의 본 이름으로 줄이고, 이름 끝의 점·공백은 뗀다(`.`·`..` 는 그대로).
 * 장치 접두(`\\?\`·`\\.\`)와 드라이브(`C:`)는 그대로 둔다 — 드라이브 경로로 접는 것은 foldWindowsAlias 의 일이다. 그 밖의 플랫폼은 그대로(`:` 는 이름의 글자다).
 */
export function foldStreams(path: string, platform: string = process.platform): string {
  if (platform !== "win32") return path;
  const device = /^[\\/]{2}[?.][\\/]/.exec(path)?.[0] ?? "";
  const drive = /^[A-Za-z]:/.exec(path.slice(device.length))?.[0] ?? "";
  const head = device + drive;
  return head + path.slice(head.length).split(/([\\/])/).map((part) => {
    if (part === "\\" || part === "/") return part;
    const name = part.split(":")[0];
    return name === "." || name === ".." ? name : name.replace(/[. ]+$/, "") || name;
  }).join("");
}

/** (dev, ino) — 없거나 파일 번호를 주지 않는 파일 시스템(ino 0)이면 undefined */
function fileId(path: string): string | undefined {
  try { const stat = statSync(path, { bigint: true }); return stat.ino ? `${stat.dev}:${stat.ino}` : undefined; } catch { return undefined; }
}

/**
 * 사용자 수준 호스트 설정 파일 — ~/.claude/settings(.local).json, ~/.codex(또는 CODEX_HOME)/hooks.json·config.toml.
 * 같은 파일의 다른 이름(스트림 표기·긴 경로 접두·로컬 관리 공유·이름 끝 점·공백·대소문자·8.3 짧은 이름·`..`·상대 경로)도 본다 —
 * 이름을 접고 있는 조상까지 실제 경로로 푼 뒤 견주고, 이름으로 접지 못한 별칭(다른 이름의 UNC·하드 링크)은 파일이 있으면 그 (dev, ino),
 * 없으면 부모 폴더의 (dev, ino)와 파일 이름으로 견준다. 상대 경로는 세션 작업 경로와 저장소 루트 양쪽에서 푼다(막는 쪽).
 */
function userHostConfig(target: string, bases: string[]): boolean {
  if (!target) return false;
  const win = process.platform === "win32";
  // 실제 경로로 풀지 못하면(권한 등) 접은 이름 그대로 견준다
  const key = (path: string) => {
    let value = resolve(path);
    try { value = canonical(value); } catch { /* 접은 이름으로 견준다 */ }
    value = value.replace(/\\/g, "/");
    return win ? value.toLowerCase() : value;
  };
  const claude = join(homedir(), ".claude");
  const codexHomes = [join(homedir(), ".codex"), ...(process.env.CODEX_HOME ? [process.env.CODEX_HOME] : [])];
  const files = [join(claude, "settings.json"), join(claude, "settings.local.json"),
    ...codexHomes.flatMap((home) => [join(home, "hooks.json"), join(home, "config.toml")])];
  const folded = foldStreams(foldWindowsAlias(expandTilde(target)));
  const candidates = [...new Set(isAbsolute(folded) ? [resolve(folded)] : bases.filter(Boolean).map((base) => resolve(base, folded)))];
  const wanted = new Set(files.map(key));
  if (candidates.some((candidate) => wanted.has(key(candidate)))) return true;
  const sameName = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  return candidates.some((candidate) => {
    const id = fileId(candidate), parent = fileId(dirname(candidate));
    return files.some((file) => (id !== undefined && id === fileId(file)) ||
      (parent !== undefined && parent === fileId(dirname(file)) && sameName(basename(candidate), basename(file))));
  });
}
const USER_HOST_CONFIG_DENIED = "사용자 수준 호스트 설정(~/.claude/settings.json · settings.local.json · ~/.codex/hooks.json · config.toml)은 도구로 쓰지 않습니다 — " +
  "disableAllHooks·hook 덮어쓰기는 모든 프로젝트의 code-agent 판정을 끕니다. 바꿔야 하면 사람이 직접 고칩니다.";

/** 셸 이름은 호스트 표기다(Claude 는 `Bash 로`) */
const stateBashDenied = (): string =>
  `\`.code-agent/\` 는 code-agent 명령으로만 바뀝니다 — 작업 상태 · 승인과 확정 원장을 ${viaShell()} 건드리지 않습니다. ` +
  "상태는 code-agent status 로 봅니다.";

/**
 * `.code-agent` 를 경로로 가리키는가 — 명령 이름 `code-agent` 는 앞에 점이 없어 걸리지 않는다. Windows 의 글자 그대로의 별칭
 * (대소문자, 이름 끝의 점·공백 `.code-agent./`, 8.3 짧은 이름 `CODE-A~1`, 스트림 표기 `.code-agent::$INDEX_ALLOCATION\`)도 같은 폴더로 본다.
 */
function mentionsState(command: string): boolean {
  return /(?:^|[^A-Za-z0-9_.-])\.code-agent[. ]*(?:[\\/\s"'`:]|$)|(?:^|[^A-Za-z0-9_.~-])code-a~\d(?:[\\/\s"'`:]|$)/i.test(command);
}

/**
 * 경로에 `:` 가 든 쓰기는 받지 않는다. Windows 에서 `requirement.md::$DATA` 는 대체 데이터 스트림 표기로
 * 같은 파일을 가리키는데, 아직 없는 파일이면 실제 경로로 풀리지 않아 이름 대조를 비켜 간다.
 */
function streamGuard(path: string): string | undefined {
  return path.includes(":")
    ? `경로에 ':' 가 든 파일은 쓸 수 없습니다: ${path} — Windows 에서는 대체 데이터 스트림 표기로 다른 이름을 단 같은 파일이 됩니다.`
    : undefined;
}

/** 작업 지시서는 `code-agent request submit` 이 렌더한다 — 세션이 있든 없든 모델이 직접 쓰지 않는다 */
function requirementGuard(path: string): string | undefined {
  return /^doc\/work\/[^/]+\/requirement\.md$/i.test(path)
    ? `작업 지시서(${path})는 code-agent request submit 이 렌더합니다 — 요구사항은 ${skill("ca-request")} 로 접수하고, 고칠 것은 request.json 에 씁니다. ` +
        "사람이 직접 쓰는 지시서는 사람이 편집기로 씁니다."
    : undefined;
}

/**
 * 요구사항 접수 — 쓸 수 있는 곳은 그 작업 폴더뿐이고, 지시서 자체는 코드가 렌더한다.
 * 확정 전에 코드나 문서를 "미리" 고쳐 두는 일과, 모델이 지시서를 손으로 다듬는 일을 막는다.
 */
function decideRequestWrite(session: RequestSession, path: string): string | undefined {
  const folder = workDocsDir(session.id);
  if (path.toLowerCase() === requirementFile(session.id).toLowerCase()) {
    return (
      `${requirementFile(session.id)} 는 코드가 렌더합니다 — code-agent request submit 이 ${folder}/request.json 에서 만듭니다. ` +
      "고칠 것은 request.json 에 쓰고 다시 제출하세요. 원문은 사람이 준 그대로 둡니다."
    );
  }
  if (path === folder || path.startsWith(`${folder}/`)) {
    return undefined;
  }
  return (
    `요구사항 접수 중에는 작업 폴더(${folder}/) 밖은 쓸 수 없습니다: ${path}. ` +
    "코드와 문서는 사람이 요구사항을 확정하고 분석이 시작된 뒤에 씁니다."
  );
}

function repoPath(repoRoot: string, target: string): string {
  // 로컬 관리 공유·장치 경로는 드라이브 경로로 접어 판정한다(win32) — 같은 파일을 다른 이름으로 가리켜 저장소 밖으로 보이지 않게.
  // `~` 는 홈으로 푼다(도구가 그렇게 실행한다)
  const folded = foldWindowsAlias(expandTilde(target));
  // 이름으로 접지 못한 UNC(FQDN·다른 주소·사용자 공유)는 공유 쪽 조상의 (dev, ino)로 저장소 안인지 본다
  const absolute = shareInside(repoRoot, folded) ?? (isAbsolute(folded) ? folded : resolve(repoRoot, folded));
  return relative(repoRoot, canonical(absolute)).replace(/\\/g, "/");
}

/** 작업 · 세션 모드 공통 — 저장소 밖과 `.code-agent/` 는 도구로 쓸 수 없다 */
function guardRepo(path: string, target: string): string | undefined {
  if (path === "" || path.startsWith("..") || isAbsolute(path)) {
    return `저장소 밖의 파일입니다: ${target}`;
  }
  return stateGuard(path);
}

function stateGuard(path: string): string | undefined {
  if (/^\.(?:codex|agents|claude)(?:\/|$)/i.test(path)) return "호스트 설정·훅·스킬은 모델이 직접 변경하지 않습니다. 사람이 init 또는 update로 설치합니다.";
  if (path.toLowerCase() === STATE_DIR || path.toLowerCase().startsWith(`${STATE_DIR}/`)) {
    return (
      "작업 상태·제출된 계획·승인과 확정 기록은 도구로 고칠 수 없습니다. " +
      "진행은 code-agent next, 계획은 code-agent plan submit, 확정은 현재 세션의 ca-answer 동의 절차로 바뀝니다."
    );
  }
  return undefined;
}

/** 매니페스트 문서 경로의 저장소 상대 꼴 — `./`·끝 `/` 를 뗀다 */
function docRoot(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}
/**
 * 문서 작성 세션 — 문서를 쓰다가 코드를 "고쳐 두는" 일을 막는다.
 * 쓸 수 있는 곳은 `doc/` 아래, 세션을 열 때(`docs begin`) 등록돼 있던 문서 경로의 `.md`, `code-agent.json`(도입할 때 만든다)뿐이다.
 * 범위는 세션 파일에 고정돼 있어 세션 중에 매니페스트의 문서 경로를 바꿔도 넓어지지 않는다(`docs link` 로 연결한 문서만 더해진다).
 * 범위가 없는 이전 형식 세션은 지금 매니페스트로 계산하되 `doc/` 밖은 `.md` 만 연다.
 */
function decideDocWrite(session: { writable?: string[] }, manifest: Manifest | undefined, path: string): string | undefined {
  // doc/ 아래라도 지시서는 접수가 렌더한다
  const order = requirementGuard(path);
  if (order) return order;
  if (path === MANIFEST_FILE || path === "doc" || path.startsWith("doc/")) return undefined;
  const roots = (session.writable ?? [...POLICY_KINDS, ...KNOWLEDGE_KINDS].flatMap((kind) => docPaths(manifest, kind))).map(docRoot);
  if (path.toLowerCase().endsWith(".md") && roots.some((root) => root && root !== "doc" && (path === root || path.startsWith(`${root}/`)))) return undefined;
  return (
    `문서 작성 중에는 문서 자리(doc/, 세션을 열 때 등록돼 있던 .md 문서, code-agent.json) 밖은 쓸 수 없습니다: ${path}. ` +
    "세션 중에 code-agent.json 의 문서 경로를 바꿔도 이 범위는 넓어지지 않습니다 — 기존 문서는 code-agent docs link 로 연결하세요. " +
    "코드를 바꿔야 한다고 보이면 문서에 적고 사람에게 알리세요. 세션은 code-agent docs end 로 끝납니다."
  );
}

/**
 * 셸 명령이 키 파일 자리를 가리키는가.
 *
 * 해석한 경로만 보면 `~`·`$HOME` 표기를 놓친다 — 셸이 풀기 전의 글자도 함께 본다.
 * 허용 목록을 통과한 명령(`declared`)이라도 여기서 먼저 걸린다.
 */
const STORE_MARKERS = [
  "~/.code-agent",
  "$home/.code-agent",
  "${home}/.code-agent",
  "%userprofile%/.code-agent",
  "$code_agent_home",
  "${code_agent_home}",
  "%code_agent_home%",
];

function mentionsStore(command: string): boolean {
  const text = command.replace(/\\/g, "/").toLowerCase();
  return text.includes(normalized(storeDir())) || STORE_MARKERS.some((marker) => text.includes(marker)) || STORE_FILE_NAME.test(command);
}

function decideBash(manifest: Manifest | undefined, command: string, documenting: boolean, powershell = false): string | undefined {
  if (mentionsStore(command)) {
    return STORE_DENIED;
  }
  if (mentionsAidlc(command)) {
    return "code-agent 작업·세션이 진행 중이라 AWS AI-DLC 를 실행하지 않습니다 — 두 워크플로를 동시에 진행하지 않습니다. " +
      "현재 작업을 반영(deliver)하거나 ca-answer의 abort 동의로 끝낸 뒤 사용하세요.";
  }
  // 문서 세션에서는 **선언된 명령을 열지 않는다.** 그 세션은 `code-agent.json` 을 쓸 수 있는
  // 유일한 자리라(`decideDocWrite`), 허용 목록을 모델이 제 손으로 넓히고 그것을 그대로 돌리는
  // 길이 열린다. 문서를 쓰는 동안 빌드·테스트를 돌릴 일은 없다.
  const declared = documenting
    ? []
    : [manifest?.build, manifest?.test, ...Object.values(manifest?.commands ?? {})]
        .filter((argv): argv is string[] => Array.isArray(argv) && argv.length > 0)
        .map((argv) => argv.join(" "));

  const allowed =
    !SHELL_META.test(command) && !(powershell && powershellMeta(command)) &&
    (isModelCommand(command) ||
      declared.includes(command) ||
      (!WRITES_FILE.test(command) && !READS_OUTSIDE.test(command) && (READONLY_GIT.test(command) || READONLY_BRANCH.test(command))));
  if (allowed) {
    return undefined;
  }
  return (
    `작업 중에는 ${viaShell()} code-agent 명령(${[...MODEL_SUBCOMMANDS, "doctor(조회)"].join(" · ")}), 선언된 명령` +
    (declared.length > 0 ? ` (${declared.join(" / ")})` : "") +
    ", 읽기용 git(status·diff·log·show, branch 는 목록 보기만, 파일로 내보내기 없이)만 실행할 수 있습니다. " +
    "연결·리다이렉트(; && | >)와 줄바꿈(CR·LF)은 안 됩니다" + (powershell ? ", PowerShell 에서는 작은따옴표 밖의 ( ) { } @ $ 도 안 됩니다(경로는 작은따옴표로 감싸세요)" : "") + ". " +
    "init·abort·approve·reject·confirm·model·deliver·plugin add·plugin remove 는 " +
    "직접 호출하지 않고 현재 세션의 ca-answer 동의 절차를 사용합니다. " +
    fileToolsHint()
  );
}

/**
 * 계획 담당의 출력 문서 자리(staging). 실행 중인 그 배정의 담당만 쓰고, 계획 담당은 그 밖을 쓰지 않는다.
 * 본문을 결과 보고에 싣지 않으려고 연 자리라 메인이 대신 쓸 수 없다 — 쓰면 관찰된 결과가 아니게 된다.
 * 둘 다 아니면 undefined로 기존 판정에 넘기고, 허용이면 빈 문자열이다.
 */
function decidePlanner(work: Work, path: string, input: HookInput): string | undefined {
  const staging = `${workDocsDir(work.active.id)}/.staging/`;
  const inside = path.toLowerCase().startsWith(staging.toLowerCase());
  const planning = work.active.planningVersion && ["analysis", "impact", "design", "plan"].includes(work.active.phase);
  if (!planning) return inside ? "staging은 계획 단계의 배정 담당만 씁니다." : undefined;
  const state = inside || input.agent_id ? loadPlanning(work) : undefined;
  const agent = input.agent_id ? state?.agents.find((item) => item.id === input.agent_id && item.session === input.session_id && !item.finished) : undefined;
  if (!inside) return agent ? `계획 담당은 배정 파일의 staging 경로에만 씁니다: ${path}` : undefined;
  if (!agent) return "staging은 실행 중인 배정의 계획 담당만 씁니다. 메인은 계획 문서를 대신 쓰지 않습니다. 서브 에이전트 식별자를 hook에 주지 않는 호스트(Codex)의 담당은 artifacts에 {path, content}로 전체 내용을 넣습니다.";
  const [dispatchId, name, ...rest] = path.slice(staging.length).split("/");
  const record = state!.tasks.find((item) => item.attempts.at(-1)?.status === "running" && item.attempts.at(-1)?.dispatchId === dispatchId);
  if (!record || rest.length || TASK_AGENTS[record.task.role] !== agent.type || (agent.dispatchId && agent.dispatchId !== dispatchId) ||
    !record.task.outputs.some((output) => basename(output) === name)) return `실행 중인 배정의 staging 경로가 아닙니다: ${path}`;
  return "";
}

function decideWrite(work: Work, path: string): string | undefined {
  const { repoRoot, active } = work;
  // 지시서는 사람의 입력이다 — 작업 폴더 안에 있어도 모델이 고치지 않는다. 모호하면 질문으로 돌린다.
  if (path === active.spec) {
    return (
      `작업 지시서(${active.spec})는 고칠 수 없습니다. 요구가 모호하거나 틀려 보이면 ` +
      `${workDocsDir(active.id)}/questions.md 에 질문으로 남기세요 — 지시서는 사람이 고칩니다.`
    );
  }
  // 05-plan.md 는 제출된 plan.json 의 파생물이라 코드만 쓴다 — 모델이 고치면 승인받은 계획과 읽는 문서가 갈라진다.
  // 대소문자는 무시한다 — 파일이 아직 없으면 canonical 이 실제 이름으로 되돌려 주지 못해 `05-PLAN.md` 가 지나간다.
  if (path.toLowerCase() === planDocFile(active.id).toLowerCase()) {
    return (
      `${planDocFile(active.id)} 는 코드가 렌더합니다 — code-agent plan submit 이 plan.json 에서 만듭니다. ` +
      `고칠 것이 있으면 ${workDocsDir(active.id)}/plan.json 을 고쳐 다시 제출하세요.`
    );
  }
  // ⑧ 도 같은 이유로 코드만 쓴다 — 검증 결과는 모델이 보고하는 것이 아니라 명령이 돌아서 남은 것만 유효하다.
  //
  // ⑨·⑩ 은 경로로 막지 않는다. 한 파일 안에서 쓰는 쪽이 갈리기 때문이다(회차 머리·추적표는 코드,
  // 지적·요약은 모델) — 안쪽만 막으려면 Edit 의 부분 치환까지 봐야 해 경로 단위 거부보다 비싸다.
  // 대신 코드가 그 구역을 **다시 렌더해 바이트로 대조한다** (blocks.ts · review.ts · deliver.ts).
  if (path.toLowerCase() === validationDocFile(active.id).toLowerCase()) {
    return (
      `${validationDocFile(active.id)} 는 코드가 렌더합니다 — code-agent check · test · integrate 가 검증 증거에서 만듭니다. ` +
      "검증 결과는 모델이 보고하는 것이 아니라 명령이 돌아서 남은 것만 유효합니다."
    );
  }
  // 작업 폴더(번호 문서·질문·계획 초안)는 어느 스테이지에서든 쓴다.
  const workDir = workDocsDir(active.id);
  if (active.planningVersion && Object.keys(TASK_AGENTS).flatMap(role => requiredOutputs(work, role as keyof typeof TASK_AGENTS)).some(file => file.toLowerCase() === path.toLowerCase())) return "이 계획 문서는 관찰된 담당 에이전트의 결과로 생성합니다. planning prepare·dispatch 후 결과의 artifacts로 반환하세요.";
  if (path === workDir || path.startsWith(`${workDir}/`)) {
    return undefined;
  }

  // 리팩토링이 기존 테스트를 고치면 '동작 보존' 을 재는 자가 없어진다. 계획 밖 변경으로도 잡히지만
  // 여기서 막아야 **무엇이 규칙인지**가 거부 사유로 보인다. 접두어를 먼저 보고 그때만 git 을 부른다.
  if (work.order.kind === "refactor") {
    const roots = testRoots(work);
    if (roots.some((root) => path === root || path.startsWith(`${root}/`)) && trackedTestFiles(work).includes(path)) {
      return (
        `리팩토링은 기존 테스트를 고치지 않습니다 — hook 이 막습니다: ${path}. ` +
        "동작이 보존되는지 보는 것이 그 테스트입니다. " +
        `테스트를 고쳐야 할 이유가 보이면 ${workDocsDir(active.id)}/questions.md 로 물으세요.`
      );
    }
  }

  if (active.phase === "analysis" || active.phase === "impact" || active.phase === "design" || active.phase === "plan") {
    return (
      `지금은 ${active.phase} 스테이지라 작업 폴더(${workDir}/) 밖은 쓸 수 없습니다. ` +
      "코드는 계획이 승인된 뒤 implement 스테이지에서 씁니다."
    );
  }
  // 반영 단계 — 검증·리뷰·통합을 마친 트리를 사람이 확인하는 자리다. 작업 폴더(⑩·지식 제안·질문)는 위에서 이미 열렸다
  if (active.phase === "deliver") {
    return (
      `반영(deliver) 단계라 작업 폴더(${workDir}/) 밖은 쓸 수 없습니다: ${path}. ` +
      "검증·리뷰·통합을 마친 트리를 사람이 확인하는 자리입니다 — 여기서 고치면 증거가 무효가 됩니다. " +
      "고칠 것이 있으면 무엇을 왜 고쳐야 하는지 사용자에게 보고하고, 사용자가 되돌리라고 하면 " +
      "code-agent back check(계획을 바꿔야 하면 back plan) 뒤 수정 루프로 고칩니다."
    );
  }
  const { plan, order, manifest } = work;
  if (!plan) {
    return "제출된 계획이 없습니다. code-agent plan submit 으로 계획을 제출하고 승인을 받아야 합니다.";
  }
  const approval = approvalOf(work);
  if (approval.status !== "approved") {
    // 재진입 순서(되감기는 낡은 계획 작업·계획 변경이 필요할 때만, 아니면 그 자리에서 plan 동의)는 status 의 `다음:` 과 같은 문장이다
    return `계획이 승인되지 않았습니다 (${approval.status}). ${reentryHint(work, approval) ?? ""}`;
  }
  if (active.phase === "implement" && plan.tasks && !plan.tasks.find(task => task.id === active.task)?.files.includes(path)) return `현재 Task ${active.task ?? "없음"}에 배정되지 않은 파일입니다: ${path}`;

  // 계획이 이 파일에 배정한 단계. 검증·리뷰는 고쳐 쓰는 자리라 커서가 아니라 이 단계의 규칙으로 본다.
  const planStage = work.stages.find((candidate) =>
    plan.files.some((file) => file.stage === candidate.key && file.path === path),
  );
  // implement 는 지금 단계의 파일만 — 경계·계획 대조는 커서 단계로 한다.
  const stage = active.phase === "implement" ? work.stage : planStage;
  if (!stage) {
    return active.phase === "implement"
      ? `지금 단계(${active.stage ?? "없음"})를 매니페스트에서 찾을 수 없습니다. code-agent status 로 확인하세요.`
      : `승인된 계획에 없는 파일입니다: ${path}. 필요하면 사람에게 알리세요 — 계획을 고치면 재승인을 받습니다.`;
  }
  const blocked = reproReason(work, path);
  if (blocked) {
    return blocked;
  }
  // 동결은 **그 파일이 속한 단계**로 잰다. 커서 단계로 재면, 구현 중 커서가 테스트 단계에 서 있는
  // 동안 고칠 파일까지 '테스트가 얼었다' 는 엉뚱한 사유로 막힌다 (막히는 것은 맞아도 이유가 틀린다).
  const frozen = freezeReason(work, planStage ?? stage, path);
  if (frozen) {
    return frozen;
  }
  const violations = [
    ...checkPaths({ repoRoot, order, manifest, plan, stage, files: [{ path, content: "" }] }),
    ...unplannedFiles(plan, stage, [path]),
  ];
  if (violations.length > 0) {
    return violations.map((v) => `[${v.item}] ${v.file}: ${v.detail}`).join("\n");
  }
  return undefined;
}

/**
 * fix 의 '재현 먼저'. 재현 증거가 없으면 **고칠 파일**(kind:"test" 가 아닌 계획 파일)을 쓸 수 없다.
 *
 * `freezeReason` 과 같은 이유로 스테이지가 아니라 증거로 잰다 — `back implement` 로 풀리면 안 된다.
 * 판정은 `reproMissing` 한 곳에 있다 (`next` 게이트가 같은 함수를 쓴다).
 */
function reproReason(work: Work, path: string): string | undefined {
  if (work.order.kind !== "fix" || !work.plan) {
    return undefined;
  }
  // 커서 단계가 아니라 **그 파일이 속한 단계**로 본다 — 재현 테스트는 어느 커서에서도 열려 있어야 하고,
  // 고칠 파일은 어느 커서에서도 닫혀 있어야 한다. 계획에 없는 파일은 다른 검사가 막는다.
  const testKeys = new Set(work.stages.filter((candidate) => candidate.kind === "test").map((candidate) => candidate.key));
  const planned = work.plan.files.find((file) => file.path === path);
  if (!planned || testKeys.has(planned.stage)) {
    return undefined;
  }
  const missing = reproMissing(work, loadEvidence(work.repoRoot, work.active.id, work.active.target));
  if (!missing) {
    return undefined;
  }
  return (
    `${missing} — 재현을 먼저 봐야 이 파일을 고칠 수 있습니다: ${path} (fix).\n` +
    "kind:\"test\" 단계의 계획 파일을 쓴 뒤 code-agent repro 로 지금 코드에서 **실패**하는 것을 보세요 — " +
    "고치고 나서 쓴 테스트는 결함을 재현한 적이 없습니다."
  );
}

/**
 * 이 파일을 고칠 수 없는 이유. 둘이다.
 *
 * **스테이지로 재지 않는다.** 증거가 있고 그 증거가 지금 계획(`planHash`) 위의 것인지만 본다 —
 * `code-agent back implement` 로 커서를 구현으로 빼면 두 규칙이 다 풀리기 때문이다. 첫 구현 패스에는
 * 증거 자체가 없어 여기서 걸릴 것이 없고, 계획을 재승인하면 `planHash` 가 달라져 둘이 함께 풀린다.
 *
 * **① 쓰기 한도(원인별)** — 고쳐도 다음 회차가 거부될 때만(`writeBlockReason` — check() 의 회차 판정과 같은 함수)
 * 계획 안 파일을 **전부** 거부한다. 고쳐 쓰기·리뷰 회차·총 회차 중 막은 카운터의 문구를 낸다. 작업 폴더는
 * 이 함수에 오기 전에 이미 통과했으므로 보고와 질문의 길은 남는다.
 *
 * **② 테스트 동결** — 결과가 인식된(또는 코드 결함으로 실패한) test 실행 뒤, 또는 재현을 본 뒤에는
 * `kind: "test"` 단계의 계획 파일을 고칠 수 없다. 실패한 단언을 지워 통과시키는 길이 여기서 닫힌다.
 * `kind` 는 `hashManifest` 가 이미 해시하므로 승인 묶임이 따라온다: 승인 뒤에 선언을 끌 수 없다.
 * 푸는 길은 셋 — ⑨ 에 그 파일을 가리키는 열린 계획 안 지적, 결과 미확인 회차의 수집 수정 1회(fix 는 없다),
 * 또는 계획 재승인(planHash 가 달라지면 증거가 통째로 무효라 동결도 함께 풀린다).
 */
function freezeReason(work: Work, stage: StageDef, path: string): string | undefined {
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (!evidence || !work.plan || evidence.planHash !== hashPlan(work.plan)) {
    return undefined;
  }
  const view = verifyView(work, evidence);
  const blocked = writeBlockReason({ state: view.state, emptyRound: view.emptyRound, budget: view.budget, path, questionsPath: questionsFile(work.active.id),
    reviewOpened: view.reviewOpened, reviewOpenFindings: view.reviewOpenFindings });
  if (blocked) return blocked;
  // 재현을 본 순간에도 언다 — 그때부터 단언을 약하게 하면 재현이 증거가 아니게 된다.
  // (`phase: "repro"` 로 기록하는 이유가 여기다. `test` 로 기록하면 재현에 실패했을 때
  //  재현 테스트를 고칠 길이 막혀 교착이 된다.)
  if (stage.kind === "test" && testFrozen(evidence)) {
    // 탈출구 — ⑨ 에 이 파일을 가리키는 열린 계획 안 지적이 있거나, 계획이 재승인되거나.
    // 앞의 것은 문서에 남는 지적이 열쇠라 몰래 풀 수 없다 (그 줄이 닫히기 전에는 리뷰 게이트가 막는다).
    if (findingOpensFile(work, path)) {
      return undefined;
    }
    // 결과 미확인 — 수집 수정 1회 동안 TC 이름을 고치는 자리다(그 회차는 고쳐 쓰기를 쓰지 않는다)
    if (collectWindowOpen(view)) {
      return undefined;
    }
    return (
      `테스트가 이미 돌아 얼어 있는 파일입니다: ${path} (단계 ${stage.key}, kind: test). ` +
      "테스트가 틀렸다고 판단되면 고치지 말고 근거와 함께 보고하세요 — 단언을 지워 통과시키는 길을 막는 자리입니다. " +
      "(재현을 본 뒤에는 재현 테스트가 얼립니다 — 그 단언을 약하게 하면 재현이 증거가 아니게 됩니다.) " +
      `정말 고쳐야 하면 ${workDocsDir(work.active.id)}/09-review.md 에 그 파일을 가리키는 지적으로 남기거나, ` +
      "계획을 고쳐 사람의 재승인을 받으세요." +
      (view.testState === "result-unconfirmed" && view.budget.collect.limit > 0 && view.budget.collect.left === 0
        ? " 결과가 일부 인식되지 않은 회차라면 수집 수정 1회 동안만 열리고, 그 회차는 이미 썼습니다."
        : "")
    );
  }
  return undefined;
}

/** stdin 으로 받아 stdout 으로 낸다. 판정 자체가 실패하면 exit 2 — 막는 쪽으로 닫는다 */
export function runHook(stdin: string): number {
  try {
    // Claude PreToolUse — 거부 문구는 Claude 표기다(같은 판정을 Codex 진입은 Codex 표기로 부른다)
    const reason = withNotation("claude", () => decide({ ...(JSON.parse(stdin) as HookInput), host: "claude" }, process.env.CLAUDE_PROJECT_DIR));
    if (reason) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `code-agent hook 이 판정에 실패해 막았습니다: ${error instanceof Error ? error.message : error}\n`,
    );
    return 2;
  }
}
