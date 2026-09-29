import type { WorkOrder } from "./workOrder";

/** 이름 하나와, 그 이름이 작업을 만들 때 가리키던 커밋. 커밋은 그 뒤로 움직이지 않는다 */
export interface RefPin {
  /** 사람이 적은 이름 — `master`·`feat/x`·태그 무엇이든 */
  ref: string;
  /** 굳혀 둔 커밋 */
  commit: string;
}

/**
 * 이 작업이 딛고 선 자리.
 *
 * 브랜치 이름은 움직이고 체크아웃도 바뀐다. 굳혀 두지 않으면 같은 작업이 언제 검증하느냐에
 * 따라 다른 코드를 보게 되므로, 작업을 만들 때 커밋으로 바꿔 두고 그 뒤로는 커밋만 쓴다.
 */
export interface JobRefs {
  /** 작업 브랜치 — 생성물을 얹어 검증할 바탕 */
  work: RefPin;
  /**
   * 비교 브랜치 — 이 작업이 어디서 갈라져 나왔는지.
   *
   * **없을 수 있다.** 적어 주지도 않았고 `master` 도 `main` 도 없는 저장소라면 짐작하지
   * 않는다. 비교 대상은 기록이지 검증이 딛는 자리가 아니므로, 그것 하나 때문에 작업을
   * 막지 않는다 — 기본 브랜치 이름이 다른 저장소가 통째로 못 쓰게 되는 편이 더 나쁘다.
   */
  base?: RefPin;
}

/** 계획 단계가 정한, 이 단계에서 만들 파일 하나 */
export interface PlannedFile {
  stage: string;
  /** 저장소 루트 기준 상대경로 */
  path: string;
  purpose: string;
  /** 이 파일이 담당하는 요구 항목 번호 (R1 …). 요구사항 분석을 거친 계획에만 있다 */
  requirements?: string[];
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

/**
 * 지시서의 보존 조건 하나와, 이번 변경이 그것을 지키는 방법.
 * refactor 의 계획은 이것이 본체다 — 무엇이 보존되어야 하는지가 그 작업의 내용이기 때문이다.
 */
export interface PreserveNote {
  /** 작업 지시서의 preserve 문장을 그대로 옮긴 것 */
  item: string;
  how: string;
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
  /** 보존 조건과 지키는 방법. 계획 스키마가 갈리는 종류에서만 채워진다 */
  preserve?: PreserveNote[];
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
  /**
   * 왜 이 결과인가. `failed` 는 명령이 돌아서 실패한 것이고, `error` 는 명령이 돌지 못한 것이다.
   * 둘을 같은 "실패"로 읽으면 git 저장소가 아닌 곳에서 아무 테스트도 안 쓰고 재현 단계가 끝난다 —
   * expect: fail 은 `failed` 만 재현으로 인정한다.
   */
  outcome: "passed" | "failed" | "not-run" | "error";
  log: string;
  /**
   * 명령을 아예 돌리지 않았는지. 안 돌린 것을 "통과"로 읽으면 검증하지 않은 코드를
   * 검증된 것으로 착각하게 되므로, 통과와 구분해서 알린다.
   */
  skipped?: boolean;
}
