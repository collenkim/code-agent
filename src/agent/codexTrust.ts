/**
 * Codex 프로젝트 신뢰·hook 신뢰 점검(doctor) — `CODEX_HOME/config.toml`(없으면 `~/.codex/config.toml`)을 **읽기만** 한다.
 *
 * Codex 의 프로젝트 hook(`.codex/hooks.json`)은 프로젝트 신뢰(`[projects.'<경로>'] trust_level = "trusted"`)와 hook 검토·신뢰가
 * 둘 다 있어야 돈다. 신뢰되지 않은 hook 을 `codex exec` 는 알리지 않고 건너뛴다(codex-cli 0.161.0, 2026-10-08 실측). 프로젝트 신뢰의
 * 꼴은 실측이다 — Windows 는 경로를 소문자·역슬래시로 적는다. 실측한 항목은 모두 저장소 경로 자체였고, 상위 폴더의 신뢰를 Codex 가
 * 그 안의 저장소에 적용하는지는 확인하지 못했다 — 그래서 저장소 자체의 항목만 신뢰로 보고 상위 폴더 항목만 있으면 '확인 필요'(parent)로 둔다.
 * hook 신뢰는 바이너리 문자열(`hooks.state."…".trusted_hash`)로만 확인했고 키의 꼴은 확인하지 못했다 —
 * 그래서 기록을 찾으면 알리고, 못 찾으면 '확인 필요' 로 둔다(없다고 단정하지 않는다). 기록은 저장소 경로로 시작하는 키만 본다 — 다른 꼴이면
 * 못 찾은 것('확인 필요')이 되어 안전한 쪽이고, 형제 저장소의 기록을 이 저장소의 것으로 알리지 않는다.
 */
import { existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export interface CodexTrust {
  /** parent — 상위 폴더 항목만 있다(Codex 가 적용하는지 확인하지 못했다 — doctor 는 ✓ 로 보지 않는다) */
  project: "trusted" | "parent" | "untrusted" | "missing" | "no-config" | "unreadable";
  projectText: string;
  hooks: "recorded" | "unknown";
  hooksText: string;
}

/** 경로 비교 꼴 — 구분자를 `/` 로, 대소문자를 접고, 끝 구분자를 뗀다(Codex 는 Windows 경로를 소문자로 적는다) */
const fold = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const QUOTED = String.raw`'([^']*)'|"((?:[^"\\]|\\.)*)"`;
/** TOML 의 따옴표 키 — '리터럴' 은 그대로, "기본" 은 `\\`·`\"` 만 푼다 */
const unquote = (literal: string | undefined, basic: string | undefined): string =>
  literal !== undefined ? literal : (basic ?? "").replace(/\\(["\\])/g, "$1");

export function codexConfigPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml");
}

/** 저장소 루트와 그 상위 폴더(실제 경로) — 가까운 것부터. 첫 원소가 저장소 자체다 */
function candidates(repoRoot: string): string[] {
  let current: string;
  try { current = realpathSync.native(repoRoot); } catch { current = resolve(repoRoot); }
  const list: string[] = [];
  for (;;) {
    list.push(fold(current));
    const parent = dirname(current);
    if (parent === current) return list;
    current = parent;
  }
}

export function codexTrust(repoRoot: string, env: Readonly<Record<string, string | undefined>> = process.env): CodexTrust {
  const config = codexConfigPath(env);
  const unknownHooks = "확인 필요 — Codex 대화형 세션의 'Hooks need review' 화면에서 이 저장소의 hook 을 검토·신뢰하세요(.codex/hooks.json 이 바뀌면 다시 검토합니다). " +
    "codex exec 는 신뢰되지 않은 hook 을 알리지 않고 건너뜁니다";
  if (!existsSync(config)) {
    return { project: "no-config", projectText: `${config} 가 없습니다 — 이 PC 에서 Codex 를 열어 이 저장소를 신뢰하기 전에는 프로젝트 hook 이 돌지 않습니다`, hooks: "unknown", hooksText: unknownHooks };
  }
  let text: string;
  try { text = readFileSync(config, "utf8"); } catch (error) {
    return { project: "unreadable", projectText: `${config} 를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, hooks: "unknown", hooksText: unknownHooks };
  }
  const projects = new Map<string, { key: string; trust?: string }>();
  const hookKeys: string[] = [];
  let table: { key: string; trust?: string } | undefined, inHooks = false;
  const header = new RegExp(String.raw`^\s*\[\s*projects\s*\.\s*(?:${QUOTED})\s*\]\s*(?:#.*)?$`);
  for (const line of text.split(/\r?\n/)) {
    const project = header.exec(line);
    if (project) {
      const key = unquote(project[1], project[2]);
      table = { key };
      projects.set(fold(key), table);
      inHooks = false;
      continue;
    }
    if (/^\s*\[/.test(line)) { table = undefined; inHooks = /^\s*\[\s*hooks\s*\.\s*state\b/.test(line); }
    const trust = table && new RegExp(String.raw`^\s*trust_level\s*=\s*(?:${QUOTED})`).exec(line);
    if (table && trust) table.trust = unquote(trust[1], trust[2]);
    // hook 신뢰 기록 — [hooks.state."…"] 표 머리·그 표 안의 줄·점 키(hooks.state."…".trusted_hash = …)의 따옴표 문자열을 모은다
    if (inHooks || /\bhooks\s*\.\s*state\b/.test(line)) {
      for (const match of line.matchAll(new RegExp(QUOTED, "g"))) hookKeys.push(fold(unquote(match[1], match[2])));
    }
  }
  const roots = candidates(repoRoot);
  const own = projects.get(roots[0]);
  const found = own ?? roots.slice(1).map((root) => projects.get(root)).find((entry) => entry !== undefined);
  const where = `${config} 의 [projects.'${found?.key ?? ""}']`;
  const project: CodexTrust["project"] = !found ? "missing" : !own ? "parent" : found.trust === "trusted" ? "trusted" : "untrusted";
  const projectText = project === "trusted" ? `${where} trust_level = "trusted"`
    : project === "untrusted" ? `${where} trust_level = "${found?.trust ?? "(없음)"}" — 신뢰하지 않은 프로젝트에서는 프로젝트 hook·설정이 꺼집니다`
    : project === "parent" ? `확인 필요 — 상위 폴더 항목 ${where} trust_level = "${found?.trust ?? "(없음)"}" 만 있습니다. Codex 가 상위 폴더 신뢰를 이 저장소에 ` +
      "적용하는지 확인하지 못했습니다 — 이 저장소를 직접 신뢰하세요(신뢰되지 않으면 codex exec 는 프로젝트 hook 을 알리지 않고 건너뜁니다)"
    : `${config} 에 이 저장소의 신뢰 항목이 없습니다 — 신뢰 전에는 프로젝트 hook·설정이 꺼집니다`;
  // 키가 이 저장소 경로이거나 그 아래 경로(`<저장소>/.codex/hooks.json:…`)로 시작할 때만 — 앞부분이 같은 형제 저장소(`<저장소>-old`)는 아니다
  const recorded = hookKeys.some((key) => key === roots[0] || key.startsWith(`${roots[0]}/`));
  return { project, projectText, hooks: recorded ? "recorded" : "unknown",
    hooksText: recorded ? `${config} 에 이 저장소의 hook 신뢰 기록(hooks.state)이 있습니다 — .codex/hooks.json 이 바뀌면 Codex 가 다시 검토를 요구합니다` : unknownHooks };
}
