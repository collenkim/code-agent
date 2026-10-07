/**
 * 작업 지시서 — 모든 작업이 통과해야 하는 입구.
 *
 * 여기서 걸리면 **작업을 시작하지 않는다.** 커서도 브랜치도 만들어지지 않는다는 것이 이 파일의
 * 존재 이유다 — 뒤 층의 검사(계획 승인·경계 검사)는 전부 작업이 이미 돌기 시작한 뒤에야
 * 일어나므로, 그것만으로는 통제가 모델이 협조하는 동안만 유지된다.
 *
 * 규격은 doc/requirement.md 에 있다. 여기서 검사하는 것은 형식·존재·값·오타·실재 다섯이고,
 * 무엇이 걸리든 사람이 문서를 고쳐야 풀린다 — 우회 옵션은 만들지 않는다.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const KINDS = ["feature", "fix", "refactor"] as const;
export type WorkKind = (typeof KINDS)[number];

/** 파이프라인이 실제로 분기·검사에 쓰는 속성. 이 목록은 늘리지 않는다. */
const RESERVED = ["kind", "id", "title", "target", "scope", "preserve", "approver"] as const;

/**
 * target 이 저장소 경로로 해석되는 종류.
 *
 * feature 의 대상은 **이제부터 만들** 도메인이라 아직 디렉토리가 없다. 실재를 물을 수 있는
 * 것은 이미 있는 코드를 다루는 둘뿐이다.
 */
const TARGET_IS_PATH: Record<WorkKind, boolean> = {
  feature: false,
  fix: true,
  refactor: true,
};

/** 보존할 대상이 있는 종류에서만 필수다. feature 는 새로 만드는 것이라 해당이 없다. */
const REQUIRES_SCOPE: WorkKind[] = ["fix", "refactor"];
const REQUIRES_PRESERVE: WorkKind[] = ["fix", "refactor"];

export interface WorkOrderAttribute {
  name: string;
  required: boolean;
  values?: string[];
}

/** 프로젝트가 code-agent.json 에 선언하는 확장 속성 정책 */
export interface WorkOrderPolicy {
  attributes: WorkOrderAttribute[];
  requireApprover: boolean;
}

export interface WorkOrder {
  kind: WorkKind;
  id: string;
  title: string;
  /** 하나여도 배열로 정규화한다 — 대상마다 진행이 갈라지므로 호출자가 분기하지 않게 한다 */
  target: string[];
  scope: string[];
  preserve: string[];
  approver?: string;
  /** 프로젝트가 선언한 확장 속성. 파이프라인은 이 값들로 분기하지 않는다 */
  extra: Record<string, string | string[]>;
  /** 머리말이 있던 문서 — 어디를 고쳐야 하는지 알려 주려고 남긴다 */
  sourcePath: string;
}

export interface WorkOrderProblem {
  attribute: string;
  detail: string;
}

export class WorkOrderError extends Error {
  constructor(readonly problems: WorkOrderProblem[]) {
    super(
      "작업 지시서가 규격에 맞지 않아 진행하지 않았습니다 " +
        `(${problems.length}건) — 작업을 시작하지 않았습니다:\n` +
        problems.map((problem) => `  - [${problem.attribute}] ${problem.detail}`).join("\n") +
        "\n\n머리말 규격은 doc/requirement.md 에 있습니다.",
    );
    this.name = "WorkOrderError";
  }
}

// ---- 머리말 파서 ----

/**
 * 식별자·대상을 파일 이름과 디렉토리 이름으로 쓸 수 있게 만든다.
 * 승인 원장과 대상별 갈래가 같은 규칙을 써야 해서 여기 둔다.
 */
export function slug(text: string): string {
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // 점으로만 된 값(`.` · `..`)은 경로 조각으로 쓰면 사라지거나 한 단계 거슬러 오른다.
  // fix·refactor 의 대상은 저장소 경로라 `.` 이 실제로 들어온다 — 갈래가 뒤섞이는 자리다.
  return /^\.+$/.test(cleaned) || cleaned === "" ? "unnamed" : cleaned;
}

