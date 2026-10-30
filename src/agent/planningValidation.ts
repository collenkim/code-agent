import { existsSync, readFileSync } from "fs";
import { filePaths } from "../core/fileOperations";
import { join } from "path";
import { buildIndex } from "./knowledgeIndex";
import { questionsFile, workDocsDir } from "./layout";
import { referenceProblem, similarPaths } from "./planningState";
import { ruled } from "./planningRules";
import { normalizeHeading } from "./docs";
import { WORK_SCHEMAS } from "./schemas";
import { errorLogOf } from "../core/workOrder";
import { sourceItems } from "./sourceTrace";
import { parseQuestions } from "./questions";
import type { Work } from "./work";
import { coverageProblems, parseTestCases, readWorkDoc, type DocOverlay } from "./workDocs";
import { testRoots, trackedTestFiles } from "./evidence";
import { codeStages } from "./phaseInfo";
import { hashPlan } from "../core/approval";
import { checkPaths } from "../core/gate";
import { missingPreserve, planFormatFor, sequenceProblems } from "../core/plan";
import type { BuildPlan } from "../core/types";

/** critic이 본 초안과 실제 승인·구현할 제출본이 같은 계획이어야 한다. */
export function reviewedPlanProblems(work: Work): string[] {
  if (!work.active.planningVersion || !work.plan) return [];
  try {
    const format = planFormatFor(work.order.kind);
    const draft = format.toPlan(format.schema.parse(JSON.parse(readFileSync(join(work.repoRoot, workDocsDir(work.active.id), "plan.json"), "utf8"))));
    if (hashPlan(draft) === hashPlan(work.plan)) return [];
  } catch { /* 아래의 재제출 안내로 통합한다. */ }
  return ["독립 검토한 초안과 제출된 계획이 다릅니다. 관찰된 plan.json을 다시 제출하세요."];
}

const REFERENCE = /([\w가-힣./-]+\.[A-Za-z]\w*):(\d+)/g;
const PENDING = /확인\s*필요|\bTODO\b|\bTBD\b/;
const BR_TOKEN = /(?<![\w-])BR-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g;
const flat = (value: string) => value.replace(/\s+/g, " ").trim();
const clip = (value: string) => { const text = flat(value); return text.length > 80 ? `${text.slice(0, 77)}…` : text; };
/** 줄 번호를 지키며 HTML 주석을 지운다 */
const uncommented = (text: string) => text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));

/** 인용 표시 — 백틱·큰따옴표·굽은 따옴표·낫표. 작은따옴표는 문장 속 아포스트로피와 섞여 쓰지 않는다 */
const QUOTED = /`([^`]+)`|"([^"]+)"|“([^”]+)”|「([^」]+)」|『([^』]+)』/g;
/**
 * 근거로 검사하지 않는 자리 — 확정 지시서 원문(오류 로그·요구 내용·완료 조건·제약)의 글자를 그대로 인용한 따옴표·백틱(8자 이상)과
 * 오류 로그를 그대로 옮긴 코드 블록 줄이다. 로그의 `OrderService.java:42`, 요구의 "cache.internal.net:6379 로 연결" 은 사람이 준 글일 뿐
 * 저장소 근거가 아니다 — 01 의 근거 인용(REQ-TRACE)은 이 글자를 그대로 옮기라고 요구한다. 원문에 없는 인용(`src/a.ts:10`)은 그대로 근거로 검사한다.
 */
function sourceQuoteRanges(line: string, fenced: boolean, log: string | undefined, request: readonly string[]): [number, number][] {
  if (fenced) return log && flat(line).length >= 8 && log.includes(flat(line)) ? [[0, line.length]] : [];
  const sources = [...(log ? [log] : []), ...request];
  return [...line.matchAll(QUOTED)].filter((match) => {
    const quote = flat((match.slice(1).find((group) => group !== undefined) ?? "").normalize("NFC"));
    return quote.length >= 8 && sources.some((source) => source.includes(quote));
  }).map((match): [number, number] => [match.index!, match.index! + match[0].length]);
}

/**
 * 04 업무 규칙 — `## 업무 규칙` 절에서 BR 토큰으로 시작하는 줄이 정의다. 정의는 같은 줄에 자기 근거(실제 파일:줄 · 답변된 Q · 업무 정책 문서의 BR 키)가
 * 있어야 한다(다른 로컬 BR 은 근거가 아니다 — 순환 근거). 정의가 아닌 줄(AC·기능 정의)의 BR 은 자기 근거가 있거나, 근거 있는 정의가 정확히 하나면 된다.
 */
