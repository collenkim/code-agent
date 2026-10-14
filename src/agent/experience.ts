import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { documentEntries, entryFields, keyRefs, pathList } from "./knowledge";
import { freshnessText, pathTouches } from "./knowledgeIndex";
import type { Freshness, SearchQuery } from "./knowledgeIndex";
import { experienceFile, STATE_DIR, WORK_DOCS_DIR } from "./layout";

/**
 * 작업 경험 기록 — 확정 정책·기능 문서와 다른 **선택적** 기록이다. 공통 KNOWLEDGE 종류에 넣지 않는다:
 * 경험은 그 작업 당시의 관찰·시도·가설이라 현재 동작의 정본이 아니고, 매 작업에 쓰라고 요구하지 않는다.
 *
 * - 자리: 원래 작업의 폴더 `doc/work/<ID>/experience.md` — `code-agent experience add` 만이 쓴다(hook 이 도구 쓰기를 막는다).
 *   작업 폴더라 반영(deliver) 커밋에 함께 들어가고, 승인 해시·계획 입력(doc/work 제외)·검증 묶임 밖이라 기록해도 승인·증거가 무효가 되지 않는다.
 * - ID: `EXP-<원래 작업 ID>-<순번>` — 처음 쓰는 작업이 자기 폴더의 다음 순번으로 정한다. 작업 ID 가 저장소에서 유일하므로 병렬 작업끼리 겹치지 않는다.
 * - 수정: 지난 작업의 폴더는 고치지 않는다. 뒤의 작업이 같은 ID 를 `버전: n+1` 로 자기 폴더에 쓴다(`revises`). 가장 높은 버전이 현재다 —
 *   같은 작업 안에서 다시 쓰면 반영 전 초안이라 그 항목을 갈아 끼우고 버전은 그대로다. 이력은 버전별 항목과 git 이력이다.
 * - 상태: 가설 · 검증됨 · 폐기(선언) — `검증됨` 은 그 버전을 쓴 작업의 통과한 검증 기록(`verify:<단계>`)과 이어질 때만 검증됨으로 본다.
 *   이어지지 않으면 `검증 근거 없음`(가설로 본다). 다른 기록이 `대체:` 로 가리키면 `대체됨` 이다. 모델의 선언만으로 확정하지 않는다.
 * - 정책이 아니다: 검색은 KNOWLEDGE 항목과 따로 세고 따로 보여 준다 — 반드시 적용하는 업무 정책 자리를 차지하지 않는다. 정책으로 올리려면
 *   지식 제안(knowledge.proposal)과 반영 동의를 거친다.
 */

export const EXPERIENCE_STATES = ["가설", "검증됨", "폐기"] as const;
export type DeclaredState = (typeof EXPERIENCE_STATES)[number];
export type ExperienceState = DeclaredState | "검증 근거 없음" | "대체됨" | "버전 충돌";
export const EXPERIENCE_ID = /^EXP-[A-Za-z0-9._-]+-\d+$/;
/** `검증:` 칸이 받는 근거 — 그 버전을 쓴 작업의 검증 증거에서 그 단계의 마지막 회차가 통과했는가 */
export const VERIFY_REF = /^verify:(repro|check|test|integrate)$/;

const line = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, size: number) => z.array(line(max)).max(size).default([]);

/** `experience add` 의 초안 — 칸마다 길이 상한이 있다(로그 전문이 아니라 요약을 쓰게) */
export const ExperienceDraftSchema = z.object({
  title: line(120),
  problem: line(600),
  environment: line(300).optional(),
  attempts: z.array(z.object({ approach: line(300), failure: line(300) }).strict()).max(8).default([]),
  cause: line(600),
  solution: line(600).optional(),
  evidence: list(100, 8),
  conditions: line(400),
  status: z.enum(EXPERIENCE_STATES).default("가설"),
  features: list(80, 10),
  policies: list(80, 10),
  code: list(200, 20),
  tests: list(200, 20),
  aliases: list(60, 10),
  revises: z.string().regex(EXPERIENCE_ID).optional(),
  supersedes: z.string().regex(EXPERIENCE_ID).optional(),
  change: line(300).optional(),
}).strict();
export type ExperienceDraft = z.infer<typeof ExperienceDraftSchema>;

