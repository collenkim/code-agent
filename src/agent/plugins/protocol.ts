import { z } from "zod";

import { SLOTS } from "../../core/manifest";
import type { Slot } from "../../core/manifest";

export { SLOTS };
export type { Slot };

/**
 * 플러그인 = **명령 어댑터**. stdin 으로 요청 JSON 한 벌을 받고 stdout 으로 응답 JSON 한 벌을 낸다
 * (hook 과 같은 규약이라 언어를 가리지 않는다).
 *
 * 계약에 버전이 있는 이유: 어댑터는 이 저장소 밖에서 따로 산다. 코어가 자리를 늘리거나 입력을
 * 바꾸면 옛 어댑터는 **모르는 채로** 그럴듯한 답을 낸다 — 버전이 맞지 않으면 부르지 않고
 * 기본 구현으로 떨어지는 것이 조용히 틀린 순위를 쓰는 것보다 싸다.
 */
export const PROTOCOL = "code-agent.plugin";
export const VERSION = "1";

/** 요청에 실어 보내는 목록의 상한. 넘으면 자르고 `input.truncated: true` 를 함께 보낸다 */
export const MAX_ITEMS = 3000;

/** 상한이 걸리는 요청 키. 배열이면 자른다 — `files` 만 자르면 다른 자리는 상한 없이 나간다 */
export const CAPPED_KEYS = ["files", "docs", "planFiles", "changed", "requirements"] as const;

/**
 * 화면에 찍는 어댑터 문자열 하나의 길이 상한.
 *
 * 응답 본문 상한(1 MiB)은 프로세스를 지키지만 **모델의 화면**은 지키지 않는다. 자리 출력은
 * `context`·`review`·`survey` 의 stdout 으로 나가 모델이 지시로 읽는 자리라, 어댑터가 준 문장
 * 하나가 여러 줄이 되면 그 자리에서 무엇이든 쓸 수 있다.
 */
export const MAX_TEXT = 200;

/** 화면에 찍는 어댑터 목록 하나의 개수 상한 (`ranked`·`sections` 는 자리별 limit 이 따로 있다) */
export const MAX_OUTPUT_ITEMS = 50;

/** 로그에 남기는 응답의 상한 — 로그가 저장소 상태를 잡아먹지 않게 */
export const LOG_RESPONSE_BYTES = 64 * 1024;

/** `<slot>.jsonl` 에 남기는 줄 수 */
export const LOG_LINES = 200;

export interface Limit {
  timeoutMs: number;
  maxBytes: number;
}

/**
 * 상한 표.
 *
 * `verify.extra` 만 120초다. 그보다 오래 도는 정적 분석은 플러그인이 아니라 매니페스트
 * `commands` 에 선언한다 — 그 길은 이미 있고 `checkCommands` 가 돌린다. 두 번째 러너(비동기)를
 * 만들지 않으려고 고른 대가이고, 2분 넘는 판정 플러그인은 쓸 수 없다.
 */
export const HANDSHAKE_LIMIT: Limit = { timeoutMs: 10_000, maxBytes: 256 * 1024 };

const SLOT_LIMIT: Limit = { timeoutMs: 20_000, maxBytes: 1024 * 1024 };

export const SLOT_LIMITS: Record<Slot, Limit> = {
  "survey.classify": SLOT_LIMIT,
  "candidates.rank": SLOT_LIMIT,
  "context.docs": SLOT_LIMIT,
  "review.prefilter": SLOT_LIMIT,
  "code.index": SLOT_LIMIT,
  "verify.extra": { timeoutMs: 120_000, maxBytes: 1024 * 1024 },
};

// ---- 자리별 입력 ----

/** ① 의 요구 항목 한 줄 — 제목과 `근거:` 인용문을 합친 것 */
export interface RequirementRef {
  key: string;
  text: string;
}

export interface FileRef {
  path: string;
  ext: string;
}

export interface DocRef {
  kind: string;
  path: string;
  headings: { heading: string; line: number }[];
}

/** `context.docs` 가 불리는 단계 — 이 자리는 analysis~plan 에서만 돈다(implement 이후는 부르지 않는다) */
export const CONTEXT_DOCS_PHASES = ["analysis", "impact", "design", "plan"] as const;
export type ContextDocsPhase = (typeof CONTEXT_DOCS_PHASES)[number];

