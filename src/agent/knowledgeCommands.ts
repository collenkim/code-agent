import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { writeAtomic } from "../core/atomic";
import { documentEntries, knowledgePath, removeEntry } from "./knowledge";
import type { DocumentEntry } from "./knowledge";
import { KNOWLEDGE_KINDS, SCHEMAS } from "./schemas";
import type { KnowledgeKind } from "./schemas";
import { Stop } from "./stop";
import { askOnTerminal, requireTerminal } from "./tty";
import { loadManifestIfAny } from "./work";

/**
 * `code-agent knowledge` · `code-agent knowledge prune` — 쌓인 공통 KNOWLEDGE 를 사람이 들여다보는 자리.
 *
 * 문서는 `deliver` 가 키 단위로 upsert 하며 자란다. 자라기만 하고 줄지 않으므로, 어느 작업이 무엇을
 * 넣었는지 보는 길과 **사람이** 썩은 항목을 걷어내는 길이 필요하다. 둘 다 사람의 자리라 모델이
 * 부르는 서브명령 목록(`MODEL_SUBCOMMANDS`)에는 넣지 않는다.
 */

/** 출처를 알 수 없는 항목 — 사람이 손으로 넣었거나, 아직 커밋되지 않았거나, git 저장소가 아니다 */
const UNKNOWN = "(미상)";

const USAGE = "사용법: code-agent knowledge [prune]";

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

// ---- 썩은 참조 ----

/** `path/to/File.java:31` · `src/x/y.ts` — 확장자가 있고 경로 구분자가 있는 것만 참조로 본다 */
const REF = /[\w./-]+\.[A-Za-z]\w*(?::\d+)?/g;

/**
 * 항목 본문이 닻으로 든 저장소 경로.
 *
 * 세 가지를 뺀다. **URL** 은 저장소 경로가 아니고(`example.com/a.md` 가 그대로 걸린다),
 * 경로 구분자 없는 **홑이름**(`Order.java`)은 어디를 가리키는지 모르며,
 * **KNOWLEDGE 문서 자신**을 가리키는 줄은 늘 존재해 판정을 무의미하게 만든다.
 */
export function codeRefs(body: string, knowledgeDocs: string[]): string[] {
  const withoutUrls = body.replace(/https?:\/\/\S+/g, " ");
  const refs = new Set<string>();
  for (const match of withoutUrls.matchAll(REF)) {
    const ref = match[0];
    const path = ref.replace(/:\d+$/, "");
    if (!path.includes("/") || knowledgeDocs.includes(path)) continue;
    refs.add(ref);
  }
  return [...refs].sort();
}

/** 트리에 없는 참조. `existsSync` 가 아니라고 하면 git 에게 한 번 더 묻는다 (경로 형식·대소문자 차이) */
export function missingRefs(repoRoot: string, refs: string[]): string[] {
  return refs.filter((ref) => {
    const path = ref.replace(/:\d+$/, "");
    if (existsSync(join(repoRoot, path))) return false;
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return false;
    } catch {
      return true;
    }
  });
}

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
      "  /ca-docs 로 뼈대를 만들거나, code-agent docs link <종류> <경로> 로 이미 있는 문서를 등록하세요.",
    ].join("\n");
  }
  const lines: string[] = [];
  for (const doc of docs) {
    lines.push(`${doc.path} (항목 ${doc.entries.length})`);
    if (doc.entries.length === 0) {
      lines.push("  (비어 있습니다)");
      continue;
    }
    const ids = blameIds(repoRoot, doc.path);
    const keyWidth = Math.max(...doc.entries.map((entry) => entry.key.length));
    for (const entry of doc.entries) {
      const refs = codeRefs(entry.body, paths);
      lines.push(
        `  ${entry.key.padEnd(keyWidth)}  ${(ids.get(entry.line) ?? UNKNOWN).padEnd(10)}  ${refs[0] ?? "근거 경로 없음"}`,
      );
    }
  }
  return [
    ...lines,
    "",
    "작업 ID 는 **그 키를 마지막으로 쓴 작업**입니다 — 같은 키를 다시 반영하면 최신 것만 보입니다.",
    `커밋되지 않았거나 사람이 손으로 넣은 항목은 ${UNKNOWN} 입니다.`,
  ].join("\n");
}

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

export function knowledge(repoRoot: string, subcommand: string | undefined): string {
  if (subcommand === undefined) {
    return knowledgeList(repoRoot);
  }
  if (subcommand === "prune") {
    return knowledgePrune(repoRoot);
  }
  throw new Stop(USAGE);
}
