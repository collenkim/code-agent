import { existsSync, readFileSync } from "fs";
import { join, posix } from "path";

import type { Manifest } from "../core/manifest";
import { formatPlan } from "../core/plan";
import type { BuildPlan } from "../core/types";
import type { WorkKind } from "../core/workOrder";
import { checkSections, docPaths, normalizeHeading, sectionBody, sha } from "./docs";
import { workDocsDir } from "./layout";
import { SCHEMAS, WORK_SCHEMAS } from "./schemas";
import type { WorkDocKind } from "./schemas";

/**
 * 작업 폴더의 번호 문서 — ① 요구사항 → ② 영향도 → ③ 설계 → ④ 기능 → ⑤ 계획 → ⑦ 테스트 명세.
 *
 * 번호가 곧 순서이고 앞 번호가 뒤 번호의 재료다. 코드가 보는 것은 섹션 존재만이 아니라
 * **번호끼리의 대조**다 — 영향 표에 모든 R, R 마다 AC, 모든 AC 가 TC 에. 그 대조가 없으면
 * 문서는 형식만 갖추고 요구 하나가 조용히 사라진다.
 *
 * `05-plan.md` 는 코드가 `plan.json` 에서 렌더한다(파생물) — hook 이 모델의 쓰기를 거부한다.
 */
export const PLAN_DOC_FILE = "05-plan.md";

/** 승인 묶음에 들어가는 고정 목록 — 모델이 쓴 목록에 기대지 않는다 */
const HASHED_KINDS: WorkDocKind[] = ["01-requirements", "02-analysis", "03-design", "04-functional", "07-test-spec"];

export function workDocPath(id: string, kind: WorkDocKind): string {
  return posix.join(workDocsDir(id), WORK_SCHEMAS[kind].defaultPath);
}

export function planDocFile(id: string): string {
  return posix.join(workDocsDir(id), PLAN_DOC_FILE);
}

/** 없거나 비었으면 undefined — 둘 다 "아직 쓰지 않았다" 이다 */
export function readWorkDoc(repoRoot: string, id: string, kind: WorkDocKind): string | undefined {
  const full = join(repoRoot, workDocPath(id, kind));
  if (!existsSync(full)) {
    return undefined;
  }
  const text = readFileSync(full, "utf-8");
  return text.trim() === "" ? undefined : text;
}

function absent(id: string, kind: WorkDocKind): string {
  return `${workDocPath(id, kind)} — 없거나 비어 있습니다 (code-agent docs skeleton ${kind})`;
}

/** 필수 섹션이 비었거나 없는 것 — 프로젝트 문서와 같은 검사다 */
function lackingSections(id: string, kind: WorkDocKind, text: string): string[] {
  const empty = checkSections(WORK_SCHEMAS[kind], text).filter((section) => section.required && !section.filled);
  return empty.length === 0
    ? []
    : [`${workDocPath(id, kind)} — 필수 섹션이 비었거나 없습니다: ${empty.map((section) => section.heading).join(", ")} (code-agent docs skeleton ${kind})`];
}

