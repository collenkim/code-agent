import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, posix } from "path";

import { MANIFEST_FILE } from "../core/manifest";
import type { Manifest } from "../core/manifest";
import type { Presence } from "../core/approval";
import { STATE_DIR } from "./layout";
import { GAP_MARKER, KNOWLEDGE_KINDS, POLICY_KINDS, SCHEMAS } from "./schemas";
import type { DocKind, DocSchema, KnowledgeKind } from "./schemas";

/**
 * 공통 POLICY 문서 — 아키텍처 · 코드 컨벤션 · 테스트 전략 · 품질·보안 기준.
 *
 * 넷 다 셋을 만족해야 작업이 시작되고 스테이지가 넘어간다. 그 빈자리를 모델이 지어내기 때문이다.
 * 1. 파일이 있다  2. 필수 섹션이 있고 비어 있지 않다(`확인 필요` 가 남지 않았다)  3. 사람이 지금 내용으로 확정했다
 *
 * 공통 KNOWLEDGE(데이터 사전·API 목록·업무 규칙)는 여기에 끼지 않는다 — 파일 존재만 보고 막지 않는다(checkKnowledge).
 */
export type DocState = "missing-file" | "missing-sections" | "unconfirmed" | "stale" | "confirmed";

export interface SectionState {
  id: string;
  heading: string;
  required: boolean;
  found: boolean;
  /** 실제 내용이 한 줄이라도 있다 — 주석·제목·`확인 필요` 줄은 내용이 아니다 */
  filled: boolean;
  /** `확인 필요` 가 남은 줄 수. 막지는 않고, 확정하는 사람이 보고 판단한다 */
  open: number;
}

export interface DocCheck {
  kind: DocKind;
  label: string;
  paths: string[];
  state: DocState;
  ok: boolean;
  sections: SectionState[];
  /** 지금 내용의 해시. 파일이 없으면 없다 */
  hash?: string;
  problem?: string;
}

export const DOCS_LEDGER = `${STATE_DIR}/approvals/docs.jsonl`;

export function docPaths(manifest: Manifest | undefined, kind: DocKind): string[] {
  if (kind === "conventions") {
    // 컨벤션만 여럿이다 — 이미 여러 파일·디렉토리에 흩어져 있는 저장소가 흔하다
    return manifest && manifest.conventions.length > 0 ? manifest.conventions : [SCHEMAS.conventions.defaultPath];
  }
  const registered = {
    architecture: manifest?.docs.architecture,
    "test-strategy": manifest?.docs.testStrategy,
    quality: manifest?.docs.quality,
    "data-dictionary": manifest?.docs.knowledge?.dataDictionary,
    "api-catalog": manifest?.docs.knowledge?.apiCatalog,
    "business-rules": manifest?.docs.knowledge?.businessRules,
  }[kind];
  return [registered ?? SCHEMAS[kind].defaultPath];
}

/** 경로가 디렉토리면 그 아래 마크다운 전부 — 컨벤션은 여러 파일로 나뉘어 있기 흔하다 */
function markdownFiles(repoRoot: string, path: string): string[] {
  const absolute = join(repoRoot, path);
  if (!statSync(absolute).isDirectory()) {
    return [path];
  }
  return readdirSync(absolute)
    .sort()
    .flatMap((name) => {
      const child = posix.join(path, name);
      if (statSync(join(repoRoot, child)).isDirectory()) return markdownFiles(repoRoot, child);
      return name.endsWith(".md") ? [child] : [];
    });
}

/** 제목 비교용 — 번호·뒤에 붙은 괄호 설명·강조·공백은 제목이 아니다. 섹션을 찾는 곳은 전부 이것을 쓴다 */
export function normalizeHeading(text: string): string {
  return text
    .replace(/^[\d.)\s]+/, "")
    // 뒤에 붙은 괄호 설명은 제목이 아니다 — "응답 (성공, HTTP 200)" 은 "응답" 이다
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * 제목과 그 아래 본문(다음 같은·더 높은 수준 제목 전까지). 주석은 본문이 아니다.
 * `line` 은 1부터 센 제목 줄 번호, `level` 은 `#` 의 개수 — `context.docs` 의 기본 구현이
 * 절을 가리키고 문서 제목(level 1, 본문이 문서 전체다)을 걸러 낼 때 쓴다.
 */
