/**
 * 요구 개정의 영향 — 확정된 개정의 변경(항목 ID·전후 글)에서 영향받는 분석·계획·검증을 코드가 계산한다. 자연어를 해석하지 않는다.
 *
 * 경로: 바뀐 접수 항목 ID(REQ·DONE·CON) → 01 의 R(`출처:` 가 그 ID) → 승인된 계획의 Task(그 R 담당)·AC(`AC-R<n>-*`) → ⑦ TC(그 AC)
 * → 계획 파일(Task·파일의 담당 R). 바뀐 글(전후 모두)에 보안 낱말(권한·인증·JWT·데이터 계약 …)이 있으면 보안 영향이다.
 * 범위를 입증하지 못한 것은 보수적으로 전체로 본다(`conservative` 에 이유): 새 항목(아직 R 이 없다), R 로 추적되지 않는 ID, 범위 밖(OUT)
 * 변경, 작업 범위 머리말(종류·대상·범위·보존) 변경, 01·승인된 계획이 아직 없음, 개정 기록이 없어 바뀐 항목을 모름.
 *
 * 흐름이 새 확정 개정을 따를 때(request.ts syncRequestRevision) 커서(`request.impacts`, 최근 IMPACT_KEEP 건)에 남고, status·계획 배정·리뷰
 * context 가 그대로 보인다. 검증 게이트는 영향 뒤의 check·test·integrate 실행과 리뷰 회차를 요구한다(`impactAfter`) — 계획이 그대로라 검증
 * 증거의 묶임(기준·트리·매니페스트·계획)이 유지되어도 바뀐 요구로 다시 본다. 같은 트리의 다시 실행은 회차를 쓰지 않고, 그 리뷰 회차는 요구
 * 변경 회차(`cause: "requirement"`)라 리뷰 회차 한도에 세지 않는다.
 */
import { existsSync, readFileSync } from "fs";
import { planFile, type ActiveWork } from "./layout";
import { requirementBlocks, sourceIds } from "./requirementFields";
import type { Change } from "./requirementRevisions";
import { parseTestCases, readWorkDoc } from "./workDocs";

export interface RequirementImpact {
  at: string;
  /** 따르게 된 확정 개정과 앞서 따르던 개정 */
  revision?: number;
  previous?: number;
  /** 바뀐 접수 항목 ID */
  items: string[];
  /** 01 의 R — 출처가 바뀐 항목인 것 */
  requirements: string[];
  tasks: string[];
  acceptance: string[];
  cases: string[];
  files: string[];
  /** 바뀐 글에서 찾은 보안 낱말 */
  security: string[];
  /** 범위를 입증하지 못해 전체로 본 이유 */
  conservative: string[];
}

export const IMPACT_KEEP = 10;

/**
 * 보안 영향 낱말 — 권한·인증·토큰·세션·암호·개인정보와 데이터 계약(스키마·API 계약·마이그레이션). 바뀐 항목의 전후 글에서 대소문자 없이 찾는다.
 * 넓게 잡는다 — 놓치면 보안 테스트가 다시 돌지 않고, 잘못 잡으면 검증을 한 번 더 돌 뿐이다.
 */
const SECURITY_TERMS: readonly [string, RegExp][] = [
  ["권한", /권한|인가|authori[sz]|permission|\broles?\b/i],
  ["인증", /인증|authenticat|로그인|login|sso\b/i],
  ["JWT·토큰", /jwt|토큰|token|oauth|bearer/i],
  ["세션", /세션|session|쿠키|cookie/i],
  ["암호·비밀", /암호|비밀번호|password|secret|encrypt|해시|hash|서명|signature|키 관리|api[ -]?key/i],
  ["개인정보", /개인정보|민감|pii\b|마스킹|masking/i],
  ["데이터 계약", /데이터 계약|스키마|schema|api 계약|응답 형식|요청 형식|contract|마이그레이션|migration|ddl\b|컬럼|column|테이블|table/i],
  ["보안", /보안|security|취약|csrf|xss|cors|injection|인젝션/i],
];

/** 작업 범위를 바꾸는 머리말 — 바뀌면 어디에 닿는지 항목으로 추적할 수 없다 */
const SCOPE_FIELDS = ["kind", "target", "scope", "preserve"];

