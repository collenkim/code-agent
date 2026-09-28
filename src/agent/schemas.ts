/**
 * 프로젝트 필수 문서의 스키마 — 어떤 섹션이 있어야 하고, 비었을 때 무엇을 물어야 하는가.
 *
 * 섹션 검사는 코드가 한다(제목 대조). 섹션을 채우는 것은 역공학이나 사용자 입력이고,
 * 그때 무엇을 물을지도 여기서 온다 — 질문이 실행마다 달라지지 않게.
 */
export type DocKind = "architecture" | "conventions";

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
      required: true,
      guide: "무엇을 어느 수준으로 테스트하나, 테스트 위치·이름·픽스처 방식, 사용하는 도구",
      questions: [
        { ask: "기본 테스트 수준은?", options: ["단위 테스트 위주", "슬라이스 테스트(@DataJpaTest 등)", "통합 테스트(@SpringBootTest)", "테스트 없음"] },
        { ask: "테스트 이름·위치 규칙은?" },
      ],
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

export const SCHEMAS: Record<DocKind, DocSchema> = { architecture: ARCHITECTURE, conventions: CONVENTIONS };

/**
 * 작업 문서 — 분석이 필요하다고 할 때 작업 폴더에 **요구사항 범위만** 만든다.
 *
 * 프로젝트 문서와 같은 섹션 검사를 받지만 확정은 따로 없다 — 계획과 한 묶음으로 승인된다.
 * 역공학(explorer)과 사용자 답(questions.md)이 채우므로 질문 목록은 두지 않는다.
 */
export type WorkDocKind = "data" | "api" | "current";

export const DATA: DocSchema = {
  kind: "data",
  label: "데이터 정의",
  defaultPath: "data.md",
  sections: [
    {
      id: "entities", heading: "대상 엔티티", aliases: ["대상", "엔티티", "테이블"], required: true, questions: [],
      guide: "이번 요구 항목이 만들거나 바꾸는 엔티티·테이블만 — 새로 만드는지 바꾸는지, 담당 요구 항목(R 번호)",
    },
    {
      id: "fields", heading: "필드", aliases: ["컬럼", "속성"], required: true, questions: [],
      guide: "엔티티별 표: 이름 · 타입 · 필수 · 길이/정밀도 · 제약 · 기본값 · 근거(코드 경로 또는 사용자 답 Qn)",
    },
    {
      id: "relations", heading: "관계", aliases: ["연관", "연관관계"], required: false, questions: [],
      guide: "다른 엔티티와의 연결과 방식 (ID 참조 · JPA 연관 등), 존재 확인을 어디서 하는지",
    },
    {
      id: "impact", heading: "기존 데이터 영향", aliases: ["마이그레이션", "기존 데이터"], required: false, questions: [],
      guide: "기존 테이블·데이터가 바뀌면 무엇이 어떻게 — 새 테이블만이면 '없음'",
    },
  ],
};

export const API: DocSchema = {
  kind: "api",
  label: "API 정의",
  defaultPath: "api.md",
  sections: [
    {
      id: "endpoints", heading: "엔드포인트", aliases: ["엔드포인트 목록", "API 목록", "접점"], required: true, questions: [],
      guide: "메서드 · 경로 · 하는 일 · 담당 요구 항목(R 번호) · 새로 만드는지 바꾸는지",
    },
    {
      id: "request", heading: "요청", aliases: ["요청 형식", "request"], required: true, questions: [],
      guide: "엔드포인트별 경로 변수 · 쿼리 · 본문 필드와 검증 규칙",
    },
    {
      id: "response", heading: "응답", aliases: ["응답 형식", "response"], required: true, questions: [],
      guide: "성공 응답의 모양 — 프로젝트의 공통 응답 래퍼를 따르면 그 이름과 함께",
    },
    {
      id: "errors", heading: "오류", aliases: ["예외", "오류 응답", "errors"], required: true, questions: [],
      guide: "실패 조건마다 오류 코드 · HTTP 상태 · 근거 (없는 id, 검증 실패, 참조 대상 없음 …)",
    },
  ],
};

export const CURRENT: DocSchema = {
  kind: "current",
  label: "현행 분석",
  defaultPath: "current.md",
  sections: [
    {
      id: "files", heading: "관련 파일", aliases: ["관련 코드", "대상 파일"], required: true, questions: [],
      guide: "이번 요구 항목이 닿는 파일과 왜 관련되는지 한 줄씩",
    },
    {
      id: "behavior", heading: "현행 동작", aliases: ["현재 동작", "지금 동작"], required: true, questions: [],
      guide: "지금 코드가 실제로 하는 것 (근거 path:line) — fix 면 결함이 나는 경로까지",
    },
    {
      id: "changes", heading: "바뀌는 곳", aliases: ["변경 지점", "고칠 곳"], required: true, questions: [],
      guide: "무엇을 어떻게 바꾸는지, 파일·메서드 단위로",
    },
    {
      id: "impact", heading: "영향 범위", aliases: ["영향", "호출하는 곳"], required: true, questions: [],
      guide: "바뀌는 코드를 부르는 곳과 그쪽에 미치는 영향 — 없으면 근거와 함께 '없음'",
    },
    {
      id: "callpath", heading: "호출 경로", aliases: ["호출 흐름"], required: false, questions: [],
      guide: "진입점(컨트롤러·핸들러)부터 저장소까지, 필요한 만큼만",
    },
  ],
};

export const WORK_SCHEMAS: Record<WorkDocKind, DocSchema> = { data: DATA, api: API, current: CURRENT };

/** 작업 폴더의 이 이름이면 그 스키마. 인용한 프로젝트 문서처럼 이름이 다르면 섹션 검사를 하지 않는다 */
export function workSchemaFor(fileName: string): DocSchema | undefined {
  return Object.values(WORK_SCHEMAS).find((schema) => schema.defaultPath === fileName);
}

export function isDocKind(value: string): value is DocKind {
  return value === "architecture" || value === "conventions";
}

/** 빈 문서의 뼈대 — 제목과 안내 주석. 역공학·사용자 입력이 이 틀을 채운다 */
export function skeleton(schema: DocSchema): string {
  const lines = [`# ${schema.label}`, ""];
  for (const section of schema.sections) {
    lines.push(`## ${section.heading}`, "");
    lines.push(`<!-- ${section.required ? "필수" : "선택"}: ${section.guide} -->`, "");
    if (section.required) {
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