/**
 * master 가 인계한 지식 항목 참조 — agent-knowledge 공통 계약 제안(`itemId`·`generation`·`commit`·`itemSha256`)의 이름 그대로에
 * `required` 를 더했다. 본문은 싣지 않는다 — 받는 쪽이 같은 세대에서 다시 꺼내 해시·커밋·범위를 대조한다.
 * master 쪽(hook 경로의 순수 모듈)은 이 타입을 `import type` 으로만 쓴다.
 */
export interface KnowledgeRef {
  itemId: string;
  generation: number;
  /** 40자리 소문자 16진 커밋 SHA */
  commit: string;
  /** 64자리 소문자 16진 — 항목 내용(UTF-8)의 SHA-256 */
  itemSha256: string;
  /** 검증에 실패하면 이 작업의 근거 재확인·재계획이 필요한 항목인가 */
  required: boolean;
}

export interface KnowledgeHandoff {
  version: 1;
  refs: KnowledgeRef[];
}

export interface SlotInput {
  "survey.classify": {
    files: FileRef[];
    layerCandidates: { name: string; dirs: string[]; files: string[] }[];
  };
  "candidates.rank": {
    requirements: RequirementRef[];
    keywords: string[];
    files: FileRef[];
    limit: number;
  };
  "context.docs": {
    requirements: RequirementRef[];
    docs: DocRef[];
    limit: number;
    /** 선택 입력 — 어댑터가 describe `accepts` 에 `context.docs.phase` 를 적었을 때만 보낸다 */
    phase?: ContextDocsPhase;
    /** 선택 입력(`context.docs.files`) — 이 작업이 닿는 파일(영향 범위 표·후보 순위), 저장소 기준 경로 */
    files?: string[];
    /** 선택 입력(`context.docs.refs`) — master 가 인계한 항목 참조 */
    refs?: KnowledgeRef[];
  };
  "review.prefilter": {
    baseCommit: string;
    treeHash: string;
    files: string[];
    rules: { source: string; rule: string }[];
  };
  /** 예약 필드 — 현재 호출하지 않는다 */
  "code.index": { symbols?: string[]; from: string[] };
  "verify.extra": {
    phase: "check";
    baseCommit: string;
    treeHash: string;
    planFiles: string[];
    changed: { status: string; path: string }[];
  };
}

// ---- 자리별 출력 ----

export interface RankedFile {
  path: string;
  /** 0..1 */
  score: number;
  why: string;
}

export interface DocSection {
  path: string;
  heading: string;
  why: string;
  /**
   * 선택 — 어댑터가 준 출처 참조(`DocSectionRef` 꼴). 스키마는 모양을 보지 않고 통과시키고 호스트(knowledgeRefs.ts)가 섹션마다
   * 엄격히 검사한다: 항목 하나가 깨졌다고 호출 전체를 버리지 않는다. 이 필드가 있는 섹션은 현재 파일과 내용 해시가 맞아야 쓴다.
   */
  ref?: unknown;
}

/** 인계 참조 하나를 어댑터가 되찾은 결과 */
export interface PinnedResult {
  itemId: string;
  ok: boolean;
  reason?: string;
  section?: DocSection;
}

/** 어댑터가 기본 검색을 요청하는 이유 — 이 필드를 낸 어댑터에만 적용한다(정상 빈 `sections` 의 뜻은 그대로) */
export interface DocsFallback {
  code: string;
  message?: string;
}

export interface Suspect {
  path: string;
  line?: number;
  rule?: string;
  note: string;
}

export interface ClassifiedLayer {
  name: string;
  purpose: string;
  paths: string[];
}

export interface ExtraRun {
  kind: string;
  outcome: "passed" | "failed" | "error" | "not-run";
  summary: string;
  detail?: string;
}

