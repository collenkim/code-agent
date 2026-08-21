/**
 * 작업 지시서 — 모든 작업이 통과해야 하는 입구(0차 게이트).
 *
 * 여기서 걸리면 **프롬프트를 만들지 않는다.** 모델에 한 글자도 가지 않는다는 것이 이 파일의
 * 존재 이유다 — 뒤 층의 검사(슬롯·승인·경계)는 전부 모델을 한 번 부른 뒤에야 일어나므로,
 * 그것만으로는 통제가 모델이 협조하는 동안만 유지된다.
 *
 * 규격은 doc/work-order.md 에 있다. 여기서 검사하는 것은 형식·존재·값·오타·실재 다섯이고,
 * 무엇이 걸리든 사람이 문서를 고쳐야 풀린다 — 우회 옵션은 만들지 않는다.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const KINDS = ["bootstrap", "adopt", "feature", "fix", "refactor"] as const;
export type WorkKind = (typeof KINDS)[number];

/** 파이프라인이 실제로 분기·검사에 쓰는 속성. 이 목록은 늘리지 않는다. */
const RESERVED = ["kind", "id", "title", "target", "scope", "preserve", "approver"] as const;

/**
 * target 이 저장소 경로로 해석되는 종류.
 *
 * bootstrap 의 대상은 프로젝트 이름이고, feature 의 대상은 **이제부터 만들** 도메인이라
 * 아직 디렉토리가 없다. 실재를 물을 수 있는 것은 이미 있는 코드를 다루는 셋뿐이다.
 */
const TARGET_IS_PATH: Record<WorkKind, boolean> = {
  bootstrap: false,
  adopt: true,
  feature: false,
  fix: true,
  refactor: true,
};

/** 보존할 대상이 있는 종류에서만 필수다. bootstrap 은 보존할 것이 아직 없어 해당이 없다. */
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
        `(${problems.length}건) — 프롬프트를 만들지 않았습니다:\n` +
        problems.map((problem) => `  - [${problem.attribute}] ${problem.detail}`).join("\n") +
        "\n\n머리말 규격은 doc/work-order.md 에 있습니다.",
    );
    this.name = "WorkOrderError";
  }
}

/** 종류가 무엇을 뜻하는지. 모델은 kind 라는 낱말만 보고는 무엇이 달라지는지 모른다. */
const KIND_MEANING: Record<WorkKind, string> = {
  bootstrap:
    "신규 프로젝트를 처음 만든다. 복제할 코드가 없으므로 결정 문서와 스캐폴더 출력만이 근거다",
  adopt:
    "이미 있는 저장소에 도입한다. 코드가 정본이고, 만드는 것은 그 코드에서 읽어 낸 선언과 문서다",
  feature: "기능·도메인을 새로 추가한다. 참조 표준 도메인의 구조를 그대로 따른다",
  fix: "결함을 고친다. 재현 조건이 먼저이고, 고치는 범위를 넘지 않는다",
  refactor:
    "동작을 바꾸지 않고 구조만 고친다. 무엇이 보존되어야 하는지가 이 작업의 본체다",
};

/**
 * 확정된 지시서를 프롬프트에 실을 형태로.
 *
 * 0차 게이트를 통과했다는 것은 **사람이 정한 것이 확정됐다**는 뜻이다. 그것을 매 턴 프롬프트
 * 머리에 실어 두지 않으면 모델은 턴마다 같은 것을 다시 추론하고, 그 추론이 턴마다 흔들린다.
 * 검사는 매번 새로 하되(캐시하면 지시서를 고쳐 우회할 수 있다), 확정된 사실은 계속 실어 준다.
 */
export function describeWorkOrder(order: WorkOrder): string {
  const lines = [
    "# 작업 지시서 — 사람이 확정한 것. 여기 적힌 것은 다시 정하지 않는다",
    `- 작업 종류: ${order.kind} — ${KIND_MEANING[order.kind]}`,
    `- 식별자: ${order.id}`,
    `- 제목: ${order.title}`,
    `- 대상: ${order.target.join(", ")}`,
  ];

  if (order.scope.length > 0) {
    lines.push(
      `- 건드려도 되는 곳: ${order.scope.join(", ")}`,
      "  이 밖의 파일은 필요해 보여도 바꾸지 않는다. 필요하면 note 에만 적는다.",
    );
  }

  if (order.preserve.length > 0) {
    lines.push(
      "- 바뀌면 안 되는 것 — 하나라도 어기면 이 작업은 실패다:",
      ...order.preserve.map((entry) => `  - ${entry}`),
    );
  }

  return lines.join("\n");
}

// ---- 머리말 파서 ----

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
 * 스펙 문서들에서 작업 지시서를 읽는다.
 *
 * 머리말은 **정확히 한 장**에만 있어야 한다. 둘 이상이면 어느 것이 지시서인지 --spec 순서에
 * 의존하게 되고, 순서는 사람이 쉽게 바꾸는 것이라 통제의 근거로 삼을 수 없다.
 */
export function loadWorkOrder(
  repoRoot: string,
  specPaths: string[],
  policy: WorkOrderPolicy,
): WorkOrder {
  const found = specPaths
    .map((path) => ({ path, values: parseFrontMatter(readFileSync(path, "utf-8")) }))
    .filter((candidate): candidate is { path: string; values: Record<string, string | string[]> } =>
      candidate.values !== undefined,
    );

  if (found.length === 0) {
    throw new WorkOrderError([
      {
        attribute: "머리말",
        detail:
          "작업 지시서가 없습니다. --spec 문서 중 한 장의 맨 첫 줄부터 머리말을 두세요:\n" +
          "    ---\n" +
          `    kind: feature        # ${KINDS.join(" | ")}\n` +
          "    id: PROJ-1\n" +
          "    title: 한 줄 요약\n" +
          "    target: 대상\n" +
          "    ---",
      },
    ]);
  }

  if (found.length > 1) {
    throw new WorkOrderError([
      {
        attribute: "머리말",
        detail:
          `머리말이 ${found.length} 장에 있습니다: ${found.map((entry) => entry.path).join(", ")}\n` +
          "    정확히 한 장에만 두세요 — 둘 이상이면 어느 것이 지시서인지 --spec 순서에 달리게 됩니다",
      },
    ]);
  }

  return validateWorkOrder(repoRoot, found[0].values, found[0].path, policy);
}
