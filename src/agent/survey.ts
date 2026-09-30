import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { extname, join, posix } from "path";

import { collectExemplars } from "../core/exemplar";
import { loadManifest } from "../core/manifest";
import { KINDS } from "../core/workOrder";
import { stageTestRoots } from "./evidence";

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

/**
 * 도구 후보 — 테스트 전략과 품질·보안 기준 두 문서가 같은 것(빌드 파일·CI 설정)을 읽으므로
 * 코드가 한 번 세서 둘이 나눠 쓴다. 모델에게 세게 하면 실행마다 결과가 달라진다.
 */
const TOOL_HINTS: { group: string; name: string; pattern: RegExp }[] = [
  { group: "테스트", name: "JUnit 5", pattern: /junit-jupiter|junit5/i },
  { group: "테스트", name: "JUnit 4", pattern: /junit:junit|junit4/i },
  { group: "테스트", name: "Mockito", pattern: /mockito/i },
  { group: "테스트", name: "AssertJ", pattern: /assertj/i },
  { group: "테스트", name: "Spring Boot Test", pattern: /spring-boot-starter-test/i },
  { group: "테스트", name: "Testcontainers", pattern: /testcontainers/i },
  { group: "테스트", name: "REST Assured", pattern: /rest-assured/i },
  { group: "테스트", name: "Jest", pattern: /"jest"|\bjest\b/i },
  { group: "테스트", name: "Vitest", pattern: /vitest/i },
  { group: "테스트", name: "Playwright", pattern: /playwright/i },
  { group: "테스트", name: "Cypress", pattern: /cypress/i },
  { group: "테스트", name: "pytest", pattern: /pytest/i },
  { group: "정적 분석", name: "Checkstyle", pattern: /checkstyle/i },
  { group: "정적 분석", name: "PMD", pattern: /\bpmd\b/i },
  { group: "정적 분석", name: "SpotBugs", pattern: /spotbugs/i },
  { group: "정적 분석", name: "Error Prone", pattern: /errorprone|error_prone/i },
  { group: "정적 분석", name: "JaCoCo", pattern: /jacoco/i },
  { group: "정적 분석", name: "Spotless", pattern: /spotless/i },
  { group: "정적 분석", name: "SonarQube", pattern: /sonarqube|sonarcloud/i },
  { group: "정적 분석", name: "ESLint", pattern: /eslint/i },
  { group: "정적 분석", name: "Biome", pattern: /biome/i },
  { group: "정적 분석", name: "Ruff", pattern: /\bruff\b/i },
  { group: "정적 분석", name: "flake8", pattern: /flake8/i },
  { group: "정적 분석", name: "mypy", pattern: /mypy/i },
  { group: "보안", name: "FindSecBugs", pattern: /findsecbugs/i },
  { group: "보안", name: "OWASP Dependency-Check", pattern: /dependency-?check/i },
  { group: "보안", name: "npm audit", pattern: /npm audit/i },
  { group: "보안", name: "pip-audit", pattern: /pip-audit/i },
  { group: "보안", name: "Bandit", pattern: /bandit/i },
  { group: "보안", name: "비밀정보 검사(gitleaks·trufflehog)", pattern: /gitleaks|trufflehog/i },
  { group: "보안", name: "Snyk", pattern: /snyk/i },
];

