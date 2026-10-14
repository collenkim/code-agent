import { sectionBody } from "./docs";
import { proposalFile } from "./knowledge";
import { buildIndex, CHANGING_DECISIONS, DOC_DECISIONS, docImpactBody, docImpactRows, relatedEntries } from "./knowledgeIndex";
import type { DocImpactRow, IndexEntry, KnowledgeIndex } from "./knowledgeIndex";
import { WORK_SCHEMAS } from "./schemas";
import type { Work } from "./work";
import { readWorkDoc, workDocPath, type DocOverlay } from "./workDocs";

/**
 * 문서 영향 — 분석(impact)에서 이번 변경이 어느 지식 항목에 닿는지 판단하고, 반영(deliver)이 그 판단과 실제 적용을 맞춰 본다.
 *
 * 문서 영향 판단이 켜진 작업(`active.knowledgeVersion`)에만 건다 — 진행 중이던 작업의 02 에는 이 절이 없다.
 * 막는 것은 둘이다: 판단 없는 표(판단 값·근거가 빈 줄)와, 이 작업이 닿는 파일을 근거로 든 기존 항목을 판단하지 않은 것.
 * 관련 없는 항목까지 판단하라고 하지 않는다 — 범위는 영향 범위 표(impact)·계획 파일과 근거 경로가 겹치는 항목뿐이다.
 */

/** 영향 범위 표의 `닿는 파일/모듈` 칸에 적힌 경로 */
export function impactTableFiles(text: string): string[] {
  const body = sectionBody(WORK_SCHEMAS["02-analysis"], text, "impact");
  const files = new Set<string>();
  for (const line of body.split("\n")) {
    const cells = line.trim().startsWith("|") ? line.split("|").slice(1) : [];
    if (!/\bR\d+\b/.test(cells[0] ?? "")) continue;
    for (const match of (cells[1] ?? "").matchAll(/[\w./-]*\/[\w./-]+|[\w-]+\.[A-Za-z]\w*/g)) {
      files.add(match[0].replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, ""));
    }
  }
  return [...files];
}

/** 이 작업의 02 문서 영향 표 — 절이 없으면 undefined */
export function workDocImpact(work: Work, overlay?: DocOverlay): DocImpactRow[] | undefined {
  const text = readWorkDoc(work.repoRoot, work.active.id, "02-analysis", overlay);
  const body = text === undefined ? undefined : docImpactBody(text);
  return body === undefined ? undefined : docImpactRows(body);
}

function judged(rows: DocImpactRow[], entry: IndexEntry): boolean {
  return rows.some((row) => row.keys.includes(entry.key));
}

/**
 * impact 게이트 — 표가 있고, 줄마다 판단·근거가 있고, 영향 범위 표의 파일을 근거로 든 항목이 모두 판단됐는가.
 * `index` 를 넘기면 그것을 쓴다(테스트·한 번 만든 인덱스 재사용).
 */
