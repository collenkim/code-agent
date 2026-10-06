import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { assetBytes, assetCount, assetKeys, assetText, CLAUDE_ASSETS, installedPath, packageVersion } from "./assets";
import { STATE_DIR } from "./layout";
import { applyModels } from "./models";
import { Stop } from "./stop";
import { hookFile, Host, HostSelection, hostAssets, selectedHosts } from "./hosts";

const BLOCK_START = "<!-- code-agent:start -->";
const BLOCK_END = "<!-- code-agent:end -->";
const GITIGNORE_START = "# code-agent:start";
const GITIGNORE_END = "# code-agent:end";

/**
 * PreToolUse hook 이 받을 도구. 읽기 셋은 키 파일(`~/.code-agent/`) 하나를 닫으려고 넣는다 —
 * hook 의 읽기 분기는 여기에 없으면 불리지 않는다.
 */
export const HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob";

export interface InitOptions {
  /** hook 이 부를 CLI. 생략하면 PATH 의 code-agent — 개발 중에는 로컬 빌드를 가리킨다 */
  cli?: string;
  host?: HostSelection;
}

/** 표시된 블록만 넣거나 바꾼다. 블록 밖은 사람의 것이라 건드리지 않는다 */
function upsertBlock(path: string, start: string, end: string, body: string): "created" | "updated" {
  const block = `${start}\n${body.trim()}\n${end}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${block}\n`);
    return "created";
  }
  const text = readFileSync(path, "utf-8");
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  const next =
    from >= 0 && to > from
      ? text.slice(0, from) + block + text.slice(to + end.length)
      : `${text.replace(/\s*$/, "")}\n\n${block}\n`;
  writeFileSync(path, next);
  return "updated";
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

/**
 * 우리 항목인지 가르는 규칙은 **서브명령 이름**이다 — 이벤트마다 다른 서브명령을 부르므로
 * 한쪽을 지우면서 다른 쪽을 지우지 않는다. `doctor` · `update` 가 읽을 때도 같은 규칙을 쓴다.
 */
