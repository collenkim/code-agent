import { existsSync, readdirSync, statSync } from "fs";
import { extname, join, posix } from "path";

import { collectExemplars } from "../core/exemplar";
import { loadManifest } from "../core/manifest";

/**
 * 뼈대 역공학의 **결정론적인 절반** — 저장소를 얕게 훑어 사실만 뽑는다.
 *
 * 모델에게 "저장소를 살펴봐"라고 시키면 첫 도구 호출이 `Glob **\/*` 가 되고, `.git` 과 빌드 산출물까지
 * 컨텍스트에 쏟는다(스파이크에서 봤다). 빌드 파일·언어·디렉토리 모양·계층 후보·표본 경로는 코드가 세면 되고,
 * 서브에이전트는 여기서 짚어 준 표본만 읽으면 된다.
 */
const SKIP = new Set([
  ".git", "node_modules", "build", "target", "dist", "out", ".gradle", ".idea", ".vscode", "bin", "obj",
  ".code-agent", ".claude", "vendor", "venv", ".venv", "__pycache__", "coverage", ".next", "generated",
]);

const BUILD_FILES = [
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew",
  "package.json", "tsconfig.json", "pyproject.toml", "requirements.txt", "setup.py", "go.mod", "Cargo.toml",
  "composer.json", "Gemfile", "Makefile", "Dockerfile", "docker-compose.yml",
];

const SOURCE_EXT = new Set([".java", ".kt", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".cs", ".php", ".rb", ".scala", ".vue"]);

const MAX_FILES = 20000;

interface Entry {
  path: string;
  dir: string;
  ext: string;
}

function walk(repoRoot: string): { files: Entry[]; truncated: boolean } {
  const files: Entry[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(join(repoRoot, dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = dir ? posix.join(dir, name) : name;
      let stat;
      try {
        stat = statSync(join(repoRoot, path));
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!SKIP.has(name) && !name.startsWith(".")) stack.push(path);
        continue;
      }
      files.push({ path, dir, ext: extname(name).toLowerCase() });
      if (files.length >= MAX_FILES) return { files, truncated: true };
    }
  }
  return { files, truncated: false };
}

function isTest(path: string): boolean {
  return /(^|\/)(src\/test|tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path) || /Tests?\.(java|kt)$/.test(path);
}

