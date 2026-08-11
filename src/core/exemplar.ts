import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, posix } from "path";

import type { Manifest, StageDef } from "./manifest";

/**
 * 참조 표준 파일을 얼마나 읽어 넣을지의 상한.
 * 모델이 스스로 탐색하게 두지 않고 코드가 결정론적으로 고르는 대신, 그 양은 여기서 통제한다.
 */
const MAX_FILES_PER_DIR = 5;
const MAX_LINES_PER_FILE = 500;

export interface ExemplarFile {
  /** 저장소 루트 기준 상대경로 */
  path: string;
  content: string;
  /** 상한에 걸려 잘렸으면 그 사유 */
  truncated?: string;
}

/** 도메인 이름을 PascalCase 접두어로 바꾼다 (deal → Deal). */
export function toPascalCase(domain: string): string {
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

/** 프로젝트가 선언한 도메인 분류들. 분류가 없는 프로젝트는 빈 문자열 하나로 다룬다. */
function domainRootsOf(manifest: Manifest): string[] {
  return manifest.domainRoots.length > 0 ? manifest.domainRoots : [""];
}

/**
 * 저장소 기준 도메인 디렉토리 경로.
 * base를 주면 그 루트 아래로 본다 — 테스트처럼 같은 패키지 구조를 다른 루트에 미러링하는 단계용.
 */
export function domainDirOf(
  manifest: Manifest,
  domainRoot: string,
  domain: string,
  base?: string,
): string {
  return posix.join(base ?? manifest.domainBase, domainRoot, domain).replace(/\/+/g, "/");
}

/**
 * 참조 도메인 디렉토리를 찾는다. 선언된 분류(domainRoots) 중 실제로 존재하는 쪽을 쓴다 —
 * 어느 분류인지는 도메인마다 다르고, 못 찾으면 참조 없이 생성돼 품질이 무너지므로 조용히 넘기지 않는다.
 */
export function findReferenceDir(
  repoRoot: string,
  manifest: Manifest,
  referenceDomain: string,
  base?: string,
): { dir: string; domainRoot: string; relativeBase: string } {
  for (const domainRoot of domainRootsOf(manifest)) {
    const relativeBase = domainDirOf(manifest, domainRoot, referenceDomain, base);
    const dir = join(repoRoot, relativeBase);
    if (existsSync(dir)) {
      return { dir, domainRoot, relativeBase };
    }
  }
  throw new Error(
    `참조 표준 도메인을 찾을 수 없습니다: ${referenceDomain} (확인한 경로: ` +
      domainRootsOf(manifest)
        .map((root) => domainDirOf(manifest, root, referenceDomain, base))
        .join(", ") +
      ")",
  );
}

function isSourceFile(manifest: Manifest, name: string): boolean {
  if (manifest.sourceExtensions.length === 0) {
    return true;
  }
  return manifest.sourceExtensions.some((extension) => name.endsWith(extension));
}

function readCapped(absolutePath: string, relativePath: string): ExemplarFile {
  const lines = readFileSync(absolutePath, "utf-8").split("\n");
  if (lines.length <= MAX_LINES_PER_FILE) {
    return { path: relativePath, content: lines.join("\n") };
  }
  return {
    path: relativePath,
    content: lines.slice(0, MAX_LINES_PER_FILE).join("\n"),
    truncated: `총 ${lines.length}줄 중 앞 ${MAX_LINES_PER_FILE}줄만 표시`,
  };
}

/**
 * 한 단계가 참조할 표준 파일들을 읽는다.
 *
 * 모델에게 "비슷한 걸 찾아봐"라고 시키지 않고 코드가 경로를 정해 읽는 이유는, 계층+도메인이
 * 정해지면 읽을 파일이 이미 결정돼 있어 탐색이 불필요하고, 탐색을 맡기면 실행마다 참조가
 * 달라져 결과가 흔들리기 때문이다. 없는 파일은 건너뛰되 호출자가 알 수 있게 목록으로 돌려준다.
 */
export function collectExemplars(
  repoRoot: string,
  manifest: Manifest,
  referenceDomain: string,
  stage: StageDef,
): { files: ExemplarFile[]; missing: string[] } {
  const { dir, relativeBase } = findReferenceDir(repoRoot, manifest, referenceDomain, stage.base);

  const files: ExemplarFile[] = [];
  const missing: string[] = [];

  for (const pattern of stage.exemplars) {
    const resolved = pattern.replace(/\{Ref\}/g, toPascalCase(referenceDomain));

    if (resolved.endsWith("/")) {
      const subDir = join(dir, resolved);
      if (!existsSync(subDir)) {
        missing.push(resolved);
        continue;
      }
      const entries = readdirSync(subDir)
        .filter((name) => isSourceFile(manifest, name))
        .filter((name) => statSync(join(subDir, name)).isFile())
        .sort()
        .slice(0, MAX_FILES_PER_DIR);
      for (const name of entries) {
        files.push(readCapped(join(subDir, name), posix.join(relativeBase, resolved, name)));
      }
      continue;
    }

    const filePath = join(dir, resolved);
    if (!existsSync(filePath)) {
      missing.push(resolved);
      continue;
    }
    files.push(readCapped(filePath, posix.join(relativeBase, resolved)));
  }

  return { files, missing };
}

/**
 * 참조 도메인의 파일 목록(내용 제외)을 저장소 루트 기준 상대경로로 돌려준다.
 * 계획 단계는 "어떤 파일을 만들지"만 정하면 되므로 내용까지 읽을 필요가 없다.
 */
export function listReferenceTree(
  repoRoot: string,
  manifest: Manifest,
  referenceDomain: string,
  stages: StageDef[],
): string[] {
  const walk = (current: string, prefix: string): string[] =>
    readdirSync(current).flatMap((name) => {
      const child = join(current, name);
      const relative = posix.join(prefix, name);
      return statSync(child).isDirectory() ? walk(child, relative) : [relative];
    });

  // 단계마다 루트가 다를 수 있다(본 소스 / 테스트). 계획이 양쪽 경로를 다 제안할 수 있어야 한다.
  const bases = [...new Set(stages.map((stage) => stage.base ?? manifest.domainBase))];

  return bases
    .flatMap((base) => {
      const found = findReferenceDir(repoRoot, manifest, referenceDomain, base);
      return walk(found.dir, found.relativeBase);
    })
    .sort();
}

/** 참조 표준 파일들을 프롬프트에 넣을 형태로 직렬화한다. */
export function formatExemplars(files: ExemplarFile[], language?: string): string {
  if (files.length === 0) {
    return "(참조 표준 파일 없음)";
  }
  return files
    .map((file) => {
      const header = file.truncated ? `## ${file.path} (${file.truncated})` : `## ${file.path}`;
      return `${header}\n\`\`\`${language ?? ""}\n${file.content}\n\`\`\``;
    })
    .join("\n\n");
}
