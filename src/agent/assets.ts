import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import type { Dirent } from "fs";
import { join } from "path";

import { Stop } from "./stop";

/**
 * 템플릿(스킬·에이전트·CLAUDE 블록)을 읽는 **유일한 자리**.
 *
 * 두 모드가 있다. 단일 실행 파일(Node SEA)로 묶으면 패키지 폴더가 없고 파일이 실행 파일 안에
 * 들어 있다. npm 으로 설치하면 지금까지처럼 패키지 폴더에 있다. 부르는 쪽(init · update)이
 * 갈리지 않도록 **키를 패키지 루트 기준 `/` 상대경로**로 맞춘다 —
 * `template/claude/skills/ca-plan/SKILL.md` 는 두 모드에서 같은 문자열이다.
 */

/** `node:sea` 에서 우리가 쓰는 것만. Node 22 미만에는 이 모듈이 없다 */
interface SeaLike {
  isSea(): boolean;
  getAsset(key: string, encoding: "utf8"): string;
  getRawAsset(key: string): ArrayBuffer;
  getAssetKeys(): string[];
}

/**
 * 단일 실행 파일인데 자원을 읽을 수 없을 때의 사유. `getAssetKeys` 는 Node 24.8 에 들어왔다 —
 * 그보다 낮은 Node 로 만든 바이너리는 여기 걸린다.
 *
 * 모듈을 읽는 중에 던지면 스택만 나가므로 사유만 적어 두고 **자원을 실제로 읽는 자리**에서 던진다.
 */
let seaProblem: string | undefined;

/**
 * `node:sea` 를 **동적으로** 잡는다 — 없는 Node 에서 npm 모드가 죽으면 안 되고,
 * 번들러가 이 줄을 정적으로 풀어 버리면 SEA 밖에서 터진다(`--external:node:sea`).
 *
 * 돌려주는 것은 **쓸 수 있는 SEA 뿐**이다. "node:sea 가 없다"(→ 패키지 폴더에서 읽는다)와
 * "단일 실행 파일인데 자원 API 가 없다"(→ 패키지 폴더가 아예 없다)를 한 undefined 로 뭉치면
 * 뒤쪽이 실행 파일 두 단계 위를 읽으려다 맨 ENOENT 로 죽는다.
 */
function loadSea(): SeaLike | undefined {
  let module: Partial<SeaLike>;
  try {
    module = require("node:sea") as Partial<SeaLike>;
  } catch {
    return undefined; // node:sea 가 없는 Node — npm 모드다
  }
  if (typeof module.isSea !== "function" || !module.isSea()) {
    return undefined; // npm 설치 — 패키지 폴더에서 읽는다
  }
  if (typeof module.getAssetKeys !== "function" || typeof module.getAsset !== "function") {
    seaProblem =
      `이 단일 실행 파일은 node:sea.getAssetKeys 가 없는 Node ${process.version} 로 만들어졌습니다 (24.8 미만) — ` +
      "안에 든 템플릿을 읽을 수 없습니다. Node 24.8 이상에서 npm run build:bin 을 다시 돌리세요.";
    return undefined;
  }
  return module as SeaLike;
}

const sea = loadSea();

/** 이 패키지의 루트 — dist/agent/assets.js 기준 두 단계 위. SEA 에서는 쓰지 않는다 */
const PACKAGE_ROOT = join(__dirname, "..", "..");

/** 저장소에 설치되는 스킬·에이전트가 사는 자리 */
export const CLAUDE_ASSETS = "template/claude";

/** 단일 실행 파일로 도는가 — 자원을 못 읽는 바이너리도 단일 실행 파일이다 */
export function isPackaged(): boolean {
  return sea !== undefined || seaProblem !== undefined;
}

/** 자원을 읽기 전에 한 번. 못 읽는 바이너리는 여기서 한 문장으로 멈춘다 */
function usableSea(): SeaLike | undefined {
  if (seaProblem !== undefined) {
    throw new Stop(seaProblem);
  }
  return sea;
}

