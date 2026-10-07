import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { assetCount, assetKeys, CLAUDE_ASSETS, installedPath, packageVersion, strayInstalled, templateHash } from "./assets";
import { init, installedHook, requireInstallSettings } from "./init";
import type { InitOptions } from "./init";
import { loadActive, PHASES, STATE_DIR } from "./layout";
import { AGENTS, installedClaudeModel } from "./models";
import { claudeModelOf, isClaudeOverride, modelLabel, TIER_DEFAULTS } from "./modelPolicy";
import { hostAssets, selectedHosts } from "./hosts";

// The CLI opts into source updates; update() remains the local template-copy API.
export { previewSourceUpdate, sourceUpdateSnapshot, updateFromSource } from "./sourceUpdate";
export type { SourceUpdateOptions } from "./sourceUpdate";

/**
 * `code-agent update` — 지금 도는 버전의 스킬·에이전트·hook 을 다시 설치한다.
 *
 * 보존은 **새로 짜지 않는다** — `init` 이 이미 하고 있다(settings.json 은 우리 항목만 교체, CLAUDE.md·
 * .gitignore 는 표시 블록만, `models.json` 오버라이드는 `applyModels` 가 다시 바른다). 여기서 하는 일은
 * 넷뿐이다: 설치된 모든 호스트의 설정을 쓰기 전에 읽어 보고, `--cli` 를 승계하고, init 을 부르고,
 * **무엇이 바뀌었는지** 앞뒤를 견줘 말한다.
 * 정의 파일의 model·effort 는 전후를 견줘 따로 보고한다 — 원인(손 수정·기본값 변경·받은 설정)은 가리지 않는다.
 *
 * TTY 는 필요 없다 — 사람의 판정이 아니라 파일 복사다.
 */

/** 진행 중인 작업이 있어도 **막지 않는다** — 아래 주석의 근거를 보라 */
const MIDWAY: readonly string[] = PHASES.slice(PHASES.indexOf("implement"), PHASES.indexOf("integrate") + 1);

const BLOCK_FILES = [".claude/settings.json", "CLAUDE.md", ".gitignore"] as const;

function readIfAny(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

function hashOf(path: string): string | undefined {
  const text = readIfAny(path);
  return text === undefined ? undefined : templateHash(text);
}

function installedVersion(repoRoot: string): string | undefined {
  return readIfAny(join(repoRoot, STATE_DIR, "version"))?.trim();
}

/** `node "<경로>" hook` 에서 경로를 되찾는다 — 없으면 PATH 의 code-agent 를 쓰던 설치다 */
function inheritedCli(command: string | undefined): string | undefined {
  return command === undefined ? undefined : /^\S+\s+"([^"]+)"/.exec(command)?.[1];
}

function list(paths: string[]): string {
  return paths.slice(0, 5).join(" · ") + (paths.length > 5 ? ` (+${paths.length - 5})` : "");
}

export function update(repoRoot: string, options: InitOptions = {}): string {
  const hosts = selectedHosts(repoRoot, options.host);
  // 호스트마다 init 을 따로 부르므로 시작 전에 모든 호스트의 설정을 한 번 읽는다 — 뒤 호스트에서 멈추면 앞 호스트만 갱신된다
  requireInstallSettings(repoRoot, hosts);
  return hosts.map(host => {
    if (host === "claude") return updateClaude(repoRoot, {...options, host});
    const assets = hostAssets("codex", repoRoot);
    const changed = [...assets].filter(([path, text]) => readIfAny(join(repoRoot, path)) !== text).map(([path]) => path);
    const cli = options.cli ?? inheritedCli(installedHook(repoRoot, "PreToolUse", "codex-event", "codex"));
    const result = init(repoRoot, {host, cli});
    return `${result}\n  번들 변경 ${changed.length}개${changed.length ? `: ${list(changed)}` : ""}\n  기존 사용자 설정·진행 상태를 유지했습니다. 설치된 스킬·에이전트의 수동 수정은 번들로 덮어씁니다.`;
  }).join("\n\n");
}