export interface SlotOutput {
  "survey.classify": {
    layers: ClassifiedLayer[];
    components?: { name: string; paths: string[]; note?: string }[];
  };
  "candidates.rank": { ranked: RankedFile[] };
  "context.docs": {
    sections: DocSection[];
    /** 선택 — 어댑터가 이번 결과를 쓰지 말고 기본 검색을 쓰라고 요청한다(빈 결과·필수 자료만·쓸 항목 없음 등) */
    fallback?: DocsFallback;
    /** 선택 — 로그에만 남긴다. 화면(모델 입력)에 찍지 않는다 */
    diagnostics?: Record<string, unknown>;
    /** 선택 — 입력 `refs` 의 결과 */
    pinned?: PinnedResult[];
  };
  "review.prefilter": { suspects: Suspect[] };
  "code.index": {
    symbols: { name: string; path: string; line: number; kind: string }[];
    callers: { from: string; to: string }[];
  };
  "verify.extra": { runs: ExtraRun[] };
}

const PathString = z.string().min(1);

const DocSectionSchema = z.object({ path: PathString, heading: z.string(), why: z.string(), ref: z.unknown().optional() });

export const SLOT_OUTPUT_SCHEMA: { [S in Slot]: z.ZodType<SlotOutput[S]> } = {
  "survey.classify": z.object({
    layers: z.array(z.object({ name: z.string(), purpose: z.string(), paths: z.array(PathString) })),
    components: z
      .array(z.object({ name: z.string(), paths: z.array(PathString), note: z.string().optional() }))
      .optional(),
  }),
  "candidates.rank": z.object({
    ranked: z.array(z.object({ path: PathString, score: z.number().min(0).max(1), why: z.string() })),
  }),
  "context.docs": z.object({
    sections: z.array(DocSectionSchema),
    fallback: z
      .object({ code: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "fallback.code 는 소문자·숫자·- 64자 이내입니다"), message: z.string().optional() })
      .optional(),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
    pinned: z
      .array(z.object({ itemId: z.string().min(1), ok: z.boolean(), reason: z.string().optional(), section: DocSectionSchema.optional() }))
      .optional(),
  }),
  "review.prefilter": z.object({
    suspects: z.array(
      z.object({ path: PathString, line: z.number().int().optional(), rule: z.string().optional(), note: z.string() }),
    ),
  }),
  "code.index": z.object({
    symbols: z.array(z.object({ name: z.string(), path: PathString, line: z.number().int(), kind: z.string() })),
    callers: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  "verify.extra": z.object({
    runs: z.array(
      z.object({
        // 식별자다 — 증거 런의 `kind` 접두사가 되어 ⑧ 의 표 칸에 그대로 들어간다. 자유 문자열이면
        // `|` 와 줄바꿈으로 표 행을 **위조**할 수 있고, 그 문서는 증거에서 다시 렌더되므로 바이트
        // 대조 게이트가 위조를 잡지 못한다 (사람이 읽는 보고서만 거짓이 된다).
        kind: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, "런 kind 는 [A-Za-z0-9._:-] 64자 이내의 식별자입니다"),
        outcome: z.enum(["passed", "failed", "error", "not-run"]),
        summary: z.string(),
        detail: z.string().optional(),
      }),
    ),
  }),
};

// ---- 악수(describe · probe) ----

/**
 * 키 전달 방식은 **어댑터가 정하고 등록이 기록한다.** `plugin add` 에 `--secret-env` 같은 플래그를
 * 두지 않는 이유 — 어댑터만이 제 인터페이스를 알고, 사람에게 환경변수 이름을 묻는 것은 사람이
 * 답할 수 없는 질문이다.
 *
 * `stdin` 이 기본이다: argv 는 프로세스 목록에 보이고 환경변수는 손자 프로세스까지 샌다.
 */
export interface SecretSpec {
  required: boolean;
  delivery: "stdin" | "env";
  /** delivery 가 env 일 때만 — 그 이름으로만 넣는다 */
  env?: string;
}

/**
 * 자리별 **선택 입력** — 어댑터가 describe 의 `accepts` 에 `<자리>.<필드>` 로 적어 등록한 것만 보낸다.
 * accepts 가 없는 등록에는 선택 입력을 보내지 않는다 — 그 요청은 자리의 필수 입력뿐이다.
 */
export const OPTIONAL_INPUTS: Partial<Record<Slot, readonly string[]>> = {
  "context.docs": ["phase", "files", "refs"],
};