function businessRuleProblems(path: string, lines: string[], grounded: (line: string) => boolean): string[] {
  const rules = WORK_SCHEMAS["04-functional"].sections.find((section) => section.id === "rules")!;
  const names = [rules.heading, ...rules.aliases].map(normalizeHeading);
  const definitions = new Map<string, { line: number; grounded: boolean }[]>();
  const uses: { line: number; text: string; tokens: string[] }[] = [];
  const problems: string[] = [];
  let inRules = false;
  lines.forEach((line, index) => {
    if (/^##\s/.test(line)) { inRules = names.includes(normalizeHeading(line.replace(/^##\s+/, ""))); return; }
    const tokens = [...new Set([...line.matchAll(BR_TOKEN)].map((match) => match[0]))];
    if (!tokens.length) return;
    const head = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\s*\|\s*/, "").replace(/^[*_`]+/, "");
    const defined = inRules ? tokens.find((token) => head.startsWith(token) && !/^[\w-]/.test(head.slice(token.length))) : undefined;
    if (!defined) { uses.push({ line: index + 1, text: line, tokens }); return; }
    const own = grounded(line);
    definitions.set(defined, [...definitions.get(defined) ?? [], { line: index + 1, grounded: own }]);
    if (!own) problems.push(ruled("FUN-BR", `${path}:${index + 1}: 업무 규칙 ${defined} 에 근거가 없습니다 — 실제 파일:줄 · 답변된 Q 번호 · 업무 정책 문서의 BR 키 중 하나를 같은 줄에 넣으세요: ${clip(line)}`));
  });
  for (const [token, entries] of definitions) {
    if (entries.length > 1) problems.push(ruled("FUN-BR", `${path}: 업무 규칙 ${token} 이 여러 번 정의됐습니다 (${entries.map((entry) => `${entry.line}행`).join(", ")}) — 한 줄로 합치세요`));
  }
  for (const use of uses) {
    if (grounded(use.text)) continue;
    // 근거 없는 정의·중복 정의는 정의 쪽에서 이미 거부했다 — 여기서는 정의가 아예 없는 BR 만 더한다
    const unknown = use.tokens.filter((token) => !definitions.has(token));
    if (unknown.length) {
      problems.push(ruled("FUN-BR", `${path}:${use.line}: 정의되지 않은 업무 규칙 ${unknown.join(", ")} 를 가리킵니다 — \`## 업무 규칙\` 에 근거와 함께 정의하거나, 이 줄에 실제 파일:줄 · 답변된 Q 번호 · 업무 정책 문서의 BR 키를 넣으세요: ${clip(use.text)}`));
    }
  }
  return problems;
}

/**
 * 신규 흐름의 미결 사항과 실제 근거 검사. 내용의 타당성은 별도 critic이 판단한다.
 * `only` 가 있으면 그 파일 이름만 본다. `overlay` 의 문서(완료 hook 의 staging 본문)는 디스크보다 먼저 읽는다.
 * 문구는 `[규칙 ID] 문서:줄: 문제 — 고칠 방향` 꼴이다.
 */