/** 한 버전 — 한 작업 폴더의 항목 하나 */
export interface ExperienceVersion {
  id: string;
  /** freshness 가 읽는 키 — id 와 같다 */
  key: string;
  version: number;
  /** 이 버전을 쓴 작업(폴더) */
  work: string;
  path: string;
  line: number;
  end: number;
  title: string;
  body: string;
  declared: string;
  evidence: string[];
  /** 검증 기록과 이어진 근거 */
  verified: string[];
  /** 이어지지 않은 근거 — 형식이 틀렸거나 그 단계가 통과하지 않았다 */
  unverified: string[];
  refs: string[];
  features: string[];
  policies: string[];
  aliases: string[];
  supersedes?: string;
  problems: string[];
}

export interface ExperienceRecord {
  id: string;
  current: ExperienceVersion;
  /** 현재보다 낮은 버전 — 오래된 것부터 */
  history: ExperienceVersion[];
  state: ExperienceState;
  supersededBy?: string;
  /** 현재 버전과 같은 버전을 쓴 다른 작업의 항목 */
  conflicts: ExperienceVersion[];
}

export interface ExperienceIndex {
  records: ExperienceRecord[];
  /** 읽은 기록 파일 */
  files: string[];
}

function readText(path: string): string | undefined {
  try { return existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : undefined; } catch { return undefined; }
}

/** 작업의 검증 증거에서 통과한 단계 — 단계마다 마지막으로 돈 회차의 실행이 전부 통과했을 때만 */
function passedPhases(repoRoot: string, work: string): Set<string> {
  const passed = new Set<string>();
  const dir = join(repoRoot, STATE_DIR, "work", work);
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".verify.json")); } catch { return passed; }
  for (const name of names) {
    try {
      const evidence = JSON.parse(readFileSync(join(dir, name), "utf8")) as { runs?: { phase?: string; round?: number; outcome?: string }[] };
      const runs = Array.isArray(evidence.runs) ? evidence.runs : [];
      for (const phase of new Set(runs.map((run) => run.phase).filter((value): value is string => typeof value === "string"))) {
        const mine = runs.filter((run) => run.phase === phase);
        const last = Math.max(...mine.map((run) => (typeof run.round === "number" ? run.round : 0)));
        const latest = mine.filter((run) => (typeof run.round === "number" ? run.round : 0) === last);
        if (latest.length > 0 && latest.every((run) => run.outcome === "passed")) passed.add(phase);
      }
    } catch { /* 읽을 수 없는 증거는 근거가 아니다 */ }
  }
  return passed;
}

/** `검증:` 칸의 근거를 그 작업의 검증 기록과 대조한다 */
export function checkEvidence(repoRoot: string, work: string, evidence: readonly string[], cache = new Map<string, Set<string>>()): { verified: string[]; unverified: string[] } {
  if (!cache.has(work)) cache.set(work, passedPhases(repoRoot, work));
  const passed = cache.get(work)!;
  const verified: string[] = [], unverified: string[] = [];
  for (const ref of evidence) {
    const phase = VERIFY_REF.exec(ref)?.[1];
    (phase && passed.has(phase) ? verified : unverified).push(ref);
  }
  return { verified, unverified };
}