export function assetText(key: string): string {
  const module = usableSea();
  return module ? module.getAsset(key, "utf8") : readFileSync(join(PACKAGE_ROOT, ...key.split("/")), "utf-8");
}

/**
 * 바이트 그대로. 저장소에 **설치하는** 자리(`init`)는 이것을 쓴다 —
 * `assetText` 로 돌리면 언젠가 `template/claude` 아래 들어올 텍스트 아닌 파일(그림·PDF)이
 * utf-8 왕복에서 조용히 깨진다.
 */
export function assetBytes(key: string): Buffer {
  const module = usableSea();
  return module ? Buffer.from(module.getRawAsset(key)) : readFileSync(join(PACKAGE_ROOT, ...key.split("/")));
}

/** `prefix/` 로 시작하는 키를 정렬해서. 두 모드가 같은 목록을 돌려준다 */
/** 스킬·에이전트 수와 보조 문서 수 — 보조 문서(criteria·legacy·reference 등)는 스킬이 필요할 때 읽는 파일이다 */
export function assetCount(paths: string[]): string {
  const entries = paths.filter((path) => path.endsWith("/SKILL.md") || /(^|\/)agents\//.test(path)).length;
  return entries === paths.length ? `${entries}개` : `${entries}개 · 보조 문서 ${paths.length - entries}개`;
}

export function assetKeys(prefix: string): string[] {
  const module = usableSea();
  if (module) {
    return module.getAssetKeys().filter((key) => key.startsWith(`${prefix}/`)).sort();
  }
  const keys: string[] = [];
  walk(join(PACKAGE_ROOT, ...prefix.split("/")), prefix, keys);
  return keys.sort();
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const key = `${base}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), key, out);
    else out.push(key);
  }
}

export function packageVersion(): string {
  return (JSON.parse(assetText("package.json")) as { version: string }).version;
}

/** 번들 키를 저장소 안의 자리로 — `template/claude/agents/ca-x.md` → `<repo>/.claude/agents/ca-x.md` */
export function installedPath(repoRoot: string, key: string): string {
  return join(repoRoot, ".claude", ...key.slice(CLAUDE_ASSETS.length + 1).split("/"));
}

/**
 * 저장소에 깔려 있는데 **이 버전의 번들에는 없는** `ca-*` 파일 — 이름이 바뀌었거나 빠진 스킬·에이전트다.
 *
 * `init`·`update` 는 번들에 있는 키만 쓰므로 이런 파일은 영영 남고, Claude Code 는 계속 읽는다.
 * 지우지는 않는다 — 사람이 손으로 만든 `ca-` 스킬일 수도 있어 자동 삭제할 근거가 없다. 알리기만 한다.
 */
export function strayInstalled(repoRoot: string, keys: string[]): string[] {
  const known = new Set(keys.map((key) => installedPath(repoRoot, key)));
  const found: string[] = [];
  const scan = (dir: string, shown: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 아직 설치되지 않은 저장소
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path, `${shown}/${entry.name}`);
      else if (!known.has(path)) found.push(`${shown}/${entry.name}`);
    }
  };
  for (const area of ["skills", "agents"]) {
    const dir = join(repoRoot, ".claude", area);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // `ca-` 로 시작하는 것만 본다 — 저장소의 다른 스킬·에이전트는 우리 것이 아니다
    for (const entry of entries) {
      if (!entry.name.startsWith("ca-")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path, `.claude/${area}/${entry.name}`);
      else if (!known.has(path)) found.push(`.claude/${area}/${entry.name}`);
    }
  }
  return found.sort();
}

/**
 * 설치본과 번들을 견주는 해시.
 *
 * 줄바꿈(Windows 의 autocrlf)과 `model:` 줄은 내용이 아니라 설정이라 빼고 본다 —
 * `applyModels` 가 그 줄을 사람의 선택대로 다시 쓰므로, 넣으면 모델을 바꾼 저장소가 영영 "다름" 이 된다.
 */
export function templateHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^model:.*$/m, "model:");
  return createHash("sha256").update(normalized, "utf-8").digest("hex").slice(0, 16);
}
