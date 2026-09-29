/**
 * 프로젝트 필수 문서의 스키마 — 어떤 섹션이 있어야 하고, 비었을 때 무엇을 물어야 하는가.
 *
 * 섹션 검사는 코드가 한다(제목 대조). 섹션을 채우는 것은 역공학이나 사용자 입력이고,
 * 그때 무엇을 물을지도 여기서 온다 — 질문이 실행마다 달라지지 않게.
 */
/** 막는 문서 — 넷 다 확정돼야 작업이 시작된다 */
export type PolicyKind = "architecture" | "conventions" | "test-strategy" | "quality";
/** 막지 않는 문서 — 파일만 있으면 되고, 반영마다 자란다 */
export type KnowledgeKind = "data-dictionary" | "api-catalog" | "business-rules";
export type DocKind = PolicyKind | KnowledgeKind;

export const POLICY_KINDS: PolicyKind[] = ["architecture", "conventions", "test-strategy", "quality"];
export const KNOWLEDGE_KINDS: KnowledgeKind[] = ["data-dictionary", "api-catalog", "business-rules"];

export interface SectionSchema {
  id: string;
  /** 문서에 쓸 제목 (`## 제목`) */
  heading: string;
  /** 이 제목으로도 인정한다 — 이미 있는 문서를 연결할 때 이름이 조금 달라도 받는다 */
  aliases: string[];
  required: boolean;
  /** 무엇을 쓰는 섹션인가 — 뼈대의 안내 주석과 역공학 지시에 쓰인다 */
  guide: string;
  /** 사용자 입력으로 채울 때 묻는 것. 선택지는 결정이 필요한 곳에만 */
  questions: { ask: string; options?: string[] }[];
}

export interface DocSchema {
  kind: DocKind | WorkDocKind;
  label: string;
  defaultPath: string;
  /** knowledge 는 게이트가 파일 존재뿐이라 뼈대에 미결 표시를 넣지 않는다 — 막지 않는 문서의 표시는 영원히 안 지워진다 */
  layer?: "knowledge";
  sections: SectionSchema[];
}

/** 이 표시가 남은 필수 섹션은 채워지지 않은 것이다. 역공학이 코드로 알 수 없는 자리에 남긴다 */
export const GAP_MARKER = "확인 필요";