/** 따옴표로 감싼 값을 흔히 쓰므로 벗겨 준다. 안쪽은 손대지 않는다. */
function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && /^(".*"|'.*')$/s.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scalarOrArray(text: string): string | string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map(unquote)
      .filter((item) => item !== "");
  }
  return unquote(trimmed);
}

/**
 * 머리말만 떼어 낸다. 첫 줄이 `---` 가 아니면 머리말이 없는 문서다.
 *
 * 값은 문자열과 문자열 배열만 받는다. 중첩을 허용하는 순간 회사마다 다른 모양이 다시 생겨
 * "봉투가 하나"라는 성질이 사라지므로, 들여쓴 줄은 배열 항목이 아닌 한 오류로 본다.
 */
export function parseFrontMatter(text: string): Record<string, string | string[]> | undefined {
  const lines = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    throw new WorkOrderError([
      { attribute: "머리말", detail: "여는 `---` 는 있는데 닫는 `---` 가 없습니다" },
    ]);
  }

  const values: Record<string, string | string[]> = {};
  let currentKey: string | undefined;

  for (let index = 1; index < end; index += 1) {
    const line = lines[index].replace(/\s+$/, "");
    if (line.trim() === "") {
      continue;
    }

    const item = line.match(/^\s*-\s+(.*)$/);
    if (item) {
      if (!currentKey) {
        throw new WorkOrderError([
          { attribute: "머리말", detail: `${index + 1}행: 어느 속성의 항목인지 알 수 없습니다` },
        ]);
      }
      const previous = values[currentKey];
      values[currentKey] = [
        ...(Array.isArray(previous) ? previous : []),
        unquote(item[1]),
      ].filter((entry) => entry !== "");
      continue;
    }

    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!pair) {
      throw new WorkOrderError([
        {
          attribute: "머리말",
          detail:
            `${index + 1}행을 읽을 수 없습니다: ${line.trim()}\n` +
            "    `속성: 값` 또는 `- 항목` 만 씁니다. 들여쓴 중첩 구조는 쓰지 않습니다",
        },
      ]);
    }

    const [, key, rest] = pair;
    if (key in values) {
      throw new WorkOrderError([{ attribute: key, detail: "같은 속성이 두 번 나옵니다" }]);
    }

    currentKey = key;
    values[key] = rest.trim() === "" ? [] : scalarOrArray(rest);
  }

  return values;
}

// ---- 검사 ----

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry.trim() !== "");
}

function asText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ").trim() : (value ?? "").trim();
}

/** 저장소 안에 실제로 있는지. 경로 오타는 첫 프롬프트가 아니라 접수하는 자리에서 드러나야 한다. */
function checkPaths(
  repoRoot: string,
  attribute: string,
  paths: string[],
  problems: WorkOrderProblem[],
): void {
  for (const path of paths) {
    if (!existsSync(join(repoRoot, path))) {
      problems.push({
        attribute,
        detail: `대상 저장소에 없는 경로입니다: ${path}`,
      });
    }
  }
}

function checkExtras(
  values: Record<string, string | string[]>,
  policy: WorkOrderPolicy,
  problems: WorkOrderProblem[],
): Record<string, string | string[]> {
  const declared = new Map(policy.attributes.map((attribute) => [attribute.name, attribute]));
  const extra: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(values)) {
    if ((RESERVED as readonly string[]).includes(key)) {
      continue;
    }
    const attribute = declared.get(key);
    if (!attribute) {
      // 오타를 조용히 넘기면 "선언했는데 안 걸리는" 상태가 된다.
      problems.push({
        attribute: key,
        detail:
          "예약 속성도 아니고 프로젝트가 선언한 속성도 아닙니다" +
          (declared.size > 0 ? ` (선언된 것: ${[...declared.keys()].join(", ")})` : ""),
      });
      continue;
    }
    extra[key] = value;
  }

  for (const attribute of policy.attributes) {
    const value = extra[attribute.name];
    if (attribute.required && asList(value).length === 0) {
      problems.push({ attribute: attribute.name, detail: "프로젝트가 필수로 선언한 속성입니다" });
      continue;
    }
    if (!attribute.values || value === undefined) {
      continue;
    }
    for (const entry of asList(value)) {
      if (!attribute.values.includes(entry)) {
        problems.push({
          attribute: attribute.name,
          detail: `허용되지 않은 값입니다: ${entry} (허용: ${attribute.values.join(", ")})`,
        });
      }
    }
  }

  return extra;
}

