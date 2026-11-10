/**
 * 지식 검색 결과의 출처 참조(`DocSectionRef`)를 **지금 작업 트리의 파일**과 대조한다 — 어댑터가 무엇을 주든 화면에 싣는 범위는
 * 호스트가 직접 읽어 내용 해시로 확인한 것뿐이다.
 *
 * - 참조는 섹션마다 엄격히 검사한다(`parseSectionRef`). 하나가 깨졌다고 호출 전체를 버리지 않는다.
 * - 읽는 파일은 이번 입력이 보낸 문서 경로(docRefs) 안의 상대 경로뿐이다. 원격 결과가 준 임의 경로를 열지 않는다.
 * - 줄 범위는 과거 줄 번호·같은 제목을 믿지 않는다. 적힌 범위의 해시가 맞으면 그대로(exact), 아니면 같은 길이의 창을
 *   제목 줄에서 시작하는 자리에서만 찾아 정확히 한 곳이 맞을 때만 옮긴다(moved). 문서 단위 항목은 exact 만 받는다.
 * - 상태 표시는 어댑터가 준 상태를 올리지 않는다 — 확정이 아니면 확정이라고 쓰지 않는다.
 */
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import type { DocSection } from "./plugins/protocol";

export const REF_STATUSES = ["confirmed_policy", "observed_behavior", "verified_experience", "unverified", "deprecated", "conflicted"] as const;
export type RefStatus = (typeof REF_STATUSES)[number];