function updateClaude(repoRoot: string, options: InitOptions): string {
  const version = packageVersion();
  const keys = assetKeys(CLAUDE_ASSETS);
  const before = new Map(keys.map((key) => [key, hashOf(installedPath(repoRoot, key))]));
  const beforeVersion = installedVersion(repoRoot);
  const beforeFiles = new Map(BLOCK_FILES.map((file) => [file, readIfAny(join(repoRoot, file))]));
  const active = loadActive(repoRoot);
  const beforeModels = new Map(AGENTS.map((agent) => [agent, installedClaudeModel(repoRoot, agent)]));

  // `--cli` 승계. 주지 않았는데 지금 hook 이 `node "<경로>"` 꼴이면 그 경로를 그대로 쓴다 —
  // `upsertHook` 은 우리 항목을 걷어내고 새로 넣으므로, 승계하지 않으면 개발용 설치가
  // 조용히 `code-agent hook` 으로 갈아 끼워진다.
  const cli = options.cli ?? inheritedCli(installedHook(repoRoot, "PreToolUse", "hook"));
  init(repoRoot, {cli, host: "claude"});

  const shown = (key: string) => `.claude/${key.slice(CLAUDE_ASSETS.length + 1)}`;
  const added = keys.filter((key) => before.get(key) === undefined);
  const changed = keys.filter((key) => {
    const was = before.get(key);
    return was !== undefined && was !== hashOf(installedPath(repoRoot, key));
  });
  // 손으로 고쳐 둔 것의 근사: **같은 버전인데** 내용이 달랐던 파일. 이전 버전의 번들 해시가 남아 있지
  // 않아 이보다 정확히는 가릴 수 없다 — 버전이 올랐으면 템플릿이 바뀐 것과 구분되지 않는다.
  const handmade = beforeVersion === version ? changed : [];
  // templateHash 는 머리말의 model·effort 줄을 빼고 보므로 그 줄의 변화는 여기서 따로 센다. 손으로 고친 값을 되돌렸는지,
  // 기본값이 바뀌었는지, 다른 사람이 커밋한 models.json 을 받았는지는 가릴 수 없어 전후 값만 말한다.
  const label = (config: { model?: string; effort?: string }) => `${config.model ?? "(없음)"}${config.effort ? `/${config.effort}` : ""}`;
  const rewritten = AGENTS.flatMap((agent) => {
    const was = beforeModels.get(agent), now = installedClaudeModel(repoRoot, agent);
    return was && now && (was.model !== now.model || was.effort !== now.effort) ? [{ agent, was, now }] : [];
  });
  // 이전 번들 기본값 꼴(opus·강도 없음)이던 역할 중 사용자 변경값이 없는 것 — 이번 버전의 역할별 기본값을 받았다
  const legacy = rewritten.filter(({ agent, was }) => was.model === "opus" && was.effort === undefined && !isClaudeOverride(repoRoot, agent));
  const overrides = AGENTS.filter((agent) => isClaudeOverride(repoRoot, agent));
  // 이 버전이 더는 담지 않는 `ca-*`. 쓰지 않는 키는 건드리지 않으니 영영 남고 Claude Code 는 계속 읽는다.
  // 지우지는 않는다 — 사람이 만든 `ca-` 스킬과 가릴 수 없다.
  const stray = strayInstalled(repoRoot, keys);

  const lines = [
    added.length > 0 ? `스킬·에이전트 ${added.length}개 추가: ${list(added.map(shown))}` : undefined,
    changed.length > 0 ? `스킬·에이전트 ${changed.length}개 갱신: ${list(changed.map(shown))}` : undefined,
    added.length === 0 && changed.length === 0 ? `스킬·에이전트 ${assetCount(keys)} 그대로` : undefined,
    ...BLOCK_FILES.map((file) => {
      const same = beforeFiles.get(file) === readIfAny(join(repoRoot, file));
      const detail =
        file === ".claude/settings.json"
          ? ` (PreToolUse ${installedHook(repoRoot, "PreToolUse", "hook")} · 질문 PreToolUse ${installedHook(repoRoot, "PreToolUse", "consent-event")} · 질문 PostToolUse ${installedHook(repoRoot, "PostToolUse", "consent-event")} · Stop ${installedHook(repoRoot, "Stop", "stop")} · SubagentStart ${installedHook(repoRoot, "SubagentStart", "review-event")} · SubagentStop ${installedHook(repoRoot, "SubagentStop", "review-event")} · 계획 SubagentStart ${installedHook(repoRoot, "SubagentStart", "planning-event")} · 계획 SubagentStop ${installedHook(repoRoot, "SubagentStop", "planning-event")} · SessionStart ${installedHook(repoRoot, "SessionStart", "session-event")})`
          : "";
      return `${file}: ${same ? "그대로" : "갱신"}${detail}`;
    }),
    rewritten.length > 0
      ? `에이전트 모델·추론 강도 ${rewritten.length}개를 설정대로 다시 썼습니다: ${list(rewritten.map(({ agent, was, now }) => `${agent} ${label(was)} → ${label(now)}`))} — 기준: .code-agent/models.json(없는 역할은 역할 기본값)`
      : undefined,
    legacy.length > 0
      ? `그중 ${legacy.length}개는 이전 번들 기본값(opus·강도 없음)이던 정의 파일입니다 — 이번 버전의 역할별 기본값` +
        `(판단 ${modelLabel(TIER_DEFAULTS.judgment.claude)} · 실행 ${modelLabel(TIER_DEFAULTS.execution.claude)})을 적용했습니다. ` +
        "이전 값이 필요하면 모델 변경을 요청하세요(수동 TTY: code-agent model <역할> <모델> --host claude --effort <강도>)"
      : undefined,
    overrides.length > 0
      ? `에이전트 모델 오버라이드 ${overrides.length}개 유지: ${overrides.map((agent) => `${agent}=${modelLabel(claudeModelOf(repoRoot, agent))}`).join(" · ")}`
      : undefined,
    `${STATE_DIR}/version = ${version}`,
  ].filter((line): line is string => line !== undefined);

  return [
    beforeVersion && beforeVersion !== version
      ? `code-agent 를 ${beforeVersion} → ${version} 으로 갱신했습니다 — ${repoRoot}`
      : `code-agent ${version} 을 다시 설치했습니다 — ${repoRoot}`,
    ...lines.map((line) => `  - ${line}`),
    ...(stray.length > 0
      ? [
          `  !! 이 버전에 없는 스킬·에이전트 ${stray.length}개가 남아 있습니다: ${list(stray)}`,
          "     (이름이 바뀌었거나 빠진 것입니다. Claude Code 는 계속 읽으니 필요 없으면 손으로 지우세요 —",
          "      사람이 만든 ca- 스킬과 가릴 수 없어 자동으로 지우지 않습니다)",
        ]
      : []),
    ...(handmade.length > 0
      ? [
          `  !! 손으로 고쳐 두었던 파일을 덮어썼습니다: ${list(handmade.map(shown))}`,
          "     (같은 버전인데 내용이 달랐던 파일입니다. 스킬·에이전트는 템플릿 사본이라 갱신이 덮어씁니다 —",
          "      프로젝트 규칙은 CLAUDE.md 의 블록 밖이나 doc/ 에 두세요)",
        ]
      : []),
    // 막지 않고 알리기만 한다. 템플릿은 *지침*이고 게이트는 *코드*다 — 승인·증거는 planHash·
    // hashManifest·트리 해시에 묶여 있어 스킬 파일이 바뀌어도 통과가 되살아나지 않는다.
    // 거부하면 긴 작업 중에 버그 수정 배포를 받지 못한다.
    ...(active && MIDWAY.includes(active.phase)
      ? [
          `  !! 진행 중인 작업이 있습니다 (${active.id} · ${active.phase}${active.stage ? `/${active.stage}` : ""}).`,
          "     절차 문구가 바뀌었을 수 있으니 지금 스테이지 스킬을 /ca-status 로 다시 확인하세요.",
          "     승인·증거는 해시에 묶여 있어 갱신으로 무효가 되지 않습니다.",
        ]
      : []),
    "",
    "  갱신된 파일을 커밋해 팀과 공유하세요.",
  ].join("\n");
}
