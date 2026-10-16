import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { writeIfChanged } from "../core/atomic";
import { assetBytes, assetCount, assetKeys, assetText, CLAUDE_ASSETS, installedPath, packageVersion } from "./assets";
import { STATE_DIR } from "./layout";
import { applyModels, policySummary } from "./models";
import { readClaudeOverrides, readCodexOverrides } from "./modelPolicy";
import { Stop } from "./stop";
import { crossNotice, hookFile, Host, HostSelection, hostAssets, selectedHosts } from "./hosts";
import { runtimeHost } from "./crossEnv";
import { checkChoiceConfig, installChoiceConfig } from "./choiceConfig";

const BLOCK_START = "<!-- code-agent:start -->";
const BLOCK_END = "<!-- code-agent:end -->";
const GITIGNORE_START = "# code-agent:start";
const GITIGNORE_END = "# code-agent:end";
/**
 * .gitignore 블록 — 개인 진행 상태·세션·동의 기록·작업 임대(lease.json·잠금)·이 PC 의 적용 버전(runtime.json·잠금)·보존한 사본 대신 둔
 * 번들 내용. 두 호스트 설치가 같은 블록을 쓴다
 */
const GITIGNORE_LINES = ["active.json", "docs-session.json", "request-session.json", "log/", "consents/", "lease.json*", "runtime.json", "runtime.lock",
  "template-conflicts/", "graph/"].map((line) => `${STATE_DIR}/${line}`).join("\n");

/**
 * PreToolUse hook 이 받을 도구. 읽기 셋은 키 파일(`~/.code-agent/`) 하나를 닫으려고 넣는다 —
 * hook 의 읽기 분기는 여기에 없으면 불리지 않는다. `mcp__.*` 는 경로 인자가 있는 MCP 도구를 같은 규칙으로 판정한다.
 */
export const HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob|mcp__.*";

/** Claude 에 설치하는 hook — (이벤트, 하위 명령). doctor·설치 감지가 같은 목록을 쓴다 */
export const CLAUDE_HOOKS = [
  ["PreToolUse", "hook"], ["PreToolUse", "consent-event"], ["PostToolUse", "consent-event"], ["Stop", "stop"],
  ["SubagentStart", "review-event"], ["SubagentStop", "review-event"], ["SubagentStart", "planning-event"], ["SubagentStop", "planning-event"],
  ["SessionStart", "session-event"],
] as const;
/** Codex 에 설치하는 이벤트(모두 codex-event). SessionStart 는 작업 임대를 새 세션으로 넘겨받는다(Claude session-event 와 같은 규칙) */
export const CODEX_EVENTS = ["PreToolUse", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "SessionStart"] as const;

export interface InitOptions {
  /** hook 이 부를 CLI. 생략하면 PATH 의 code-agent — 개발 중에는 로컬 빌드를 가리킨다 */
  cli?: string;
  host?: HostSelection;
  /** 쓰지 않을 사본(저장소 기준 `/` 경로) — 사람이 고친 스킬·에이전트를 버전 적용이 보존할 때(runtimeApply.ts) */
  preserve?: ReadonlySet<string>;
  /** 다시 설치(update) — 처음 설치의 '다시 열고 훅을 신뢰' 안내를 빼고, 다시 열지는 바뀐 종류대로 따로 말한다(runtimeApply.hostGuidance) */
  refresh?: boolean;
}

/** 표시된 블록만 넣거나 바꾼다. 블록 밖은 사람의 것이라 건드리지 않는다 */
function upsertBlock(path: string, start: string, end: string, body: string): "created" | "updated" {
  const block = `${start}\n${body.trim()}\n${end}`;
  if (!existsSync(path)) {
    writeIfChanged(path, `${block}\n`);
    return "created";
  }
  const text = readFileSync(path, "utf-8");
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  const next =
    from >= 0 && to > from
      ? text.slice(0, from) + block + text.slice(to + end.length)
      : `${text.replace(/\s*$/, "")}\n\n${block}\n`;
  writeIfChanged(path, next);
  return "updated";
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; commandWindows?: string }[];
}

