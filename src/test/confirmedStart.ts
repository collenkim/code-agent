import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { start as startUnconfirmed } from "../agent/commands";
import { canonical, loadActive, saveActive } from "../agent/layout";
import { recordRequestDecision, requestState } from "../agent/request";
import { parseFrontMatter } from "../core/workOrder";

/**
 * 사람이 터미널에서 요구사항을 확정한 것으로 두고 시작한다.
 *
 * 접수 · 확정 자체는 request 테스트가 본다. 다른 테스트는 스테이지를 보러 왔으므로, 지시서를 쓴 그 자리에서
 * 확정 기록을 남긴 뒤 진짜 `start` 를 부른다 — 형식이 틀린 지시서면 기록 없이 넘겨 `start` 가 그 오류를 그대로 낸다.
 */
export function confirmForTest(repoRoot: string, spec: string): void {
  const absolute = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  const path = relative(repoRoot, canonical(absolute)).replace(/\\/g, "/");
  if (!existsSync(join(repoRoot, path))) return;
  let id: string | undefined;
  try {
    const values = parseFrontMatter(readFileSync(join(repoRoot, path), "utf-8"));
    id = typeof values?.id === "string" && values.id !== "" ? values.id : undefined;
  } catch {
    return;
  }
  if (!id || requestState(repoRoot, id, path).status === "confirmed") return;
  recordRequestDecision(repoRoot, {
    id,
    spec: path,
    decision: "confirmed",
    approver: "test",
    presence: { channel: "tty", verified: true, detail: "테스트 — 터미널 확정을 흉내낸다" },
  });
}

export function start(repoRoot: string, spec: string, options: { target?: string; base?: string; planning?: boolean } = {}): string {
  confirmForTest(repoRoot, spec);
  const result = startUnconfirmed(repoRoot, spec, options);
  // 기존 회귀군은 이전 버전에서 시작한 작업의 재개 호환성을 검사한다.
  // 신규 관찰 흐름 테스트는 planning:true로 실제 start 기본값을 유지한다.
  if (!options.planning) {
    const active = loadActive(repoRoot)!;
    delete active.planningVersion;
    saveActive(repoRoot, active, "start");
  }
  return result;
}
