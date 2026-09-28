import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, posix } from "path";

import type { Manifest } from "../core/manifest";
import type { Presence } from "../core/approval";
import { STATE_DIR } from "./layout";
import { GAP_MARKER, SCHEMAS } from "./schemas";
import type { DocKind, DocSchema } from "./schemas";

/**
 * 프로젝트 필수 문서 — 아키텍처와 코드 컨벤션.
 *
 * 셋을 모두 만족해야 어떤 작업도 요구사항 분석 이후로 가지 않는다. 그 빈자리를 모델이 지어내기 때문이다.
 * 1. 파일이 있다  2. 필수 섹션이 있고 비어 있지 않다(`확인 필요` 가 남지 않았다)  3. 사람이 지금 내용으로 확정했다
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
  if (kind === "architecture") {
    return [manifest?.docs.architecture ?? SCHEMAS.architecture.defaultPath];
  }
  return manifest && manifest.conventions.length > 0 ? manifest.conventions : [SCHEMAS.conventions.defaultPath];
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

function normalizeHeading(text: string): string {
  return text
    .replace(/^[\d.)\s]+/, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 제목과 그 아래 본문(다음 같은·더 높은 수준 제목 전까지). 주석은 본문이 아니다 */
function sectionsOf(text: string): { heading: string; body: string }[] {
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const found: { heading: string; level: number; start: number }[] = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) found.push({ heading: match[2], level: match[1].length, start: index });
  });
  return found.map((entry, index) => {
    const end = found.slice(index + 1).find((other) => other.level <= entry.level)?.start ?? lines.length;
    return { heading: entry.heading, body: lines.slice(entry.start + 1, end).join("\n") };
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

function sha(text: string): string {
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
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter((line) => line.trim() !== "") : [];
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
  if (lacking.length > 0) {
    return {
      ...base,
      state: "missing-sections",
      ok: false,
      sections,
      hash,
      problem: `필수 섹션이 비었거나 없습니다: ${lacking.map((section) => section.heading).join(", ")}`,
    };
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
  return [checkDoc(repoRoot, manifest, "architecture"), checkDoc(repoRoot, manifest, "conventions")];
}

export function docsReady(checks: DocCheck[]): boolean {
  return checks.every((entry) => entry.ok);
}

/** 계획 승인에 묶는 해시 — 확정된 두 문서의 해시를 합친 것. 확정 전에는 없다 */
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
