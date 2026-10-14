import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { writeAtomic } from "../core/atomic";
import { codeRefs, documentEntries, knowledgePath, missingRefs, removeEntry } from "./knowledge";
import type { DocumentEntry } from "./knowledge";
import { buildIndex, freshness, freshnessText, hitLine, linkLine, mandatoryPolicies, parseQuery, pendingWithoutEntry, search } from "./knowledgeIndex";
import { keywordsOf } from "./plugins/defaults";
import { EXPERIENCE_ID, EXPERIENCE_NOTE, experienceIndex, experienceLine, searchExperience } from "./experience";
import { KNOWLEDGE_KINDS, SCHEMAS } from "./schemas";
import type { KnowledgeKind } from "./schemas";
import { Stop } from "./stop";
import { askOnTerminal, requireTerminal } from "./tty";
import { loadManifestIfAny } from "./work";
import { skill } from "./hostText";

/**
 * `code-agent knowledge` · `knowledge find` · `knowledge prune` — 쌓인 공통 KNOWLEDGE 를 들여다보는 자리.
 *
 * 문서는 `deliver` 가 키 단위로 upsert·삭제·이름 변경하며 자란다. 목록은 항목마다 마지막으로 쓴 작업과
 * 최신성(그 뒤에 근거 코드·테스트가 바뀌었는가)을, `find` 는 키·경로·별칭·낱말로 줄 범위를 찾는다.
 * `find` 만 읽기 전용이라 모델이 부르는 서브명령 목록(`MODEL_SUBCOMMANDS`)에 있다. 목록과 정리는 사람의 자리다.
 */

/** 출처를 알 수 없는 항목 — 사람이 손으로 넣었거나, 아직 커밋되지 않았거나, git 저장소가 아니다 */
const UNKNOWN = "(미상)";

const USAGE = "사용법: code-agent knowledge [find <낱말|키|경로...> | prune]";

/** `find` 가 한 번에 보여 주는 결과 수 — 넘으면 수를 적는다 */
const FIND_LIMIT = 15;

// ---- 출처 (작업 ID) ----

/**
 * 제목 줄을 마지막으로 쓴 커밋의 제목에서 작업 ID 를 되찾는다.
 *
 * `applyEntry` 는 출처를 문서에 적지 않는다. 적게 바꾸면 이미 쌓인 문서를 전부 손봐야 하므로,
 * **git 에서 복원한다** — `deliver` 가 `[<ID>] <제목>` 으로 결정론적으로 커밋하기 때문에 가능하다.
 *
 * `--porcelain` 은 커밋마다 `summary <제목>` 을 한 번 실어 주므로 문서당 git 호출은 한 번이다.
 */
function blameIds(repoRoot: string, file: string): Map<number, string> {
  let out: string;
  try {
    out = execFileSync("git", ["blame", "--porcelain", "--", file], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return new Map(); // git 저장소가 아니거나 아직 커밋되지 않은 파일
  }
  const subjects = new Map<string, string>();
  const shaOfLine = new Map<number, string>();
  let sha = "";
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header) {
      sha = header[1];
      shaOfLine.set(Number(header[2]), sha);
      continue;
    }
    if (line.startsWith("summary ")) {
      subjects.set(sha, line.slice("summary ".length));
    }
  }
  const ids = new Map<number, string>();
  for (const [line, commit] of shaOfLine) {
    const id = /^\[([^\]]+)\]/.exec(subjects.get(commit) ?? "")?.[1];
    if (id) ids.set(line, id);
  }
  return ids;
}

// ---- 썩은 참조 ---- (판정은 knowledge.ts — 반영 검사와 같은 함수를 쓴다)

export { codeRefs, missingRefs };

// ---- 문서 읽기 ----

interface LoadedDoc {
  kind: KnowledgeKind;
  /** 저장소 기준 경로 */
  path: string;
  text: string;
  entries: DocumentEntry[];
}

