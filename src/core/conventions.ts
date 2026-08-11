import { existsSync, readdirSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";

/**
 * 경로를 **대상 저장소 기준으로 먼저** 푼다.
 *
 * 컨벤션·템플릿·정책은 그 프로젝트의 것을 봐야 하므로, 상대경로는 실행 위치가 아니라
 * 대상 저장소를 기준으로 해석한다. 저장소 안에 없으면 실행 위치 기준으로 한 번 더 시도한다
 * (저장소 밖에 문서를 두고 쓰는 경우도 막지 않기 위함).
 */
export function resolveAgainstRepo(repoRoot: string, path: string): string {
  if (isAbsolute(path)) {
    return path;
  }
  const inRepo = join(repoRoot, path);
  if (existsSync(inRepo)) {
    return inRepo;
  }
  return resolve(path);
}

/** 디렉토리면 그 안의 마크다운 문서로 펼친다. */
function expandToDocuments(path: string): string[] {
  if (!statSync(path).isDirectory()) {
    return [path];
  }
  return readdirSync(path)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(path, name));
}

export interface ResolvedConventions {
  paths: string[];
  /** 어디서 찾았는지 — 사람이 확인할 수 있게 남긴다 */
  source: string;
}

/**
 * 적용할 컨벤션 문서를 정한다.
 *
 * 기본값은 **대상 프로젝트가 `code-agent.json` 에 선언한 경로**다. 컨벤션은 프로젝트마다
 * 다르고 그 저장소가 정본이라, 에이전트나 다른 저장소의 문서를 기본값으로 삼지 않는다.
 * 파일 하나가 아니라 디렉토리도 받는 이유는 규칙이 보통 여러 장으로 나뉘어 있기 때문이다.
 */
export function resolveConventions(
  repoRoot: string,
  declared: string[],
  override?: string[],
): ResolvedConventions {
  const entries = override?.length ? override : declared;
  const origin = override?.length ? "--conventions" : "code-agent.json";

  // 컨벤션 문서가 없는 것이 정상인 실행이 있다 — 신규 프로젝트 구성과 레거시 도입은
  // 그 문서를 만들어 내는 쪽이다. 막지 않되, 프롬프트에 없다는 사실이 드러나게 한다.
  if (entries.length === 0) {
    return { paths: [], source: "(없음 — 이 실행에서 만들어 낼 대상)" };
  }

  const paths = entries.flatMap((entry) => {
    const path = resolveAgainstRepo(repoRoot, entry);
    if (!existsSync(path)) {
      throw new Error(`컨벤션 문서를 찾을 수 없습니다: ${entry} (${origin})`);
    }
    return expandToDocuments(path);
  });

  if (paths.length === 0) {
    throw new Error(`컨벤션 문서가 비어 있습니다: ${entries.join(", ")} (${origin})`);
  }
  return { paths, source: `${entries.join(", ")} (${origin})` };
}