export const ARCHITECTURE: DocSchema = {
  kind: "architecture",
  label: "아키텍처",
  defaultPath: "doc/architecture.md",
  sections: [
    {
      id: "stack",
      heading: "기술 스택",
      aliases: ["기술스택", "tech stack", "스택"],
      required: true,
      guide: "언어·런타임 버전, 프레임워크, 빌드 도구, DB, 주요 라이브러리 — 빌드 파일이 있으면 적힌 버전 그대로, 없으면 정해진 것만",
      questions: [
        { ask: "언어와 버전은?", options: ["Java 21", "Java 17", "Kotlin", "TypeScript (Node)", "Python"] },
        { ask: "프레임워크는?", options: ["Spring Boot 3", "Spring Boot 2", "NestJS", "FastAPI", "없음"] },
        { ask: "빌드 도구는?", options: ["Gradle", "Maven", "npm/pnpm", "uv/poetry"] },
        { ask: "DB 와 접근 방식은?", options: ["JPA/Hibernate", "MyBatis", "JDBC/QueryDSL", "ORM 없음"] },
      ],
    },
    {
      id: "structure",
      heading: "모듈/패키지 구조",
      aliases: ["모듈 구조", "패키지 구조", "디렉토리 구조", "프로젝트 구조", "module structure"],
      required: true,
      guide: "소스 루트, 모듈 나눔, 도메인 디렉토리가 놓이는 규칙 (예: `com.acme.app.<분류>.<도메인>.<계층>`)",
      questions: [
        { ask: "코드를 무엇 기준으로 나누나?", options: ["도메인 → 계층 (domain/order/service)", "계층 → 도메인 (service/order)", "기능별 폴더 (co-locate)", "멀티 모듈"] },
      ],
    },
    {
      id: "layers",
      heading: "계층과 책임",
      aliases: ["계층", "계층 구조", "레이어", "layers"],
      required: true,
      guide: "계층마다 이름과 책임, 무엇을 하지 않는지 (예: 컨트롤러는 트랜잭션을 열지 않는다)",
      questions: [
        { ask: "계층 구성은?", options: ["Controller · Service · Repository · Domain", "Controller · Facade · Command/Query · Repository", "Hexagonal (adapter · application · domain)"] },
        { ask: "각 계층이 하지 않는 일(금지)은?" },
      ],
    },
    {
      id: "dependencies",
      heading: "의존 방향",
      aliases: ["의존 규칙", "의존성 방향", "dependency rule"],
      required: true,
      guide: "어느 계층이 어느 계층을 불러도 되는가, 도메인 사이 참조 규칙",
      questions: [
        { ask: "도메인끼리 직접 참조해도 되나?", options: ["된다", "서비스(파사드)를 거쳐서만", "이벤트로만"] },
      ],
    },
    {
      id: "common",
      heading: "공통 모듈",
      aliases: ["공통", "공통 모듈/유틸", "common"],
      required: true,
      guide: "공통 응답·예외·유틸·설정 등 모든 도메인이 쓰는 것의 위치와 쓰는 법. 없으면 '없음'이라고 쓴다",
      questions: [{ ask: "공통 응답 형식·예외·유틸은 어디에 있나? (없으면 새로 만들 위치)" }],
    },
    {
      id: "decisions",
      heading: "주요 결정",
      aliases: ["설계 결정", "결정", "decisions", "adr"],
      required: true,
      guide: "식별자 전략 · 트랜잭션 경계 · 예외 체계 · 인증·권한 · soft delete · 멀티테넌시 · 로깅 — 항목마다 결정 (이유는 알면 한 줄)",
      questions: [
        { ask: "식별자 전략은?", options: ["DB auto increment", "시퀀스", "UUID", "업무 키"] },
        { ask: "트랜잭션 경계는 어느 계층인가?", options: ["Service", "Facade", "Controller 가 아닌 곳 어디든"] },
        { ask: "삭제 방식은?", options: ["물리 삭제", "soft delete (삭제 플래그)", "도메인마다 다름"] },
        { ask: "멀티테넌시는?", options: ["없음", "테넌트 컬럼", "스키마 분리"] },
        { ask: "인증·권한은 어떻게 하나?" },
      ],
    },
    {
      id: "integrations",
      heading: "외부 연동",
      aliases: ["연동", "외부 시스템", "integrations"],
      required: false,
      guide: "외부 API·메시지·배치 연동과 그 위치",
      questions: [{ ask: "연동하는 외부 시스템이 있나?" }],
    },
  ],
};