function ourEntry(entry: HookEntry, subcommand: string): boolean {
  return entry.hooks.some(
    (hook) => hook.type === "command" && typeof hook.command === "string" && /code-agent|agent[\\/]cli\.js/.test(hook.command) && new RegExp(` ${subcommand}$`).test(hook.command),
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
function upsertHook(path: string, event: string, subcommand: string, command: string, matcher?: string): void {
  const settings = readSettings(path);
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const ours = (entry: HookEntry) => ourEntry(entry, subcommand);
  hooks[event] = [
    ...(hooks[event] ?? []).flatMap((entry) => {
      if (!ours(entry)) return [entry];
      const remaining = entry.hooks.filter(hook => !ourEntry({hooks:[hook]}, subcommand));
      return remaining.length ? [{...entry, hooks:remaining}] : [];
    }),
    { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] },
  ];
  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function init(repoRoot: string, options: InitOptions = {}): string {
  const hosts = selectedHosts(repoRoot, options.host);
  // 검증을 먼저 끝내어 깨진 사용자 설정을 덮어쓰지 않는다.
  for (const host of hosts) readSettings(settingsFile(repoRoot, host));
  const previous = existsSync(join(repoRoot, STATE_DIR, "hosts.json")) ? selectedHosts(repoRoot) :
    installedHook(repoRoot, "PreToolUse", "hook") ? ["claude" as Host] : [];
  const results = hosts.map(host => host === "claude" ? initClaude(repoRoot, options) : initCodex(repoRoot, options));
  mkdirSync(join(repoRoot, STATE_DIR), {recursive: true});
  writeFileSync(join(repoRoot, STATE_DIR, "hosts.json"), JSON.stringify([...new Set([...previous, ...hosts])]) + "\n");
  return results.join("\n\n");
}

export function codexMatcherProblem(repoRoot: string, event: string): string | undefined {
  const settings = readSettings(settingsFile(repoRoot, "codex"));
  const entries = (settings.hooks as Record<string, HookEntry[]> | undefined)?.[event] ?? [];
  const entry = entries.find(candidate => ourEntry(candidate, "codex-event"));
  return entry?.matcher && entry.matcher !== "*" ? "Codex 공통 훅의 matcher가 이벤트 범위를 제한하고 있습니다." : undefined;
}

function initCodex(repoRoot: string, options: InitOptions): string {
  for (const [file, text] of hostAssets("codex", repoRoot)) {
    const target = join(repoRoot, file);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, text);
  }
  const command = options.cli ? `node "${options.cli.replace(/\\/g, "/")}" codex-event` : "code-agent codex-event";
  for (const event of ["PreToolUse", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop"]) {
    upsertHook(settingsFile(repoRoot, "codex"), event, "codex-event", command);
  }
  upsertBlock(join(repoRoot, "AGENTS.md"), BLOCK_START, BLOCK_END, assetText("template/CODEX.block.md"));
  upsertBlock(join(repoRoot, ".gitignore"), GITIGNORE_START, GITIGNORE_END,
    `${STATE_DIR}/active.json\n${STATE_DIR}/docs-session.json\n${STATE_DIR}/request-session.json\n${STATE_DIR}/log/\n${STATE_DIR}/consents/`);
  mkdirSync(join(repoRoot, STATE_DIR), {recursive: true});
  writeFileSync(join(repoRoot, STATE_DIR, "version"), `${packageVersion()}\n`);
  return ["Codex용 code-agent를 설치했습니다.",
    "  스킬 18개: .agents/skills/ca-* · 에이전트 8개: .codex/agents/ca-*.toml",
    "  훅 5종: .codex/hooks.json · 지침: AGENTS.md · 모델·추론 강도: 역할별 제품 기본값과 사용자 변경값",
    "  code-agent model --host codex로 역할별 설정을 확인하고 변경할 수 있습니다.",
    "  Codex를 다시 열고 프로젝트 훅을 검토·신뢰한 뒤 $ca-request로 시작하세요.",
    "  승인 응답은 ca-answer가 안내하는 사용자 대화 메시지로 관찰합니다.",
    "  설치는 Codex를 실행하거나 훅을 자동 신뢰하지 않습니다. code-agent doctor --host codex로 파일을 점검하세요.",
  ].join("\n");
}

function initClaude(repoRoot: string, options: InitOptions = {}): string {
  const lines: string[] = [];
  const invoke = (subcommand: string): string =>
    options.cli ? `node "${options.cli.replace(/\\/g, "/")}" ${subcommand}` : `code-agent ${subcommand}`;
  const command = invoke("hook");

  // 파일이 아니라 자원(asset)에서 설치한다 — 단일 실행 파일에는 패키지 폴더가 없다
  const keys = assetKeys(CLAUDE_ASSETS);
  for (const key of keys) {
    const target = installedPath(repoRoot, key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, assetBytes(key));
  }
  lines.push(`스킬·에이전트 ${assetCount(keys)}: .claude/skills/ca-*, .claude/agents/ca-*`);
  // 템플릿은 전부 opus 다. 사람이 바꿔 둔 모델이 있으면 다시 설치해도 그대로 둔다.
  applyModels(repoRoot);

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
    `${STATE_DIR}/active.json\n${STATE_DIR}/docs-session.json\n${STATE_DIR}/request-session.json\n${STATE_DIR}/log/\n${STATE_DIR}/consents/`,
  );
  lines.push(".gitignore: 개인 진행 상태·세션 확인 제외 (.code-agent/active.json, docs-session.json, request-session.json, log/, consents/)");

  mkdirSync(join(repoRoot, STATE_DIR), { recursive: true });
  const version = packageVersion();
  writeFileSync(join(repoRoot, STATE_DIR, "version"), `${version}\n`);
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