export interface ImpactInput {
  changes: Change[];
  /** 개정 기록이 없어 바뀐 항목을 모른다(손으로 쓴 지시서·이전 형식) */
  unknownChanges?: boolean;
  analysis?: string;
  plan?: { files?: { path: string; requirements?: string[] }[]; tasks?: { id: string; requirements: string[]; files: string[]; acceptance: string[] }[] };
  testSpec?: string;
  revision?: number;
  previous?: number;
  at?: string;
}

const unique = (values: string[]): string[] => [...new Set(values)];
const byNumber = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

export function requirementImpact(input: ImpactInput): RequirementImpact {
  const conservative: string[] = [];
  const itemChanges = input.changes.filter((change): change is Exclude<Change, { op: "header" }> => change.op !== "header");
  const items = unique(itemChanges.map((change) => change.id)).sort(byNumber);
  if (input.unknownChanges) conservative.push("개정 기록이 없어 바뀐 항목을 알 수 없습니다");
  for (const change of input.changes) {
    if (change.op === "header" && SCOPE_FIELDS.includes(change.field)) conservative.push(`작업 범위 머리말(${change.field})이 바뀌었습니다`);
  }
  const blocks = input.analysis ? requirementBlocks(input.analysis).map((block) => ({ key: block.key, sources: sourceIds(block.sources).ids })) : [];
  if (items.length && !input.analysis) conservative.push("01 이 아직 없어 바뀐 항목의 R 을 알 수 없습니다");
  if (items.length && !input.plan) conservative.push("승인된 계획이 아직 없어 영향받는 Task·파일을 알 수 없습니다");
  const requirements: string[] = [];
  for (const change of itemChanges) {
    if (change.id.startsWith("OUT-")) { conservative.push(`범위 밖 ${change.id} 이 바뀌었습니다 — 범위 밖은 R 로 추적하지 않습니다`); continue; }
    if (change.op === "add") { conservative.push(`새 항목 ${change.id} — 아직 분석·계획에 연결되지 않았습니다`); continue; }
    const owners = blocks.filter((block) => block.sources.includes(change.id)).map((block) => block.key);
    if (input.analysis && !owners.length) conservative.push(`${change.id} 을 출처로 둔 R 이 01 에 없습니다`);
    requirements.push(...owners);
  }
  const keys = unique(requirements).sort(byNumber);
  const tasks = (input.plan?.tasks ?? []).filter((task) => task.requirements.some((key) => keys.includes(key)));
  const acceptance = unique(tasks.flatMap((task) => task.acceptance).filter((ac) => keys.some((key) => ac.startsWith(`AC-${key}-`)))).sort(byNumber);
  const cases = input.testSpec ? parseTestCases(input.testSpec).filter((tc) => tc.acceptance.some((ac) => acceptance.includes(ac))).map((tc) => tc.id) : [];
  const files = unique([
    ...tasks.flatMap((task) => task.files),
    ...(input.plan?.files ?? []).filter((file) => (file.requirements ?? []).some((key) => keys.includes(key))).map((file) => file.path),
  ]).sort();
  const texts = itemChanges.flatMap((change) => change.op === "add" ? [change.text] : change.op === "modify" ? [change.before, change.text] : [change.before]);
  const security = SECURITY_TERMS.filter(([, pattern]) => texts.some((text) => pattern.test(text))).map(([label]) => label);
  return {
    at: input.at ?? new Date().toISOString(),
    ...(input.revision ? { revision: input.revision } : {}), ...(input.previous ? { previous: input.previous } : {}),
    items, requirements: keys, tasks: tasks.map((task) => task.id), acceptance, cases: unique(cases).sort(byNumber), files, security, conservative: unique(conservative),
  };
}

