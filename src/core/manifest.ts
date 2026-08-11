import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

export const MANIFEST_FILE = "code-agent.json";

const StageSchema = z.object({
  key: z.string().describe("--stages 에서 쓰는 식별자"),
  title: z.string().describe("이 단계가 만드는 것"),
  template: z.string().describe("같은 디렉토리의 템플릿 문서 파일명"),
  base: z
    .string()
    .optional()
    .describe(
      "이 단계의 도메인 디렉토리 루트. 생략하면 domainBase. 테스트처럼 같은 패키지 구조를 " +
        "다른 루트 아래에 미러링하는 단계에 쓴다 (예: src/test/java/...)",
    ),
  exemplars: z
    .array(z.string())
    .default([])
    .describe("참조 도메인 디렉토리 기준 상대경로. {Ref}는 참조 도메인 PascalCase로 치환. /로 끝나면 디렉토리 전체"),
  outputDirs: z
    .array(z.string())
    .default([])
    .describe("산출물이 놓일 수 있는 도메인 하위 디렉토리. '.'은 도메인 디렉토리 바로 아래. 비면 소스가 아닌 문서 산출물"),
});

const ManifestSchema = z.object({
  language: z
    .string()
    .optional()
    .describe("주 언어. 프롬프트 문구와 코드블록 표기에만 쓴다 (예: java, typescript, python)"),
  sourceExtensions: z
    .array(z.string())
    .default([])
    .describe("참조 표준으로 읽을 파일 확장자. 비면 디렉토리의 모든 파일을 읽는다"),
  domainBase: z.string().describe("도메인 디렉토리들이 놓이는 저장소 기준 경로"),
  domainRoots: z
    .array(z.string())
    .default([""])
    .describe("domainBase 아래의 도메인 분류 디렉토리. 분류가 없으면 생략"),
  conventions: z
    .array(z.string())
    .default([])
    .describe("컨벤션 문서 경로(파일 또는 디렉토리), 저장소 기준"),
  referenceDomain: z.string().optional().describe("기본 참조 표준 도메인"),
  build: z
    .array(z.string())
    .optional()
    .describe("컴파일 검증 명령. 첫 원소가 저장소 안의 실행 파일이면 그 경로로 실행한다"),
  test: z
    .array(z.string())
    .optional()
    .describe("테스트 실행 명령. --test 로 켠다. 실패는 자동 수정 대상이 아니라 보고 대상이다"),
  stages: z.array(StageSchema).min(1),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type StageDef = z.infer<typeof StageSchema>;

/**
 * 프로젝트 설정을 읽는다.
 *
 * 패키지 경로·계층 이름·빌드 명령·단계 구성은 프로젝트마다 다르므로 에이전트가 알고 있지 않고,
 * 대상 프로젝트가 템플릿 디렉토리에 선언한 것을 그대로 쓴다. 에이전트에 특정 프로젝트의 상수가
 * 박히는 순간 다른 프로젝트에 못 쓰게 된다.
 */
export function loadManifest(templatesDir: string): Manifest {
  const path = join(templatesDir, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${MANIFEST_FILE} 을 찾을 수 없습니다: ${templatesDir}\n` +
        "템플릿 디렉토리에 프로젝트 설정(도메인 경로·계층·단계)을 선언해야 합니다.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${MANIFEST_FILE} 파싱 실패: ${err instanceof Error ? err.message : err}`);
  }

  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${MANIFEST_FILE} 형식 오류:\n${issues}`);
  }
  return parsed.data;
}

/** 실행할 단계 목록. onlyStages가 있어도 선언된 순서를 유지한다. */
export function selectStages(manifest: Manifest, onlyStages?: string[]): StageDef[] {
  if (!onlyStages?.length) {
    return manifest.stages;
  }

  const unknown = onlyStages.filter((key) => !manifest.stages.some((stage) => stage.key === key));
  if (unknown.length > 0) {
    throw new Error(
      `알 수 없는 단계: ${unknown.join(", ")} ` +
        `(선언된 단계: ${manifest.stages.map((stage) => stage.key).join(", ")})`,
    );
  }
  return manifest.stages.filter((stage) => onlyStages.includes(stage.key));
}