export const CONVENTIONS: DocSchema = {
  kind: "conventions",
  label: "코드 컨벤션",
  defaultPath: "doc/conventions.md",
  sections: [
    {
      id: "naming",
      heading: "명명",
      aliases: ["명명 규칙", "네이밍", "이름 규칙", "naming"],
      required: true,
      guide: "클래스·파일·메서드·변수·테이블 이름 규칙과 계층별 접미사 (예: OrderService, OrderRepository)",
      questions: [{ ask: "계층별 클래스 이름 접미사는?" }, { ask: "메서드 이름 규칙(조회·저장·삭제)은?" }],
    },
    {
      id: "layerRules",
      heading: "계층별 규칙",
      aliases: ["계층 규칙", "계층별 작성 규칙"],
      required: true,
      guide: "계층마다 파일을 어떻게 쓰는가 — 입력 검증 위치, DTO 변환 위치, 조회와 변경의 분리 등",
      questions: [{ ask: "입력 검증은 어디서 하나?", options: ["Controller (@Valid)", "Service", "Domain 생성자"] }, { ask: "DTO ↔ 엔티티 변환은 어디서 하나?" }],
    },
    {
      id: "errors",
      heading: "예외 처리",
      aliases: ["예외", "에러 처리", "오류 처리", "error handling"],
      required: true,
      guide: "예외 클래스 체계, 던지는 곳과 잡는 곳, 오류 응답 형식",
      questions: [{ ask: "업무 예외는 어떻게 던지나?", options: ["공통 BusinessException + 오류 코드", "도메인별 예외 클래스", "표준 예외 그대로"] }],
    },
    {
      id: "tests",
      heading: "테스트 규칙",
      aliases: ["테스트", "테스트 작성", "testing"],
      required: false,
      // 수준·명령·통과 기준은 테스트 전략 문서가 맡는다. 두 문서가 같은 것을 적으면 어느 쪽이 정본인지 사라진다
      guide: "테스트 코드 표기만 — 위치·클래스/메서드 이름·픽스처 표기·TC id 를 코드에 남기는 방법",
      questions: [{ ask: "테스트 이름·위치 규칙은?" }, { ask: "TC id 를 테스트 코드에 어떻게 남기나?" }],
    },
    {
      id: "style",
      heading: "포매팅·주석",
      aliases: ["포매팅", "주석", "코드 스타일", "style"],
      required: false,
      guide: "포매터·린터 설정, 주석 규칙",
      questions: [{ ask: "포매터·린터가 있나?" }],
    },
  ],
};

/**
 * 테스트 전략 — "테스트했다"가 이 저장소에서 무슨 뜻인지 한 번만 정해 둔다.
 * 없으면 작업마다 모델이 범위를 새로 발명하고, 실패하면 단언을 지우는 쪽으로 기운다.
 */
export const TEST_STRATEGY: DocSchema = {
  kind: "test-strategy",
  label: "테스트 전략",
  defaultPath: "doc/test-strategy.md",
  sections: [
    {
      id: "levels",
      heading: "수준과 범위",
      aliases: ["테스트 수준", "수준", "범위", "levels"],
      required: true,
      guide: "Unit · Integration · E2E 각각 필수인가·선택인가·하지 않는가와 그 수준에서 무엇을 검증하는가. 하지 않는 수준은 '하지 않음'이라고 적는다",
      questions: [
        { ask: "단위 테스트는?", options: ["모든 서비스·도메인 필수", "분기 있는 로직만", "하지 않음"] },
        { ask: "통합 테스트는?", options: ["주요 흐름 필수(@SpringBootTest 등)", "슬라이스만", "선택", "하지 않음"] },
        { ask: "E2E 는?", options: ["Playwright·Cypress", "REST 시나리오", "수동", "하지 않음"] },
      ],
    },
    {
      id: "tools",
      heading: "도구와 실행 명령",
      aliases: ["도구", "실행 명령", "도구와 명령", "tools"],
      required: true,
      // 첫 목록의 백틱 이름을 code-agent.json 과 대조한다(docs.ts). 이름이 없으면 "테스트를 돌렸다"가 아무것도 돌리지 않은 결과 위에 선다
      guide:
        "프레임워크·대역 라이브러리와, 수준마다 어떤 명령으로 도는가. 목록은 ``- `이름`: 무엇을 돌리나`` 형식 — " +
        "이름은 code-agent.json 의 build · test · commands 키여야 한다 (코드가 대조한다). 자동 실행이 없으면 `- 없음`",
      questions: [{ ask: "테스트 프레임워크와 대역 라이브러리는?" }, { ask: "수준마다 어떤 명령으로 도나? (code-agent.json 의 build·test·commands 이름)" }],
    },
    {
      id: "criteria",
      heading: "통과 기준",
      aliases: ["통과 조건", "완료 기준", "criteria"],
      required: true,
      guide: "요구 항목 하나가 '테스트됐다'가 되는 조건 — 수락 기준(④)당 최소 몇 케이스, 실패 경로 포함 여부, 커버리지를 쓴다면 대상과 값",
      questions: [
        { ask: "통과 기준은?", options: ["수락 기준마다 최소 1 + 실패 경로 1", "수락 기준마다 1", "커버리지 수치로", "수치 없음"] },
        { ask: "커버리지 목표는?", options: ["안 씀", "라인 70%", "라인 80%", "변경 라인만 80%"] },
      ],
    },
    {
      id: "data",
      heading: "데이터와 격리",
      aliases: ["테스트 데이터", "격리", "픽스처"],
      required: false,
      guide: "픽스처·테스트 더블·DB(인메모리·Testcontainers·공용) 초기화·외부 연동 처리",
      questions: [
        { ask: "테스트 DB 는?", options: ["H2 등 인메모리", "Testcontainers", "공용 개발 DB", "안 씀"] },
        { ask: "외부 연동은?", options: ["mock", "스텁 서버", "실제 호출"] },
      ],
    },
  ],
};

