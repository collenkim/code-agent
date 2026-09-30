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

/**
 * 디렉토리 안에서 이름을 찾는다 — 정확히 같은 것이 없으면 **대소문자만 다른 것이 하나**일 때 그것을 쓴다.
 *
 * 도메인 디렉토리 이름은 소문자 한 덩어리(`salesmaterial`)인데 클래스 이름은 낱말 경계가 있다
 * (`SalesMaterial`). `{Ref}` 치환은 첫 글자만 올릴 수 있으므로 `Salesmaterial.java` 를 찾고, 그 파일은
 * 없다. 낱말 경계는 이름만 보고 알 수 없지만 **디스크에는 답이 있다** — 대소문자를 무시하면 하나로
 * 좁혀진다. 둘 이상이면 고르지 않는다. 추측으로 고른 참조는 없는 것보다 나쁘다.
 */
function resolveName(dir: string, wanted: string): string | undefined {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return undefined;
  }
  const entries = readdirSync(dir);
  if (entries.includes(wanted)) {
    return wanted;
  }
  const loose = entries.filter((name) => name.toLowerCase() === wanted.toLowerCase());
  return loose.length === 1 ? loose[0] : undefined;
}

/**
 * 참조 디렉토리 기준 상대경로를 디스크의 실제 이름으로 푼다. 조각마다 `resolveName` 을 거친다.
 * 못 풀면 undefined — 호출자가 missing 으로 적는다.
 */
function resolvePath(dir: string, relative: string): string | undefined {
  const parts = relative.split("/").filter((part) => part !== "");
  let current = dir;
  const resolved: string[] = [];
  for (const part of parts) {
    const actual = resolveName(current, part);
    if (actual === undefined) {
      return undefined;
    }
    resolved.push(actual);
    current = join(current, actual);
  }
  return resolved.join("/");
}

/** 디렉토리형 참조에서 상한에 밀려 내용이 실리지 않은 파일들 */
export interface OmittedExemplars {
  /** 선언된 패턴 (`cd/` 처럼 `/` 로 끝난다) */
  pattern: string;
  /** 내용이 실린 파일 수 */
  shown: number;
  /** 내용 없이 이름만 알리는 나머지 */
  names: string[];
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
): { files: ExemplarFile[]; missing: string[]; omitted: OmittedExemplars[] } {
  // 참조할 파일을 선언하지 않은 단계(프로젝트 골격 등)는 참조 도메인 자체가 없을 수 있다.
  if (stage.exemplars.length === 0) {
    return { files: [], missing: [], omitted: [] };
  }

  const { dir, relativeBase } = findReferenceDir(repoRoot, manifest, referenceDomain, stage.base);

  const files: ExemplarFile[] = [];
  const missing: string[] = [];
  const omitted: OmittedExemplars[] = [];

  for (const pattern of stage.exemplars) {
    const wanted = pattern.replace(/\{Ref\}/g, toPascalCase(referenceDomain));
    // 디스크의 실제 이름으로 푼다. 대소문자만 다른 것이 하나면 그것이다 — {Ref} 가 낱말 경계를
    // 모르는 도메인(salesmaterial → SalesMaterial)에서 여기서 갈린다.
    const resolved = resolvePath(dir, wanted);
    if (resolved === undefined) {
      missing.push(wanted);
      continue;
    }

    if (pattern.endsWith("/")) {
      const subDir = join(dir, resolved);
      const entries = readdirSync(subDir)
        .filter((name) => isSourceFile(manifest, name))
        .filter((name) => statSync(join(subDir, name)).isFile())
        .sort();
      const shown = entries.slice(0, MAX_FILES_PER_DIR);
      for (const name of shown) {
        files.push(readCapped(join(subDir, name), posix.join(relativeBase, resolved, name)));
      }
      // 내용은 상한까지만, **이름은 전부**. 잘렸다는 사실을 숨기면 모델은 없는 것으로 알고
      // 그 자리를 지어낸다.
      if (entries.length > shown.length) {
        omitted.push({ pattern, shown: shown.length, names: entries.slice(shown.length) });
      }
      continue;
    }

    files.push(readCapped(join(dir, resolved), posix.join(relativeBase, resolved)));
  }

  return { files, missing, omitted };
}

/** 참조 표준 파일들을 code-agent context 출력에 넣을 형태로 직렬화한다. */
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