export function sectionsOf(text: string): { heading: string; body: string; line: number; level: number }[] {
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const found: { heading: string; level: number; start: number }[] = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) found.push({ heading: match[2], level: match[1].length, start: index });
  });
  return found.map((entry, index) => {
    const end = found.slice(index + 1).find((other) => other.level <= entry.level)?.start ?? lines.length;
    return {
      heading: entry.heading,
      body: lines.slice(entry.start + 1, end).join("\n"),
      line: entry.start + 1,
      level: entry.level,
    };
  });
}

/**
 * 섹션마다 **내용이 있는가**와 **미결이 몇 줄인가**를 따로 센다.
 *
 * 둘을 하나로 묶으면(미결 한 줄이면 불통과) 핵심은 다 쓴 문서가 세부 한 줄 때문에 못 지나가고,
 * 사람은 표시를 지워서 통과시키는 법을 배운다. 막는 것은 "비어 있음"이고, 미결은 확정하는 사람에게 보인다.
 */
export function checkSections(schema: DocSchema, text: string): SectionState[] {
  const sections = sectionsOf(text);
  return schema.sections.map((section) => {
    const names = [section.heading, ...section.aliases].map(normalizeHeading);
    const bodies = sections
      .filter((candidate) => names.includes(normalizeHeading(candidate.heading)))
      .map((match) => match.body.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
    const filled = bodies.some((lines) => lines.some((line) => !line.startsWith("#") && !line.includes(GAP_MARKER)));
    const open = bodies.flat().filter((line) => line.includes(GAP_MARKER)).length;
    return { id: section.id, heading: section.heading, required: section.required, found: bodies.length > 0, filled, open };
  });
}

/**
 * 스키마가 정한 한 섹션의 본문 — 별칭으로 쓴 제목도 같은 섹션이고, 여러 번 나오면 이어 붙인다.
 * 섹션마다 다른 규칙(명령 이름 대조 · 영향 범위 표 · 테스트 케이스 표)을 코드가 볼 때 쓴다.
 */
export function sectionBody(schema: DocSchema, text: string, id: string): string {
  const section = schema.sections.find((candidate) => candidate.id === id);
  if (!section) {
    return "";
  }
  const names = [section.heading, ...section.aliases].map(normalizeHeading);
  return sectionsOf(text)
    .filter((candidate) => names.includes(normalizeHeading(candidate.heading)))
    .map((match) => match.body)
    .join("\n");
}

/** 명령 이름을 적는 섹션 — 여기 적힌 이름은 매니페스트에 실재해야 한다 */
const COMMAND_SECTIONS: Partial<Record<DocKind, string[]>> = {
  "test-strategy": ["tools"],
  quality: ["static", "security"],
};

/**
 * 첫 목록의 백틱 이름 — ``- `unit`: 단위 테스트`` 의 `unit`. `- 없음` 은 이름이 아니라 `none` 으로 센다.
 * 백틱으로 시작하지 않는 줄은 대조하지 않는다 — 자동 검사가 없는 것은 사실일 수 있고,
 * 거짓말이 되는 것은 '있다고 적고 돌지 않는' 쪽뿐이다.
 *
 * 빈 줄은 목록의 끝이 아니다 (마크다운의 loose list) — 건너뛰고, 목록이 아닌 줄에서만 끝낸다.
 * 여기서 끊으면 항목을 띄어 쓴 목록의 뒷이름이 통째로 대조에서 빠진다.
 */
export function firstListNames(body: string): { names: string[]; none: boolean } {
  const lines = body.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => /^[-*]\s+/.test(line));
  const names: string[] = [];
  let none = false;
  for (let index = start; index >= 0 && index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") continue;
    if (!/^[-*]\s+/.test(line)) break;
    const item = line.replace(/^[-*]\s+/, "");
    if (item.startsWith("없음")) {
      none = true;
      continue;
    }
    const match = /^`([^`]+)`/.exec(item);
    if (match) names.push(match[1]);
  }
  return { names, none };
}

/**
 * 명령을 적는 섹션의 문제 — 이름이 `code-agent.json` 에 실재하는가, 애초에 대조할 이름을 적었는가.
 *
 * `verifyByBuild` 는 명령이 없으면 `not-run · skipped` 로 돌려주므로, 이 대조가 없으면
 * "테스트를 돌렸다"는 보고가 아무것도 돌리지 않은 결과 위에 선다. 확정 화면에서 드러나야 할 일이다.
 * 백틱 이름도 `없음` 도 없는 산문("단위 테스트는 ./gradlew unitTest 로 돈다")은 대조가 0건이 되므로 미충족이다.
 */
function commandProblems(manifest: Manifest | undefined, schema: DocSchema, text: string): string[] {
  const ids = COMMAND_SECTIONS[schema.kind as DocKind];
  if (!ids) return [];
  const declared = new Set([
    ...(manifest?.build ? ["build"] : []),
    ...(manifest?.test ? ["test"] : []),
    ...Object.keys(manifest?.commands ?? {}),
  ]);
  return ids.flatMap((id) => {
    const heading = schema.sections.find((section) => section.id === id)?.heading ?? id;
    const { names, none } = firstListNames(sectionBody(schema, text, id));
    if (names.length === 0 && !none) {
      return [`${heading}: 실행 명령을 목록으로 적으세요 — \`- \`<이름>\`: 설명\` (자동 검사가 없으면 \`- 없음\`)`];
    }
    const unknown = names.filter((name) => !declared.has(name));
    return unknown.length === 0
      ? []
      : [`${heading}: ${MANIFEST_FILE} 에 없는 명령 이름입니다: ${unknown.join(", ")} — build · test · commands 에 선언하거나 문서에서 지우세요`];
  });
}

