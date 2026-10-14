/**
 * `code-agent context` 의 단계별 렌더러 — commands.ts `context()` 가 작업을 읽고 요구 키를 확인한 뒤 `renderContext` 를 부른다.
 * 절마다 함수 하나이고 조건·순서는 `renderContext` 에 있다. 출력은 분리 전과 바이트가 같다(분리 커밋의 골든 비교).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { collectExemplars, formatExemplars } from "../core/exemplar";
import type { Manifest } from "../core/manifest";
import { planFormatFor } from "../core/plan";
import { businessRuleFiles } from "./planningState";
import { docPaths, normalizeHeading } from "./docs";
import { AFTER_IMPLEMENT, questionsFile, workDocsDir } from "./layout";
import { prDocFile } from "./deliver";
import { keyRefs, proposalFile } from "./knowledge";
import { impactTableFiles, proposalScope } from "./knowledgeImpact";
import { buildIndex, freshness, hitLine, mandatoryPolicies, relatedEntries, requiredConventionLines, search } from "./knowledgeIndex";
import type { Freshness, Hit, IndexEntry, KnowledgeIndex, SearchQuery } from "./knowledgeIndex";
import { collectWindowOpen, loadEvidence, planPaths, reviewRoundUsage, runsOf, testFrozen, testRoots, testStageFiles, validationDocFile, verifyView } from "./evidence";
import { budgetText } from "./retryPolicy";
import { CONTEXT_POLICY_KINDS, docRefs, hitSection, isTestPath, keywordsOf, rankCandidatesScan, requirementItems, type RankScan } from "./plugins/defaults";
import { MAX_ITEMS } from "./plugins/protocol";
import type { DocSection, RequirementRef } from "./plugins/protocol";
import { callSlot, clamp, sourceLines } from "./plugins/run";
import { changedList, loadReview, reviewDocFile, roundChanges } from "./review";
import { KNOWLEDGE_KINDS } from "./schemas";
import { sourceFileScan, SURVEY_MAX_FILES } from "./survey";
import type { Work } from "./work";
import { acceptanceCriteria, parseTestCases, planDocFile, readWorkDoc, workDocPath } from "./workDocs";
import { sourceItems } from "./sourceTrace";
import { agentName, notation, skillFile } from "./hostText";
import { codeStages, PHASE_LABEL } from "./phaseInfo";

/** 렌더러가 읽는 것 — 작업(커서·매니페스트·지시서)과, impact·design·plan 이면 확인된 요구 키 */
export interface RenderInput { repoRoot: string; work: Work; keys: string[] }

const CANDIDATE_LIMIT = 20;
const DOC_SECTION_LIMIT = 10;

/** `candidates.rank` — 요구 항목과 관련된 파일 순위. 순위 파일 경로는 문서 검색의 근거 경로 대조에도 쓴다 */
function candidateLines(repoRoot: string, manifest: Manifest, items: RequirementRef[], keywords: string[], ranked: string[] = []): string[] {
  const { files, truncated } = sourceFileScan(repoRoot);
  // 플러그인에는 상한(MAX_ITEMS)까지만 간다 — 잘려도 소스가 남도록 테스트가 아닌 파일을 먼저 둔다
  const ordered = [...files.filter((file) => !isTestPath(file.path)), ...files.filter((file) => isTestPath(file.path))];
  let scan = undefined as RankScan | undefined;   // 기본 구현이 돌았을 때만 채워진다
  const result = callSlot(
    repoRoot,
    manifest,
    "candidates.rank",
    () => ({ requirements: items, keywords, files: ordered, limit: CANDIDATE_LIMIT }),
    () => {
      scan = rankCandidatesScan(repoRoot, files, keywords, CANDIDATE_LIMIT);
      return { ranked: scan.ranked };
    },
  );
  const top = result.output.ranked.slice(0, CANDIDATE_LIMIT);
  ranked.push(...top.map((entry) => entry.path));
  const scope: string[] = [];
  if (scan && scan.skipped > 0) {
    scope.push(`- 범위: 소스 ${scan.total}개 중 경로는 전부, 본문은 ${scan.read}개만 봤습니다(경로가 걸린 파일·테스트가 아닌 파일 먼저) — 순위에 없으면 직접 찾아야 합니다.`);
  }
  if (truncated) {
    scope.push(`- 범위: 저장소 파일이 ${SURVEY_MAX_FILES}개를 넘어 앞부분(경로 사전순)만 셌습니다 — 순위에 없으면 직접 찾아야 합니다.`);
  }
  if (result.source === "plugin" && files.length > MAX_ITEMS) {
    scope.push(`- 플러그인에는 소스 앞 ${MAX_ITEMS}개(테스트가 아닌 파일 먼저)만 보냈습니다 — 순위에 없으면 직접 찾아야 합니다.`);
  }
  return [
    "## 관련 후보 파일 (순위 — 다시 찾지 말고 이것부터)",
    ...sourceLines(result, "내장 키워드 스캔, 결정론"),
    ...scope,
    ...(top.length > 0
      ? top.map((entry, index) => `${index + 1}. ${clamp(entry.path)} (${entry.score.toFixed(2)} — ${clamp(entry.why)})`)
      : [scope.length > 0
        ? "- 없음 — 본 범위에서 요구 항목의 낱말에 걸리는 파일이 없습니다. 후보를 직접 찾아야 합니다."
        : "- 없음 — 요구 항목의 낱말에 걸리는 파일이 없습니다. 후보를 직접 찾아야 합니다."]),
  ];
}

/** 반드시 적용하는 업무 정책·관련 항목을 한 번에 보여 주는 상한 — 넘으면 수를 적고 `knowledge find` 로 넘긴다 */
const KNOWLEDGE_LIMIT = 15;
/** 컨벤션 `[필수]` 줄 상한 */
const REQUIRED_RULE_LIMIT = 30;

const FIND_HINT = "code-agent knowledge find <낱말|키|경로> (셸이 없는 담당은 지식 문서에서 키·낱말을 검색)";
const STALE_NOTE = "- 재검토 필요·참조 없음·보류·미커밋 항목은 요약을 믿지 말고 그 범위의 원문과 근거 코드·테스트를 직접 확인한다";