/**
 * 우리 항목인지 가르는 규칙은 **서브명령 이름**이다 — 이벤트마다 다른 서브명령을 부르므로
 * 한쪽을 지우면서 다른 쪽을 지우지 않는다. `doctor` · `update` 가 읽을 때도 같은 규칙을 쓴다.
 */
function ourEntry(entry: HookEntry, subcommand: string): boolean {
  return entry.hooks.some(
    // Codex PreToolUse 는 비Windows 명령에 ` || exit 2` 를 붙여 설치한다 — 그 꼴도 우리 항목이다
    (hook) => hook.type === "command" && typeof hook.command === "string" && /code-agent|agent[\\/]cli\.js/.test(hook.command) && new RegExp(` ${subcommand}(?: \\|\\| exit 2)?$`).test(hook.command),
  );
}

/**
 * 깨진 JSON 은 **던진다** — 조용히 `{}` 로 보면 `upsertHook` 이 사람의 다른 hook·설정을 통째로
 * 날려 쓴다. settings.json 은 우리만 쓰는 파일이 아니다.
 */
function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const settings = JSON.parse(readFileSync(path, "utf-8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("설정은 JSON 객체여야 합니다.");
    if (settings.hooks !== undefined) {
      if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) throw new Error("hooks는 객체여야 합니다.");
      for (const entries of Object.values(settings.hooks)) {
        if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== "object" || !Array.isArray(entry.hooks) || entry.hooks.some((hook: unknown) => !hook || typeof hook !== "object"))) throw new Error("훅 항목 형식이 잘못되었습니다.");
      }
    }
    return settings;
  } catch (error) {
    throw new Stop(
      `${path} 을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}\n  이 파일을 고친 뒤 다시 도세요.`,
    );
  }
}

function settingsFile(repoRoot: string, host: Host = "claude"): string {
  return hookFile(repoRoot, host);
}

/**
 * settings.json 이 깨져 있으면 그 사유, 멀쩡하면 undefined.
 *
 * `installedHook` 은 "항목이 없다" 와 "파일을 못 읽는다" 를 둘 다 undefined 로 돌려준다. 그것만 보면
 * doctor 가 `→ code-agent init` 을 처방하는데 그 init 은 같은 파일에서 멈춘다 — 그래서 doctor 는
 * hook 을 묻기 **전에** 이것을 먼저 묻는다.
 */
export function settingsProblem(repoRoot: string, host: Host = "claude"): string | undefined {
  try {
    readSettings(settingsFile(repoRoot, host));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
}

/** settings.json 에 설치된 우리 hook 명령. 없거나 파일이 깨졌으면 undefined (사유는 `settingsProblem`) */
export function installedHook(repoRoot: string, event: string, subcommand: string, host: Host = "claude"): string | undefined {
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(settingsFile(repoRoot, host));
  } catch {
    return undefined; // 사유는 doctor 가 `settingsProblem` 으로 따로 말한다
  }
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[] | undefined>;
  const entry = (hooks[event] ?? []).find((candidate) => ourEntry(candidate, subcommand));
  return entry?.hooks.find((hook) => ourEntry({hooks:[hook]}, subcommand))?.command;
}