export function sha(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16)}`;
}

/** 줄바꿈은 해시에 넣지 않는다 — Windows 의 autocrlf 가 내용을 바꾸지 않았는데 확정을 무효로 만들면 안 된다 */
function hashFiles(repoRoot: string, files: string[]): string {
  return sha(files.map((file) => `${file}\n${readFileSync(join(repoRoot, file), "utf-8").replace(/\r\n/g, "\n")}`).join("\n\0\n"));
}

// ---- 확정 원장 ----

interface DocRecord {
  kind: DocKind;
  paths: string[];
  hash: string;
  approver: string;
  at: string;
  presence: Presence;
  prev: string;
}

function ledgerLines(repoRoot: string): string[] {
  const path = join(repoRoot, DOCS_LEDGER);
  // autocrlf 체크아웃이 붙인 CR 은 쓰인 바이트가 아니다 — 원장은 LF 로만 쓴다
  return existsSync(path) ? readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim() !== "") : [];
}

/** 사슬을 검사하며 읽는다. 끊겼으면 던진다 — 나중에 고친 확정을 조용히 믿지 않는다 */
export function readDocLedger(repoRoot: string): DocRecord[] {
  const lines = ledgerLines(repoRoot);
  return lines.map((line, index) => {
    const record = JSON.parse(line) as DocRecord;
    const expected = index === 0 ? "genesis" : sha(lines[index - 1]);
    if (record.prev !== expected) {
      throw new Error(`${DOCS_LEDGER} ${index + 1}번째 줄: 사슬이 끊겼습니다 — 누가 원장을 고쳤는지 확인하세요.`);
    }
    return record;
  });
}

export function recordDocConfirmation(
  repoRoot: string,
  check: DocCheck,
  approver: string,
  presence: Presence,
): void {
  if (!check.hash) {
    throw new Error(`${check.label} 문서가 없어 확정할 수 없습니다.`);
  }
  readDocLedger(repoRoot);
  const lines = ledgerLines(repoRoot);
  const record: DocRecord = {
    kind: check.kind,
    paths: check.paths,
    hash: check.hash,
    approver,
    at: new Date().toISOString(),
    presence,
    prev: lines.length === 0 ? "genesis" : sha(lines[lines.length - 1]),
  };
  const path = join(repoRoot, DOCS_LEDGER);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

// ---- 점검 ----

export function checkDoc(repoRoot: string, manifest: Manifest | undefined, kind: DocKind): DocCheck {
  const schema = SCHEMAS[kind];
  const paths = docPaths(manifest, kind);
  const base = { kind, label: schema.label, paths };

  const missing = paths.filter((path) => !existsSync(join(repoRoot, path)));
  if (missing.length > 0) {
    const sections = schema.sections.map((s) => ({ id: s.id, heading: s.heading, required: s.required, found: false, filled: false, open: 0 }));
    return { ...base, state: "missing-file", ok: false, sections, problem: `파일이 없습니다: ${missing.join(", ")}` };
  }

  const files = paths.flatMap((path) => markdownFiles(repoRoot, path));
  const text = files.map((file) => readFileSync(join(repoRoot, file), "utf-8")).join("\n\n");
  const sections = checkSections(schema, text);
  const hash = hashFiles(repoRoot, files);
  const lacking = sections.filter((section) => section.required && !section.filled);
  // 이름 대조 실패는 상태를 늘리지 않고 여기 합친다 — DocState 가 늘면 안내 문구가 곳곳에서 같이 늘어난다
  const commands = commandProblems(manifest, schema, text);
  if (lacking.length > 0 || commands.length > 0) {
    const problem = [
      lacking.length > 0 ? `필수 섹션이 비었거나 없습니다: ${lacking.map((section) => section.heading).join(", ")}` : undefined,
      ...commands,
    ].filter((line) => line !== undefined);
    return { ...base, state: "missing-sections", ok: false, sections, hash, problem: problem.join(" / ") };
  }

  const confirmations = readDocLedger(repoRoot).filter((record) => record.kind === kind);
  const last = confirmations[confirmations.length - 1];
  if (!last) {
    return { ...base, state: "unconfirmed", ok: false, sections, hash, problem: `사람의 확정이 없습니다 — code-agent confirm doc ${kind}` };
  }
  if (last.hash !== hash || last.paths.join("\n") !== paths.join("\n")) {
    return { ...base, state: "stale", ok: false, sections, hash, problem: `확정 뒤 내용이 바뀌었습니다 — code-agent confirm doc ${kind} 로 다시 확정` };
  }
  return { ...base, state: "confirmed", ok: true, sections, hash };
}

export function checkProjectDocs(repoRoot: string, manifest: Manifest | undefined): DocCheck[] {
  return POLICY_KINDS.map((kind) => checkDoc(repoRoot, manifest, kind));
}

export interface KnowledgeCheck {
  kind: KnowledgeKind;
  label: string;
  path: string;
  exists: boolean;
}

/**
 * 공통 KNOWLEDGE — 파일이 있는지만 본다. **작업을 막지 않는다.**
 * 막으면 첫 도입에서 아무 작업도 시작되지 않고, 코드가 3초면 만드는 빈 파일로 작업을 세우는 것은 의식이다.
 */
export function checkKnowledge(repoRoot: string, manifest: Manifest | undefined): KnowledgeCheck[] {
  return KNOWLEDGE_KINDS.map((kind) => {
    const path = docPaths(manifest, kind)[0];
    return { kind, label: SCHEMAS[kind].label, path, exists: existsSync(join(repoRoot, path)) };
  });
}

export function formatKnowledgeChecks(checks: KnowledgeCheck[]): string {
  return checks
    .map((entry) => `  ${entry.exists ? "✓" : "·"} ${entry.label}: ${entry.path}${entry.exists ? "" : " — 없음 (막지는 않습니다)"}`)
    .join("\n");
}

export function docsReady(checks: DocCheck[]): boolean {
  return checks.every((entry) => entry.ok);
}

/** 계획 승인에 묶는 해시 — 확정된 POLICY 4종의 해시를 합친 것. 확정 전에는 없다 */
export function projectDocsHash(checks: DocCheck[]): string | undefined {
  return docsReady(checks) ? sha(checks.map((entry) => `${entry.kind}:${entry.hash}`).join("\n")) : undefined;
}

export function formatDocChecks(checks: DocCheck[], detailed = false): string {
  return checks
    .map((entry) => {
      const head = entry.ok
        ? `  ✓ ${entry.label}: ${entry.paths.join(", ")} (확정됨)`
        : `  ✗ ${entry.label}: ${entry.problem}`;
      if (!detailed || entry.state === "missing-file") return head;
      const rows = entry.sections.map(
        (section) =>
          `      ${section.filled ? "✓" : section.required ? "✗" : "·"} ${section.heading}` +
          (section.filled ? "" : section.found ? " — 내용 없음 (주석·확인 필요 만 있음)" : " — 섹션 없음") +
          (section.filled && section.open > 0 ? ` — 미결 ${section.open}줄` : "") +
          (section.required ? "" : " (선택)"),
      );
      const open = entry.sections.reduce((sum, section) => sum + section.open, 0);
      if (open > 0 && entry.state !== "missing-sections") {
        rows.push(`      미결(${GAP_MARKER}) ${open}줄 — 막지는 않습니다. 확정하기 전에 그대로 둘지 보세요`);
      }
      return [head, ...rows].join("\n");
    })
    .join("\n");
}