/** 요구 문장에 나온 지식 키 — 인덱스에 있는 키만 */
function mentionedKeys(items: RequirementRef[], index: KnowledgeIndex): string[] {
  const text = items.map((item) => item.text).join("\n");
  return [...new Set([...keyRefs(text), ...index.entries.filter((entry) => text.includes(entry.key)).map((entry) => entry.key)])]
    .filter((key) => index.entries.some((entry) => entry.key === key));
}

/** 플러그인이 고른 절을 인덱스의 항목·절로 되찾는다 — 줄 범위·최신성을 붙이려고. 못 찾으면 플러그인 글자 그대로 */
function fromPlugin(index: KnowledgeIndex, section: DocSection): Hit | DocSection {
  const key = /^`([^`]+)`/.exec(section.heading)?.[1];
  const entry = key ? index.entries.find((candidate) => candidate.path === section.path && candidate.key === key) : undefined;
  if (entry) return { entry, score: 0, why: section.why ? [clamp(section.why)] : [] };
  const found = index.sections.find((candidate) => candidate.path === section.path && normalizeHeading(candidate.heading) === normalizeHeading(section.heading));
  return found ? { section: found, score: 0, why: section.why ? [clamp(section.why)] : [] } : section;
}

const isHit = (value: Hit | DocSection): value is Hit => "score" in value;

function staleShown(fresh: Map<IndexEntry, Freshness>): boolean {
  return [...fresh.values()].some((entry) => entry.state !== "최신" && entry.state !== "근거 경로 없음");
}

/** 반드시 적용하는 업무 정책 줄 — 상한을 넘으면 수를 적는다 */
function mandatoryLines(mandatory: { entry: IndexEntry; why: string }[], fresh: Map<IndexEntry, Freshness>): string[] {
  if (mandatory.length === 0) return [];
  return [
    "",
    "## 반드시 적용하는 업무 정책 (순위와 관계없이 — 구분 필수·관찰 아님)",
    ...mandatory.slice(0, KNOWLEDGE_LIMIT).map(({ entry, why }) => hitLine({ entry, score: 0, why: [why] }, fresh.get(entry))),
    ...(mandatory.length > KNOWLEDGE_LIMIT ? [`- 범위: ${mandatory.length}개 중 ${KNOWLEDGE_LIMIT}개만 — 나머지는 ${FIND_HINT}`] : []),
  ];
}

/**
 * `context.docs` — 지식 항목·문서 절 순위와 반드시 적용하는 업무 정책.
 * `files` 는 이 작업이 닿는 파일(후보 순위·영향 범위 표) — 근거 경로가 겹치는 항목이 위로 온다.
 * 플러그인이 등록돼 있으면 순위는 플러그인 것이고, 줄 범위·최신성·반드시 적용하는 정책은 코드가 붙인다(플러그인에 더 보내지 않는다).
 */
function docSectionLines(repoRoot: string, manifest: Manifest, items: RequirementRef[], keywords: string[], files: string[] = []): string[] {
  const index = buildIndex(repoRoot, manifest, CONTEXT_POLICY_KINDS);
  const query: SearchQuery = { keywords, keys: mentionedKeys(items, index), files };
  let hits: Hit[] | undefined;
  const result = callSlot(
    repoRoot,
    manifest,
    "context.docs",
    () => ({ requirements: items, docs: docRefs(repoRoot, manifest), limit: DOC_SECTION_LIMIT }),
    () => {
      hits = search(index, query);
      return { sections: hits.slice(0, DOC_SECTION_LIMIT).map(hitSection) };
    },
  );
  const shown = hits ? hits.slice(0, DOC_SECTION_LIMIT) : result.output.sections.slice(0, DOC_SECTION_LIMIT).map((section) => fromPlugin(index, section));
  const entries = shown.filter(isHit).flatMap((hit) => (hit.entry ? [hit.entry] : []));
  const mandatory = mandatoryPolicies(index, query, entries).filter(({ entry }) => !entries.includes(entry));
  const fresh = freshness(repoRoot, [...entries, ...mandatory.slice(0, KNOWLEDGE_LIMIT).map(({ entry }) => entry)]);
  return [
    "## 참고 문서 (지식 항목·문서 절 순위 — 전문을 읽지 말고 이 줄 범위만)",
    ...sourceLines(result, "키·경로·별칭·본문 검색"),
    ...(shown.length > 0
      ? shown.map((item) => (isHit(item)
        ? hitLine(item, item.entry ? fresh.get(item.entry) : undefined)
        : `- ${clamp(item.path)} · ## ${clamp(item.heading)}${item.why ? ` (${clamp(item.why)})` : ""}`))
      : ["- 없음 — 등록된 문서에서 걸리는 항목·절이 없습니다."]),
    ...(hits && hits.length > shown.length ? [`- 범위: 걸린 ${hits.length}개 중 상위 ${shown.length}개만 — 더 찾으려면 ${FIND_HINT}`] : []),
    ...(staleShown(fresh) ? [STALE_NOTE] : []),
    ...mandatoryLines(mandatory, fresh),
  ];
}

/**
 * 이 작업의 파일을 근거로 든 지식 항목 — 근거 경로가 겹치는 것만(관련 없는 항목은 보이지 않는다).
 * 반드시 적용하는 업무 정책과 컨벤션 `[필수]` 줄도 함께 — 순위에서 빠졌다는 이유로 놓치지 않게.
 */
function fileKnowledgeLines(repoRoot: string, manifest: Manifest, files: string[], title: string, rules = true): string[] {
  const index = buildIndex(repoRoot, manifest, []);
  const related = relatedEntries(index, files);
  const mandatory = mandatoryPolicies(index, { keywords: [], keys: [], files }, related).filter(({ entry }) => !related.includes(entry));
  const required = rules ? requiredConventionLines(repoRoot, manifest) : [];
  const fresh = freshness(repoRoot, [...related.slice(0, KNOWLEDGE_LIMIT), ...mandatory.slice(0, KNOWLEDGE_LIMIT).map(({ entry }) => entry)]);
  return [
    ...(related.length > 0 ? [
      "",
      title,
      ...related.slice(0, KNOWLEDGE_LIMIT).map((entry) => hitLine({ entry, score: 0, why: [] }, fresh.get(entry))),
      ...(related.length > KNOWLEDGE_LIMIT ? [`- 범위: ${related.length}개 중 ${KNOWLEDGE_LIMIT}개만 — 나머지는 ${FIND_HINT}`] : []),
      ...(staleShown(fresh) ? [STALE_NOTE] : []),
    ] : []),
    ...mandatoryLines(mandatory, fresh),
    ...(required.length > 0 ? [
      "",
      "## 컨벤션 필수 규칙 (`[필수]` — 참조 코드와 달라도 이것을 따르고, 다르면 보고한다)",
      ...required.slice(0, REQUIRED_RULE_LIMIT).map((rule) => `- ${rule.path}:${rule.line} ${clamp(rule.text)}`),
      ...(required.length > REQUIRED_RULE_LIMIT ? [`- 범위: ${required.length}줄 중 ${REQUIRED_RULE_LIMIT}줄만 — 나머지는 컨벤션 문서에서 \`[필수]\` 로 찾는다`] : []),
    ] : []),
  ];
}