const tokens = (value: string | undefined): string[] =>
  (value ?? "").replace(/`/g, " ").split(/[\s,·]+/).map((token) => token.trim()).filter(Boolean);

/** 한 작업 폴더의 경험 항목들 */
function versionsIn(repoRoot: string, work: string, cache: Map<string, Set<string>>): ExperienceVersion[] {
  const path = experienceFile(work);
  const text = readText(join(repoRoot, path));
  if (text === undefined) return [];
  return documentEntries(text).filter((entry) => EXPERIENCE_ID.test(entry.key)).map((entry) => {
    const fields = entryFields(entry.body);
    const problems: string[] = [];
    const rawVersion = fields.get("버전");
    const version = rawVersion && /^\d+$/.test(rawVersion.trim()) ? Number(rawVersion.trim()) : 1;
    if (rawVersion !== undefined && !/^\d+$/.test(rawVersion.trim())) problems.push(`버전이 숫자가 아닙니다: ${rawVersion}`);
    const declared = (fields.get("상태") ?? "가설").trim().split(/\s/)[0];
    if (!(EXPERIENCE_STATES as readonly string[]).includes(declared)) problems.push(`상태는 ${EXPERIENCE_STATES.join(" · ")} 중 하나입니다: ${declared}`);
    if (version === 1 && !entry.key.startsWith(`EXP-${work}-`)) problems.push(`처음 버전의 ID 는 EXP-${work}-<순번> 입니다`);
    const written = fields.get("작업")?.trim();
    if (written && written !== work) problems.push(`작업 칸(${written})이 기록 폴더(${work})와 다릅니다`);
    const evidence = tokens(fields.get("검증"));
    const { verified, unverified } = checkEvidence(repoRoot, work, evidence, cache);
    const supersedes = keyRefs(fields.get("대체") ?? "").find((key) => EXPERIENCE_ID.test(key));
    return {
      id: entry.key, key: entry.key, version, work, path, line: entry.line, end: entry.end,
      title: entry.heading.replace(/^###\s+`[^`]+`\s*/, "").trim(),
      body: entry.body, declared, evidence, verified, unverified,
      refs: [...new Set([...pathList(fields.get("코드")), ...pathList(fields.get("테스트"))])].sort(),
      features: keyRefs(fields.get("기능") ?? ""), policies: keyRefs(fields.get("정책") ?? ""),
      aliases: (fields.get("별칭") ?? "").split(/[,·]/).map((alias) => alias.replace(/`/g, "").trim()).filter(Boolean),
      ...(supersedes ? { supersedes } : {}),
      problems,
    };
  });
}

/** 작업 폴더 이름 — 읽을 수 없으면 빈 목록 */
function workFolders(repoRoot: string): string[] {
  try {
    return readdirSync(join(repoRoot, WORK_DOCS_DIR), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** 모든 작업 폴더의 경험을 ID 별로 모은다 — 요청할 때 계산한다(파일로 남기지 않는다) */
export function experienceIndex(repoRoot: string): ExperienceIndex {
  const cache = new Map<string, Set<string>>();
  const versions: ExperienceVersion[] = [];
  const files: string[] = [];
  for (const work of workFolders(repoRoot)) {
    const found = versionsIn(repoRoot, work, cache);
    if (existsSync(join(repoRoot, experienceFile(work)))) files.push(experienceFile(work));
    versions.push(...found);
  }
  const byId = new Map<string, ExperienceVersion[]>();
  for (const version of versions) byId.set(version.id, [...(byId.get(version.id) ?? []), version]);
  const records: ExperienceRecord[] = [];
  for (const [id, all] of byId) {
    const sorted = [...all].sort((a, b) => a.version - b.version || (a.path < b.path ? -1 : 1));
    const top = sorted[sorted.length - 1].version;
    const tops = sorted.filter((version) => version.version === top);
    const current = tops[0];
    const missing = [...Array(top).keys()].map((n) => n + 1).filter((n) => !sorted.some((version) => version.version === n));
    if (missing.length > 0) current.problems.push(`버전 ${missing.join(", ")} 이(가) 없습니다`);
    records.push({ id, current, history: sorted.filter((version) => version.version < top), state: "가설", conflicts: tops.slice(1) });
  }
  // 대체는 현재 버전이 폐기가 아닌 기록이 가리킬 때만 — 가리키는 쪽이 지금 살아 있어야 옛것이 밀려난다
  const supersededBy = new Map<string, string>();
  for (const record of records) {
    if (record.current.supersedes && record.current.declared !== "폐기" && record.current.supersedes !== record.id) supersededBy.set(record.current.supersedes, record.id);
  }
  for (const record of records) {
    const by = supersededBy.get(record.id);
    record.state = record.conflicts.length > 0 ? "버전 충돌"
      : record.current.declared === "폐기" ? "폐기"
        : by ? "대체됨"
          : record.current.declared === "검증됨" ? (record.current.verified.length > 0 ? "검증됨" : "검증 근거 없음")
            : "가설";
    if (by) record.supersededBy = by;
  }
  records.sort((a, b) => (a.current.path < b.current.path ? -1 : a.current.path > b.current.path ? 1 : a.current.line - b.current.line));
  return { records, files };
}

/** 지금 쓸 만한가 — 폐기·대체됨은 검색에서 뒤로 보낸다(지우지 않는다: 왜 버렸는지도 경험이다) */
export function activeExperience(record: ExperienceRecord): boolean {
  return record.state !== "폐기" && record.state !== "대체됨";
}

export interface ExperienceHit { record: ExperienceRecord; score: number; why: string[] }

/**
 * KNOWLEDGE 검색과 같은 점수(키 10 · 근거 경로 6 · 연결 4 · 낱말 이름 3 / 본문 1)로 따로 센다. 결과는 KNOWLEDGE 결과와 섞지 않는다.
 * 폐기·대체됨은 살아 있는 기록 뒤에 온다.
 */
export function searchExperience(index: ExperienceIndex, query: SearchQuery): ExperienceHit[] {
  const keys = new Set(query.keys);
  const hits: ExperienceHit[] = [];
  for (const record of index.records) {
    const version = record.current;
    let score = 0;
    const why: string[] = [];
    if (keys.has(record.id)) { score += 10; why.push("키"); }
    const touched = query.files.find((file) => version.refs.some((ref) => pathTouches(ref, file)));
    if (touched) { score += 6; why.push(`경로 ${touched}`); }
    const linked = [...version.features, ...version.policies].find((key) => keys.has(key));
    if (linked) { score += 4; why.push(`연결 ${linked}`); }
    const name = [record.id, version.title, ...version.aliases].join(" ").toLowerCase();
    const body = version.body.slice(0, 4000).toLowerCase();
    const words: string[] = [];
    for (const keyword of query.keywords) {
      if (name.includes(keyword)) { score += 3; words.push(keyword); } else if (body.includes(keyword)) { score += 1; words.push(keyword); }
    }
    if (words.length) why.push(`낱말 ${words.slice(0, 4).join(" · ")}`);
    if (score > 0) hits.push({ record, score, why });
  }
  return hits.sort((a, b) => Number(activeExperience(b.record)) - Number(activeExperience(a.record)) || b.score - a.score ||
    (a.record.current.path < b.record.current.path ? -1 : a.record.current.path > b.record.current.path ? 1 : a.record.current.line - b.record.current.line));
}

/** 상태 글 — 선언과 판정이 다르면 판정을 쓴다 */
export function experienceStateText(record: ExperienceRecord): string {
  switch (record.state) {
    case "대체됨": return `대체됨 → ${record.supersededBy}`;
    case "버전 충돌": return `버전 충돌(${[record.current, ...record.conflicts].map((version) => version.work).join(", ")})`;
    case "검증 근거 없음": return "검증 근거 없음 — 가설로 본다";
    default: return record.state;
  }
}

/** 근거 경로의 변경 — 최신이면 비운다. 근거 경로가 없으면 변경을 감지할 수 없다고 적는다 */
export function experienceDriftText(fresh: Freshness | undefined): string {
  if (!fresh || fresh.state === "최신") return "";
  if (fresh.state === "근거 경로 없음") return "근거 경로 없음 — 코드 변경 감지 불가";
  return freshnessText(fresh);
}

/** 검색 결과 한 줄 — `경로 L시작-L끝 · ID 제목 [경험 · 상태 · v버전 · 변경] (이유)` */
export function experienceLine(hit: ExperienceHit, fresh?: Freshness): string {
  const version = hit.record.current;
  const status = ["경험", experienceStateText(hit.record), `v${version.version}`, experienceDriftText(fresh)].filter(Boolean).join(" · ");
  return `- ${version.path} L${version.line}-L${version.end} · \`${version.id}\` ${version.title} [${status}]${hit.why.length ? ` (${hit.why.join(" · ")})` : ""}`;
}

/** 경험 묶음 끝의 안내 — 출력마다 같은 문장 */
export const EXPERIENCE_NOTE = "경험은 당시 작업의 기록이지 확정 정책이 아닙니다 — 적용 전에 그 줄 범위와 현재 코드를 확인하고, 정책으로 올리려면 지식 제안(knowledge.proposal)으로 반영 동의를 거칩니다. 변경이 감지되지 않았다는 것은 내용이 맞다는 보장이 아닙니다.";

/** 원래 작업 ID — `EXP-<작업 ID>-<순번>` 에서 */
export function originWork(id: string): string {
  return id.replace(/^EXP-/, "").replace(/-\d+$/, "");
}

/** 새 기록의 순번 — 그 작업 폴더에 있는 처음 버전 ID 의 최댓값 + 1 */
export function nextExperienceId(repoRoot: string, work: string): string {
  const text = readText(join(repoRoot, experienceFile(work))) ?? "";
  const prefix = `EXP-${work}-`;
  const used = documentEntries(text).map((entry) => entry.key).filter((key) => key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length)))
    .map((key) => Number(key.slice(prefix.length)));
  return `${prefix}${used.length ? Math.max(...used) + 1 : 1}`;
}

/** 한 작업 폴더의 경험 항목 수 — status 한 줄 */
export function workExperienceCount(repoRoot: string, work: string): number {
  const text = readText(join(repoRoot, experienceFile(work)));
  return text === undefined ? 0 : documentEntries(text).filter((entry) => EXPERIENCE_ID.test(entry.key)).length;
}