/**
 * 품질·보안 기준 — 무엇을 돌려 무엇을 통과라 하고, 무엇이 반영을 막는가.
 * 무엇을 돌리는지는 매니페스트가, 왜·무엇이 통과인지는 이 문서가 맡는다.
 */
export const QUALITY: DocSchema = {
  kind: "quality",
  label: "품질·보안 기준",
  defaultPath: "doc/quality.md",
  sections: [
    {
      id: "static",
      heading: "정적 분석",
      aliases: ["정적 분석 도구", "린트", "lint", "static analysis"],
      required: true,
      guide: "돌리는 도구·설정 파일 위치와 어떤 명령으로 도는가. ``- `이름`: 도구 — 무엇을 본다``. 자동 검사가 없으면 `- 없음`",
      questions: [
        { ask: "정적 분석은?", options: ["Checkstyle+SpotBugs", "SonarQube", "ESLint·Ruff 등 린터", "컴파일 경고만", "없음"] },
        { ask: "기존 경고는?", options: ["지금 0건이라 새 경고는 즉시 실패", "baseline 을 두고 새 것만", "보고만"] },
      ],
    },
    {
      id: "security",
      heading: "보안 검사",
      aliases: ["보안", "취약점 검사", "security"],
      required: true,
      guide: "의존성 취약점 · 비밀정보 · 코드 보안 규칙 세 갈래를 각각 어떤 명령으로 보는가. 자동 검사가 없는 갈래는 `- 없음 — 리뷰에서 본다`",
      questions: [
        { ask: "의존성 취약점 검사는?", options: ["작업마다", "CI 에서 주기적으로", "안 함"] },
        { ask: "비밀정보 검사는?", options: ["gitleaks 등 자동", "리뷰에서 눈으로", "안 함"] },
      ],
    },
    {
      id: "gate",
      heading: "통과 기준과 반영 차단",
      aliases: ["통과 기준", "차단 기준", "반영 차단"],
      required: true,
      guide: "검사마다 무엇이 통과인가(종료 코드 0 / 심각도 임계 / baseline)와, 어떤 실패가 반영을 막고 어떤 것은 보고로 끝나는가. 예외를 두려면 누가 승인하는가",
      questions: [
        { ask: "차단 임계는?", options: ["Critical 0", "High 이상 0", "CVSS 7.0 이상 0", "보고만"] },
        { ask: "반영을 막는 것은?", options: ["컴파일·테스트·정적 분석·보안 전부", "컴파일·테스트만", "컴파일만"] },
        { ask: "예외는 누가 승인하나?", options: ["지시서의 승인자", "팀 리드", "예외 없음"] },
      ],
    },
    {
      id: "review",
      heading: "리뷰에서 사람이 보는 것",
      aliases: ["사람이 보는 것", "리뷰 체크리스트"],
      required: false,
      guide: "자동 검사가 못 잡아 ⑨ 코드 리뷰에서 확인할 항목 — 권한 확인 위치, 개인정보 로깅, 입력 검증",
      questions: [{ ask: "자동 검사가 못 잡아 리뷰에서 꼭 볼 것은?" }],
    },
  ],
};