/** 알려진 협의 토큰 전부 — 등록이 이 밖의 토큰은 버린다 */
export const KNOWN_ACCEPTS: readonly string[] = Object.entries(OPTIONAL_INPUTS).flatMap(([slot, fields]) => (fields ?? []).map((field) => `${slot}.${field}`));

export interface DescribeOutput {
  name: string;
  adapterVersion: string;
  slots: Slot[];
  sendsCode: boolean;
  secret?: SecretSpec;
  note?: string;
  /** 받겠다는 선택 입력(`OPTIONAL_INPUTS`) — `"context.docs.phase"` 꼴 */
  accepts?: string[];
}

export const DESCRIBE_SCHEMA: z.ZodType<DescribeOutput> = z
  .object({
    name: z.string().min(1),
    adapterVersion: z.string(),
    slots: z.array(z.enum(SLOTS)).min(1),
    sendsCode: z.boolean(),
    secret: z
      .object({
        required: z.boolean(),
        delivery: z.enum(["stdin", "env"]),
        env: z.string().min(1).optional(),
      })
      .optional(),
    note: z.string().optional(),
    // 모양만 넓게 받는다 — 이 릴리스가 모르는 토큰(다음 버전의 선택 입력)은 등록이 KNOWN_ACCEPTS 로 걸러 버린다(plugin add)
    accepts: z.array(z.string().min(1).max(128)).max(256).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.secret?.delivery === "env" && !value.secret.env) {
      ctx.addIssue({ code: "custom", path: ["secret", "env"], message: "delivery 가 env 면 환경변수 이름이 필요합니다" });
    }
  });

export interface ProbeOutput {
  ready: boolean;
  detail?: string;
}

export const PROBE_SCHEMA: z.ZodType<ProbeOutput> = z.object({
  ready: z.boolean(),
  detail: z.string().optional(),
});

/** 봉투만 본다 — `output` 의 모양은 자리별 스키마가 따로 본다 */
export const ENVELOPE_SCHEMA = z.object({
  protocol: z.string(),
  version: z.string(),
  requestId: z.string(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

/** `plugin list` 와 문서가 함께 쓰는 자리 설명 — 기본 구현이 무엇이고 어디서 도는가 */
export const SLOT_NOTES: Record<Slot, { where: string; fallback: string }> = {
  "survey.classify": { where: "code-agent survey", fallback: "경로 규칙 + surveyor" },
  "candidates.rank": { where: "code-agent context", fallback: "내장 키워드 스캔" },
  "review.prefilter": { where: "code-agent review", fallback: "reviewer 가 전부 봄" },
  "context.docs": { where: "code-agent context", fallback: "키·경로·별칭·본문 검색" },
  // 부르는 지점이 없는 자리 — where 가 비어 있으면 `plugin list` 가 괄호를 붙이지 않는다
  "code.index": { where: "", fallback: "없음 — 예약 (이 버전은 부르지 않는다)" },
  "verify.extra": { where: "code-agent check", fallback: "매니페스트 commands" },
};

/**
 * 그 자리를 열면 어댑터로 **무엇이 나가는가**. 등록 화면이 그대로 찍는다.
 *
 * `sendsCode` 는 어댑터가 스스로 답한 값이라 그것만으로는 사람이 판단할 자료가 못 된다 —
 * `false` 라고 답해도 자리마다 이만큼은 간다.
 */
export const SLOT_SENDS: Record<Slot, string> = {
  "survey.classify": "소스 파일 경로 목록 · 계층 후보",
  "candidates.rank": "요구 항목 문장 · 키워드 · 소스 파일 경로 목록",
  "context.docs": "요구 항목 문장 · 등록된 문서의 경로와 제목 (어댑터가 받겠다고 한 경우만: 단계 · 작업 파일 경로 · master 인계 근거 참조)",
  "review.prefilter": "기준 커밋 · 트리 해시 · 계획 파일 경로 · 컨벤션 규칙 문장",
  "code.index": "(예약 — 부르지 않으므로 아무것도 나가지 않는다)",
  "verify.extra": "기준 커밋 · 트리 해시 · 계획 파일 경로 · 바뀐 파일 경로",
};