function loadDocs(repoRoot: string): { docs: LoadedDoc[]; paths: string[] } {
  const manifest = loadManifestIfAny(repoRoot);
  const paths = KNOWLEDGE_KINDS.map((kind) => knowledgePath(manifest, kind));
  const docs: LoadedDoc[] = [];
  KNOWLEDGE_KINDS.forEach((kind, index) => {
    const path = paths[index];
    const absolute = join(repoRoot, path);
    if (!existsSync(absolute)) return;
    const text = readFileSync(absolute, "utf-8");
    docs.push({ kind, path, text, entries: documentEntries(text) });
  });
  return { docs, paths };
}

// ---- 목록 ----

export function knowledgeList(repoRoot: string): string {
  const { docs, paths } = loadDocs(repoRoot);
  if (docs.length === 0) {
    return [
      "공통 KNOWLEDGE 문서가 없습니다.",
      ...paths.map((path) => `  - ${path}`),
      `  ${skill("ca-docs")} 로 뼈대를 만들거나, code-agent docs link <종류> <경로> 로 이미 있는 문서를 등록하세요.`,
    ].join("\n");
  }
  const index = buildIndex(repoRoot, loadManifestIfAny(repoRoot), []);
  const fresh = freshness(repoRoot, index.entries);
  const lines: string[] = [];
  for (const doc of docs) {
    lines.push(`${doc.path} (항목 ${doc.entries.length}) · ${SCHEMAS[doc.kind].label}`);
    if (doc.entries.length === 0) {
      lines.push("  (비어 있습니다)");
      continue;
    }
    const ids = blameIds(repoRoot, doc.path);
    const keyWidth = Math.max(...doc.entries.map((entry) => entry.key.length));
    const indexed = index.entries.filter((entry) => entry.kind === doc.kind && entry.path === doc.path);
    for (const entry of doc.entries) {
      const refs = codeRefs(entry.body, paths);
      const state = fresh.get(indexed.find((item) => item.line === entry.line)!);
      const status = state ? freshnessText(state) || state.state : "";
      lines.push(
        `  ${entry.key.padEnd(keyWidth)}  ${(ids.get(entry.line) ?? UNKNOWN).padEnd(10)}  ${refs[0] ?? "근거 경로 없음"}${status && status !== "근거 경로 없음" ? `  [${status}]` : ""}`,
      );
    }
  }
  const pending = pendingWithoutEntry(repoRoot, index);
  return [
    ...lines,
    ...(pending.length > 0
      ? ["", "갱신을 선언하고 반영한 작업인데 문서에 없는 키 (반영에서 거부·보류했다 — 다음 작업에서 다시 판단한다):", ...pending.map((item) => `  - ${item.key} · ${item.id} (${item.decision})`)]
      : []),
    "",
    "[최신] 은 항목을 마지막으로 바꾼 커밋 뒤에 근거 코드·테스트가 바뀌지 않았다는 뜻이지 내용이 맞다는 보장은 아닙니다. 조사에서 현재 코드를 확인하세요.",
    "[재검토 필요]·[참조 없음]·[보류] 항목은 원문과 근거 코드를 직접 확인하고, 동작을 바꾸는 작업의 문서 영향에서 갱신을 판단합니다.",
    "작업 ID 는 **그 키를 마지막으로 쓴 작업**입니다 — 같은 키를 다시 반영하면 최신 것만 보입니다.",
    `커밋되지 않았거나 사람이 손으로 넣은 항목은 ${UNKNOWN} 입니다.`,
  ].join("\n");
}

// ---- 찾기 ----

/**
 * `knowledge find <낱말|키|경로...>` — KNOWLEDGE 항목과 POLICY 절을 같은 점수로 찾아 줄 범위·상태·연결을 보여 준다.
 * 반드시 적용하는 업무 정책은 상위 결과에서 빠져도 따로 적는다. 읽기 전용이다.
 */