/**
 * 공통 KNOWLEDGE — 도입에 빈 뼈대로 만들고 반영(deliver)마다 그 작업 범위만 자란다.
 *
 * 게이트는 파일 존재뿐이다. 섹션 검사도 확정도 없다 — 코드가 3초면 만드는 빈 파일로 작업을 막는 것은 의식이다.
 * 뼈대에 `확인 필요` 를 넣지 않는 것도 같은 이유다(막지 않는 문서의 미결 표시는 영원히 지워지지 않는다).
 */
export const DATA_DICTIONARY: DocSchema = {
  kind: "data-dictionary",
  label: "데이터 사전",
  defaultPath: "doc/knowledge/data-dictionary.md",
  layer: "knowledge",
  sections: [
    {
      id: "entities",
      heading: "엔티티",
      aliases: ["엔티티 목록", "테이블"],
      required: true,
      guide: "항목 하나에 ``### `KEY` 이름`` (KEY 는 공백 없는 테이블/엔티티 키). 본문: 한 줄 설명 · 저장 위치 · 필드 표 · 관계 · 근거(path:line 또는 작업 ID+R번호)",
      questions: [{ ask: "문서로 남길 핵심 엔티티 3~5개는?" }, { ask: "코드에 없지만 알아야 할 데이터 규칙(보존 기간·개인정보·마스킹)이 있나?" }, { ask: "다른 시스템과 공유하는 테이블이 있나?" }],
    },
    {
      id: "codes",
      heading: "공통 코드",
      aliases: ["코드값", "열거형"],
      required: false,
      guide: "여러 도메인이 함께 쓰는 열거형·코드 집합만. 한 엔티티에서만 쓰이면 그 항목 안에 둔다",
      questions: [],
    },
  ],
};

export const API_CATALOG: DocSchema = {
  kind: "api-catalog",
  label: "API 목록",
  defaultPath: "doc/knowledge/api-catalog.md",
  layer: "knowledge",
  sections: [
    {
      id: "endpoints",
      heading: "엔드포인트",
      aliases: ["접점", "API"],
      required: true,
      guide: "항목 하나에 ``### `GET:/api/orders/{id}` 주문 단건 조회``. 본문: 한 줄 설명 · 인증/권한 · 요청·응답 요약 · 오류 코드 · 핸들러 위치(path:line)",
      questions: [{ ask: "외부(다른 팀·외부사)가 쓰는 접점이 있고 그 계약은 고정인가?" }, { ask: "공통 응답 래퍼·오류 코드 체계가 있나? (아키텍처에 썼으면 인용으로 끝)" }, { ask: "버전 정책이 있나?" }],
    },
    {
      id: "conventions",
      heading: "공통 규약",
      aliases: ["공통", "규약"],
      required: false,
      guide: "모든 접점에 걸리는 것만 — 공통 응답 래퍼·페이징·오류 코드 체계·버전 정책. 아키텍처의 `공통 모듈` 과 겹치면 인용한다",
      questions: [],
    },
  ],
};

export const BUSINESS_RULES: DocSchema = {
  kind: "business-rules",
  label: "업무 규칙·용어집",
  defaultPath: "doc/knowledge/business-rules.md",
  layer: "knowledge",
  sections: [
    {
      id: "glossary",
      heading: "용어",
      aliases: ["용어집", "glossary"],
      required: true,
      guide: "표 한 줄에 용어 하나: `용어 | 뜻(한 줄) | 코드에서의 이름`. 뜻과 코드 이름이 어긋나는 것(업무는 '취소', 코드는 VOID)이 이 표의 값어치다",
      questions: [{ ask: "신입이 가장 자주 틀리는 용어 3개는?" }],
    },
    {
      id: "rules",
      heading: "업무 규칙",
      aliases: ["규칙", "business rules"],
      required: true,
      guide: "항목 하나에 ``### `BR-<도메인>-<두자리>` 한 줄 규칙``. 본문: 조건 → 결과 · 적용 범위 · 예외 · 근거. 코드를 보면 아는 구현 세부는 규칙이 아니다",
      questions: [{ ask: "코드만 봐서는 알 수 없는 업무 규칙 하나를 예로 들면? (승인 한도·마감 시각·예외 관례)" }],
    },
  ],
};