/** 어댑터가 섹션에 붙이는 출처 참조 — agent-knowledge 의 필드 이름 그대로다 */
export interface DocSectionRef {
  engine: "agent-knowledge";
  /** `<sourceId>:<path>#<anchor>` */
  itemId: string;
  projectId: string;
  sourceId: string;
  /** DB 별 색인 세대 번호(1부터) */
  generation: number;
  commit: string;
  blobSha: string;
  documentSha256: string;
  /** sha256(UTF-8) — 원본 문서 줄 startLine..endLine 을 "\n" 으로 이은 글 */
  itemSha256: string;
  startLine: number;
  endLine: number;
  unit: "document" | "section" | "entry";
  kind: string;
  status: RefStatus;
  confirmed: boolean;
  declaredStatus: string | null;
  reason?: string;
  pinned?: boolean;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// 모르는 키를 받지 않는다 — 계약 밖의 필드가 섞인 참조는 어댑터와 호스트가 다른 것을 뜻할 수 있다
const SECTION_REF_SCHEMA: z.ZodType<DocSectionRef> = z
  .object({
    engine: z.literal("agent-knowledge"),
    itemId: z.string().min(1),
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    generation: z.number().int().min(1),
    commit: z.string().regex(HEX40),
    blobSha: z.string().regex(HEX40),
    documentSha256: z.string().regex(HEX64),
    itemSha256: z.string().regex(HEX64),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    unit: z.enum(["document", "section", "entry"]),
    kind: z.string().min(1),
    status: z.enum(REF_STATUSES),
    confirmed: z.boolean(),
    declaredStatus: z.string().nullable(),
    reason: z.string().optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((ref) => ref.startLine <= ref.endLine, { message: "startLine 이 endLine 보다 뒤입니다" });

/** 참조 하나를 엄격히 읽는다 — 형식이 어긋나면 undefined */
export function parseSectionRef(value: unknown): DocSectionRef | undefined {
  const parsed = SECTION_REF_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** 거부 사유 — 기록과 `검증 제외` 줄에 그대로 쓴다 */
export type RefRejection = "invalid-ref" | "not-in-docs" | "missing-file" | "content-changed" | "ambiguous";

export interface VerifiedRef {
  ok: true;
  ref: DocSectionRef;
  path: string;
  /** 해시로 확인한 지금 파일의 줄 범위(1부터, 끝 포함) */
  start: number;
  end: number;
  how: "exact" | "moved";
}

export interface RejectedRef {
  ok: false;
  reason: RefRejection;
  /** 참조에 읽을 수 있는 itemId 가 있으면 — 기록용 */
  itemId?: string;
  path: string;
}

/**
 * 저장소 기준 상대 경로인가 — 역슬래시·절대 경로·드라이브 문자·`..`·`.`·빈 구성요소를 받지 않는다.
 * docRefs 경로 집합 안인지는 따로 본다. 이 검사는 그 집합이 우연히 이상한 경로를 품어도 저장소 밖을 읽지 않게 한다.
 */
export function safeDocPath(path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

/**
 * 작업 파일 경로를 저장소 기준 상대 경로로 맞춘다 — 역슬래시·앞 `./`·끝 `/` 를 정리하고, 그래도 상대 경로가 아니면(URL·저장소 밖·`..`)
 * undefined. 영향 범위 표에서 뽑힌 값에는 엔드포인트·패턴이 섞여 있어 선택 입력 `files` 에 싣기 전에 거른다.
 */
export function repoRelativePath(file: string): string | undefined {
  const path = file.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return safeDocPath(path) ? path : undefined;
}

/** 문서를 줄로 읽는 함수 — 없으면 undefined. 한 번의 context 안에서 같은 파일을 여러 번 읽지 않게 캐시한다 */
export type DocReader = (path: string) => string[] | undefined;

/** BOM 을 떼고 `\r?\n` 으로 나눈다 — agent-knowledge 가 해시를 낸 원본 줄과 같은 단위다 */
export function docReader(repoRoot: string): DocReader {
  const cache = new Map<string, string[] | undefined>();
  return (path) => {
    if (!cache.has(path)) {
      let lines: string[] | undefined;
      try {
        lines = readFileSync(join(repoRoot, path), "utf8").replace(/^﻿/, "").split(/\r?\n/);
      } catch {
        lines = undefined;
      }
      cache.set(path, lines);
    }
    return cache.get(path);
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 제목 줄 — 옮긴 범위를 찾는 출발점은 여기뿐이다(본문 한가운데의 같은 글을 같은 항목으로 잡지 않게) */
const HEADING = /^#{1,6}\s/;

function itemIdOf(value: unknown): string | undefined {
  const id = (value as { itemId?: unknown } | null | undefined)?.itemId;
  return typeof id === "string" && id !== "" ? id.slice(0, 512) : undefined;
}

/**
 * 섹션 하나의 참조를 지금 파일과 대조한다. `docs` 는 이번 입력이 보낸 문서 경로 — 그 밖의 경로는 읽지 않고 `not-in-docs` 다.
 * `section.path` 는 참조의 itemId 가 가리키는 경로와 같아야 한다(다른 문서의 해시를 이 문서의 범위로 쓰지 않게).
 */
export function verifySectionRef(section: Pick<DocSection, "path" | "ref">, docs: ReadonlySet<string>, read: DocReader): VerifiedRef | RejectedRef {
  const path = section.path;
  const ref = parseSectionRef(section.ref);
  if (!ref || !ref.itemId.startsWith(`${ref.sourceId}:${path}#`)) return { ok: false, reason: "invalid-ref", itemId: itemIdOf(section.ref), path };
  if (!safeDocPath(path) || !docs.has(path)) return { ok: false, reason: "not-in-docs", itemId: ref.itemId, path };
  const lines = read(path);
  if (!lines) return { ok: false, reason: "missing-file", itemId: ref.itemId, path };
  const length = ref.endLine - ref.startLine + 1;
  const hashAt = (start: number): string | undefined =>
    start + length - 1 <= lines.length ? sha256(lines.slice(start - 1, start - 1 + length).join("\n")) : undefined;
  if (hashAt(ref.startLine) === ref.itemSha256) return { ok: true, ref, path, start: ref.startLine, end: ref.endLine, how: "exact" };
  // 문서 전체 항목은 옮겨 갈 자리가 없다 — 적힌 범위가 맞지 않으면 바뀐 것이다
  if (ref.unit === "document") return { ok: false, reason: "content-changed", itemId: ref.itemId, path };
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (HEADING.test(line) && index + 1 !== ref.startLine && hashAt(index + 1) === ref.itemSha256) found.push(index + 1);
  });
  if (found.length === 1) return { ok: true, ref, path, start: found[0], end: found[0] + length - 1, how: "moved" };
  return { ok: false, reason: found.length > 1 ? "ambiguous" : "content-changed", itemId: ref.itemId, path };
}

const UNVERIFIED = "미확인 — 탐색 참고, 확정 근거 아님";

/**
 * 상태 표시 — 어댑터의 상태를 **올리지 않는다**. 확정 상태라도 confirmed 가 아니면 미확인이고, 관찰·충돌·폐기는 confirmed 와 관계없이
 * 그 이름 그대로다(관찰을 정책으로 읽지 않게).
 */
export function statusLabel(ref: Pick<DocSectionRef, "status" | "confirmed">): string {
  switch (ref.status) {
    case "confirmed_policy":
      return ref.confirmed ? "확정 정책" : UNVERIFIED;
    case "verified_experience":
      return ref.confirmed ? "검증된 경험" : UNVERIFIED;
    case "observed_behavior":
      return "관찰 — 현재 동작, 정책 아님";
    case "conflicted":
      return "충돌 — 확인 필요";
    case "deprecated":
      return "폐기 — 쓰지 않는다";
    default:
      return UNVERIFIED;
  }
}

/**
 * code-agent 인덱스 항목·절로 되찾은 범위에 덧붙이는 표시 — 그 줄의 구분·상태는 code-agent 문서(업무 정책의 `구분`·`상태`, 개발 지침)가
 * 정본이라 어댑터의 확정·미확인 판정은 싣지 않고(기록에만 남는다) 낮추는 신호(관찰·충돌·폐기)만 덧붙인다. 없으면 undefined.
 */
export function cautionLabel(ref: Pick<DocSectionRef, "status" | "confirmed">): string | undefined {
  return ref.status === "observed_behavior" || ref.status === "conflicted" || ref.status === "deprecated" ? statusLabel(ref) : undefined;
}

/**
 * 색인 기준 커밋이 HEAD 와 다르거나 범위를 옮겨 찾았으면 그 사실을 적는다 — 거부하지 않는다(내용은 지금 파일로 확인했다).
 * 같으면 undefined.
 */
export function commitNote(verified: Pick<VerifiedRef, "ref" | "how">, head: string | undefined): string | undefined {
  return verified.ref.commit !== head || verified.how === "moved" ? `기준 커밋 ${verified.ref.commit.slice(0, 7)} — 현재 파일과 일치 확인` : undefined;
}

/** 줄 범위의 제목 — 시작 줄이 제목이면 그것, 아니면 바로 위 제목. 없으면 undefined */
export function headingAt(lines: readonly string[], start: number): string | undefined {
  for (let index = Math.min(start, lines.length) - 1; index >= 0; index -= 1) {
    if (HEADING.test(lines[index])) return lines[index].trim();
  }
  return undefined;
}

/** HEAD 커밋 — 저장소가 아니거나 커밋이 없으면 undefined */
export function headCommit(repoRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return HEX40.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}
