/**
 * 계획 문서·결과 검사의 규칙 식별자 — 검사 문구 앞의 `[ID]` 와 배정 파일 `## 제출 전 점검` 이 같은 표에서 나온다.
 * 담당은 점검 목록의 ID 로 무엇이 검사되는지 미리 보고, 거부되면 같은 ID 로 어느 점검을 어겼는지 찾는다.
 * 점검 목록은 역할·작업 종류에 걸리는 규칙만 싣는다 — 모든 담당에게 같은 긴 문구를 붙이지 않는다.
 *
 * hook 경로 모듈(stagedChecks·workDocs·planningHook)이 import 하므로 다른 모듈을 import 하지 않는다.
 */

export type RuleId =
  | "REQ-FORMAT" | "REQ-TRACE"
  | "DOC-MISSING" | "DOC-SECTION" | "DOC-PENDING" | "DOC-REF"
  | "IMP-TABLE" | "IMP-CURRENT" | "IMP-LOG" | "IMP-DOC"
  | "DES-NA" | "FUN-AC" | "FUN-BR"
  | "TST-CASE" | "TST-REPRO" | "TST-LEVEL"
  | "PLN-SHAPE" | "PLN-SEQ" | "PLN-PATH" | "PLN-PRESERVE" | "PLN-VERIFY" | "PLN-FIX" | "PLN-REFACTOR"
  | "RES-SCOPE" | "RES-STATUS" | "RES-QREQ" | "RES-OUTPUT";

/** 검사 문구에 규칙 식별자를 붙인다 — 이미 붙은 문구는 그대로 둔다 */
export function ruled(id: RuleId, message: string): string {
  return ruleOf(message) ? message : `[${id}] ${message}`;
}

/** 문구의 규칙 식별자 — 없으면 undefined */
export function ruleOf(message: string): RuleId | undefined {
  const id = /^\[([A-Z]+-[A-Z]+)\] /.exec(message)?.[1];
  return id && RULES.some((rule) => rule.id === id) ? id as RuleId : undefined;
}

/** 여러 줄로 이은 거부 문구 안의 규칙 식별자 전부(등록된 것만, 나온 횟수대로) — 재시도 기록의 규칙별 집계(retryReport) */
export function ruleIdsIn(text: string): RuleId[] {
  return [...text.matchAll(/\[([A-Z]+-[A-Z]+)\]/g)].map((match) => match[1]).filter((id): id is RuleId => RULES.some((rule) => rule.id === id));
}

/** 점검 목록을 만들 때 코드가 채우는 값 — 담당이 옮겨 적거나 세지 않게 실제 ID·경로를 넣는다 */
export interface ChecklistContext {
  role: string;
  kind: string;
  /** 이 배정의 requirements (analysis 는 REQ·DONE·CON, 뒤 단계는 R) */
  requirements: string[];
  outputs: string[];
  /** 지시서에 `## 오류 로그` 가 있다 */
  log: boolean;
  /** 문서 영향 판단이 켜진 작업 */
  knowledge: boolean;
  /** 계획 형식이 preserve 를 요구한다 */
  preserve: boolean;
  /** 단계 key → 쓸 수 있는 위치 */
  stages: { key: string; dirs: string[]; test: boolean }[];
}

const DOC_ROLES = ["analysis", "impact", "synthesis", "design", "plan"];
const IMPACT_ROLES = ["impact", "synthesis"];

interface Rule {
  id: RuleId;
  roles: string[];
  when?: (ctx: ChecklistContext) => boolean;
  check: (ctx: ChecklistContext) => string;
}

const ids = (values: string[]) => values.join(", ") || "(없음)";