/** CI 설정은 walk 가 보지 않는다(점으로 시작하는 디렉토리) — 실제로 도는 명령의 1순위 근거라 따로 찾는다 */
function ciFiles(repoRoot: string): string[] {
  const workflows = ".github/workflows";
  const found = existsSync(join(repoRoot, workflows))
    ? readdirSync(join(repoRoot, workflows)).filter((name) => /\.ya?ml$/.test(name)).sort().map((name) => posix.join(workflows, name))
    : [];
  return [...found, ...["Jenkinsfile", ".gitlab-ci.yml"].filter((path) => existsSync(join(repoRoot, path)))];
}

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
  // 빌드 파일을 빈 저장소 판정보다 **먼저** 센다 — 그 판정이 이것을 함께 본다
  const builds = files.filter((file) => BUILD_FILES.includes(posix.basename(file.path)) && file.path.split("/").length <= 3);
  const out: string[] = ["# 뼈대 역공학 — 저장소 개요 (code-agent survey)", ""];
  if (truncated) out.push(`> 파일이 ${MAX_FILES}개를 넘어 앞부분만 셌습니다.`, "");
  // 신규(빈) 저장소인지는 **코드가 판정한다** — 모델이 숫자를 눈대중해 실행마다 다른 길로 가지 않게.
  // 다만 "소스 0개" 는 SOURCE_EXT 가 아는 확장자로만 센 것이라, 목록 밖 언어(C·C++·Swift·Dart·Elixir…)로
  // 가득 찬 저장소도 0개로 나온다. 빌드 파일까지 없을 때만 "빈 저장소" 라고 단정하고, 아니면
  // **무엇을 쟀는지** 그대로 적어 스킬이 사람에게 확인하고 갈라지게 한다.
  if (sources.length === 0) {
    out.push(
      builds.length === 0
        ? "> **소스 파일이 없습니다 — 신규(빈) 저장소입니다.** 역공학할 것이 없으므로 문서와 code-agent.json 을 인터뷰로 만듭니다."
        : `> **code-agent 가 아는 확장자의 소스 파일이 없습니다 — 신규(빈) 저장소이거나 지원 목록 밖 언어입니다.** ` +
            `빌드·설정 파일은 ${builds.length}개 있습니다(아래). 인터뷰로 가기 전에 코드가 실재하는지 사람에게 확인하세요 ` +
            `(아는 확장자: ${[...SOURCE_EXT].join(" ")}).`,
      "> 정할 것: 언어 · 소스 루트(domainBase) · 단계 목록(key · title · outputDirs · kind) · build · test · prepare 명령 · git.base",
      "",
    );
  }

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

  // 도구 후보 — 빌드 파일과 CI 설정에 이름이 나오는 것만. 이름이 나온다고 도는 것은 아니므로 '후보'다
  const scanned = [...builds.map((file) => file.path), ...ciFiles(repoRoot)];
  const hits = new Map<string, string[]>();
  for (const path of scanned) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, path), "utf-8");
    } catch {
      continue;
    }
    for (const hint of TOOL_HINTS) {
      if (hint.pattern.test(text)) hits.set(`${hint.group}\u0000${hint.name}`, [...(hits.get(`${hint.group}\u0000${hint.name}`) ?? []), path]);
    }
  }
  out.push("## 도구 후보 (테스트 전략 · 품질·보안 기준의 근거 — 이름이 적힌 파일까지)");
  for (const group of ["테스트", "정적 분석", "보안"]) {
    const rows = [...hits.entries()].filter(([key]) => key.startsWith(`${group}\u0000`));
    out.push(`- ${group}: ${rows.length ? rows.map(([key, paths]) => `${key.split("\u0000")[1]} (${paths.join(", ")})`).join(", ") : "없음"}`);
  }
  const ci = ciFiles(repoRoot);
  out.push(`- CI 설정: ${ci.length ? ci.join(", ") : "없음"}`, "");

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
  // 종류마다 도는 단계가 있는가. 여기서 말해 주지 않으면 fix 지시서로 start 할 때 처음 알게 된다.
  // failed 는 건드리지 않는다 — 경고이지 형식 오류가 아니다(종료 코드 0 유지).
  for (const kind of KINDS) {
    const running = manifest.stages.filter((stage) => stage.kinds.length === 0 || stage.kinds.includes(kind));
    if (running.length === 0) {
      out.push(`- 확인: ${kind} 로 돌 단계가 없습니다 — stages[].kinds 에 "${kind}" 를 더하거나 kinds 를 비우세요 (비면 모든 종류)`);
      continue;
    }
    if (!running.some((stage) => stage.kind === "test")) {
      out.push(
        `- 확인: ${kind} 에 kind:"test" 단계가 없습니다 — 테스트 동결이 걸리지 않습니다` +
          (kind === "fix" ? " (fix 는 재현 테스트를 넣을 자리가 없어 plan submit 이 거부합니다)" : ""),
      );
    }
  }
  // kind:"test" 단계가 제 자리를 밝히지 않으면 "기존 테스트" 를 가려낼 수 없다 — refactor 의 보호가
  // 통째로 꺼지고 fix 의 재현 테스트도 자리를 잴 수 없다. 선언을 보고 미리 말해 주는 자리가 여기다.
  for (const stage of manifest.stages.filter((stage) => stage.kind === "test")) {
    if (stageTestRoots(stage).length === 0) {
      out.push(
        `- 확인: ${stage.key} 는 kind:"test" 인데 자리를 밝히지 않았습니다 ` +
          "(scope:\"project\" 의 outputDirs 나 base) — refactor 의 기존 테스트 보호가 걸리지 않고, " +
          "fix 의 계획은 재현 테스트의 자리를 잴 수 없어 거부됩니다",
      );
    }
  }
  if (manifest.stages.every((stage) => stage.exemplars.length === 0)) {
    out.push("- 확인: 참조 파일을 선언한 단계가 없습니다 — 신규(빈) 저장소면 정상입니다");
  }
  for (const [name, argv] of [["build", manifest.build], ["test", manifest.test], ["prepare", manifest.prepare]] as const) {
    if (argv && !existsSync(join(repoRoot, argv[0])) && !/^[a-z]+$/.test(argv[0])) {
      out.push(`- 확인: ${name} 명령의 실행 파일이 저장소에 없습니다: ${argv[0]}`);
    }
  }
  out.push("", failed ? "✗ 참조 파일을 못 찾는 단계가 있습니다 — 경로·{Ref}·referenceDomain 을 고치세요." : "✓ 모든 단계가 참조 파일을 찾습니다.");
  return { text: out.join("\n"), ok: !failed };
}