export const SCHEMAS: Record<DocKind, DocSchema> = {
  architecture: ARCHITECTURE,
  conventions: CONVENTIONS,
  "test-strategy": TEST_STRATEGY,
  quality: QUALITY,
  "data-dictionary": DATA_DICTIONARY,
  "api-catalog": API_CATALOG,
  "business-rules": BUSINESS_RULES,
};

/**
 * 작업 문서 — 작업 폴더의 번호 문서. 번호가 곧 순서이고, 앞 번호가 뒤 번호의 재료다.
 *
 * 프로젝트 문서와 같은 섹션 검사를 받지만 확정은 따로 없다 — 계획과 한 묶음으로 승인된다.
 * 역공학(explorer)과 사용자 답(questions.md)이 채우므로 질문 목록은 두지 않는다.
 * 섹션 말고 코드가 더 보는 것(R·AC·TC 대조)은 `workDocs.ts` 에 있다.
 */
export type WorkDocKind = "01-requirements" | "02-analysis" | "03-design" | "04-functional" | "07-test-spec";

export const REQUIREMENTS: DocSchema = {
  kind: "01-requirements",
  label: "요구사항 정의",
  defaultPath: "01-requirements.md",
  sections: [
    {
      id: "items", heading: "R1 · <요구 한 줄>", aliases: [], required: true, questions: [],
      guide:
        "요구 하나에 블록 하나(`## R<번호> · <요구 한 줄>`), 번호는 1부터 중복 없이. 블록마다 `근거: \"<지시서 문장 그대로>\"` 한 줄 필수 — " +
        "인용할 문장이 없으면 지시서에 없는 요구다. 이어서 데이터 · 접점(API·화면) · 기존 코드를 건드리는지 한 줄씩 (② 와 ③ 의 범위가 여기서 정해진다)",
    },
    {
      id: "assumptions", heading: "가정", aliases: ["가정과 근거"], required: true, questions: [],
      guide:
        "질문하지 않고 기본값으로 정한 기술 세부 + 근거(컨벤션 위치 · 참조 코드 path:line · 일반 관행). 없으면 `- 없음`. " +
        "승인 화면에 그대로 실려 사람이 계획과 함께 받아들인다",
    },
    {
      id: "outOfScope", heading: "범위 밖", aliases: ["하지 않는 것"], required: false, questions: [],
      guide: "눈에 띄었지만 이번에 하지 않는 것과 근거 — 리뷰가 '빠뜨린 것' 으로 올리지 않게 하는 자리",
    },
  ],
};

export const ANALYSIS: DocSchema = {
  kind: "02-analysis",
  label: "영향도 분석",
  defaultPath: "02-analysis.md",
  sections: [
    {
      id: "current", heading: "기존 시스템 분석", aliases: ["현행 분석", "현행 동작", "기존 시스템"], required: true, questions: [],
      guide: "닿는 파일·모듈이 지금 하는 일, 근거는 path:line. fix 면 결함이 나는 경로까지. 신규 도메인이면 붙을 공통 모듈만",
    },
    {
      id: "impact", heading: "영향 범위", aliases: ["영향", "영향도"], required: true, questions: [],
      guide:
        "표 한 장: `| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |`. **첫 열에 01 의 모든 R 이 한 줄 이상** — " +
        "영향이 없는 R 도 근거와 함께 '없음' 으로 한 줄 넣는다 (코드가 첫 열만 대조한다)",
    },
    {
      id: "risk", heading: "Risk", aliases: ["리스크", "위험"], required: true, questions: [],
      guide: "이 변경이 깨뜨릴 수 있는 것 · 왜 · 완화(테스트·순서·플래그). 없으면 근거와 함께 '없음'",
    },
    {
      id: "callpath", heading: "호출 경로", aliases: ["호출 흐름"], required: false, questions: [],
      guide: "진입점(컨트롤러·핸들러)부터 저장소까지, 필요한 만큼만",
    },
  ],
};