/** ① 요구사항 정의 — 01 형식·확정된 접수 요구·업무 규칙 KNOWLEDGE·참고 문서 절 */
export function analysisSection({ repoRoot, work }: RenderInput, out: string[]): void {
  const { active, manifest } = work;
  out.push(
    "",
    "## ① 01-requirements.md — 요구사항 정의",
    `${workDocPath(active.id, "01-requirements")} 에 쓴다 (뼈대: code-agent docs skeleton 01-requirements).`,
    "필수 형식: `## R<번호>` 1개 이상·중복 없음 · R 블록마다 비어 있지 않은 `근거:` · `## 가정`. 아래 접수 요구 목록을 인용의 합으로 전부 연결해야 next 가 넘어간다.",
    "```markdown",
    "## R1 · <요구 한 가지>",
    "출처: REQ-1 (아래 접수 요구 목록의 ID, 여러 개면 쉼표로 구분)",
    "근거: \"<지시서 문장 그대로>\"",
    "- 데이터: 만든다 | 바꾼다 | 안 건드린다",
    "- 접점(API·화면): 만든다 | 바꾼다 | 안 건드린다",
    "- 기존 코드: 고친다 | 안 고친다",
    "",
    "## 가정",
    "- <정한 것> — 근거: <컨벤션 위치 · 참조 코드 path:line · 일반 관행>   ← 없으면 `- 없음`",
    "",
    "## 범위 밖   ← 선택",
    "- <이번에 하지 않는 것> — 근거: <왜 밖인가>",
    "```",
    "",
    "## 확정된 접수 요구 — 빠짐없이 R에 연결",
    ...sourceItems(readFileSync(join(repoRoot, active.spec), "utf8")).map((item) => `- ${item.id}: ${item.text}`),
    "근거는 이 목록의 문장을 그대로 인용합니다. 나누어 분석하면 근거 줄을 여러 개 써서 원문 전체를 덮으세요. 제외하려면 지시서를 고쳐 다시 확정합니다.",
  );
  // 업무 규칙을 묻기 전에 먼저 찾게 한다 — analysis 시점에는 01 이 없으므로 낱말은 지시서의 접수 요구 항목에서 뽑는다
  const specItems = sourceItems(readFileSync(join(repoRoot, active.spec), "utf8")).map((item) => ({ key: item.id, text: item.text }));
  const rules = businessRuleFiles(work);
  out.push("", `- 업무 규칙 KNOWLEDGE (묻기 전에 먼저 찾는다 — 배정 inputs 에 있다): ${rules.join(", ") || "없음"}`);
  out.push("", ...docSectionLines(repoRoot, manifest, specItems, keywordsOf(specItems)));

}

/** 질문과 가정의 구분 */
export function questionsAndAssumptions({ work }: RenderInput, out: string[]): void {
  const { active } = work;
  out.push(
    "",
    "## 질문과 가정 — 어느 쪽인가",
    `- **질문** (${questionsFile(active.id)}, 답이 올 때까지 진행 금지): 업무 규칙 · 범위(무엇을 만들고 무엇을 안 만드는가) · 권한 · 데이터의 의미 ·`,
    "  다른 도메인·외부와의 계약 · 아키텍처·컨벤션과 충돌하는 것. 모델이 정하면 지어낸 것이 되는 것들이다.",
    `- **가정** (${workDocPath(active.id, "01-requirements")} 의 \`## 가정\`, 진행한다): 컨벤션·참조 코드·일반 관행으로 기본값을 댈 수 있고 승인 때 고쳐도 싼 기술 세부 —`,
    "  메서드 이름 · 정렬 · 숫자 정밀도 · 테스트 케이스 목록 · 메시지 문구 · 이번 범위 밖으로 둘 부수 작업. 근거를 반드시 단다.",
    "- 가정은 승인 화면에 그대로 보여 사람이 계획과 함께 받아들인다. 확신이 없으면 질문으로.",
  );

}

/** ② 영향도 분석 */
export function impactSection({ work }: RenderInput, out: string[]): void {
  const { active, manifest } = work;
  out.push(
    "",
    "## ② 02-analysis.md — 영향도 분석",
    `${workDocPath(active.id, "02-analysis")} 에 쓴다 (뼈대: code-agent docs skeleton 02-analysis).`,
    "필수 섹션: 기존 시스템 분석 · 영향 범위 · Risk. `영향 범위` 표의 **첫 열에 01 의 모든 R** 이 한 줄 이상이어야 넘어간다 —",
    "영향이 없는 R 도 근거와 함께 '없음' 으로 한 줄 넣는다.",
    "```markdown",
    "## 영향 범위",
    "| R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급 |",
    "|---|---|---|---|",
    "| R1 | <path:line> | <부르는 곳> | 없음 — <근거> |",
    "```",
    `- 공통 KNOWLEDGE (읽기만 — 키가 있어도 현재 코드와 호출자 영향을 확인하고 인용한다): ${KNOWLEDGE_KINDS.map((kind) => docPaths(manifest, kind)[0]).join(", ")}`,
  );
  if (work.active.knowledgeVersion) {
    out.push(
      "",
      "`## 문서 영향` 표도 쓴다 — 이번 변경이 기능·흐름·업무 정책·데이터·API 문서의 어느 항목을 바꾸는가. 키 칸은 백틱 키, 판단은 갱신 · 신규 · 삭제 · 이름 변경 · 영향 없음 · 충돌, 근거는 한 줄.",
      "영향 범위 표의 파일을 근거로 든 항목은 빠짐없이 판단해야 넘어간다(아래 '닿을 파일을 근거로 든 지식 항목'). 정책과 현재 코드가 다르면 고치지 말고 `충돌` 로 적고 질문한다.",
      "```markdown",
      "## 문서 영향",
      "| 문서 | 키 | 판단 | 근거 |",
      "|---|---|---|---|",
      "| features | `FEAT-<도메인>-<이름>` | 갱신 | R1 이 입력에 사유를 더한다 |",
      "| business-rules | `BR-<도메인>-01` | 영향 없음 | 한도 규칙은 그대로 — R1 은 사유만 |",
      "```",
    );
  }

}

