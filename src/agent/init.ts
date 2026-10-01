import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { assetBytes, assetKeys, assetText, CLAUDE_ASSETS, installedPath, packageVersion } from "./assets";
import { STATE_DIR } from "./layout";
import { applyModels } from "./models";
import { Stop } from "./stop";

const BLOCK_START = "<!-- code-agent:start -->";
const BLOCK_END = "<!-- code-agent:end -->";
const GITIGNORE_START = "# code-agent:start";
const GITIGNORE_END = "# code-agent:end";

/**
 * PreToolUse hook 이 받을 도구. 읽기 셋은 키 파일(`~/.code-agent/`) 하나를 닫으려고 넣는다 —
 * hook 의 읽기 분기는 여기에 없으면 불리지 않는다.
 */
export const HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob";

export interface InitOptions {
  /** hook 이 부를 CLI. 생략하면 PATH 의 code-agent — 개발 중에는 로컬 빌드를 가리킨다 */
  cli?: string;
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
    (hook) => /code-agent|agent[\\/]cli\.js/.test(hook.command) && new RegExp(` ${subcommand}$`).test(hook.command),
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
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    throw new Stop(
      `${path} 을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}\n  이 파일을 고친 뒤 다시 도세요.`,
    );
  }
}

function settingsFile(repoRoot: string): string {
  return join(repoRoot, ".claude", "settings.json");
}

/**
 * settings.json 이 깨져 있으면 그 사유, 멀쩡하면 undefined.
 *
 * `installedHook` 은 "항목이 없다" 와 "파일을 못 읽는다" 를 둘 다 undefined 로 돌려준다. 그것만 보면
 * doctor 가 `→ code-agent init` 을 처방하는데 그 init 은 같은 파일에서 멈춘다 — 그래서 doctor 는
 * hook 을 묻기 **전에** 이것을 먼저 묻는다.
 */
export function settingsProblem(repoRoot: string): string | undefined {
  try {
    readSettings(settingsFile(repoRoot));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
}

/** settings.json 에 설치된 우리 hook 명령. 없거나 파일이 깨졌으면 undefined (사유는 `settingsProblem`) */
export function installedHook(repoRoot: string, event: string, subcommand: string): string | undefined {
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(settingsFile(repoRoot));
  } catch {
    return undefined; // 사유는 doctor 가 `settingsProblem` 으로 따로 말한다
  }
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[] | undefined>;
  const entry = (hooks[event] ?? []).find((candidate) => ourEntry(candidate, subcommand));
  return entry?.hooks.find((hook) => new RegExp(` ${subcommand}$`).test(hook.command))?.command;
}

/**
 * 설치된 PreToolUse 항목의 matcher 가 넘기지 않는 도구 — 없으면 빈 목록.
 * matcher 가 없거나 `*` 면 전부 넘긴다. 옛 설치본(읽기 셋이 없는 matcher)을 doctor 가 짚는 자리다.
 */
export function unmatchedTools(repoRoot: string, event = "PreToolUse", expected = HOOK_MATCHER): string[] {
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(join(repoRoot, ".claude", "settings.json"));
  } catch {
    return [];
  }
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const entry = (hooks[event] ?? []).find((candidate) => ourEntry(candidate, event === "PreToolUse" ? "hook" : "review-event"));
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
    ...(hooks[event] ?? []).filter((entry) => !ours(entry)),
    { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] },
  ];
  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function init(repoRoot: string, options: InitOptions = {}): string {
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
  lines.push(`스킬·에이전트 ${keys.length}개: .claude/skills/ca-*, .claude/agents/ca-*`);
  // 템플릿은 전부 opus 다. 사람이 바꿔 둔 모델이 있으면 다시 설치해도 그대로 둔다.
  applyModels(repoRoot);

  const settings = settingsFile(repoRoot);
  upsertHook(settings, "PreToolUse", "hook", command, HOOK_MATCHER);
  // Stop hook — PreToolUse 가 못 보는 것(도구를 거치지 않고 생긴 파일·남은 질문)을 턴 끝에 한 번 본다
  upsertHook(settings, "Stop", "stop", invoke("stop"));
  upsertHook(settings, "SubagentStart", "review-event", invoke("review-event"), "ca-reviewer");
  upsertHook(settings, "SubagentStop", "review-event", invoke("review-event"), "ca-reviewer");
  lines.push(`hook: .claude/settings.json → PreToolUse ${command} · Stop ${invoke("stop")} · SubagentStart/Stop ${invoke("review-event")}`);

  const claude = upsertBlock(join(repoRoot, "CLAUDE.md"), BLOCK_START, BLOCK_END, assetText("template/CLAUDE.block.md"));
  lines.push(`CLAUDE.md: code-agent 블록 ${claude === "created" ? "생성" : "갱신"}`);

  upsertBlock(
    join(repoRoot, ".gitignore"),
    GITIGNORE_START,
    GITIGNORE_END,
    `${STATE_DIR}/active.json\n${STATE_DIR}/docs-session.json\n${STATE_DIR}/request-session.json\n${STATE_DIR}/log/`,
  );
  lines.push(".gitignore: 개인 진행 상태 제외 (.code-agent/active.json, docs-session.json, request-session.json, log/)");

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