export const RULES: readonly Rule[] = [
  { id: "REQ-FORMAT", roles: ["analysis"], check: () => "요구마다 `## R<n> · <한 줄>` 블록, 블록마다 `근거: \"<지시서 문장 그대로>\"` 한 줄 이상, `## 가정` 섹션(정한 것이 없으면 `- 없음`)" },
  { id: "REQ-TRACE", roles: ["analysis"], check: (ctx) => `\`출처:\` 에 지시서 ID 를 글자 그대로(${ids(ctx.requirements)}) 쓰고, 인용들의 합이 각 항목 원문을 전부 덮는다. 인용은 따옴표 안만 보고 설명은 닫는 따옴표 뒤에 둔다. 문장 사이 쉼표·마침표는 빠져도 되지만 숫자·기호·경로·조건은 빠지면 안 된다` },
  { id: "DOC-MISSING", roles: [], check: () => "배정 출력 문서가 있다" },
  { id: "DOC-SECTION", roles: ["impact", "synthesis", "design", "plan"], check: () => "뼈대의 필수 섹션을 모두 채운다(안내 주석만 남은 섹션은 빈 섹션이다)" },
  { id: "DOC-PENDING", roles: DOC_ROLES, check: () => "`확인 필요`·TODO·TBD 를 남기지 않는다 — 업무 결정은 needs-input 질문으로, 기술 기본값은 정한 값과 이유로 적는다" },
  { id: "DOC-REF", roles: DOC_ROLES, check: (ctx) => "근거 `path:line` 은 저장소 루트 기준 전체 경로의 실재하는 파일·줄이다(파일 이름만 쓰지 않는다)" + (ctx.log ? ". 오류 로그의 `File.java:42` 는 로그 글자 그대로 백틱 안에 인용한다 — 근거로 세지 않는다" : "") },
  { id: "IMP-TABLE", roles: IMPACT_ROLES, check: (ctx) => `\`## 영향 범위\` 표 첫 열에 ${ids(ctx.requirements)} 를 한 줄씩, 나머지 칸을 비우지 않는다(영향이 없으면 근거와 함께 '없음')` },
  { id: "IMP-CURRENT", roles: IMPACT_ROLES, when: (ctx) => ctx.kind === "fix" || ctx.kind === "refactor", check: (ctx) => `\`## 기존 시스템 분석\` 에 ${ctx.kind === "fix" ? "결함이 나는 경로" : "지금 동작"} 과 근거 path:line 최소 하나 — '해당 없음' 으로 비우지 않는다` },
  { id: "IMP-LOG", roles: IMPACT_ROLES, when: (ctx) => ctx.kind === "fix" && ctx.log, check: () => "`## 기존 시스템 분석` 에 로그 대응 줄 하나 이상 — 로그 문구를 백틱으로 글자 그대로(8자 이상) 인용하고 같은 줄 백틱 밖에 저장소에 있는 원인 코드 path:line. 예: `- \\`NullPointerException: items is null\\` → src/main/java/app/OrderService.java:42 — items 를 확인하지 않는다`" },
  { id: "IMP-DOC", roles: IMPACT_ROLES, when: (ctx) => ctx.knowledge, check: () => "`## 문서 영향` 표 `| 문서 | 키 | 판단 | 근거 |` — 영향 범위 표의 파일을 근거로 든 지식 항목을 모두 판단한다. context 후보 목록에 없는 파일이면 지식 문서 폴더를 그 경로로 Grep 해 확인한다" },
  { id: "DES-NA", roles: ["design"], check: () => "03 의 `해당 없음` 은 `해당 없음 — <근거>` 로 쓴다" },
  { id: "FUN-AC", roles: ["design"], check: (ctx) => `R 마다(${ids(ctx.requirements)}) \`AC-R<n>-<m>\` 최소 하나, 번호 뒤에 구체적인 완료 조건` },
  { id: "FUN-BR", roles: ["design"], check: () => "`## 업무 규칙` 의 `BR-<n>` 정의 줄마다 같은 줄에 근거(실제 path:line · 답변된 Q 번호 · 업무 정책 문서의 BR 키). 정의한 BR 을 AC 등에서 가리킬 때는 근거를 되풀이하지 않아도 된다. 같은 BR 을 두 번 정의하지 않는다" },
  { id: "TST-CASE", roles: ["plan"], check: () => "07 표 `| TC-<n> | Unit·Integration·E2E | AC-… | 케이스 | 기대 결과 |` — 모든 TC에 04의 AC, 모든 AC에 실행 가능한 TC를 연결한다. 입력·호출·구체적인 기대값이나 오류를 단언한다. 전체 테스트 통과·기존 파일 보존 자체는 독립 TC가 아니라 실행 절차·preserve에 둔다" },
  { id: "TST-REPRO", roles: ["plan"], when: (ctx) => ctx.kind === "fix", check: (ctx) => "07 `## 재현` 에 결함을 재현하는 TC id(`- TC-1`)" + (ctx.log ? ". 로컬 재현이 안 되면 `- 방식: 로그 근거 — <사유>`" : "") },
  { id: "TST-LEVEL", roles: ["plan"], check: () => "테스트 전략이 '하지 않음' 이라 한 수준을 쓰면 07 `## 안 하는 것` 에 근거" },
  { id: "PLN-SHAPE", roles: ["plan"], check: (ctx) => `plan.json 은 planShape 그대로 — tasks(파일 소유·의존성·AC), 모든 파일에 requirements, 모든 R(${ids(ctx.requirements)})이 어떤 파일에 닿고, openQuestions 는 비운다(질문은 needs-input)` },
  { id: "PLN-SEQ", roles: ["plan"], check: () => "sequence의 단계 순서·why를 채우고 각 tasks의 requirements마다 대응 AC-R번호를 acceptance에 넣는다. 테스트 담당도 예외가 아니다. 그 AC를 07의 실행 가능한 TC까지 연결하고 연결이 없으면 제출 전에 고친다" },
  { id: "PLN-PATH", roles: ["plan"], check: (ctx) => `files 의 stage·path 는 단계 위치 안 — ${ctx.stages.map((stage) => `${stage.key}: ${stage.dirs.join(", ") || "제한 없음"}`).join(" · ")}` },
  { id: "PLN-PRESERVE", roles: ["plan"], when: (ctx) => ctx.preserve, check: () => "지시서의 보존 항목을 계획 preserve 에 모두" },
  { id: "PLN-VERIFY", roles: ["plan"], check: () => "검증 명령(build·test·commands)이 가리키는 파일을 계획 files 에 넣지 않는다" },
  { id: "PLN-FIX", roles: ["plan"], when: (ctx) => ctx.kind === "fix", check: (ctx) => `sequence[0] 은 테스트 단계, 재현 테스트 파일은 테스트 단계 위치(${ids(ctx.stages.filter((stage) => stage.test).flatMap((stage) => stage.dirs))}) 안에` },
  { id: "PLN-REFACTOR", roles: ["plan"], when: (ctx) => ctx.kind === "refactor", check: () => "기존 테스트 파일은 계획 files 에 넣지 않고, 07 의 TC 는 기존 테스트의 TC ID 를 재사용한다(inputs 의 테스트 파일)" },
  { id: "RES-SCOPE", roles: ["*"], check: () => "evidence·facts·findings 의 출처는 inputs 와 dependencies 근거의 실제 파일·줄만(이 배정의 출력 문서는 근거가 아니다)" },
  { id: "RES-STATUS", roles: ["*"], check: () => "completed 는 근거 하나 이상·질문 없음, needs-input 은 질문 하나 이상" },
  { id: "RES-QREQ", roles: ["*"], check: (ctx) => `질문의 requirements 는 ${ids(ctx.requirements)} 중에서` },
  { id: "RES-OUTPUT", roles: ["*"], when: (ctx) => ctx.outputs.length > 0, check: (ctx) => `completed 는 배정 출력(${ctx.outputs.join(", ")}) 전부를 artifacts 에 한 번씩` },
];

/** 역할·작업 종류에 걸리는 규칙 ID — 점검 목록과 시험이 같은 함수를 쓴다 */
export function rulesFor(ctx: ChecklistContext): RuleId[] {
  return RULES.filter((rule) => (rule.roles.includes("*") || rule.roles.includes(ctx.role)) && (rule.when?.(ctx) ?? true)).map((rule) => rule.id);
}

/** 배정 파일의 `## 제출 전 점검` — 완료 hook 이 같은 ID 로 거부한다 */
export function submitChecklist(ctx: ChecklistContext): string {
  const lines = RULES.filter((rule) => rulesFor(ctx).includes(rule.id)).map((rule) => `- [${rule.id}] ${rule.check(ctx)}`);
  return ["## 제출 전 점검", "", "완료 hook 이 아래 규칙으로 결과를 검사하고, 거부하면 같은 `[ID]` 와 문서:줄을 알려 준다.", "", ...lines].join("\n");
}