export function knowledgeFind(repoRoot: string, text: string): string {
  const index = buildIndex(repoRoot, loadManifestIfAny(repoRoot));
  // 경험 ID 는 KNOWLEDGE 키가 아니다 — 낱말로 쪼개지지 않게 먼저 떼어 경험 검색의 키로만 쓴다
  const experienceKeys = text.split(/\s+/).map((token) => token.replace(/^`|`$/g, "")).filter((token) => EXPERIENCE_ID.test(token));
  const rest = text.split(/\s+/).filter((token) => !experienceKeys.includes(token.replace(/^`|`$/g, ""))).join(" ");
  const query = parseQuery(rest, index, (value) => keywordsOf([{ key: "", text: value }]));
  if (query.keys.length === 0 && query.files.length === 0 && query.keywords.length === 0 && experienceKeys.length === 0) {
    throw new Stop(USAGE);
  }
  const hits = search(index, query);
  const shown = hits.slice(0, FIND_LIMIT);
  const shownEntries = shown.flatMap((hit) => (hit.entry ? [hit.entry] : []));
  const mandatory = mandatoryPolicies(index, query, shownEntries).filter(({ entry }) => !shownEntries.includes(entry));
  const fresh = freshness(repoRoot, [...shownEntries, ...mandatory.map(({ entry }) => entry)]);
  const searched = [...new Set([...index.docs.filter((doc) => doc.exists).map((doc) => doc.path), ...index.sections.map((section) => section.path)])];
  const lines = [`찾기: ${[...experienceKeys, ...query.keys, ...query.files, ...query.keywords].join(" · ")}`];
  if (hits.length === 0) {
    lines.push(
      "",
      searched.length > 0 ? `KNOWLEDGE·POLICY 에서 걸린 항목이 없습니다 (찾은 문서: ${searched.join(", ")}).` : "찾을 문서가 없습니다.",
      "문서에 없는 동작일 수 있습니다 — 코드와 테스트를 직접 찾으세요.",
    );
  } else {
    lines.push("");
    for (const hit of shown) {
      lines.push(hitLine(hit, hit.entry ? fresh.get(hit.entry) : undefined));
      const link = hit.entry ? linkLine(hit.entry) : undefined;
      if (link) lines.push(link);
    }
    if (hits.length > shown.length) {
      lines.push(`- 범위: 걸린 ${hits.length}개 중 상위 ${shown.length}개만 — 키·경로·낱말을 더 좁혀 다시 찾으세요`);
    }
  }
  if (mandatory.length > 0) {
    lines.push("", "반드시 적용하는 업무 정책 (순위와 관계없이 — 구분 필수·관찰 아님):");
    for (const { entry, why } of mandatory) lines.push(hitLine({ entry, score: 0, why: [why] }, fresh.get(entry)));
  }
  if ([...fresh.values()].some((state) => state.state !== "최신" && state.state !== "근거 경로 없음")) {
    lines.push("", "상태가 붙은 항목(재검토 필요·참조 없음·보류·미커밋)은 요약을 믿지 말고 그 범위의 원문과 근거 코드·테스트를 직접 확인하세요.");
  }
  // 작업 경험 — KNOWLEDGE 결과·반드시 적용하는 정책과 섞지 않고 그 뒤에 따로(상한도 따로) 보인다
  const experiences = searchExperience(experienceIndex(repoRoot), { ...query, keys: [...query.keys, ...experienceKeys] });
  const shownExperiences = experiences.slice(0, EXPERIENCE_FIND_LIMIT);
  if (shownExperiences.length > 0) {
    const drift = freshness(repoRoot, shownExperiences.map((hit) => hit.record.current));
    lines.push("", "작업 경험 (확정 정책 아님 — 당시 작업의 기록):", ...shownExperiences.map((hit) => experienceLine(hit, drift.get(hit.record.current))));
    if (experiences.length > shownExperiences.length) lines.push(`- 범위: 걸린 ${experiences.length}개 중 ${shownExperiences.length}개만 — code-agent experience list`);
    lines.push(EXPERIENCE_NOTE);
  }
  if (hits.length > 0 || mandatory.length > 0 || shownExperiences.length > 0) lines.push("", "줄 범위만 읽으세요 — 문서 전문을 열지 않습니다.");
  return lines.join("\n");
}

/** `find` 가 보여 주는 작업 경험 수 — KNOWLEDGE 결과와 따로 센다 */
const EXPERIENCE_FIND_LIMIT = 5;

// ---- 정리 ----