/** ③·④ 설계·정의 */
export function designSection({ work }: RenderInput, out: string[]): void {
  const { active, manifest } = work;
  out.push(
    "",
    "## ③ 03-design.md · ④ 04-functional.md — 설계·정의 (같은 스테이지에서 함께 쓴다)",
    `뼈대: code-agent docs skeleton 03-design · code-agent docs skeleton 04-functional`,
    `- ${workDocPath(active.id, "03-design")} — 구성 요소 · 처리 흐름 · API · 데이터 · 설계 결정.`,
    "  API·데이터는 조건부다: 안 건드리면 `해당 없음 — <근거>`. **근거 없는 `해당 없음` 은 미충족이다.**",
    `- ${workDocPath(active.id, "04-functional")} — 기능 정의 · 업무 규칙 · 예외 · 수락 기준.`,
    "  수락 기준은 `AC-R<n>-<m>` 한 줄씩, **R 마다 최소 하나** · id 중복 없음 · 01 에 없는 R 을 가리키지 않는다. 오류 코드는 03 의 API 와 글자까지 같게.",
    `- 공통 KNOWLEDGE (읽기만 — 인용은 키와 기대는 사실 한 줄을 옮겨 적고 차이만): ${KNOWLEDGE_KINDS.map((kind) => docPaths(manifest, kind)[0]).join(", ")}`,
  );

}

/** 요구 항목·참조 도메인·후보 파일·참고 문서 절 — keys 는 requireRequirements 의 요구 키 */
export function planningSupport({ repoRoot, work, keys }: RenderInput, out: string[]): void {
  const { active, manifest } = work;
  out.push("", `- 요구 항목: ${keys.join(", ")} (${workDocPath(active.id, "01-requirements")})`);

  // 참조 코드는 코드가 고른다 — 조사자마다 참조 도메인을 다시 찾아 저장소를 훑지 않게 경로를 준다.
  if (manifest.referenceDomain) {
    out.push("", `## 참조 도메인 ${manifest.referenceDomain} — 단계별 표준 파일 (다시 찾지 말고 이것부터 읽는다)`);
    for (const stage of codeStages(work)) {
      const where = stage.scope === "project" ? `저장소 기준 ${stage.outputDirs.join(", ") || "제한 없음"}` : "도메인 안";
      const { files, missing } = collectExemplars(repoRoot, manifest, manifest.referenceDomain, stage);
      const paths = files.map((file) => file.path);
      out.push(`- ${stage.key} (${where}): ${paths.join(", ") || (stage.exemplars.length === 0 ? "참조 없음" : `못 찾음 ${missing.join(", ")}`)}`);
    }
  } else {
    // 신규(빈) 저장소 — 베낄 코드가 없다. 문서가 정하지 않은 것을 지어내지 않게 자리를 짚어 준다
    out.push(
      "",
      "## 참조 없음 — 아키텍처·컨벤션 문서로",
      "참조 표준으로 삼을 기존 코드가 없습니다 (code-agent.json 에 referenceDomain 이 없습니다).",
      `구조·이름·계층 경계는 ${manifest.docs.architecture ?? "(아키텍처 문서 없음)"} 와 ` +
        `${manifest.conventions.join(", ") || "(컨벤션 문서 없음)"} 가 정한 것을 따릅니다.`,
      `문서가 정하지 않은 것은 지어내지 말고 ① ${workDocPath(active.id, "01-requirements")} 의 \`## 가정\` 에 ` +
        `근거와 함께 적거나 ${questionsFile(active.id)} 로 물으세요.`,
    );
  }

  // 자리 둘 — 기본 구현은 등록 없이 돌고, 저장소가 선언한 플러그인이 있으면 그것이 대신 채운다.
  // 재탐색을 대신하는 자리라, 여기서 준 것으로 충분하면 서브에이전트가 저장소를 다시 훑지 않는다.
  const items = requirementItems(readWorkDoc(repoRoot, active.id, "01-requirements") ?? "");
  const keywords = keywordsOf(items);
  // 문서 검색의 경로 대조 — 영향 범위 표의 파일(있으면)과 후보 순위
  const analysis = readWorkDoc(repoRoot, active.id, "02-analysis");
  const files = analysis ? impactTableFiles(analysis) : [];
  if (active.phase !== "plan") {
    out.push("", ...candidateLines(repoRoot, manifest, items, keywords, files));
  }
  out.push("", ...docSectionLines(repoRoot, manifest, items, keywords, files));
  if (active.phase === "impact" && active.knowledgeVersion) {
    out.push(...fileKnowledgeLines(repoRoot, manifest, files, "## 이 작업이 닿을 파일을 근거로 든 지식 항목 — 02 의 `문서 영향` 에서 빠짐없이 판단한다", false));
  }

}

