import { join } from "path";
import { executionMode, EXECUTION_FILE } from "./executionMode";
import { crossNotice, selectedHosts } from "./hosts";
import { hostMarked } from "./crossEnv";
import { confirmOnTerminal } from "./tty";
import { Stop } from "./stop";
import { CONTROL_LOCK, withLock, writeJson } from "./master/store";
import { activeRuns } from "./master/runs";
export function execution(root: string, mode?: string): string {
  if (mode !== undefined) {
    if (!["claude", "codex", "both"].includes(mode)) throw new Stop("사용법: code-agent execution [claude|codex|both]");
    if (hostMarked()) throw new Stop("실행 방식 변경은 호스트 밖 터미널에서 사람이 확인합니다.");
    const installed = selectedHosts(root);
    if ((mode === "both" && installed.length !== 2) || (mode !== "both" && !installed.includes(mode as "claude" | "codex"))) throw new Stop("먼저 code-agent init으로 두 호스트를 준비하세요.");
    confirmOnTerminal(`실행 방식: ${mode}\n진행 중인 호스트를 먼저 중지하세요. 작업 ID·접수 유형·임대·승인 규칙을 유지합니다. both는 현재 호스트가 개발하고 상대 호스트가 계획·코드 리뷰를 교차 검증합니다.`, mode);
    withLock(root, CONTROL_LOCK, () => {
      if (activeRuns(root).length) throw new Stop("관리 실행을 중지한 뒤 실행 방식을 바꾸세요.");
      writeJson(join(root, EXECUTION_FILE), { version: 1, mode });
    });
  }
  const current = executionMode(root) ?? (selectedHosts(root).length > 1 ? "both" : selectedHosts(root)[0]);
  return `실행 방식: ${current === "auto" ? "현재 호스트 단독 (미선택)" : current}\n` +
    (crossNotice(root) ?? "교차 검증 꺼짐 — code-agent execution both로 선택할 수 있습니다.");
}
