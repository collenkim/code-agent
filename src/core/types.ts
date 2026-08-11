/** 코드 생성 1회 실행의 입력 일체 */
export interface BuildContext {
  /** 요구사항·정책·기능·입출력이 적힌 스펙 문서 경로들 (여러 장 허용) */
  specPaths: string[];
  /** specPaths를 읽어 합친 원문 — 호출자가 직접 넣지 않는다 */
  specText?: string;
  /**
   * 코드 컨벤션 문서 경로(파일 또는 디렉토리). 생략하면 대상 저장소의 가이드 디렉토리를 찾아 쓴다 —
   * 컨벤션은 그 프로젝트 저장소가 정본이라 다른 저장소 문서를 기본값으로 삼지 않는다.
   */
  conventionsPaths?: string[];
  /** conventionsPaths를 읽어 내부에서 채우는 값 */
  conventionsText?: string;
  /** 실제로 어떤 컨벤션 문서를 썼는지 — 내부에서 채운다 */
  conventionsSource?: string;
  /** 단계별 템플릿 디렉토리 (01-spec.md ~ 07-controller.md) */
  templatesDir: string;
  /**
   * 생성 범위 정책 문서 경로. 무엇을 만들고 무엇을 만들지 않을지를 정하며
   * 특정 단계가 아니라 모든 단계에 공통 주입된다.
   */
  policyPath?: string;
  /** policyPath를 읽어 내부에서 채우는 값 */
  policyText?: string;
  /** 참조 표준 코드가 들어 있는 저장소 루트 */
  repoRoot: string;
  /** 참조 표준으로 복제할 기존 도메인 이름. 생략하면 code-agent.json 의 referenceDomain */
  referenceDomain?: string;
  /** 생성 결과를 쓸 staging 디렉토리 — 대상 저장소는 건드리지 않는다 */
  outDir: string;
  /** 실행할 단계 키. 생략 시 전체 단계 */
  onlyStages?: string[];
  /** 단계별 자가검증 게이트 실행 여부. 기본 true — false만 명시적으로 꺼짐 */
  gate?: boolean;
  /** 게이트 실패 시 같은 단계를 다시 생성할 최대 횟수 */
  maxRetries: number;
  /** 컴파일 검증 여부. 기본 false (임시 worktree를 만들어 검증하므로 비용이 큼) */
  build?: boolean;
  /**
   * 생성된 테스트를 실제로 실행할지. 기본 false.
   * 실패는 자동 수정 대상이 아니다 — 테스트가 틀렸는지 코드가 틀렸는지는 사람이 판단한다.
   */
  test?: boolean;
  /** 계획 단계의 미결 질문이 남아 있어도 생성을 계속할지. 기본 false(중단) */
  force?: boolean;
  /** 계획만 만들고 생성은 하지 않을지. 사람이 계획을 먼저 검토할 때 쓴다 */
  planOnly?: boolean;
}

/**
 * 매니페스트와 문서를 모두 읽어 빈칸이 없는 상태의 context.
 * 생성·검수 단계는 이것만 받는다 — 어떤 값이 채워졌는지 매번 확인할 필요가 없다.
 */
export interface ResolvedBuildContext extends BuildContext {
  referenceDomain: string;
  specText: string;
  conventionsText: string;
  conventionsSource: string;
}

/** 계획 단계가 정한, 이 단계에서 만들 파일 하나 */
export interface PlannedFile {
  stage: string;
  /** 저장소 루트 기준 상대경로 */
  path: string;
  purpose: string;
}

/** 이번 생성에 적용할 규칙과 그 출처(문서 섹션 또는 참조 표준 파일) */
export interface ConventionRule {
  rule: string;
  source: string;
}

/**
 * 컨벤션 문서와 참조 표준 코드가 어긋나는 지점.
 * 조용히 한쪽을 고르지 않고 계획에 남겨 사람이 볼 수 있게 한다.
 */
export interface DocConflict {
  topic: string;
  docSays: string;
  codeSays: string;
  decision: string;
}

/** "어떤 컨벤션으로 어떻게 만들지"를 정리한 작업 명세서 */
export interface BuildPlan {
  /** 프로젝트 명명 규칙을 따른 도메인 이름 */
  domainName: string;
  /** 사람이 읽는 이름 */
  domainLabel: string;
  /** 프로젝트가 선언한 domainRoots 중 하나. 분류가 없는 프로젝트면 빈 문자열 */
  domainRoot: string;
  /** 실제 디렉토리 이름 — 언어마다 대소문자 규칙이 달라 이름과 따로 둔다 */
  domainDirName: string;
  files: PlannedFile[];
  conventions: ConventionRule[];
  conflicts: DocConflict[];
  openQuestions: string[];
  reasoning: string;
}

export interface GeneratedFile {
  /** 저장소 루트 기준 상대경로 */
  path: string;
  content: string;
  /** 판단이 필요했던 지점. 없으면 생략 */
  note?: string;
}

export interface GateViolation {
  item: string;
  file: string;
  detail: string;
}

export interface GateResult {
  passed: boolean;
  violations: GateViolation[];
}

export interface StageResult {
  stage: string;
  files: GeneratedFile[];
  gate?: GateResult;
  /** 생성 시도 횟수 (게이트 재생성 포함) */
  attempts: number;
}

export interface BuildResult {
  passed: boolean;
  log: string;
}

export interface BuildOutcome {
  plan: BuildPlan;
  stages: StageResult[];
  build?: BuildResult;
  /** 테스트 실행 결과. 실패해도 재생성하지 않고 그대로 보고한다 */
  test?: BuildResult;
  /** 실제로 적용된 컨벤션 문서 출처 */
  conventionsSource: string;
}

/** 실제 API 호출 없이 미리보기(dry-run)할 때 쓰는, 조립된 프롬프트 한 벌 */
export interface PromptPreview {
  stage: string;
  /**
   * 이 프롬프트로 실제 결과를 재현할 수 있는지. 02 이후 단계는 앞 단계 산출물을
   * 입력으로 받으므로, 아직 만들어지지 않은 산출물 자리는 비어 있다.
   */
  reproducible: boolean;
  note?: string;
  system: string;
  user: string;
}