/** ⑦ 테스트 명세·계획 형식·단계·종류별 제출 규칙 */
export function planSection({ repoRoot, work }: RenderInput, out: string[]): void {
  const { active, manifest, order } = work;
  const format = planFormatFor(order.kind);
  const functional = readWorkDoc(repoRoot, active.id, "04-functional");
  const acceptance = functional ? acceptanceCriteria(functional) : [];
  const spec = readWorkDoc(repoRoot, active.id, "07-test-spec");
  const cases = spec ? parseTestCases(spec) : [];
  out.push(
    "",
    `- 수락 기준 (${workDocPath(active.id, "04-functional")}): ${acceptance.join(", ") || "없음 — 04 를 먼저 쓴다"}`,
    `- 테스트 케이스 (${workDocPath(active.id, "07-test-spec")}): ` +
      (cases.length > 0
        ? cases.map((entry) => `${entry.id}(${entry.level} → ${entry.acceptance.join(",") || "대상 없음"})`).join(", ")
        : "아직 없음"),
    `- 테스트 전략: ${docPaths(manifest, "test-strategy")[0]} · 품질·보안 기준: ${docPaths(manifest, "quality")[0]}`,
    "",
    "## ⑦ 07-test-spec.md — 테스트 명세 (구현 전에 쓴다)",
    "뼈대: code-agent docs skeleton 07-test-spec. 열 순서는 고정이고, 04 의 **모든 AC 가 최소 한 TC 에** 걸려야 계획이 제출된다.",
    "```markdown",
    "| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |",
    "|---|---|---|---|---|",
    "| TC-1 | Unit | AC-R1-1 | <무엇을 한다> | <무엇이 된다> |",
    "```",
    "",
    "## 계획 형식",
    `초안을 ${workDocsDir(active.id)}/plan.json 에 쓰고 \`code-agent plan submit ${workDocsDir(active.id)}/plan.json\` 로 제출한다.`,
    "openQuestions 가 남아 있으면 제출되지 않는다 — questions.md 로 옮겨 답을 받는다.",
    "files[].requirements 에 그 파일이 담당하는 요구 항목 번호를 적는다. 모든 요구 항목이 어느 파일엔가 닿아야 제출된다.",
    `제출하면 코드가 ${planDocFile(active.id)} 를 렌더한다 — 그 파일은 손대지 않는다 (hook 이 거부한다).`,
    "```json",
    format.shape,
    "```",
    "",
    "## 단계 (files[].stage 에 쓰는 key)",
    ...codeStages(work).map(
      (stage) =>
        `- ${stage.key}: ${stage.title} — 위치 ${stage.scope === "project" ? "(저장소 기준) " : ""}${stage.outputDirs.join(", ") || "제한 없음"}` +
        (stage.base ? ` · base ${stage.base}` : ""),
    ),
    "",
    `도메인 위치: ${manifest.domainBase}/{${manifest.domainRoots.join(",")}}/<도메인>/<단계 위치>`,
    `참조 도메인: ${manifest.referenceDomain ?? "(없음)"}`,
  );
  // 제출이 세우는 종류별 규칙은 **쓰기 전에** 보여야 한다 — 거절당해서 알게 되는 규칙은 규칙이 아니라 함정이다
  const testKeys = codeStages(work).filter((stage) => stage.kind === "test").map((stage) => stage.key);
  if (order.kind === "fix") {
    out.push(
      "",
      "## fix — 재현이 먼저다 (제출이 세우는 것)",
      `- ⑦ ${workDocPath(active.id, "07-test-spec")} 에 \`## 재현\` 절을 두고 결함을 재현하는 TC id 를 \`- TC-1\` 로 한 줄씩. 수준은 무엇이든 되고, 적은 id 는 위 표에 실재해야 합니다.`,
      `- \`sequence[0].step\` 이 kind:"test" 단계의 key 여야 합니다 (받는 값: ${testKeys.join(", ") || "없음 — code-agent.json 에 kind:\"test\" 단계가 필요합니다"}).`,
      `- \`files[]\` 에 그 단계의 파일(재현 테스트)이 있어야 하고, 그 파일은 테스트 자리 안이어야 합니다: ${testRoots(work).join(", ") || "선언 없음"}.`,
      "- 구현에서는 그 테스트를 쓰고 `code-agent repro` 로 **실패**를 본 뒤에야 고칠 파일이 열립니다.",
      "- 지시서의 오류 로그가 1차 근거입니다. 로그의 발생 조건을 로컬에서 만들 수 없으면 `## 재현` 에 `- 방식: 로그 근거 — <사유>` 를 더합니다 — 그 TC 는 로그의 입력·상태를 담은 회귀 TC 로 수정 후 통과해야 합니다(지시서에 오류 로그가 있을 때만).",
    );
  }
  if (order.kind === "refactor") {
    out.push(
      "",
      "## refactor — 기존 테스트는 계획에 넣지 않는다 (제출이 세우는 것)",
      `- 기준 커밋에 이미 있던 테스트 자리(${testRoots(work).join(", ") || "선언 없음"})의 파일은 \`files[]\` 에 넣을 수 없습니다 — 동작이 보존되는지 보는 것이 그 테스트입니다.`,
      `- 테스트를 고쳐야 할 이유가 보이면 계획에 넣지 말고 ${questionsFile(active.id)} 로 물으세요.`,
      "- `preserve` 에 지시서의 보존 항목과 그것을 어떻게 지키는지를 적어야 제출됩니다.",
    );
  }

}

/**
 * fix 구현 — 재현 먼저. `context --file` 은 서브에이전트(implementer·tester)가 읽는다 — 메인 절차(`repro` 실행·`repro-log` 동의)는 싣지 않고
 * 서브에이전트가 지킬 제약만 둔다(메인 절차의 원천은 ca-implement 3항·ca-fix)
 */
export function fixImplementSection({ work }: RenderInput, out: string[]): void {
  const { active } = work;
  out.push(
    "",
    "## fix — 재현 먼저",
    `- 테스트 단계에서 ⑦ ${workDocPath(active.id, "07-test-spec")} 의 \`## 재현\` 이 가리키는 TC 를 먼저 씁니다. 메인이 code-agent repro 로 그 TC 의 **실패**를 확인하기 전에는 고칠 파일 쓰기를 hook 이 거부합니다 — 거부되면 우회하지 말고 메인에게 보고합니다.`,
    "- repro 를 지나면 재현 테스트(kind:\"test\" 단계 파일)는 얼어붙습니다. 이후에는 고치지 않습니다.",
  );
}

const DESIGN_DOCS = ["04-functional.md", "03-design.md"] as const;
const SOURCE_LINE_CHARS = 300;
const SOURCE_LINES_MAX = 40;