export function planningDocumentProblems(work: Work, phase: string, options: { overlay?: DocOverlay; only?: string[] } = {}): string[] {
  if (!work.active.planningVersion) return [];
  const all = ["01-requirements.md", ...(phase !== "analysis" ? ["02-analysis.md"] : []), ...(["design", "plan"].includes(phase) ? ["03-design.md", "04-functional.md"] : []), ...(phase === "plan" ? ["07-test-spec.md"] : [])];
  const files = options.only ? all.filter(file => options.only!.includes(file)) : all;
  const root = work.repoRoot, dir = workDocsDir(work.active.id), problems: string[] = [];
  const questionsPath = join(root, dir, "questions.md");
  const answered = existsSync(questionsPath) ? parseQuestions(readFileSync(questionsPath, "utf8")).filter(question => question.answer).map(question => question.id) : [];
  let rules: string[] | undefined;
  const knownRules = (): string[] => (rules ??= buildIndex(root, work.manifest, []).entries.filter(entry => entry.kind === "business-rules").map(entry => entry.key));
  // 업무 정책 문서에 이미 있는 BR 키를 가리키면 근거다 — 정책 본문은 한곳(business-rules)에 두고 작업 문서는 ID 로 잇는다.
  // 지시서 원문을 그대로 인용한 자리의 `파일:줄`은 DOC-REF 처럼 근거로 보지 않는다(sourceQuoteRanges)
  const grounded = (line: string): boolean => new RegExp(REFERENCE.source).test(sourceQuoteRanges(line, false, log, request).reduce((text, [from, to]) => text.slice(0, from) + " ".repeat(to - from) + text.slice(to), line))
    || answered.some(id => new RegExp(`\\b${id}\\b`).test(line))
    || knownRules().some(key => new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(line));
  let log: string | undefined, request: string[] = [];
  try {
    const spec = readFileSync(join(root, work.active.spec), "utf8"), logged = errorLogOf(spec);
    log = logged && "log" in logged ? flat(logged.log) : undefined;
    request = sourceItems(spec).map((item) => flat(item.text.normalize("NFC")));
  } catch { /* 지시서가 없으면 원문 인용도 없다 */ }
  for (const file of files) {
    const path = `${dir}/${file}`;
    const staged = options.overlay?.get(path);
    if (staged === undefined && !existsSync(join(root, path))) { problems.push(ruled("DOC-MISSING", `필수 계획 문서가 없습니다: ${path}`)); continue; }
    const lines = uncommented(staged ?? readFileSync(join(root, path), "utf8")).split(/\r?\n/);
    const pending: string[] = [];
    let fenced = false;
    lines.forEach((line, index) => {
      if (/^\s*(?:`{3,}|~{3,})/.test(line)) { fenced = !fenced; return; }
      const marker = PENDING.exec(line);
      if (marker) pending.push(`${index + 1}행 '${marker[0]}': ${clip(line)}`);
      const skipped = sourceQuoteRanges(line, fenced, log, request);
      for (const match of line.matchAll(REFERENCE)) {
        const start = match.index!;
        // URL·JDBC 의 `//호스트:포트` 와 `계정@호스트:포트` 는 파일:줄이 아니다
        if (match[1].startsWith("//") || line[start - 1] === "@" || skipped.some(([from, to]) => start >= from && start < to)) continue;
        const problem = referenceProblem(root, { path: match[1], line: Number(match[2]) }, options.overlay);
        if (!problem) continue;
        const candidates = problem.startsWith("근거 파일이 없습니다") && !match[1].includes("/") ? similarPaths(root, match[1]) : [];
        const hint = problem.startsWith("근거 파일이 없습니다")
          ? ` — 저장소 루트 기준 전체 경로로 씁니다${candidates.length ? ` (저장소에 있는 같은 이름: ${candidates.join(", ")})` : ""}. 지시서 원문(요구·오류 로그)의 글이면 원문 글자 그대로 따옴표나 백틱 안에 인용합니다`
          : "";
        problems.push(ruled("DOC-REF", `${path}:${index + 1}: ${problem}${hint}`));
      }
      if (file === "04-functional.md" && /AC-R\d+-\d+/.test(line) && !line.replace(/AC-R\d+-\d+/g, "").replace(/[\s|:#*`._-]/g, "")) {
        problems.push(ruled("FUN-AC", `${path}:${index + 1}: AC 번호에 구체적인 완료 조건이 없습니다: ${line.trim()}`));
      }
    });
    if (pending.length) {
      problems.push(ruled("DOC-PENDING", `${path}: 미결 표시가 남았습니다 — ${pending.slice(0, 5).join(" · ")}${pending.length > 5 ? ` 외 ${pending.length - 5}줄` : ""}` +
        " — 업무 결정이면 needs-input 질문으로 돌려주고, 기술 기본값이면 정한 값과 이유를 적은 뒤 표시를 지웁니다"));
    }
    if (file === "04-functional.md") problems.push(...businessRuleProblems(path, lines, grounded));
  }
  return [...new Set(problems)];
}

/** 계획 스키마 오류 문구 — plan submit 과 완료 hook 이 같은 문구를 쓴다 */
export function formatPlanIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return "계획 형식이 맞지 않습니다:\n" + issues.map((issue) => `  - ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("\n");
}

/** 계획 초안의 자기 완결 검사(스키마 다음 — tasks·AC·요구 커버리지·남은 질문). 제출 규칙은 planRuleProblems 다. plan submit 과 완료 hook 이 같이 쓴다 */
export function planShapeProblems(work: Work, plan: BuildPlan, acceptance: string[], keys: string[]): string[] {
  const { preflightFiles } = require("./fileOperations") as typeof import("./fileOperations");
  const problems: string[] = plan.files.some(f => f.operation) ? preflightFiles(work, plan.files, plan) : [];
  if (work.active.planningVersion && !plan.tasks) problems.push("신규 계획에는 파일 소유·의존성·AC를 갖춘 tasks가 필요합니다.");
  for (const task of plan.tasks ?? []) if (task.acceptance.some(ac => !acceptance.includes(ac))) problems.push(`${task.id}: 기능 명세에 없는 완료 기준입니다.`);
  problems.push(...coverageProblems(keys, plan.files));
  if (plan.openQuestions.length > 0) problems.push(`남은 질문이 있습니다 — questions.md 로 옮겨 답을 받으세요: ${plan.openQuestions.join(" / ")}`);
  return problems.map((problem) => ruled("PLN-SHAPE", problem));
}

/**
 * 계획 제출 규칙 — 순서·preserve·검증 명령 파일·fix·refactor·경로. 계획 초안과 저장소(기준 커밋·매니페스트·지시서)만 보는
 * 결정적 검사라 plan submit 과 plan 담당 완료 hook 이 같이 쓴다(부작용 없음). `overlay` 는 완료 hook 의 staging 본문(⑦)이다.
 * 같은 초안이 hook 을 지났는데 제출에서 이 규칙으로 걸리면 critic·교차 검토를 다시 돌려야 한다 — 그래서 두 자리가 한 함수를 쓴다.
 */
export function planRuleProblems(work: Work, plan: BuildPlan, overlay?: DocOverlay): string[] {
  const { repoRoot, active, order, manifest } = work;
  const problems: string[] = sequenceProblems(plan, work.stages, order.kind).map((problem) => ruled("PLN-SEQ", problem));
  if (planFormatFor(order.kind).requiresPreserve) {
    problems.push(...missingPreserve(order, plan).map((item) => ruled("PLN-PRESERVE", `preserve 가 계획에 없습니다: ${item}`)));
  }
  // 검증 명령이 이 계획이 쓰는 파일을 가리키면 모델이 제 검증기를 쓰게 된다 — 그래도 묶임은
  // 전부 들어맞는다(가짜 검증기까지 함께 굳으므로). 코드가 판별할 수 있는 것이 아니라 사람이
  // 판단할 것이라, 조용히 지나가지 않게 제출을 세우고 무엇이 걸렸는지 그대로 보여 준다.
  const planned = new Set(plan.files.flatMap(filePaths));
  const declared = [manifest.build, manifest.test, manifest.prepare, ...Object.values(manifest.commands)]
    .filter((argv): argv is string[] => Array.isArray(argv))
    .flat()
    .map((element) => element.replace(/^\.\//, ""));
  for (const path of [...new Set(declared.filter((element) => planned.has(element)))]) {
    problems.push(ruled("PLN-VERIFY", `검증 명령이 이 계획이 쓰는 파일을 가리킵니다: ${path} — 검증을 스스로 쓰는 계획은 증거가 되지 않습니다`));
  }

  const stages = codeStages(work);
  const fixProblems: string[] = [];
  // fix 는 재현 테스트가 먼저다 — 계획이 그 순서를 담지 않으면 강제할 자리가 없다
  if (order.kind === "fix") {
    const testKeys = stages.filter((stage) => stage.kind === "test").map((stage) => stage.key);
    if (testKeys.length === 0) {
      fixProblems.push(
        "이 프로젝트에는 fix 로 도는 kind:\"test\" 단계가 없습니다 — code-agent.json 의 stages 에 하나 두고 " +
          "kinds 에 \"fix\" 를 넣으세요 (확인: code-agent manifest check)",
      );
    } else {
      const first = (plan.sequence[0]?.step ?? "").trim();
      if (!testKeys.includes(first)) {
        fixProblems.push(`계획의 sequence[0] 이 테스트 단계가 아닙니다 (지금: "${first}") — fix 는 재현 테스트가 먼저입니다. 받는 값: ${testKeys.join(", ")}`);
      }
      if (!plan.files.some((file) => testKeys.includes(file.stage))) {
        fixProblems.push(`fix 의 계획에 kind:"test" 단계의 파일이 없습니다 — 재현 테스트 파일을 계획에 넣으세요 (단계: ${testKeys.join(", ")})`);
      }
      // '재현 먼저' 는 **단계 이름표**로 판정된다 (hook 도 repro 의 깨끗한 트리 검사도). 그래서 고칠 파일을
      // 테스트 단계에 적어 넣으면 재현 전에 쓸 수 있고 — outputDirs 가 비면 위치 검사도 서지 않는다 —
      // 그 파일이 바뀐 채로 repro 가 통과한다. 이름표가 가리키는 자리 안에 있는지 여기서 본다.
      const roots = testRoots(work);
      const mislabeled = plan.files.filter(
        (file) => testKeys.includes(file.stage) && !roots.some((root) => file.path === root || file.path.startsWith(`${root}/`)),
      );
      for (const file of mislabeled) {
        fixProblems.push(
          roots.length === 0
            ? `kind:"test" 단계(${file.stage})가 자리를 밝히지 않아 재현 테스트를 가려낼 수 없습니다: ${file.path} — ` +
                "code-agent.json 의 그 단계에 scope:\"project\" 의 outputDirs 나 base 를 적으세요 (확인: code-agent manifest check)"
            : `계획이 kind:"test" 단계에 테스트 자리 밖의 파일을 넣었습니다: ${file.path} (단계 ${file.stage}) — ` +
                `'재현 먼저' 는 그 자리로 잽니다. 테스트 자리: ${roots.join(", ")}`,
        );
      }
    }
  }
  problems.push(...fixProblems.map((problem) => ruled("PLN-FIX", problem)));
  // 리팩토링이 기존 테스트를 고칠 수 있으면 '동작 보존' 을 재는 자가 없어진다. 부하를 지는 자리가 여기다
  if (order.kind === "refactor") {
    const tracked = new Set(trackedTestFiles(work));
    const createsTests = plan.files.some(file => stages.some(stage => stage.key === file.stage && stage.kind === "test"));
    const knownCases = new Set([...tracked].flatMap(path => existsSync(join(repoRoot, path))
      ? readFileSync(join(repoRoot, path), "utf8").match(/\bTC-\d+\b/g) ?? [] : []));
    if (!createsTests && knownCases.size) {
      const spec = readWorkDoc(repoRoot, active.id, "07-test-spec", overlay);
      for (const entry of spec ? parseTestCases(spec) : []) if (!knownCases.has(entry.id)) {
        problems.push(ruled("PLN-REFACTOR", `기존 테스트에 없는 ${entry.id}를 실행할 계획이 없습니다 — refactor는 기존 TC ID를 재사용하세요. 도구·파일 보존 같은 절차 확인을 실행하지 않는 TC로 만들지 않습니다`));
      }
    }
    const hit = plan.files.flatMap(filePaths).filter((path) => tracked.has(path));
    if (hit.length > 0) {
      problems.push(ruled("PLN-REFACTOR",
        `리팩토링은 기존 테스트를 고치지 않습니다 — 계획에서 빼세요: ${hit.join(", ")}. ` +
          "동작이 보존되는지 보는 것이 그 테스트입니다. " +
          `테스트를 고쳐야 할 이유가 보이면 ${questionsFile(active.id)} 로 물으세요`,
      ));
    }
  }
  for (const file of plan.files) {
    const stage = stages.find((candidate) => candidate.key === file.stage);
    if (!stage) {
      problems.push(ruled("PLN-PATH", `${file.path}: 알 수 없는 단계 ${file.stage} (단계: ${stages.map((s) => s.key).join(", ")})`));
      continue;
    }
    for (const violation of checkPaths({ repoRoot, order, manifest, plan, stage, files: filePaths(file).map(path => ({ path, content: "" })) })) {
      problems.push(ruled("PLN-PATH", `[${violation.item}] ${violation.file}: ${violation.detail}`));
    }
  }
  return problems;
}

/** staging 의 plan.json 본문 검사 — 없음·JSON 아님·스키마 오류·자기 완결 검사·제출 규칙(planRuleProblems) */
export function planDraftProblems(work: Work, text: string | undefined, acceptance: string[], keys: string[], overlay?: DocOverlay): string[] {
  const path = `${workDocsDir(work.active.id)}/plan.json`;
  if (text === undefined) return [ruled("DOC-MISSING", `필수 계획 문서가 없습니다: ${path}`)];
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (error) { return [ruled("PLN-SHAPE", `plan.json: JSON 이 아닙니다 — ${error instanceof Error ? error.message : error}`)]; }
  const format = planFormatFor(work.order.kind);
  const parsed = format.schema.safeParse(raw);
  if (!parsed.success) return [ruled("PLN-SHAPE", formatPlanIssues(parsed.error.issues))];
  const plan = format.toPlan(parsed.data);
  return [...planShapeProblems(work, plan, acceptance, keys), ...planRuleProblems(work, plan, overlay)];
}