/**
 * 머리말 값들을 작업 지시서로 확정한다. 걸린 것을 **한 번에 모아** 알린다 —
 * 한 건씩 알리면 사람이 문서를 여러 번 고치게 된다.
 */
export function validateWorkOrder(
  repoRoot: string,
  values: Record<string, string | string[]>,
  sourcePath: string,
  policy: WorkOrderPolicy,
): WorkOrder {
  const problems: WorkOrderProblem[] = [];

  const kindText = asText(values.kind);
  if (kindText === "") {
    problems.push({ attribute: "kind", detail: `필수입니다 (${KINDS.join(" | ")})` });
  } else if (!(KINDS as readonly string[]).includes(kindText)) {
    problems.push({
      attribute: "kind",
      detail: `알 수 없는 작업 종류입니다: ${kindText} (${KINDS.join(" | ")})`,
    });
  }

  const id = asText(values.id);
  const title = asText(values.title);
  if (id === "") {
    problems.push({ attribute: "id", detail: "필수입니다 — 티켓 키 또는 작업 식별자" });
  }
  if (title === "") {
    problems.push({ attribute: "title", detail: "필수입니다 — 사람이 목록에서 알아볼 한 줄" });
  }

  const target = asList(values.target);
  const scope = asList(values.scope);
  const preserve = asList(values.preserve);
  const approver = asText(values.approver);

  if (target.length === 0) {
    problems.push({ attribute: "target", detail: '필수입니다 — "어디를" 이 없으면 시작할 수 없다' });
  }

  const kind = kindText as WorkKind;
  const known = (KINDS as readonly string[]).includes(kindText);

  if (known) {
    if (REQUIRES_SCOPE.includes(kind) && scope.length === 0) {
      problems.push({
        attribute: "scope",
        detail: `${kind} 에는 필수입니다 — 이번에 건드려도 되는 경로`,
      });
    }
    if (REQUIRES_PRESERVE.includes(kind) && preserve.length === 0) {
      problems.push({
        attribute: "preserve",
        detail: `${kind} 에는 필수입니다 — 바뀌면 안 되는 것`,
      });
    }
    if (TARGET_IS_PATH[kind]) {
      checkPaths(repoRoot, "target", target, problems);
    }
  }

  // scope 는 어느 종류에서든 경로다. preserve 는 경로와 문장을 섞어 쓸 수 있어 실재를 묻지 않는다.
  checkPaths(repoRoot, "scope", scope, problems);

  if (policy.requireApprover && approver === "") {
    problems.push({
      attribute: "approver",
      detail: "이 프로젝트는 승인자를 필수로 선언했습니다 (code-agent.json 의 workOrder)",
    });
  }

  const extra = checkExtras(values, policy, problems);

  if (problems.length > 0) {
    throw new WorkOrderError(problems);
  }

  return {
    kind,
    id,
    title,
    target,
    scope,
    preserve,
    approver: approver === "" ? undefined : approver,
    extra,
    sourcePath,
  };
}

/**
 * 지시서 문서 한 장에서 작업 지시서를 읽는다.
 *
 * 머리말이 없으면 그 문서는 지시서가 아니다 — 무엇을 어디에 써야 하는지 예시로 보여 주고 멈춘다.
 */