export function survey(repoRoot: string): string {
  const { files, truncated } = walk(repoRoot);
  const sources = files.filter((file) => SOURCE_EXT.has(file.ext));
  const out: string[] = ["# 뼈대 역공학 — 저장소 개요 (code-agent survey)", ""];
  if (truncated) out.push(`> 파일이 ${MAX_FILES}개를 넘어 앞부분만 셌습니다.`, "");

  const builds = files.filter((file) => BUILD_FILES.includes(posix.basename(file.path)) && file.path.split("/").length <= 3);
  out.push("## 빌드·설정 파일 (깊이 3까지)", ...(builds.length ? builds.map((file) => `- ${file.path}`) : ["- 없음"]), "");

  const byExt = new Map<string, number>();
  for (const file of sources) byExt.set(file.ext, (byExt.get(file.ext) ?? 0) + 1);
  out.push(
    "## 언어 (소스 파일 수)",
    ...[...byExt.entries()].sort((a, b) => b[1] - a[1]).map(([ext, count]) => `- ${ext}: ${count}`),
    `- 전체 파일 ${files.length}개 중 소스 ${sources.length}개, 테스트 ${sources.filter((file) => isTest(file.path)).length}개`,
    "",
  );

  // 소스가 있는 디렉토리 — 한 줄에 파일 수. 너무 많으면 소스가 많은 순으로.
  const dirs = new Map<string, number>();
  for (const file of sources) dirs.set(file.dir, (dirs.get(file.dir) ?? 0) + 1);
  const dirRows = [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const shownDirs = dirRows.length > 80 ? [...dirRows].sort((a, b) => b[1] - a[1]).slice(0, 80).sort((a, b) => a[0].localeCompare(b[0])) : dirRows;
  out.push(`## 소스 디렉토리 (${dirRows.length}개${dirRows.length > shownDirs.length ? `, 파일이 많은 ${shownDirs.length}개만` : ""})`);
  out.push(...shownDirs.map(([dir, count]) => `- ${dir || "."} (${count})`), "");

  // 계층 후보 — 소스가 놓인 디렉토리의 마지막 이름. 도메인 → 계층 구조면 같은 이름이 여러 도메인에 반복된다.
  const leaf = new Map<string, { dirs: Set<string>; files: string[] }>();
  for (const file of sources.filter((entry) => !isTest(entry.path))) {
    const name = posix.basename(file.dir);
    if (!name) continue;
    const slot = leaf.get(name) ?? { dirs: new Set(), files: [] };
    slot.dirs.add(file.dir);
    slot.files.push(file.path);
    leaf.set(name, slot);
  }
  const layers = [...leaf.entries()].filter(([, slot]) => slot.dirs.size >= 2).sort((a, b) => b[1].dirs.size - a[1].dirs.size).slice(0, 15);
  out.push("## 계층 후보 (여러 디렉토리에 반복되는 이름)");
  out.push(...(layers.length ? layers.map(([name, slot]) => `- ${name}: 디렉토리 ${slot.dirs.size}개, 파일 ${slot.files.length}개`) : ["- 반복되는 이름 없음 — 계층형 구조가 아닐 수 있습니다"]), "");

  // 표본 — 계층마다 2개. 서브에이전트가 이것만 읽으면 규약을 뽑을 수 있게.
  out.push("## 표본 (계층 후보마다 2개 — 역공학은 이 파일들부터 읽는다)");
  for (const [name, slot] of layers.slice(0, 8)) {
    out.push(`- ${name}: ${slot.files.sort().slice(0, 2).join(", ")}`);
  }
  const tests = sources.filter((file) => isTest(file.path)).map((file) => file.path).sort();
  if (tests.length) out.push(`- 테스트: ${tests.slice(0, 3).join(", ")}`);
  out.push("");

  const docs = files.filter((file) => file.ext === ".md" && (!file.path.includes("/") || /^(doc|docs)\//.test(file.path))).map((file) => file.path);
  out.push("## 이미 있는 문서", ...(docs.length ? docs.slice(0, 30).map((path) => `- ${path}`) : ["- 없음"]));
  if (docs.length > 30) out.push(`- … 외 ${docs.length - 30}개`);
  return out.join("\n");
}

/** 도입한 매니페스트가 실제 저장소와 맞는가 — 참조 도메인과 단계별 참조 파일을 찾아 본다 */
export function manifestCheck(repoRoot: string): { text: string; ok: boolean } {
  const manifest = loadManifest(repoRoot);
  const out = ["code-agent.json 형식: 통과", ""];
  let failed = false;
  if (!manifest.referenceDomain) {
    out.push("참조 도메인: 없음 — exemplars 를 선언한 단계는 참조 표준 없이 돌게 됩니다");
  }
  for (const stage of manifest.stages) {
    if (stage.exemplars.length === 0 || !manifest.referenceDomain) {
      out.push(`- ${stage.key}: 참조 파일 선언 없음`);
      continue;
    }
    try {
      const found = collectExemplars(repoRoot, manifest, manifest.referenceDomain, stage);
      const ok = found.files.length > 0;
      failed ||= !ok;
      out.push(
        `- ${ok ? "✓" : "✗"} ${stage.key}: 참조 파일 ${found.files.length}개` +
          (found.missing.length ? ` · 못 찾음 ${found.missing.join(", ")}` : ""),
      );
    } catch (error) {
      failed = true;
      out.push(`- ✗ ${stage.key}: ${error instanceof Error ? error.message : error}`);
    }
  }
  for (const [name, argv] of [["build", manifest.build], ["test", manifest.test]] as const) {
    if (argv && !existsSync(join(repoRoot, argv[0])) && !/^[a-z]+$/.test(argv[0])) {
      out.push(`- 확인: ${name} 명령의 실행 파일이 저장소에 없습니다: ${argv[0]}`);
    }
  }
  out.push("", failed ? "✗ 참조 파일을 못 찾는 단계가 있습니다 — 경로·{Ref}·referenceDomain 을 고치세요." : "✓ 모든 단계가 참조 파일을 찾습니다.");
  return { text: out.join("\n"), ok: !failed };
}
