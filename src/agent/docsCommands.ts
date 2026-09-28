import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { userInfo } from "os";

import { MANIFEST_FILE } from "../core/manifest";
import { writeAtomic } from "../core/atomic";
import { Stop } from "./commands";
import { checkDoc, checkProjectDocs, docsReady, formatDocChecks, recordDocConfirmation } from "./docs";
import { DOCS_SESSION_FILE, loadActive } from "./layout";
import { interview, isDocKind, SCHEMAS, skeleton } from "./schemas";
import type { DocKind } from "./schemas";
import { confirmOnTerminal } from "./tty";
import { loadManifestIfAny } from "./work";

function kindOf(value: string | undefined): DocKind {
  if (!value || !isDocKind(value)) {
    throw new Stop("문서 종류는 architecture 또는 conventions 입니다.");
  }
  return value;
}

export function docsStatus(repoRoot: string): string {
  const checks = checkProjectDocs(repoRoot, loadManifestIfAny(repoRoot));
  const session = existsSync(join(repoRoot, DOCS_SESSION_FILE));
  const next = docsReady(checks)
    ? "필수 문서가 모두 확정됐습니다."
    : checks.every((entry) => entry.state === "unconfirmed" || entry.state === "stale" || entry.ok)
      ? "사람이 별도 터미널에서 확정: " +
        checks.filter((entry) => !entry.ok).map((entry) => `code-agent confirm doc ${entry.kind}`).join(" · ")
      : "/ca-docs 로 작성하세요 (역공학 · 사용자 입력 · 기존 문서 연결)";
  return [
    "프로젝트 필수 문서:",
    formatDocChecks(checks, true),
    "",
    `문서 작성 세션: ${session ? "진행 중 (doc/ · 등록된 문서 · code-agent.json 만 쓸 수 있음)" : "없음"}`,
    `다음: ${next}`,
  ].join("\n");
}

export function docsSkeleton(kind: string | undefined): string {
  return skeleton(SCHEMAS[kindOf(kind)]);
}

export function docsInterview(kind: string | undefined, sections?: string): string {
  return interview(SCHEMAS[kindOf(kind)], sections?.split(","));
}

/** 이미 있는 문서를 등록한다. code-agent.json 의 그 자리만 바꾼다 */
export function docsLink(repoRoot: string, kindArg: string | undefined, paths: string[]): string {
  const kind = kindOf(kindArg);
  const manifestPath = join(repoRoot, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Stop(
      `${MANIFEST_FILE} 이 아직 없습니다. 기본 경로(${SCHEMAS[kind].defaultPath})에 두거나, /ca-adopt 로 매니페스트를 만든 뒤 연결하세요.`,
    );
  }
  if (paths.length === 0 || (kind === "architecture" && paths.length !== 1)) {
    throw new Stop(kind === "architecture" ? "아키텍처 문서 경로 하나가 필요합니다." : "컨벤션 문서 경로(파일 또는 디렉토리)가 필요합니다.");
  }
  const missing = paths.filter((path) => !existsSync(join(repoRoot, path)));
  if (missing.length > 0) {
    throw new Stop(`없는 경로입니다: ${missing.join(", ")}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  if (kind === "architecture") {
    raw.docs = { ...((raw.docs as Record<string, unknown>) ?? {}), architecture: paths[0] };
  } else {
    raw.conventions = paths;
  }
  writeAtomic(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  return `${SCHEMAS[kind].label} 문서를 연결했습니다: ${paths.join(", ")}\n\n${formatDocChecks([checkDoc(repoRoot, loadManifestIfAny(repoRoot), kind)], true)}`;
}

export function docsBegin(repoRoot: string): string {
  const active = loadActive(repoRoot);
  if (active) {
    throw new Stop(
      `작업이 진행 중입니다 (${active.id}). 근거 문서는 작업 도중에 바꾸지 않습니다 — 작업을 끝내거나 code-agent abort 뒤에 여세요.`,
    );
  }
  mkdirSync(dirname(join(repoRoot, DOCS_SESSION_FILE)), { recursive: true });
  writeFileSync(join(repoRoot, DOCS_SESSION_FILE), `${JSON.stringify({ startedAt: new Date().toISOString() })}\n`);
  return `문서 작성 세션을 열었습니다. 끝날 때까지 doc/ · 등록된 문서 · code-agent.json 밖은 쓸 수 없습니다.\n\n${docsStatus(repoRoot)}`;
}

export function docsEnd(repoRoot: string): string {
  rmSync(join(repoRoot, DOCS_SESSION_FILE), { force: true });
  return `문서 작성 세션을 닫았습니다.\n\n${docsStatus(repoRoot)}`;
}

/** 사람이 문서를 근거로 삼겠다고 확정한다 — 터미널에서만 */
export function confirmDoc(repoRoot: string, kindArg: string | undefined): string {
  const kind = kindOf(kindArg);
  const check = checkDoc(repoRoot, loadManifestIfAny(repoRoot), kind);
  if (check.state === "confirmed") {
    return `${check.label} 문서는 지금 내용으로 이미 확정돼 있습니다.`;
  }
  if (check.state === "missing-file" || check.state === "missing-sections") {
    throw new Stop(`확정할 수 없습니다 — ${check.problem}\n\n${formatDocChecks([check], true)}`);
  }
  const shown = [
    `${check.label} 문서를 확정합니다: ${check.paths.join(", ")}`,
    formatDocChecks([check], true),
    "",
    "확정하면 이후 모든 계획이 이 내용을 근거로 삼습니다. 내용을 직접 읽고 확인한 뒤 확정하세요.",
  ].join("\n");
  const presence = confirmOnTerminal(shown, "confirm");
  recordDocConfirmation(repoRoot, check, userInfo().username, presence);
  return `${check.label} 문서를 확정했습니다 (${check.hash}).\n\n${docsStatus(repoRoot)}`;
}