export function loadWorkOrder(
  repoRoot: string,
  specPath: string,
  policy: WorkOrderPolicy,
): WorkOrder {
  const values = parseFrontMatter(readFileSync(specPath, "utf-8"));

  if (!values) {
    throw new WorkOrderError([
      {
        attribute: "머리말",
        detail:
          `작업 지시서가 없습니다: ${specPath}\n` +
          "    requirement.md 의 맨 첫 줄부터 머리말을 두세요:\n" +
          "    ---\n" +
          `    kind: feature        # ${KINDS.join(" | ")}\n` +
          "    id: PROJ-1\n" +
          "    title: 한 줄 요약\n" +
          "    target: 대상\n" +
          "    ---",
      },
    ]);
  }

  return validateWorkOrder(repoRoot, values, specPath, policy);
}

// ---- fix 의 오류 로그 ----

/**
 * fix 는 오류 로그로 고친다 — 로컬에서 재현될 수도 안 될 수도 있어서, 사람이 준 로그가 1차 근거다.
 * 로그가 없는 신고(화면 증상만 있는 경우)는 그 사유와 재현 절차를 대신 남긴다.
 */
export type ErrorLog = { log: string } | { none: { reason: string; steps: string } };

/** `## <제목>` 절의 본문. 코드 블록 안의 `## ` 줄은 절 경계로 보지 않는다 */
function sectionOf(text: string, heading: string): string | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let fence: string | undefined;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^(`{3,}|~{3,})/.exec(lines[index])?.[1];
    if (marker && (fence === undefined || (marker[0] === fence[0] && marker.length >= fence.length && lines[index].trim() === marker))) {
      fence = fence === undefined ? marker : undefined;
      continue;
    }
    if (fence !== undefined || !/^## /.test(lines[index])) continue;
    if (start >= 0) return lines.slice(start + 1, index).join("\n");
    if (lines[index].trim() === `## ${heading}`) start = index;
  }
  return start >= 0 ? lines.slice(start + 1).join("\n") : undefined;
}

export function errorLogOf(text: string): ErrorLog | undefined {
  const logged = sectionOf(text, "오류 로그");
  if (logged !== undefined) {
    const block = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/m.exec(logged);
    return block && block[2].trim() !== "" ? { log: block[2] } : undefined;
  }
  const none = sectionOf(text, "오류 로그 없음");
  if (none === undefined) return undefined;
  const reason = /사유\s*[:：]\s*(.+)/.exec(none)?.[1]?.trim() ?? "";
  const steps = /재현 절차\s*[:：]\s*([\s\S]*)/.exec(none)?.[1]?.trim() ?? "";
  return reason !== "" && steps !== "" ? { none: { reason, steps } } : undefined;
}

/** fix 지시서에 오류 로그(또는 없는 사유와 재현 절차)가 있는가 — 접수 제출·확정과 start 가 건다 */
export function errorLogProblems(kind: WorkKind, text: string): WorkOrderProblem[] {
  if (kind !== "fix" || errorLogOf(text)) return [];
  return [{
    attribute: "오류 로그",
    detail: "fix 는 오류 로그로 고칩니다 — 지시서에 `## 오류 로그` 절을 두고 로그 원문을 코드 블록(```)으로 넣으세요. " +
      "로그가 없으면 `## 오류 로그 없음` 절에 `- 사유:` 와 `- 재현 절차:` 를 적습니다",
  }];
}

/**
 * 오류 로그 절을 뺀 본문 — 로그 줄·재현 절차는 요구가 아니다. 사람이 쓴 지시서는 내용 줄을 그대로 요구 항목으로
 * 읽으므로, 빼지 않으면 스택 트레이스 한 줄 한 줄이 분석에서 연결해야 할 요구가 된다.
 */
export function withoutErrorLog(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let fence: string | undefined;
  let skipping = false;
  for (const line of lines) {
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === undefined || (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker))) {
      fence = fence === undefined ? marker : undefined;
      if (!skipping) kept.push(line);
      continue;
    }
    if (fence === undefined && /^## /.test(line)) skipping = line.trim() === "## 오류 로그" || line.trim() === "## 오류 로그 없음";
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}