export const DESIGN: DocSchema = {
  kind: "03-design",
  label: "기술 설계",
  defaultPath: "03-design.md",
  sections: [
    {
      id: "components", heading: "구성 요소", aliases: ["컴포넌트", "구성"], required: true, questions: [],
      guide: "만들거나 고칠 계층별 구성 요소와 책임, 기존 것과의 관계. 새 이름은 컨벤션의 명명 규칙대로",
    },
    {
      id: "flow", heading: "처리 흐름", aliases: ["흐름", "처리 순서"], required: true, questions: [],
      guide: "진입점부터 저장소까지 순서. 분기와 트랜잭션 경계가 어디서 열리고 닫히는지",
    },
    {
      id: "api", heading: "API", aliases: ["접점", "엔드포인트"], required: true, questions: [],
      guide:
        "엔드포인트(메서드·경로·담당 R) · 요청(검증 규칙) · 응답(공통 래퍼 이름) · 오류 코드. api-catalog.md 에 있으면 " +
        "키와 그것에 기대는 사실 한 줄을 옮겨 적고 차이만. 접점을 안 건드리면 `해당 없음 — <근거>` (근거 없는 '해당 없음' 은 미충족이다)",
    },
    {
      id: "data", heading: "데이터", aliases: ["엔티티", "데이터 모델"], required: true, questions: [],
      guide:
        "엔티티/테이블 · 필드 표(이름·타입·필수·제약·기본값) · 관계 · 기존 데이터 영향. data-dictionary.md 에 있으면 " +
        "키와 기대는 사실 한 줄을 옮겨 적고 차이만. 데이터를 안 건드리면 `해당 없음 — <근거>`",
    },
    {
      id: "decisions", heading: "설계 결정", aliases: ["결정", "설계 판단"], required: true, questions: [],
      guide: "고른 것과 버린 대안, 이유. 아키텍처 문서와 어긋나는 곳이 있으면 그 자리와 판단을 밝힌다 (plan.json 의 conflicts 로 간다)",
    },
    {
      id: "nonfunctional", heading: "비기능", aliases: ["비기능 요구", "성능·보안"], required: false, questions: [],
      guide: "성능·보안·동시성 중 이번에 실제로 걸리는 것만. 품질·보안 기준이 요구한 항목이 있으면 그것만",
    },
  ],
};

export const FUNCTIONAL: DocSchema = {
  kind: "04-functional",
  label: "기능 명세",
  defaultPath: "04-functional.md",
  sections: [
    {
      id: "functions", heading: "기능 정의", aliases: ["기능", "기능 명세"], required: true, questions: [],
      guide: "R 항목별로 입력 · 처리 · 출력. 사용자 관점 한 문단, 구현 얘기는 03 에 둔다",
    },
    {
      id: "rules", heading: "업무 규칙", aliases: ["규칙", "비즈니스 규칙"], required: true, questions: [],
      guide:
        "`BR-<n>` 한 줄씩: 조건 → 결과 · 근거(사용자 답 Qn · 기존 코드 path:line · business-rules.md 의 키와 그 조건→결과 한 줄). " +
        "근거 없는 규칙은 지어낸 것이다. 없으면 근거와 함께 '없음'",
    },
    {
      id: "exceptions", heading: "예외", aliases: ["예외 처리", "오류"], required: true, questions: [],
      guide: "실패 조건마다: 언제 · 무엇을 돌려주는가(오류 코드 · HTTP 상태) · 근거. 오류 코드는 03 의 API 섹션과 글자까지 같아야 한다",
    },
    {
      id: "acceptance", heading: "수락 기준", aliases: ["인수 기준", "AC"], required: true, questions: [],
      guide:
        "`AC-R<n>-<m>` 한 줄씩, \"~하면 ~이다\" 또는 Given/When/Then. **R 마다 최소 하나**, id 중복 없이. " +
        "⑦ 의 TC 가 이 id 로 되짚고 ⑨ 가 이 목록으로 충족을 판정한다",
    },
  ],
};