function lines(body: string): string[] {
  return body.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

// ---- ① 01-requirements.md ----

export interface Requirements {
  /** 요구 항목 번호, 쓴 순서대로 (R1, R2 …) */
  keys: string[];
  /**
   * 질문하지 않고 기본값으로 정한 것 (`## 가정`). 진행을 막지 않는 대신 승인 화면에 그대로 보여
   * 사람이 계획과 함께 받아들인다 — 모든 모호함을 질문으로 막으면 한 줄짜리 요구에도 왕복이 세 번이다.
   */
  assumptions: string[];
}

/** 형식이 틀리면 무엇이 틀렸는지 던진다 */
export function parseRequirements(text: string): Requirements {
  const blocks = text.split(/^## /m).slice(1);
  const items = blocks.filter((block) => /^R\d+\b/.test(block));
  const keys = items.map((block) => /^(R\d+)\b/.exec(block)![1]);
  // 제목 대조는 다른 섹션 검사와 같은 규칙이다 — 번호(`## 1. 가정`)·괄호 설명·스키마의 별칭을 모두 받는다
  const assumptions = WORK_SCHEMAS["01-requirements"].sections.find((section) => section.id === "assumptions")!;
  const names = [assumptions.heading, ...assumptions.aliases].map(normalizeHeading);
  const assumptionsBlock = blocks.find((block) => names.includes(normalizeHeading(block.split("\n")[0])));

  const problems: string[] = [];
  if (keys.length === 0) problems.push("요구 항목(`## R1 · …`)이 없습니다");
  const duplicated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicated.length > 0) problems.push(`요구 항목 번호가 겹칩니다: ${[...new Set(duplicated)].join(", ")}`);
  // 인용할 지시서 문장이 없는 요구는 지시서에 없는 요구다 — 모델이 보탠 것이 여기서 드러난다
  const groundless = items.filter((block) => ![...block.matchAll(/^[ \t]*근거[ \t]*:[ \t]*(.*)$/gm)]
    .some((match) => match[1].replace(/["“”「」]/g, "").trim() !== "")).map((block) => /^(R\d+)/.exec(block)![1]);
  if (groundless.length > 0) {
    problems.push(`근거: 줄이 없는 요구 항목: ${groundless.join(", ")} — 지시서 문장을 그대로 인용하세요`);
  }
  if (!assumptionsBlock) problems.push("`## 가정` 섹션이 없습니다 — 정한 것이 없으면 `- 없음`");
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return { keys, assumptions: firstList(assumptionsBlock).filter((item) => item !== "없음") };
}

/**
 * 섹션의 첫 목록 한 덩어리의 항목들 — 그 뒤에 판정 근거 같은 설명 목록이 붙어도 읽지 않는다.
 *
 * 목록 앞의 산문("아래와 같이 정했다.")은 건너뛴다 — 거기서 끊으면 가정이 몇 줄이든 빈 배열이 되어
 * 승인 화면에도 `05-plan.md` 에도 실리지 않는다. 줄은 먼저 다듬는다 (CRLF 의 `\r` 까지).
 */
function firstList(block: string | undefined): string[] {
  const lines = (block ?? "").split("\n").slice(1).map((line) => line.trim());
  const start = lines.findIndex((line) => /^[-*]\s+\S/.test(line));
  const items: string[] = [];
  for (let index = start; index >= 0 && index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") continue;
    const item = /^[-*]\s+(\S.*)$/.exec(line);
    if (!item) break;
    items.push(item[1].trim());
  }
  return items;
}

/** 없으면 undefined. 있는데 형식이 틀리면 던진다 */
export function loadRequirements(repoRoot: string, id: string): Requirements | undefined {
  const text = readWorkDoc(repoRoot, id, "01-requirements");
  return text ? parseRequirements(text) : undefined;
}

// ---- ② 02-analysis.md ----

/** 표 첫 열의 요구 항목 번호와 그 줄의 나머지 칸 — 본문 아무 데나 번호가 등장하는 것으로 통과시키지 않는다 */
function tableRows(body: string): { key: string; rest: string[] }[] {
  return lines(body)
    .filter((line) => line.startsWith("|"))
    .map((line) => {
      const cells = line.split("|").slice(1);
      const key = /\b(R\d+)\b/.exec(cells[0] ?? "")?.[1];
      return key === undefined ? undefined : { key, rest: cells.slice(1).map((cell) => cell.trim()) };
    })
    .filter((row): row is { key: string; rest: string[] } => row !== undefined);
}

/** 근거로 읽는 `path:line` — 스키마 guide 가 이미 요구하는 형태를 코드로 옮긴 것이다 */
const EVIDENCE_REF = /[\w./-]+\.[A-Za-z]\w*:\d+/;

/**
 * `기존 시스템 분석` 을 한 단어로 비우는 길을 닫는다 — **fix·refactor 에서만**.
 *
 * feature 의 대상은 이제부터 만들 도메인이라 "지금 하는 일" 이 없을 수 있지만, 고치는 작업에서
 * 그 절이 비면 뒤의 모든 판단(무엇을 고치는가 · 무엇이 보존되는가)이 근거를 잃는다.
 * 두 규칙을 같이 거는 이유 — `해당 없음` 금지만으로는 "결함이 있다" 한 줄이 통과한다.
 */
function currentSectionProblems(id: string, text: string, kind: WorkKind): string[] {
  if (kind !== "fix" && kind !== "refactor") {
    return [];
  }
  const path = workDocPath(id, "02-analysis");
  const current = sectionBody(WORK_SCHEMAS["02-analysis"], text, "current");
  const what = kind === "fix" ? "**결함이 나는 경로**를 적습니다" : "**지금 동작**을 적습니다";
  const problems: string[] = [];
  // 03 과 같은 규칙으로 목록 표시·강조를 벗기고 본다
  const body = lines(current).map((line) => line.replace(/^[-*+]\s+/, "").replace(/\*\*/g, "").trim());
  // 규칙은 "'해당 없음' 으로 **비울** 수 없다" 이지 "그 말을 쓸 수 없다" 가 아니다. 한 줄이라도 걸면,
  // 다 쓴 분석에 `- 캐시 계층: 해당 없음 — 이 경로는 캐시를 타지 않는다` 같은 하위 항목 하나로 막힌다.
  if (body.length > 0 && body.every((line) => NOT_APPLICABLE.test(line))) {
    problems.push(`${path} — ${kind} 는 기존 시스템 분석에 ${what}: '해당 없음' 으로 비울 수 없습니다`);
  }
  if (!EVIDENCE_REF.test(current)) {
    problems.push(`${path} — ${kind} 는 기존 시스템 분석에 ${what}: 근거 path:line 이 최소 하나 있어야 합니다`);
  }
  return problems;
}

export function analysisProblems(repoRoot: string, id: string, keys: string[], kind: WorkKind): string[] {
  const text = readWorkDoc(repoRoot, id, "02-analysis");
  if (!text) {
    return [absent(id, "02-analysis")];
  }
  const path = workDocPath(id, "02-analysis");
  const problems = [...lackingSections(id, "02-analysis", text), ...currentSectionProblems(id, text, kind)];
  const rows = tableRows(sectionBody(WORK_SCHEMAS["02-analysis"], text, "impact"));
  const uncovered = keys.filter((key) => !rows.some((row) => row.key === key));
  if (uncovered.length > 0) {
    problems.push(
      `${path} — 영향 범위 표에 없는 요구 항목: ${uncovered.join(", ")}` +
        " (표 첫 열에 R 번호로 한 줄씩. 영향이 없으면 근거와 함께 '없음')",
    );
  }
  // R 번호만 적고 나머지 칸을 비우면 '영향을 봤다'가 아니라 '표를 채웠다'다 — 근거가 없는 줄은 없는 줄로 본다
  const blank = rows.filter((row) => row.rest.every((cell) => cell === "")).map((row) => row.key);
  if (blank.length > 0) {
    problems.push(`${path} — 영향 범위 표의 줄이 비었습니다: ${blank.join(", ")} (닿는 곳·부르는 곳·파급을 채우고, 영향이 없으면 근거와 함께 '없음')`);
  }
  return problems;
}

// ---- ③ 03-design.md ----

/** 근거 없는 `해당 없음` 은 미충족이다 — 조건부 섹션을 한 단어로 비우는 길을 닫는다 */
const NOT_APPLICABLE = /^해당\s*없음/;
const NOT_APPLICABLE_WITH_REASON = /^해당\s*없음\s*[—–-]\s*\S/;

export function designProblems(repoRoot: string, id: string): string[] {
  const text = readWorkDoc(repoRoot, id, "03-design");
  if (!text) {
    return [absent(id, "03-design")];
  }
  const schema = WORK_SCHEMAS["03-design"];
  const problems = lackingSections(id, "03-design", text);
  const groundless = schema.sections
    .filter((section) => section.required)
    .filter((section) =>
      // 목록 표시·강조를 벗기고 본다 — `- 해당 없음` · `**해당 없음**` 이 검사를 비껴가면 근거 없이 섹션을 비우는 길이 그대로다
      lines(sectionBody(schema, text, section.id))
        .map((line) => line.replace(/^[-*+]\s+/, "").replace(/\*\*/g, "").trim())
        .some((line) => NOT_APPLICABLE.test(line) && !NOT_APPLICABLE_WITH_REASON.test(line)),
    );
  if (groundless.length > 0) {
    problems.push(
      `${workDocPath(id, "03-design")} — 해당 없음 에 근거가 없습니다: ${groundless.map((section) => section.heading).join(", ")}` +
        " (`해당 없음 — <근거>` 로 왜 안 건드리는지 씁니다)",
    );
  }
  return problems;
}

// ---- ④ 04-functional.md ----

/** 글에 있는 수락 기준 id, 쓴 순서대로 */
function acceptanceIds(text: string): string[] {
  return [...text.matchAll(/\bAC-R(\d+)-(\d+)\b/g)].map((match) => match[0]);
}

/** ④ 의 `수락 기준` 섹션에 있는 id — 다른 섹션에서 인용한 id 는 기준이 아니다 */
export function acceptanceCriteria(text: string): string[] {
  return [...new Set(acceptanceIds(sectionBody(WORK_SCHEMAS["04-functional"], text, "acceptance")))];
}

export function functionalProblems(repoRoot: string, id: string, keys: string[]): { problems: string[]; acceptance: string[] } {
  const text = readWorkDoc(repoRoot, id, "04-functional");
  if (!text) {
    return { problems: [absent(id, "04-functional")], acceptance: [] };
  }
  const path = workDocPath(id, "04-functional");
  const problems = lackingSections(id, "04-functional", text);
  const acceptance = acceptanceIds(sectionBody(WORK_SCHEMAS["04-functional"], text, "acceptance"));

  const duplicated = acceptance.filter((ac, index) => acceptance.indexOf(ac) !== index);
  if (duplicated.length > 0) {
    problems.push(`${path} — 수락 기준 id 가 겹칩니다: ${[...new Set(duplicated)].join(", ")}`);
  }
  const unknown = [...new Set(acceptance.filter((ac) => !keys.includes(/^AC-(R\d+)-/.exec(ac)![1])))];
  if (unknown.length > 0) {
    problems.push(`${path} — 01 에 없는 요구 항목을 가리키는 수락 기준: ${unknown.join(", ")}`);
  }
  const uncovered = keys.filter((key) => !acceptance.some((ac) => ac.startsWith(`AC-${key}-`)));
  if (uncovered.length > 0) {
    problems.push(`${path} — AC 가 없는 요구 항목: ${uncovered.join(", ")} (\`AC-<R번호>-1\` 로 R 마다 최소 하나)`);
  }
  return { problems, acceptance: [...new Set(acceptance)] };
}

// ---- ⑦ 07-test-spec.md ----

const TEST_LEVELS = ["Unit", "Integration", "E2E"] as const;
export type TestLevel = (typeof TEST_LEVELS)[number];

export interface TestCase {
  id: string;
  level: TestLevel;
  /** 이 케이스가 덮는 수락 기준 */
  acceptance: string[];
  /** 무엇을 하는가 · 무엇이 되는가 — 둘 다 없으면 케이스가 아니라 칸만 채운 줄이다 */
  scenario: string;
  expected: string;
}

/** 표 한 줄: `| TC-1 | Unit | AC-R1-1 | 케이스 | 기대 결과 |` — 열 순서와 개수가 고정이다 */
const TEST_CASE_ROW = /^\|\s*(TC-\d+)\s*\|\s*(Unit|Integration|E2E)\s*\|([^|]+)\|([^|]*)\|([^|]*)\|/i;

export function parseTestCases(text: string): TestCase[] {
  return lines(sectionBody(WORK_SCHEMAS["07-test-spec"], text, "cases"))
    .map((line) => TEST_CASE_ROW.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      id: match[1],
      level: TEST_LEVELS.find((level) => level.toLowerCase() === match[2].toLowerCase())!,
      acceptance: acceptanceIds(match[3]),
      scenario: match[4].trim(),
      expected: match[5].trim(),
    }));
}

/**
 * ⑦ 의 `## 재현` 절이 가리키는 TC id — 쓴 순서대로, 중복 제거.
 *
 * 표가 아니라 절로 둔 것은 열 순서·개수 계약을 종류마다 갈라 놓지 않기 위해서다
 * (`sectionsOf` 가 문서의 실제 `##` 로 경계를 잡아 `cases` 파싱에 닿지 않는다).
 */
export function reproCases(text: string): string[] {
  const body = sectionBody(WORK_SCHEMAS["07-test-spec"], text, "repro");
  return [...new Set([...body.matchAll(/\bTC-\d+\b/g)].map((match) => match[0]))];
}

const LEVEL_NAMES: Record<TestLevel, RegExp> = {
  Unit: /unit|단위/i,
  Integration: /integration|통합/i,
  E2E: /e2e/i,
};

/** 목록 한 줄의 앞(수준 이름)과 뒤(그 수준을 어떻게 하는가) — `- Unit: 분기 있는 로직만` */
function itemHead(line: string): string {
  return line.split(/[:：—–]/)[0];
}
function itemTail(line: string): string {
  return line.split(/[:：—–]/).slice(1).join(" ").trim();
}

/**
 * 테스트 전략이 `하지 않음` 이라 한 수준. 전략에서 수준을 하나도 읽지 못하면 undefined —
 * 못 읽은 것을 위반으로 만들지 않는다 (사람이 쓴 문장을 파싱하는 자리라 헛방이 비싸다).
 *
 * 수준 이름은 **앞쪽**에서 찾고 부정은 **값 쪽이 그것으로 시작할 때만** 본다. 줄 전체에 걸면
 * `- Unit: 분기 있는 로직만 — 단순 위임은 하지 않음` 이 Unit 을 '하지 않음' 으로 만들어,
 * 정상적인 계획 제출이 확정된 POLICY 문서를 고쳐야만 풀리는 자리에서 막힌다.
 */
function skippedLevels(repoRoot: string, manifest: Manifest | undefined): TestLevel[] | undefined {
  const path = join(repoRoot, docPaths(manifest, "test-strategy")[0]);
  if (!existsSync(path)) {
    return undefined;
  }
  const body = lines(sectionBody(SCHEMAS["test-strategy"], readFileSync(path, "utf-8"), "levels"));
  const named = TEST_LEVELS.map((level) => ({
    level,
    line: body.find((line) => LEVEL_NAMES[level].test(itemHead(line))),
  })).filter((entry) => entry.line !== undefined);
  return named.length === 0
    ? undefined
    : named.filter((entry) => /^(하지\s*않|안\s*함)/.test(itemTail(entry.line!))).map((entry) => entry.level);
}

/**
 * ⑦ 테스트 명세 — 계획과 **함께** 승인된다. 여기서 막지 않으면 테스트 없는 계획이 승인 화면에 올라가고,
 * 구현 뒤에 "무엇을 검증할 것이었나"가 구현을 보고 정해진다.
 */
export function testSpecProblems(
  repoRoot: string,
  id: string,
  acceptance: string[],
  manifest: Manifest | undefined,
  kind: WorkKind,
): { problems: string[]; notes: string[] } {
  const text = readWorkDoc(repoRoot, id, "07-test-spec");
  if (!text) {
    return { problems: [absent(id, "07-test-spec")], notes: [] };
  }
  const path = workDocPath(id, "07-test-spec");
  const problems = lackingSections(id, "07-test-spec", text);
  const notes: string[] = [];
  const cases = parseTestCases(text);
  if (cases.length === 0) {
    problems.push(`${path} — 테스트 케이스 표를 읽지 못했습니다: \`| TC-1 | Unit | AC-R1-1 | 케이스 | 기대 결과 |\` 형식으로 쓰세요`);
    return { problems, notes };
  }

  const ids = cases.map((entry) => entry.id);
  const duplicated = ids.filter((tc, index) => ids.indexOf(tc) !== index);
  if (duplicated.length > 0) {
    problems.push(`${path} — TC id 가 겹칩니다: ${[...new Set(duplicated)].join(", ")}`);
  }
  const empty = cases.filter((entry) => entry.acceptance.length === 0).map((entry) => entry.id);
  if (empty.length > 0) {
    problems.push(`${path} — 대상 AC 가 없는 테스트 케이스: ${empty.join(", ")} (세 번째 열에 04 의 AC id)`);
  }
  // 케이스·기대 결과가 빈 줄은 AC 를 덮은 것이 아니다 — 한 줄로 모든 AC 커버리지를 채우는 길을 닫는다
  const half = cases.filter((entry) => entry.scenario === "" || entry.expected === "").map((entry) => entry.id);
  if (half.length > 0) {
    problems.push(`${path} — 케이스·기대 결과가 빈 테스트 케이스: ${half.join(", ")} (네 번째·다섯 번째 열에 무엇을 하고 무엇이 되는지)`);
  }
  const unknown = [...new Set(cases.flatMap((entry) => entry.acceptance).filter((ac) => !acceptance.includes(ac)))];
  if (unknown.length > 0) {
    problems.push(`${path} — 04 에 없는 수락 기준을 가리킵니다: ${unknown.join(", ")}`);
  }
  const covered = new Set(cases.flatMap((entry) => entry.acceptance));
  const uncovered = acceptance.filter((ac) => !covered.has(ac));
  if (uncovered.length > 0) {
    problems.push(`${path} — 테스트 케이스가 없는 수락 기준: ${uncovered.join(", ")} (모든 AC 가 최소 한 TC 에 걸립니다)`);
  }

  // fix 는 '무엇이 결함인가' 를 TC 로 지목해야 재현을 강제할 자리가 생긴다 — 여기서 비면
  // code-agent repro 가 무엇을 돌려 무엇을 봐야 하는지 알 수 없다.
  if (kind === "fix") {
    const repro = reproCases(text);
    if (repro.length === 0) {
      problems.push(`${path} — fix 는 \`## 재현\` 절에 결함을 재현하는 TC id 를 최소 하나 적습니다 (\`- TC-1\`). 수준은 무엇이든 됩니다`);
    }
    const stray = repro.filter((tc) => !ids.includes(tc));
    if (stray.length > 0) {
      problems.push(`${path} — \`## 재현\` 이 표에 없는 TC 를 가리킵니다: ${stray.join(", ")}`);
    }
  }

  // 전략이 '하지 않음' 이라 한 수준을 쓰려면 `안 하는 것` 에 근거가 있어야 한다 — 전략을 조용히 벗어나지 않게.
  const skipped = skippedLevels(repoRoot, manifest);
  if (!skipped) {
    notes.push("테스트 전략의 `수준과 범위` 에서 수준을 읽지 못해 수준 대조는 건너뛰었습니다.");
  } else {
    const used = [...new Set(cases.map((entry) => entry.level))].filter((level) => skipped.includes(level));
    const reason = lines(sectionBody(WORK_SCHEMAS["07-test-spec"], text, "skipped"));
    if (used.length > 0 && reason.length === 0) {
      problems.push(
        `${path} — 테스트 전략이 '하지 않음' 이라 한 수준을 씁니다: ${used.join(", ")}` +
          " (`안 하는 것` 에 근거를 적거나 전략의 수준을 따르세요)",
      );
    }
  }
  return { problems, notes };
}

// ---- 승인 묶음 ----

function normalized(repoRoot: string, path: string): string {
  const full = join(repoRoot, path);
  return existsSync(full) ? readFileSync(full, "utf-8").replace(/\r\n/g, "\n") : "";
}

/** 지시서 본문 — 머리말은 orderHash 가 이미 덮으므로 뺀다 */
export function orderBody(text: string): string {
  const all = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  if (all[0]?.trim() !== "---") {
    return all.join("\n");
  }
  const end = all.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end < 0 ? all.join("\n") : all.slice(end + 1).join("\n");
}

/**
 * 계획과 한 묶음으로 승인되는 것의 해시 — **고정 목록**이다.
 * 지시서 본문 · 01 · 02 · 03 · 04 · 07. 모델이 쓴 문서 목록에 기대면 목록에서 빼는 것이 곧 검사를 끄는 것이 된다.
 * 줄바꿈(CRLF/LF)만 바뀐 것은 바뀐 것으로 보지 않는다 (프로젝트 문서 확정과 같은 이유 — autocrlf).
 */
export function workDocsHash(repoRoot: string, id: string, spec: string): string {
  const entries = [
    `${spec}#본문:${sha(orderBody(normalized(repoRoot, spec)))}`,
    ...HASHED_KINDS.map((kind) => {
      const path = workDocPath(id, kind);
      return `${path}:${sha(normalized(repoRoot, path))}`;
    }),
  ];
  return sha(entries.join("\n"));
}

// ---- ⑤ 05-plan.md (코드가 렌더한다) ----

/** 승인하면 함께 받아들이는 가정 — 승인 화면·제출 결과·05-plan.md 에 같은 모양으로 */
export function formatAssumptions(assumptions: string[]): string | undefined {
  if (assumptions.length === 0) {
    return undefined;
  }
  return [
    `가정 ${assumptions.length}개 — 승인하면 계획과 함께 받아들입니다. 틀린 것이 있으면 반려하세요:`,
    ...assumptions.map((item) => `  - ${item}`),
  ].join("\n");
}

/**
 * 제출된 계획을 사람이 읽는 문서로. `plan.json` 의 파생물이라 게이트가 없고, 대신 hook 이 모델의 쓰기를 거부한다 —
 * 승인 화면에 찍는 것과 같은 렌더러를 파일로도 내보내, 승인한 사람과 구현하는 모델이 같은 것을 본다.
 */
export function renderPlanDoc(id: string, plan: BuildPlan, assumptions: string[]): string {
  const lines = [
    `# ${id} 구현 계획`,
    "",
    `<!-- 이 파일은 code-agent plan submit 이 ${workDocsDir(id)}/plan.json 에서 렌더한다. 직접 고치지 않는다 — 고칠 것은 plan.json 에 쓰고 다시 제출한다. -->`,
    "",
    formatPlan(plan),
  ];
  if (assumptions.length > 0) {
    lines.push("", "### 가정 (01-requirements.md)", ...assumptions.map((item) => `- ${item}`));
  }
  return `${lines.join("\n")}\n`;
}