export interface PruneCandidate {
  kind: KnowledgeKind;
  /** 저장소 기준 경로 */
  path: string;
  key: string;
  heading: string;
  body: string;
  /** 지금 트리에 없는 경로 — 이 항목이 든 닻 전부다 */
  missing: string[];
}

/**
 * 표시 규칙: **참조가 하나 이상인데 그 전부가 없는** 항목만.
 *
 * 하나만 썩은 것은 리팩터링의 흔적이라 잡음이다(파일 하나가 옮겨 갔을 뿐 항목은 살아 있다).
 * 전부 없다면 그 항목의 닻이 통째로 사라진 것이다. 참조가 0개인 항목은 **절대 표시하지 않는다** —
 * `business-rules` 는 사람의 답에서 오므로 경로가 없는 것이 정상이고, 그것을 지우자고 물으면
 * 이 명령은 문서를 갉아먹는 도구가 된다.
 *
 * 고르는 일과 지우는 일을 나눠 둔다 — 지우기는 TTY 가 있어야 하지만 휴리스틱은 그렇지 않다.
 */
export function pruneCandidates(repoRoot: string): { found: PruneCandidate[]; unchecked: number } {
  const { docs, paths } = loadDocs(repoRoot);
  const found: PruneCandidate[] = [];
  let unchecked = 0;
  for (const doc of docs) {
    for (const entry of doc.entries) {
      const refs = codeRefs(entry.body, paths);
      if (refs.length === 0) {
        unchecked += 1;
        continue;
      }
      const missing = missingRefs(repoRoot, refs);
      if (missing.length === refs.length) {
        found.push({ kind: doc.kind, path: doc.path, key: entry.key, heading: entry.heading, body: entry.body, missing });
      }
    }
  }
  return { found, unchecked };
}

export function knowledgePrune(repoRoot: string): string {
  // 비TTY 는 **고르기 전에** 막는다 — 물을 수 없는 자리에서 문서를 건드릴 이유가 없다
  requireTerminal("공통 KNOWLEDGE 항목 정리");
  const { found, unchecked } = pruneCandidates(repoRoot);
  const tail = unchecked > 0 ? [`근거 경로가 없어 검사하지 못한 항목: ${unchecked}개`] : [];
  if (found.length === 0) {
    return ["근거 경로가 전부 사라진 항목은 없습니다.", ...tail].join("\n");
  }

  const removed: string[] = [];
  /** 한 문서에 여러 항목이 걸릴 수 있다 — 지울 때마다 그 문서의 지금 내용을 이어 받는다 */
  const texts = new Map<string, string>();
  for (const candidate of found) {
    const shown = [
      `${candidate.path} · ${SCHEMAS[candidate.kind].label}`,
      "",
      candidate.heading,
      candidate.body,
      "",
      `없는 경로: ${candidate.missing.join(" · ")}`,
    ].join("\n");
    // 자동 삭제는 없다 — 사람이 하나씩 보고 y 를 친 것만 지운다
    if (askOnTerminal(shown, "지우려면 y") !== "y") {
      continue;
    }
    const absolute = join(repoRoot, candidate.path);
    const next = removeEntry(texts.get(candidate.path) ?? readFileSync(absolute, "utf-8"), candidate.key);
    texts.set(candidate.path, next);
    writeAtomic(absolute, next);
    removed.push(`${candidate.path} · ${candidate.key}`);
  }

  return [
    removed.length > 0 ? `${removed.length}개 항목을 지웠습니다:` : "지운 항목이 없습니다.",
    ...removed.map((line) => `  - ${line}`),
    ...tail,
    ...(removed.length > 0
      ? ["", "이 변경은 커밋되지 않았습니다 — git add/commit 은 사람이 합니다."]
      : []),
  ].join("\n");
}

export function knowledge(repoRoot: string, args: string[]): string {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    return knowledgeList(repoRoot);
  }
  if (subcommand === "find" && rest.length > 0) {
    return knowledgeFind(repoRoot, rest.join(" "));
  }
  if (subcommand === "prune" && rest.length === 0) {
    return knowledgePrune(repoRoot);
  }
  throw new Stop(USAGE);
}