/** 설치된 Codex 우리 항목의 Windows 명령(commandWindows). 없거나 파일이 깨졌으면 undefined */
function installedCodexWindows(repoRoot: string, event: string): string | undefined {
  let settings: Record<string, unknown>;
  try { settings = readSettings(settingsFile(repoRoot, "codex")); } catch { return undefined; }
  const entries = ((settings.hooks ?? {}) as Record<string, HookEntry[] | undefined>)[event] ?? [];
  return entries.flatMap((entry) => entry.hooks).find((hook) => ourEntry({ hooks: [hook] }, "codex-event"))?.commandWindows;
}
/**
 * Codex 우리 항목의 Windows 명령이 이 버전이 설치하는 꼴(codexWindowsCommand)과 다르면 그 사유 — 같으면 undefined.
 * --cli 는 설치된 command(`node "<경로>" codex-event`)에서 되찾는다(update 의 승계와 같다). commandWindows 가 없으면 Codex 는 command 를
 * 그대로 PowerShell 로 돌리므로 그 command 가 기대하는 꼴과 같으면 문제가 아니다(--cli 설치의 Stop·Subagent·SessionStart). 사유는 이벤트별이다 —
 * 종료 코드를 넘겨야 하는 이벤트(PreToolUse·UserPromptSubmit)는 종료 코드, --cli 없는 설치는 npm 의 code-agent.ps1 과 실행 정책이다
 */
export function codexWindowsProblem(repoRoot: string, event: (typeof CODEX_EVENTS)[number]): string | undefined {
  const command = installedHook(repoRoot, event, "codex-event", "codex");
  if (command === undefined) return undefined;
  const cli = /^node\s+"([^"]+)"/.exec(command)?.[1];
  const expected = codexWindowsCommand(event, cli), installed = installedCodexWindows(repoRoot, event);
  if ((installed ?? command) === expected) return undefined;
  const reasons = [
    ...(event === "PreToolUse" || event === "UserPromptSubmit" ? ["Windows PowerShell 이 종료 코드를 바꿔 막아야 할 실패가 통과할 수 있습니다"] : []),
    ...(cli ? [] : ["PowerShell 이 npm 의 code-agent.ps1 을 골라 실행 정책(Restricted 등)에 따라 hook 이 돌지 않을 수 있습니다"]),
  ];
  return `Windows 명령(commandWindows)이 이 버전의 꼴과 다릅니다(${installed === undefined ? "없음" : installed}) — ${reasons.length ? reasons.join(" · ") : "이 버전이 설치하는 명령과 다르게 돕니다"}`;
}

/**
 * 설치된 PreToolUse 항목의 matcher 가 넘기지 않는 도구 — 없으면 빈 목록.
 * matcher 가 없거나 `*` 면 전부 넘긴다. 옛 설치본(읽기 셋이 없는 matcher)을 doctor 가 짚는 자리다.
 */
export function unmatchedTools(repoRoot: string, event = "PreToolUse", expected = HOOK_MATCHER, requestedSubcommand?: string): string[] {
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(join(repoRoot, ".claude", "settings.json"));
  } catch {
    return [];
  }
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const subcommand = requestedSubcommand ?? (event === "PostToolUse" ? "consent-event" : event === "PreToolUse" && expected === "AskUserQuestion" ? "consent-event" : event === "PreToolUse" ? "hook" : "review-event");
  const entry = (hooks[event] ?? []).find((candidate) => ourEntry(candidate, subcommand));
  if (!entry || !entry.matcher || entry.matcher === "*") return [];
  const covered = entry.matcher.split("|").map((tool) => tool.trim());
  return expected.split("|").filter((tool) => !covered.includes(tool));
}

/**
 * settings.json 의 다른 설정·다른 hook 은 그대로 두고 code-agent 항목만 하나로 맞춘다.
 *
 * 이벤트 이름을 받는 것은 P5 에서 Stop hook 이 늘었기 때문이다.
 */
