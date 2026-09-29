import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";

import { STATE_DIR } from "./layout";
import { applyModels } from "./models";

/** 이 패키지의 루트 — dist/agent/init.js 기준 두 단계 위 */
const PACKAGE_ROOT = join(__dirname, "..", "..");
const TEMPLATE_DIR = join(PACKAGE_ROOT, "template");

const BLOCK_START = "<!-- code-agent:start -->";
const BLOCK_END = "<!-- code-agent:end -->";
const GITIGNORE_START = "# code-agent:start";
const GITIGNORE_END = "# code-agent:end";

const HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash";

export interface InitOptions {
  /** hook 이 부를 CLI. 생략하면 PATH 의 code-agent — 개발 중에는 로컬 빌드를 가리킨다 */
  cli?: string;
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string }).version;
}

function copyTree(from: string, to: string, copied: string[], repoRoot: string): void {
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const target = join(to, name);
    if (statSync(source).isDirectory()) {
      copyTree(source, target, copied, repoRoot);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied.push(relative(repoRoot, target).replace(/\\/g, "/"));
  }
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
 * settings.json 의 다른 설정·다른 hook 은 그대로 두고 code-agent 항목만 하나로 맞춘다.
 *
 * 이벤트 이름을 받는 것은 P5 에서 Stop hook 이 늘었기 때문이다. 우리 것인지 가르는 규칙은
 * 서브명령 이름이다 — 이벤트마다 다른 서브명령을 부르므로 한쪽을 지우면서 다른 쪽을 지우지 않는다.
 */
function upsertHook(path: string, event: string, subcommand: string, command: string, matcher?: string): void {
  const settings = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>) : {};
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const ours = (entry: HookEntry) =>
    entry.hooks.some(
      (hook) => /code-agent|agent[\\/]cli\.js/.test(hook.command) && new RegExp(` ${subcommand}$`).test(hook.command),
    );
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

  const copied: string[] = [];
  copyTree(join(TEMPLATE_DIR, "claude"), join(repoRoot, ".claude"), copied, repoRoot);
  lines.push(`스킬·에이전트 ${copied.length}개: .claude/skills/ca-*, .claude/agents/ca-*`);
  // 템플릿은 전부 opus 다. 사람이 바꿔 둔 모델이 있으면 다시 설치해도 그대로 둔다.
  applyModels(repoRoot);

  const settings = join(repoRoot, ".claude", "settings.json");
  upsertHook(settings, "PreToolUse", "hook", command, HOOK_MATCHER);
  // Stop hook — PreToolUse 가 못 보는 것(도구를 거치지 않고 생긴 파일·남은 질문)을 턴 끝에 한 번 본다
  upsertHook(settings, "Stop", "stop", invoke("stop"));
  lines.push(`hook: .claude/settings.json → PreToolUse ${command} · Stop ${invoke("stop")}`);

  const claude = upsertBlock(
    join(repoRoot, "CLAUDE.md"),
    BLOCK_START,
    BLOCK_END,
    readFileSync(join(TEMPLATE_DIR, "CLAUDE.block.md"), "utf-8"),
  );
  lines.push(`CLAUDE.md: code-agent 블록 ${claude === "created" ? "생성" : "갱신"}`);

  upsertBlock(
    join(repoRoot, ".gitignore"),
    GITIGNORE_START,
    GITIGNORE_END,
    `${STATE_DIR}/active.json\n${STATE_DIR}/docs-session.json\n${STATE_DIR}/log/`,
  );
  lines.push(".gitignore: 개인 진행 상태 제외 (.code-agent/active.json, docs-session.json, log/)");

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
    hasManifest
      ? "  claude 를 열고 /ca-status 로 문서 상태를 확인하세요."
      : "  claude 를 열고 /ca-adopt 로 프로젝트를 도입하세요 (code-agent.json · 아키텍처 · 컨벤션).",
    "  설치된 파일(.claude/, CLAUDE.md, .code-agent/version)은 커밋해 팀과 공유합니다.",
  ].join("\n");
}
