/**
 * master 가 고른 실행 방식의 적용 범위 — 지금 작업이 master 실행이 연 작업이면 그 작업에 고정된 선택, 작업을 열기 전이면 이 세션의
 * master 실행이 받은 선택이다. 교차 검증(crossEnabled)과 단독 호스트 판정(hook)이 프로젝트 실행 방식(execution.json)보다 먼저 본다.
 * hook 경로 모듈이다: 명령 모듈을 import 하지 않고, 기록을 읽지 못하면 선택이 없는 것으로 보아 프로젝트 실행 방식으로 둔다.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadActive, STATE_DIR } from "../layout";
import { masterRun } from "./runGuard";
import type { RunExecution } from "./protocol";

/** 이 저장소의 지금 작업(또는 이 세션의 master 실행)에 master 가 고른 실행 방식 — 없으면 undefined */
export function managedExecution(root: string, env: Readonly<Record<string, string | undefined>> = process.env): RunExecution | undefined {
  let workId: string | undefined;
  try { workId = loadActive(root)?.id; } catch { workId = undefined; }
  const file = workId ? join(root, STATE_DIR, "master", "works", `${encodeURIComponent(workId)}.json`) : undefined;
  // master 실행이 연 작업이면 그 작업의 기록이 정본이다 — 선택 없이 연 작업은 프로젝트 실행 방식을 따른다
  if (file && existsSync(file)) {
    try { return (JSON.parse(readFileSync(file, "utf8")) as { execution?: RunExecution }).execution; } catch { return undefined; }
  }
  return masterRun(root, env)?.execution;
}