/** 저장소의 01·승인된 계획·⑦ 로 계산한다 — 흐름이 개정을 따르기 직전(아직 다시 분석하지 않은) 문서다 */
export function impactOf(repoRoot: string, active: Pick<ActiveWork, "id" | "target">, input: Pick<ImpactInput, "changes" | "unknownChanges" | "revision" | "previous">): RequirementImpact {
  let plan: ImpactInput["plan"];
  try {
    const path = planFile(repoRoot, active.id, active.target);
    if (existsSync(path)) plan = JSON.parse(readFileSync(path, "utf-8")) as ImpactInput["plan"];
  } catch { plan = undefined; }
  return requirementImpact({ ...input, analysis: readWorkDoc(repoRoot, active.id, "01-requirements"), plan, testSpec: readWorkDoc(repoRoot, active.id, "07-test-spec") });
}

/** 다시 검증할 영향인가 — 계획 파일에 닿았거나, 보안 영향이거나, 범위를 입증하지 못했다 */
export function needsVerify(impact: RequirementImpact): boolean {
  return impact.files.length > 0 || impact.security.length > 0 || impact.conservative.length > 0;
}

/** 시각 뒤의 마지막 검증 대상 영향 — 시각이 없으면(그 실행·회차가 없다) 마지막 검증 대상 영향 */
export function impactAfter(active: Pick<ActiveWork, "request">, at: string | undefined): RequirementImpact | undefined {
  const impact = [...(active.request?.impacts ?? [])].reverse().find(needsVerify);
  return impact && (!at || Date.parse(impact.at) > Date.parse(at)) ? impact : undefined;
}

/** 영향 한 줄 — status·게이트 문구·리뷰 context 가 같은 말을 쓴다 */
export function impactBrief(impact: RequirementImpact): string {
  const label = impact.revision ? `요구 개정 ${impact.revision}` : "요구 변경";
  const parts = [
    impact.items.length ? `항목 ${impact.items.join(", ")}` : "",
    impact.requirements.length ? `R ${impact.requirements.join(", ")}` : "",
    impact.tasks.length ? `Task ${impact.tasks.join(", ")}` : "",
    impact.cases.length ? `TC ${impact.cases.length}개` : "",
    impact.files.length ? `파일 ${impact.files.length}개` : "",
    impact.security.length ? `보안 영향(${impact.security.join("·")})` : "",
    impact.conservative.length ? "범위 미입증 — 전체" : "",
  ].filter(Boolean);
  return `${label}: ${parts.join(" · ") || "영향 없음"}`;
}

/** 영향의 근거 줄 — 범위를 입증하지 못한 이유와 영향받는 AC·TC·파일 */
export function impactLines(impact: RequirementImpact, indent = "  "): string[] {
  const list = (values: string[], limit = 12) => values.length <= limit ? values.join(", ") : `${values.slice(0, limit).join(", ")} 외 ${values.length - limit}개`;
  return [
    ...impact.conservative.map((reason) => `${indent}- 범위 미입증: ${reason}`),
    ...(impact.acceptance.length ? [`${indent}- AC: ${list(impact.acceptance)}`] : []),
    ...(impact.cases.length ? [`${indent}- TC: ${list(impact.cases)}`] : []),
    ...(impact.files.length ? [`${indent}- 파일: ${list(impact.files)}`] : []),
  ];
}

/** 리뷰가 다시 볼 계획 파일 — 보안 영향·범위 미입증이면 계획 파일 전체 */
export function impactReviewFiles(impact: RequirementImpact, planned: readonly string[]): string[] {
  return impact.security.length || impact.conservative.length ? [...planned] : impact.files.filter((path) => planned.includes(path));
}

/** 계획 배정의 영향 절 — 담당이 바뀐 요구에 닿는 부분만 고치게 한다(범위 미입증이면 그렇게 알린다) */
export function impactAssignmentLines(active: Pick<ActiveWork, "request">): string[] {
  const impact = active.request?.impacts?.at(-1);
  if (!impact || !impact.items.length && !impact.conservative.length) return [];
  return [
    `## 이번 요구 변경의 영향 — ${impactBrief(impact)}`,
    ...impactLines(impact, ""),
    impact.conservative.length
      ? "- 범위를 입증하지 못했습니다 — 바뀐 항목이 닿는 곳을 문서 전체에서 다시 확인한다."
      : "- 위 R·AC·TC·파일에 닿는 부분부터 고친다. 닿지 않는 절은 근거 없이 다시 쓰지 않는다 — 다른 절을 고쳐야 하면 그 이유를 결과에 적는다.",
  ];
}