/** 03·04 의 절 위치 — `<문서> · <절> <시작>-<끝>`. 담당은 필요한 절만 그 줄 범위로 읽는다 */
export function docSectionIndex(repoRoot: string, id: string): string[] {
  return DESIGN_DOCS.flatMap((name) => {
    const path = `${workDocsDir(id)}/${name}`, full = join(repoRoot, path);
    if (!existsSync(full)) return [];
    const lines = readFileSync(full, "utf8").split(/\r?\n/);
    const heads = lines.map((text, index) => ({ text, line: index + 1 })).filter((row) => /^## /.test(row.text));
    const ranges = heads.map((head, index) => `${head.text.slice(3).trim()} ${head.line}-${(heads[index + 1]?.line ?? lines.length + 1) - 1}`);
    return ranges.length ? [`- ${path} · ${ranges.join(" · ")}`] : [];
  });
}

/**
 * 이 Task 의 근거 줄 — 04 의 수락 기준(Task 의 AC id, Task 가 없는 계획이면 단계 파일이 맡은 R 의 AC)과 업무 규칙(BR) 줄,
 * 03 에서 Task 파일 이름이 나오는 줄을 줄 번호와 함께 뽑는다.
 * 담당이 Task 마다 03·04 전체를 다시 읽지 않게 한다(절 전체가 필요하면 docSectionIndex 의 범위만 읽는다).
 */
export function taskSourceLines(repoRoot: string, id: string, task: { acceptance: string[]; requirements?: string[]; files: string[] }): string[] {
  const out: string[] = [];
  const names = [...new Set(task.files.map((file) => file.split("/").pop()!.replace(/\.[^.]+$/, "")).filter((name) => name.length >= 3))];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ids = [...task.acceptance.map(escape), ...(task.acceptance.length ? [] : (task.requirements ?? []).map((key) => `AC-${escape(key)}-\\d+`))];
  const ac = ids.length ? new RegExp(`(?:^|[^\\w-])(?:${ids.join("|")})(?![\\w-])`) : undefined;
  const named = names.length ? new RegExp(`(?:^|[^\\w])(?:${names.map(escape).join("|")})(?!\\w)`) : undefined;
  for (const name of DESIGN_DOCS) {
    const path = `${workDocsDir(id)}/${name}`, full = join(repoRoot, path);
    if (!existsSync(full)) continue;
    const picked = readFileSync(full, "utf8").split(/\r?\n/).map((text, index) => ({ text, line: index + 1 })).filter(({ text }) =>
      !/^(?:#|<!--)/.test(text.trim()) && text.trim() !== "" &&
      (name === "04-functional.md" ? (!!ac && ac.test(text)) || /^\s*-\s*BR-\d+/.test(text) : !!named && named.test(text)));
    if (!picked.length) continue;
    out.push(`${path}`);
    for (const row of picked.slice(0, SOURCE_LINES_MAX)) {
      const text = row.text.trim();
      out.push(`- ${row.line}: ${text.length > SOURCE_LINE_CHARS ? `${text.slice(0, SOURCE_LINE_CHARS)}…` : text}`);
    }
    if (picked.length > SOURCE_LINES_MAX) out.push(`- … 외 ${picked.length - SOURCE_LINES_MAX}줄 — 절 위치로 읽는다`);
  }
  return out;
}

/** 구현 단계 — 현재 Task·만들 파일·단계 규칙·참조 표준 */
export function implementSection({ repoRoot, work }: RenderInput, out: string[]): void {
  if (!work.stage || !work.plan) return; // renderContext 가 같은 조건으로 부른다 — 타입 좁히기
  const { active, manifest } = work;
  const stage = work.stage;
  const currentTask = work.plan.tasks?.find(task => task.id === active.task);
  const planned = work.plan.files.filter((file) => currentTask ? currentTask.files.includes(file.path) : file.stage === stage.key);
  if (currentTask) out.push(`현재 Task: ${currentTask.id} · ${currentTask.title}`, `선행: ${currentTask.dependsOn.join(", ") || "없음"} · 완료 기준: ${currentTask.acceptance.join(", ")}`);
  out.push("", `## 단계 ${stage.key} — ${stage.title}`, "", "만들 파일 (승인된 계획 — 이 밖은 hook 이 거부한다):");
  out.push(...planned.map((file) => `- ${file.path} — ${file.purpose}`));
  {
    const unit = currentTask ?? { acceptance: [], requirements: [...new Set(planned.flatMap((file) => file.requirements ?? []))], files: planned.map((file) => file.path) };
    const sources = taskSourceLines(repoRoot, active.id, unit), index = docSectionIndex(repoRoot, active.id);
    if (sources.length || index.length) {
      out.push("", "## 이 Task 의 근거 — 03·04 에서 코드가 뽑은 줄 (03·04 전체를 다시 읽지 않는다. 절 전체가 필요하면 아래 절 위치의 줄 범위만 읽는다)",
        ...sources, ...(index.length ? ["절 위치:", ...index] : []));
    }
  }
  const template = join(repoRoot, stage.template);
  if (existsSync(template)) {
    out.push("", `## 단계 규칙 (${stage.template})`, readFileSync(template, "utf-8").trim());
  }
  if (work.plan.conventions.length > 0) {
    out.push("", "## 이번 계획이 적용하기로 한 규칙");
    out.push(...work.plan.conventions.map((rule) => `- ${rule.rule} (${rule.source})`));
  }
  out.push(...fileKnowledgeLines(repoRoot, manifest, planned.map((file) => file.path), "## 이 Task 의 파일에 걸린 지식 항목 (지금 동작의 요약 — 동작을 바꾸면 반영 때 제안한다)"));
  if (stage.exemplars.length > 0 && manifest.referenceDomain) {
    const exemplars = collectExemplars(repoRoot, manifest, manifest.referenceDomain, stage);
    out.push("", `## 참조 표준 — ${manifest.referenceDomain} (이 구조를 그대로 따른다)`, formatExemplars(exemplars.files, manifest.language));
    if (exemplars.missing.length > 0) out.push("", `찾지 못한 참조: ${exemplars.missing.join(", ")}`);
    for (const omitted of exemplars.omitted) {
      out.push(`내용을 생략한 참조 (${omitted.pattern}): ${omitted.names.join(", ")}`);
    }
  }

}

/** 검증·리뷰 스테이지 — 계획 파일·검증 증거·동결 */
export function verificationSection({ repoRoot, work }: RenderInput, out: string[]): void {
  if (!work.plan) return; // renderContext 가 같은 조건으로 부른다 — 타입 좁히기
  const { active } = work;
  const frozen = testStageFiles(work);
  const evidence = loadEvidence(repoRoot, active.id, active.target);
  const view = evidence ? verifyView(work, evidence) : undefined;
  // 동결 표시 셋 — 결과 미확인의 수집 수정 창, 얼어 있음, 아직 얼지 않음(결과가 인식된 test 실행부터 언다)
  const frozenNote = !evidence || !view
    ? " · kind:test (결과가 인식된 test 실행부터 언다)"
    : testFrozen(evidence) && collectWindowOpen(view)
      ? " · **결과 미확인 — 수집 수정 1회 동안 TC 이름만 고칠 수 있음**"
      : testFrozen(evidence) ? " · **얼어 있음 (kind:test)**" : " · kind:test (결과가 인식된 test 실행부터 언다)";
  out.push(
    "",
    "## 계획 파일",
    ...work.plan.files.map(
      (file) =>
        `- [${file.stage}] ${file.path} — ${file.purpose} · 요구 ${(file.requirements ?? []).join(", ") || "없음"}` +
        (frozen.includes(file.path) ? frozenNote : ""),
    ),
  );
  const index = docSectionIndex(repoRoot, active.id);
  if (index.length) out.push("", "## 03·04 절 위치 (필요한 절만 그 줄 범위로 읽는다)", ...index);
  out.push(
    "",
    `## 검증 증거 (${validationDocFile(active.id)})`,
    evidence && view
      ? [
          `- ${evidence.rounds}회차 · ${budgetText(view.budget)}`,
          ...(["check", "test"] as const).flatMap((phase) =>
            runsOf(evidence, phase).map(
              (run) => `- ${phase}/${run.kind}: ${run.outcome}${run.logFile ? ` · 로그 ${run.logFile}` : ""}`,
            ),
          ),
        ].join("\n")
      : "- 아직 없습니다 — code-agent check",
    "",
    "동결된 테스트는 review 단계의 관찰된 독립 리뷰 지적이 해당 계획 파일을 가리킬 때만 수정할 수 있습니다. 범위는 계획 파일 목록으로 판정하며 refactor의 기준 커밋 테스트는 계속 보호합니다. 수정 후 check부터 재검증·재리뷰하세요." +
      " 결과가 하나도 인식되지 않고 실패도 없던 test 실행은 얼리지 않습니다. 일부만 인식됐으면 수집 수정 1회 동안 TC 이름을 고칠 수 있습니다.",
    // 읽는 쪽은 서브에이전트다 — 사람에게 묻는 것은 메인이 한다(질문 도구 이름을 싣지 않는다)
    `계획 밖을 고쳐야 하면 고치지 말고 메인에게 보고합니다 — 메인이 ${questionsFile(active.id)} 에 질문으로 남기고, 사람의 답과 재계획·재승인 뒤에만 구현합니다.`,
  );

}

/** ⑨ 코드 리뷰 */
export function reviewSection({ repoRoot, work }: RenderInput, out: string[]): void {
  const { active } = work;
  const review = loadReview(repoRoot, active.id, active.target);
  const last = review?.rounds[review.rounds.length - 1];
  const usage = reviewRoundUsage(work);
  const changes = roundChanges(review, planPaths(work));
  out.push(
    "",
    `## ⑨ ${reviewDocFile(active.id)} — 코드 리뷰`,
    `- 회차: ${last ? `${last.round}회차 (기준 트리 ${last.treeHash})` : "없음 — code-agent review 로 먼저 여세요"} · 남은 리뷰 회차 ${Math.max(0, usage.limit - usage.used)}회`,
    "- 회차 구역(`<!-- code-agent:review:... -->`)은 코드가 렌더합니다. 손대면 게이트가 거부합니다.",
    `- ${agentName("ca-reviewer")} 에게는 위 계획 파일 목록·검증 증거·컨벤션 경로만 넘깁니다 — 저장소를 다시 훑게 하지 않습니다.`,
    ...(changes ? [
      `- **재검토 범위** — 직전 ${changes.previous}회차 뒤 바뀐 계획 파일 ${changes.changed.length}개${changedList(changes.changed)}. ` +
        "바뀌지 않은 계획 파일은 직전 회차 판정을 이어받는다 — 바뀐 파일과 그 호출자·테스트, 직전 지적의 수정 여부를 먼저 대조하고, 바뀐 것이 닿는 나머지만 다시 읽는다.",
      ...(changes.findings.length ? [`- 직전 ${changes.previous}회차 ${agentName("ca-reviewer")} 지적 — 같은 id·경로로 상태를 갱신한다:`, ...changes.findings.map((line) => `  ${line}`)] : []),
    ] : []),
    ...(review?.waivers ?? []).map((waiver) => `- 사람 판단으로 기각한 지적: ${waiver.id}(${waiver.path}) — ${waiver.reason.replace(/\s+/g, " ").slice(0, 120)} · ${waiver.round}회차 — 리뷰어에게 넘겨 같은 지적을 새 번호로 다시 내지 않게 한다`),
    "",
    `${agentName("ca-reviewer")}를 호출하면 hook이 실행·완료를 관찰하고 \`## 지적\` 표를 자동 기록합니다. 메인은 결과·상태를 대신 쓰지 않습니다:`,
    "```markdown",
    "| id | 계획 파일 | 범위 | 상태 | 지적 |",
    "|---|---|---|---|---|",
    "| F1 | <계획 파일 경로> | 계획 안 | 열림 | <무엇이 어긋났나 · 근거 · 고치는 방향> |",
    "```",
    "- **열 순서는 고정입니다** — 코드가 칸 위치로 읽습니다. 상태는 `열림` · `해결` 둘뿐이고 글자 그대로 봅니다.",
    "- 계획 파일 칸은 **저장소 기준 경로 그대로** — 백틱도 `:줄번호` 도 붙이지 마세요 (줄번호·근거는 지적 칸에).",
    "- **범위는 코드가 계획과 대조해 정합니다** — 적은 것이 다르면 게이트가 알려 줍니다.",
    `- 계획 안 지적: 고친 뒤 code-agent verify 로 check·test 를 다시 돌고 code-agent review 로 다음 회차를 엽니다. 리뷰 회차는 ${usage.limit}회까지입니다.`,
    `- 계획 밖 지적: 모델이 닫을 수 없습니다. ${questionsFile(active.id)} 로 묻거나 계획을 고쳐 재승인받습니다.`,
  );
  out.push(...fileKnowledgeLines(repoRoot, work.manifest, planPaths(work), "## 계획 파일에 걸린 지식 항목 (반드시 적용하는 정책·필수 컨벤션 위반은 지적한다)"));

}

/** 통합 검증 */
export function integrateSection(_: RenderInput, out: string[]): void {
  out.push(
    "",
    "## 통합 검증",
    "`code-agent integrate` — 굳혀 둔 기준 커밋 위에 깨끗한 worktree 를 만들고 이 작업의 변경만 얹어 전체 build · test 를 돌립니다.",
    "작업 트리에 남아 있던 산출물이 결과를 떠받치지 않는지 보는 자리라, 모델이 할 일은 명령을 부르는 것뿐입니다.",
  );

}

/** ⑩ PR 본문·반영 */
export function deliverSection({ repoRoot, work }: RenderInput, out: string[]): void {
  const { active } = work;
  const scope = proposalScope(work, planPaths(work));
  const changing = scope?.changing ?? [];
  const unjudged = scope?.unjudged ?? [];
  out.push(
    "",
    `## ⑩ ${prDocFile(active.id)} — PR 본문`,
    "모델이 쓰는 것은 세 섹션입니다 — `## 요약` · `## 확인 방법` · `## 위험·되돌리기`.",
    "추적표(R → AC → 파일 → TC → 검증) · 검증 · 변경 요약은 코드 구역(`<!-- code-agent:trace:... -->`)이라 code-agent deliver 가 렌더합니다.",
    ...(scope === undefined
      ? [`공통 KNOWLEDGE 에 더할 것이 있으면 ${proposalFile(active.id)} 에 제안으로 씁니다 — 종류(\`## data-dictionary\`)마다 \`### \`키\` 이름\` 블록, 본문에 이번 작업의 R 번호를 답니다.`]
      : changing.length === 0 && unjudged.length === 0
        ? [`02 의 문서 영향에 갱신할 항목이 없습니다 — 지식 제안(${proposalFile(active.id)})을 쓰지 않습니다.`]
        : [
          `## 지식 제안 — 02 문서 영향의 갱신·신규·삭제·이름 변경 줄만 ${proposalFile(active.id)} 에 씁니다`,
          ...changing.map((row) => `- ${row.doc} · ${row.keys.map((key) => `\`${key}\``).join(", ")} · ${row.raw} — ${row.reason}`),
          ...unjudged.map((entry) => `- ${entry.path} · \`${entry.key}\` · 02 에서 판단하지 않음(계획 파일이 근거) — 이번 변경이 그 동작을 바꿨으면 갱신을 제안한다`),
          `- 구현·검증된 지금 동작만 씁니다(코드·테스트 경로가 트리에 있어야 반영됩니다). 형식은 ${skillFile("ca-integrate", notation(), "knowledge.md")} 를 따릅니다.`,
          "- 제안하지 않은 키는 반영 뒤 보류로 보입니다(문서를 최신으로 표시하지 않습니다).",
        ]),
    "",
    "**현재 호스트 세션에서 ca-answer의 deliver 동의 절차로 확인**한 뒤 작업 브랜치에 로컬 커밋합니다. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다 (직접 CLI를 원하면 TTY에서 `code-agent deliver`).",
    "push · MR/PR 생성은 하지 않습니다 (git 호스트가 붙을 때까지 보류).",
  );
  if (changing.length > 0 || unjudged.length > 0) {
    out.push(...fileKnowledgeLines(repoRoot, work.manifest, planPaths(work), "## 계획 파일에 걸린 지식 항목 (지금 문서 — 제안의 [지금] 과 비교된다)", false));
  }

}