export const TEST_SPEC: DocSchema = {
  kind: "07-test-spec",
  label: "테스트 명세",
  defaultPath: "07-test-spec.md",
  sections: [
    {
      id: "cases", heading: "테스트 케이스", aliases: ["케이스", "TC"], required: true, questions: [],
      guide:
        "표 한 장, 열 순서 고정: `| TC-1 | Unit | AC-R1-1 | 케이스 | 기대 결과 |` (TC id · 수준 Unit/Integration/E2E · 대상 AC · 케이스 · 기대 결과). " +
        "**04 의 모든 AC 가 최소 한 줄에 걸린다.** TC id 는 중복 없이, 대상 AC 는 04 에 실재해야 한다. " +
        "AC 하나당 정상 1 + 04 의 `예외` 에서 온 실패 경로 n 으로 출발한다",
    },
    {
      id: "fixtures", heading: "테스트 데이터·환경", aliases: ["테스트 데이터", "환경"], required: false, questions: [],
      guide: "픽스처·더블·외부 연동 — 테스트 전략 문서와 다르게 갈 때만 쓰고 근거를 단다",
    },
    {
      id: "skipped", heading: "안 하는 것", aliases: ["제외", "하지 않는 것"], required: false, questions: [],
      guide: "테스트 전략이 '하지 않음' 이라 한 수준을 이번에 쓰거나, 요구하는 수준을 빼면 근거를 여기에. ⑨ 리뷰가 이 줄을 본다",
    },
  ],
};

export const WORK_SCHEMAS: Record<WorkDocKind, DocSchema> = {
  "01-requirements": REQUIREMENTS,
  "02-analysis": ANALYSIS,
  "03-design": DESIGN,
  "04-functional": FUNCTIONAL,
  "07-test-spec": TEST_SPEC,
};

export function isWorkDocKind(value: string): value is WorkDocKind {
  return value in WORK_SCHEMAS;
}

export function isDocKind(value: string): value is DocKind {
  return value in SCHEMAS;
}

export function isPolicyKind(value: string): value is PolicyKind {
  return (POLICY_KINDS as string[]).includes(value);
}

/** 빈 문서의 뼈대 — 제목과 안내 주석. 역공학·사용자 입력이 이 틀을 채운다 */
export function skeleton(schema: DocSchema): string {
  const lines = [`# ${schema.label}`, ""];
  for (const section of schema.sections) {
    lines.push(`## ${section.heading}`, "");
    lines.push(`<!-- ${section.required ? "필수" : "선택"}: ${section.guide} -->`, "");
    // KNOWLEDGE 의 빈 뼈대에는 미결 표시를 남기지 않는다 — 막지 않는 문서라 아무도 지우러 오지 않는다
    if (section.required && schema.layer !== "knowledge") {
      lines.push(`${GAP_MARKER}`, "");
    }
  }
  return lines.join("\n");
}

/** 사용자 입력으로 채울 때 묻는 것 — 섹션별로 */
export function interview(schema: DocSchema, sectionIds?: string[]): string {
  const lines = [`# ${schema.label} — 사용자 입력 질문`, ""];
  for (const section of schema.sections) {
    if (sectionIds && !sectionIds.includes(section.id)) continue;
    lines.push(`## ${section.heading} (${section.required ? "필수" : "선택"})`, `쓸 것: ${section.guide}`);
    for (const question of section.questions) {
      lines.push(`- ${question.ask}${question.options ? ` — 선택지: ${question.options.join(" / ")} / 기타` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