function upsertHook(path: string, event: string, subcommand: string, command: string, matcher?: string, extra: { commandWindows?: string } = {}): void {
  const settings = readSettings(path);
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const ours = (entry: HookEntry) => ourEntry(entry, subcommand);
  hooks[event] = [
    ...(hooks[event] ?? []).flatMap((entry) => {
      if (!ours(entry)) return [entry];
      const remaining = entry.hooks.filter(hook => !ourEntry({hooks:[hook]}, subcommand));
      return remaining.length ? [{...entry, hooks:remaining}] : [];
    }),
    { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, ...(extra.commandWindows ? { commandWindows: extra.commandWindows } : {}) }] },
  ];
  settings.hooks = hooks;
  writeIfChanged(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * 아무것도 쓰기 전에 사람의 설정 파일을 모두 읽어 본다 — hook 설정과 역할 모델 설정(`models.json`·`codex-models.json`).
 * 깨진 hook 설정을 덮어쓰지 않고, 모델 설정에서 멈출 때 스킬·에이전트만 번들로 덮인 반쯤 설치된 상태를 남기지 않는다.
 * 모델 설정은 형식까지 검사하므로 이전 버전이 그대로 쓰던 손 입력 값(대문자 별칭 등)도 여기서 멈춘다. update 는 호스트마다
 * init 을 부르므로 시작할 때 설치된 호스트 전부로 한 번 부른다.
 */
export function requireInstallSettings(repoRoot: string, hosts: readonly Host[]): void {
  for (const host of hosts) {
    readSettings(settingsFile(repoRoot, host));
    if (host === "claude") readClaudeOverrides(repoRoot);
    else { readCodexOverrides(repoRoot); checkChoiceConfig(repoRoot); }
  }
}

export function init(repoRoot: string, options: InitOptions = {}): string {
  const hosts = selectedHosts(repoRoot, options.host);
  // 검증을 먼저 끝내어 깨진 사용자 설정을 덮어쓰지 않는다.
  requireInstallSettings(repoRoot, hosts);
  const previous = existsSync(join(repoRoot, STATE_DIR, "hosts.json")) ? selectedHosts(repoRoot) :
    installedHook(repoRoot, "PreToolUse", "hook") ? ["claude" as Host] : [];
  const results = hosts.map(host => host === "claude" ? initClaude(repoRoot, options) : initCodex(repoRoot, options));
  writeIfChanged(join(repoRoot, STATE_DIR, "hosts.json"), JSON.stringify([...new Set([...previous, ...hosts])]) + "\n");
  // 두 호스트를 함께 깔면 교차 검증이 붙는다 — 둘 다 실행할 수 있을 때만 쓰도록 지금 상태를 알린다
  const cross = crossNotice(repoRoot);
  return [...results, ...(cross ? [cross] : [])].join("\n\n");
}

export function codexMatcherProblem(repoRoot: string, event: string): string | undefined {
  const settings = readSettings(settingsFile(repoRoot, "codex"));
  const entries = (settings.hooks as Record<string, HookEntry[]> | undefined)?.[event] ?? [];
  const entry = entries.find(candidate => ourEntry(candidate, "codex-event"));
  return entry?.matcher && entry.matcher !== "*" ? "Codex 공통 훅의 matcher가 이벤트 범위를 제한하고 있습니다." : undefined;
}

/**
 * Windows 의 Codex hook 명령(commandWindows) — Codex 는 이것을 `powershell.exe -NoProfile -Command "<명령>"` 으로 돌린다(0.161.0 실측).
 * Windows PowerShell 5.1 은 마지막 네이티브 명령의 exit 2 를 1 로 바꿔 내므로 종료 코드를 그대로 넘겨야 할 이벤트는 직접 넘긴다:
 * PreToolUse 는 실패(0 이 아님·node 없음)를 2 로 닫고, UserPromptSubmit 은 `$LASTEXITCODE` 를 넘긴다(동의 응답 실패 2 는 막고, node 가 없으면 0·
 * cli 가 없으면 1 이라 깨진 설치가 사용자 메시지를 막지 않는다). Stop·Subagent 이벤트는 JSON 과 0 이 정상이고 실패도 막지 않으므로 넘기지 않는다.
 * --cli 가 없으면 `cmd /c code-agent` 로 부른다 — PowerShell 은 PATH 의 npm 셋(.ps1·.cmd·sh) 중 code-agent.ps1 을 골라 실행 정책 Restricted 에서
 * 막히지만 cmd 는 PATHEXT(.exe·.cmd)로 푼다(stdin·stdout·종료 코드는 그대로 지난다).
 */
export function codexWindowsCommand(event: (typeof CODEX_EVENTS)[number], cli?: string): string {
  const base = cli ? `node "${cli.replace(/\\/g, "/")}" codex-event` : "cmd /c code-agent codex-event";
  if (event === "PreToolUse") return `${base}; if ($LASTEXITCODE -ne 0) { exit 2 }`;
  if (event === "UserPromptSubmit") return `${base}; exit $LASTEXITCODE`;
  return base;
}

function initCodex(repoRoot: string, options: InitOptions): string {
  installChoiceConfig(repoRoot, options.cli);
  const assets = hostAssets("codex", repoRoot);
  for (const [file, text] of assets) {
    if (options.preserve?.has(file)) continue;
    writeIfChanged(join(repoRoot, file), text);
  }
  const command = options.cli ? `node "${options.cli.replace(/\\/g, "/")}" codex-event` : "code-agent codex-event";
  for (const event of CODEX_EVENTS) {
    // PreToolUse 만 프로세스 실패(모듈 로드 전 종료·PATH 누락)를 막는 쪽으로 닫는다(비Windows 셸 `|| exit 2`). UserPromptSubmit 은 감싸지 않는다 —
    // 설치가 깨지면 사용자가 아무 말도 못 하게 된다. Windows 명령은 codexWindowsCommand 다(PowerShell 의 종료 코드·실행 정책)
    upsertHook(settingsFile(repoRoot, "codex"), event, "codex-event", event === "PreToolUse" ? `${command} || exit 2` : command, undefined,
      { commandWindows: codexWindowsCommand(event, options.cli) });
  }
  upsertBlock(join(repoRoot, "AGENTS.md"), BLOCK_START, BLOCK_END, assetText("template/CODEX.block.md"));
  upsertBlock(join(repoRoot, ".gitignore"), GITIGNORE_START, GITIGNORE_END, GITIGNORE_LINES);
  writeIfChanged(join(repoRoot, STATE_DIR, "version"), `${packageVersion()}\n`);
  // 수는 실제로 쓴 자원에서 센다(DOC-14 — 스킬·에이전트를 더하거나 빼도 문구가 낡지 않게)
  const paths = [...assets.keys()].map((file) => file.replace(/\\/g, "/"));
  const skills = new Set(paths.map((file) => /^\.agents\/skills\/([^/]+)\//.exec(file)?.[1]).filter(Boolean)).size;
  const agents = paths.filter((file) => /^\.codex\/agents\/[^/]+\.toml$/.test(file)).length;
  return ["Codex용 code-agent를 설치했습니다.",
    `  스킬 ${skills}개: .agents/skills/ca-* · 에이전트 ${agents}개: .codex/agents/ca-*.toml`,
    `  훅 ${CODEX_EVENTS.length}종: .codex/hooks.json · 지침: AGENTS.md · 모델·추론 강도: 역할별 제품 기본값과 사용자 변경값`,
    "  code-agent model --host codex로 역할별 설정을 확인하고 변경할 수 있습니다.",
    ...(options.refresh ? [] : ["  Codex를 다시 열고 프로젝트 훅을 검토·신뢰한 뒤 $ca-request로 시작하세요."]),
    "  선택 UI: .codex/config.toml의 code_agent MCP — 업무 질문과 동의를 방향키·Enter로 선택합니다.",
    "  설치는 Codex를 실행하거나 훅을 자동 신뢰하지 않습니다. code-agent doctor --host codex로 파일을 점검하세요.",
  ].join("\n");
}

/**
 * 설치된 호스트(hosts.json)마다 빠진 hook — 문제가 있는 호스트만. hosts.json 이 없거나 읽지 못하면 빈 목록(doctor 가 따로 알린다).
 * 설정 파일이 깨졌으면 그 사유 한 줄이다.
 */
export function hookInstallProblems(repoRoot: string): { host: Host; problems: string[] }[] {
  if (!existsSync(join(repoRoot, STATE_DIR, "hosts.json"))) return [];
  let hosts: Host[];
  try { hosts = selectedHosts(repoRoot); } catch { return []; }
  const result: { host: Host; problems: string[] }[] = [];
  for (const host of hosts) {
    const broken = settingsProblem(repoRoot, host);
    const problems = broken ? [broken]
      : host === "claude" ? CLAUDE_HOOKS.filter(([event, subcommand]) => !installedHook(repoRoot, event, subcommand)).map(([event, subcommand]) => `Claude ${event}(${subcommand})`)
      : CODEX_EVENTS.filter((event) => !installedHook(repoRoot, event, "codex-event", "codex")).map((event) => `Codex ${event}`);
    if (problems.length) result.push({ host, problems });
  }
  return result;
}
/** SessionStart·status·시작 명령이 붙이는 경고 문장 — 빠진 hook 이 없으면 undefined */
export function hookInstallWarning(repoRoot: string, problems = hookInstallProblems(repoRoot)): string | undefined {
  if (!problems.length) return undefined;
  return `code-agent hook 설정이 빠져 있습니다: ${problems.flatMap((entry) => entry.problems).join(" · ")} — 이 상태에서는 쓰기 판정·동의 관찰이 꺼집니다. ` +
    "사람에게 code-agent init(또는 doctor)으로 복구하도록 알리세요. 더 쓰지 않는 호스트라면 사람이 .code-agent/hosts.json 에서 그 이름을 빼면 됩니다.";
}
const HOST_LABEL: Record<Host, string> = { claude: "Claude Code", codex: "Codex" };
/**
 * start·request begin·docs begin 의 시작 게이트 — **실행 중인 호스트**(셸 환경 표지, runtimeHost)의 hook 이 빠졌으면 시작하지 않는다.
 * 다른 설치 호스트의 누락과 판별 불가(사람의 터미널 등)는 막지 않고 경고 문장을 돌려준다(출력 끝에 붙인다). 진행 중인 작업은 막지 않는다.
 */
export function requireStartHooks(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const problems = hookInstallProblems(repoRoot);
  if (!problems.length) return undefined;
  const running = runtimeHost(env);
  const own = running ? problems.find((entry) => entry.host === running) : undefined;
  if (own) {
    throw new Stop(`이 호스트(${HOST_LABEL[own.host]})의 hook 설정이 빠져 있어 시작하지 않습니다 — ${own.problems.join(" · ")}. hook 이 없으면 쓰기 판정·동의 관찰이 꺼집니다. 사람이 code-agent init --host ${own.host}(또는 doctor)로 복구한 뒤 다시 시작하세요.`);
  }
  return `경고: ${hookInstallWarning(repoRoot, problems)}`;
}

function initClaude(repoRoot: string, options: InitOptions = {}): string {
  const lines: string[] = [];
  const invoke = (subcommand: string): string =>
    options.cli ? `node "${options.cli.replace(/\\/g, "/")}" ${subcommand}` : `code-agent ${subcommand}`;
  const command = invoke("hook");

  // 파일이 아니라 자원(asset)에서 설치한다 — 단일 실행 파일에는 패키지 폴더가 없다
  const keys = assetKeys(CLAUDE_ASSETS);
  for (const key of keys) {
    if (options.preserve?.has(`.claude/${key.slice(CLAUDE_ASSETS.length + 1)}`)) continue;
    writeIfChanged(installedPath(repoRoot, key), assetBytes(key));
  }
  lines.push(`스킬·에이전트 ${assetCount(keys)}: .claude/skills/ca-*, .claude/agents/ca-*`);
  // 템플릿 머리말은 제품 기본값(ROLE_POLICY)이다. 사람이 바꿔 둔 모델·강도가 있으면 다시 설치해도 그대로 바른다.
  applyModels(repoRoot);
  lines.push(`모델·추론 강도: ${policySummary(repoRoot, "claude")} — code-agent model 로 확인·변경`);

  const settings = settingsFile(repoRoot);
  upsertHook(settings, "PreToolUse", "hook", command, HOOK_MATCHER);
  upsertHook(settings, "PreToolUse", "consent-event", invoke("consent-event"), "AskUserQuestion");
  upsertHook(settings, "PostToolUse", "consent-event", invoke("consent-event"), "AskUserQuestion");
  // Stop hook — PreToolUse 가 못 보는 것(도구를 거치지 않고 생긴 파일·남은 질문)을 턴 끝에 한 번 본다
  upsertHook(settings, "Stop", "stop", invoke("stop"));
  upsertHook(settings, "SubagentStart", "review-event", invoke("review-event"), "ca-reviewer");
  upsertHook(settings, "SubagentStop", "review-event", invoke("review-event"), "ca-reviewer");
  upsertHook(settings, "SubagentStart", "planning-event", invoke("planning-event"), "ca-analyst|ca-explorer|ca-writer|ca-critic");
  upsertHook(settings, "SubagentStop", "planning-event", invoke("planning-event"), "ca-analyst|ca-explorer|ca-writer|ca-critic");
  // 시작·재개·비우기·압축 뒤 진행 상태를 붙인다 — 대화 요약이 단계·동의를 잃어도 상태 파일에서 다시 잡는다
  upsertHook(settings, "SessionStart", "session-event", invoke("session-event"));
  lines.push(`hook: .claude/settings.json → PreToolUse ${command} · 질문 Pre/PostToolUse ${invoke("consent-event")} · Stop ${invoke("stop")} · SubagentStart/Stop ${invoke("review-event")} · 계획 SubagentStart/Stop ${invoke("planning-event")} · SessionStart ${invoke("session-event")}`);

  const claude = upsertBlock(join(repoRoot, "CLAUDE.md"), BLOCK_START, BLOCK_END, assetText("template/CLAUDE.block.md"));
  lines.push(`CLAUDE.md: code-agent 블록 ${claude === "created" ? "생성" : "갱신"}`);

  upsertBlock(
    join(repoRoot, ".gitignore"),
    GITIGNORE_START,
    GITIGNORE_END,
    GITIGNORE_LINES,
  );
  lines.push(".gitignore: 개인 진행 상태·세션 확인 제외 (.code-agent/active.json, docs-session.json, request-session.json, log/, consents/, lease.json, runtime.json, template-conflicts/)");

  const version = packageVersion();
  writeIfChanged(join(repoRoot, STATE_DIR, "version"), `${version}\n`);
  lines.push(`버전 고정: ${STATE_DIR}/version = ${version}`);

  const hasManifest = existsSync(join(repoRoot, "code-agent.json"));
  return [
    `code-agent 를 설치했습니다 — ${repoRoot}`,
    ...lines.map((line) => `  - ${line}`),
    "",
    "다음:",
    "  init은 설치만 합니다. 서버나 Claude Code를 실행하지 않습니다.",
    "  이 프로젝트에서 claude 를 실행한 뒤 /ca-request <요구사항> 으로 시작하세요 (ID 생략 가능).",
    "  스킬·서브에이전트는 프로젝트 설정에서 읽습니다. 별도 에이전트 등록은 필요 없습니다.",
    hasManifest
      ? "  기존 설정을 재사용합니다. 진행 중인 접수·작업은 /ca-status 확인 후 /ca-next 로 이어가세요."
      : "  접수 원문을 보관한 뒤 /ca-adopt · /ca-docs 로 공통 문서와 설정을 준비합니다.",
    "  설치된 파일(.claude/, CLAUDE.md, .code-agent/version)은 커밋해 팀과 공유합니다.",
  ].join("\n");
}