/** context() 본문 — 머리(지시서·작업 폴더·문서·scope·preserve) 뒤에 스테이지·종류에 맞는 절을 이 순서로 붙인다 */
export function renderContext(repoRoot: string, work: Work, keys: string[]): string[] {
  const { active, manifest, order } = work;
  const input: RenderInput = { repoRoot, work, keys };
  const out: string[] = [
    `# code-agent context — ${order.id} · ${PHASE_LABEL[active.phase]}`,
    "",
    `- 지시서: ${active.spec} (${order.kind}, 대상 ${active.target})`,
    `- 작업 폴더: ${workDocsDir(active.id)}/ — 분석·질문·작업 문서·계획 초안을 여기에 쓴다`,
    `- 질문: ${questionsFile(active.id)}`,
    `- 아키텍처: ${manifest.docs.architecture ?? "(없음)"}`,
    `- 코드 컨벤션: ${manifest.conventions.join(", ") || "(없음)"}`,
  ];
  if (order.scope.length > 0) out.push(`- scope (건드려도 되는 곳): ${order.scope.join(", ")}`);
  if (order.preserve.length > 0) out.push(`- preserve (바뀌면 안 되는 것): ${order.preserve.join(" / ")}`);

  if (active.phase === "analysis") {
    analysisSection(input, out);
  }
  if (active.phase === "analysis" || active.phase === "impact" || active.phase === "design") {
    questionsAndAssumptions(input, out);
  }
  if (active.phase === "impact") {
    impactSection(input, out);
  }
  if (active.phase === "design") {
    designSection(input, out);
  }
  if (active.phase === "impact" || active.phase === "design" || active.phase === "plan") {
    planningSupport(input, out);
  }
  if (active.phase === "plan") {
    planSection(input, out);
  }
  if (active.phase === "implement" && order.kind === "fix") {
    fixImplementSection(input, out);
  }
  if (active.phase === "implement" && work.stage && work.plan) {
    implementSection(input, out);
  }
  // 검증·리뷰 스테이지 — 재탐색이 비용을 터뜨리는 자리다. 읽을 것을 코드가 골라 주고,
  // 긴 것(실패 로그)은 내용이 아니라 경로만 준다.
  if (AFTER_IMPLEMENT.includes(active.phase) && work.plan) {
    verificationSection(input, out);
  }
  if (active.phase === "review") {
    reviewSection(input, out);
  }
  if (active.phase === "integrate") {
    integrateSection(input, out);
  }
  if (active.phase === "deliver") {
    deliverSection(input, out);
  }
  return out;
}