export function docImpactProblems(work: Work, overlay?: DocOverlay, index?: KnowledgeIndex): string[] {
  if (!work.active.knowledgeVersion) return [];
  const path = workDocPath(work.active.id, "02-analysis");
  const text = readWorkDoc(work.repoRoot, work.active.id, "02-analysis", overlay);
  if (text === undefined) return [];   // 02 가 없다는 문제는 analysisProblems 가 낸다
  const body = docImpactBody(text);
  if (body === undefined) {
    return [`${path} — \`## 문서 영향\` 표가 없습니다: | 문서 | 키 | 판단 | 근거 | (바꿀 문서가 없으면 | - | - | 영향 없음 | <근거> | 한 줄)`];
  }
  const rows = docImpactRows(body);
  const problems: string[] = [];
  if (rows.length === 0) problems.push(`${path} — 문서 영향 표에 줄이 없습니다 (바꿀 문서가 없으면 | - | - | 영향 없음 | <근거> |)`);
  const unknown = rows.filter((row) => !row.decision).map((row) => row.raw || "(빈 칸)");
  if (unknown.length) problems.push(`${path} — 문서 영향의 판단은 ${DOC_DECISIONS.join(" · ")} 중 하나입니다: ${unknown.join(", ")}`);
  const bare = rows.filter((row) => row.decision && row.reason.replace(/[-—\s]/g, "") === "").map((row) => row.keys.join(", ") || row.doc || row.raw);
  if (bare.length) problems.push(`${path} — 문서 영향의 근거가 비었습니다: ${bare.join(", ")} (영향 없음도 왜 없는지 한 줄)`);
  const keyless = rows.filter((row) => row.decision && CHANGING_DECISIONS.includes(row.decision) && row.keys.length === 0).map((row) => row.raw);
  if (keyless.length) problems.push(`${path} — 갱신·신규·삭제·이름 변경 줄에는 키가 있어야 합니다(반영 제안과 맞춰 봅니다): ${keyless.join(", ")}`);
  const files = impactTableFiles(text);
  const missing = relatedEntries(index ?? buildIndex(work.repoRoot, work.manifest), files).filter((entry) => !judged(rows, entry));
  if (missing.length) {
    problems.push(`${path} — 영향 범위의 파일을 근거로 든 지식 항목을 문서 영향에서 판단하세요: ${missing.map((entry) => `${entry.key}(${entry.path}:${entry.line})`).join(", ")}`);
  }
  return problems;
}

/**
 * 반영의 지식 제안 범위 — 02 문서 영향의 갱신·신규·삭제·이름 변경 줄과, 계획 파일을 근거로 든 항목 중 02 에서 판단하지 않은 것
 * (영향 범위에 없던 파일이 계획에 들어온 경우). 계획 제출을 막지 않는다 — 02 는 계획 단계에서 고칠 수 없어 막으면 되감기가 된다.
 * 판단하지 않은 항목은 제안하지 않으면 반영 뒤 근거 코드가 바뀐 것으로 재검토 필요가 된다. 문서 영향 판단이 없는 작업이면 undefined.
 */
export function proposalScope(work: Work, planFiles: string[], index?: KnowledgeIndex): { changing: DocImpactRow[]; unjudged: IndexEntry[] } | undefined {
  if (!work.active.knowledgeVersion) return undefined;
  const rows = workDocImpact(work) ?? [];
  return {
    changing: rows.filter((row) => row.decision && CHANGING_DECISIONS.includes(row.decision)),
    unjudged: relatedEntries(index ?? buildIndex(work.repoRoot, work.manifest), planFiles).filter((entry) => !judged(rows, entry)),
  };
}

/** status·스테이지 이동 출력의 `지식 제안:` 줄 — 반영 단계의 새 작업만 */
export function proposalHint(work: Work, planFiles: string[], format: string): string | undefined {
  if (work.active.phase !== "deliver") return undefined;
  const scope = proposalScope(work, planFiles);
  if (!scope) return undefined;
  const keys = scope.changing.map((row) => `${row.keys.map((key) => `\`${key}\``).join(", ") || row.doc}(${row.raw})`);
  const unjudged = scope.unjudged.length
    ? ` · 02 에서 판단하지 않은 관련 항목 ${scope.unjudged.map((entry) => `\`${entry.key}\``).join(", ")} — 이번 변경이 그 동작을 바꿨으면 함께 제안`
    : "";
  return keys.length || unjudged
    ? `지식 제안: ${keys.length ? keys.join(" · ") : "02 의 갱신 줄 없음"}${unjudged} — ${proposalFile(work.active.id)} 에, 형식은 ${format}`
    : "지식 제안: 없음 — 02 문서 영향에 갱신할 항목이 없어 지식 제안을 쓰지 않습니다";
}

/** 반영 화면·결과 — 선언한 갱신 중 적용하지 않은 키와 충돌로 판단한 줄 */
export function deliverImpact(work: Work, applied: string[]): { pending: DocImpactRow[]; conflicts: DocImpactRow[] } {
  const rows = work.active.knowledgeVersion ? workDocImpact(work) ?? [] : [];
  return {
    pending: rows.filter((row) => row.decision && CHANGING_DECISIONS.includes(row.decision) && row.keys.some((key) => !applied.includes(key))),
    conflicts: rows.filter((row) => row.decision === "충돌"),
  };
}
