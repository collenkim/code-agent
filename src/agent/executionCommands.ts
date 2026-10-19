import { join } from "path";
import { executionMode, executionPolicy, EXECUTION_FILE } from "./executionMode";
import { crossNotice, selectedHosts } from "./hosts";
import { hostMarked } from "./crossEnv";
import { confirmOnTerminal } from "./tty";
import { Stop } from "./stop";
import { CONTROL_LOCK, withLock, writeJson, readBinding } from "./master/store";
import { recordHostHandoff } from "./master/hostHandoff";
import { activeRuns } from "./master/runs";
import { handoffView, handoffSummary, requireHandoffUnchanged, applyHandoff } from "./executionHandoff";
import { skill } from "./hostText";
export function execution(root: string, mode?: string, options: { handoff?: boolean; main?: string; json?: boolean } = {}): string {
  if (options.main !== undefined && (mode !== "both" || !["claude", "codex"].includes(options.main))) throw new Stop("--main claude|codex는 both와 함께 지정합니다");
  if (options.handoff && !mode) throw new Stop("--handoff에는 전환할 실행 방식을 지정하세요");
  if (options.json && mode) throw new Stop("--json은 실행 방식·인계 상태 조회에만 사용합니다");
  if (options.json) return JSON.stringify({ policy: executionPolicy(root) ?? null, handoff: handoffView(root) });
  if (mode !== undefined) {
    if (!["claude", "codex", "both"].includes(mode)) throw new Stop("사용법: code-agent execution [claude|codex|both]");
    if (hostMarked()) throw new Stop("실행 방식 변경은 호스트 밖 터미널에서 사람이 확인합니다.");
    const installed = selectedHosts(root);
    if ((mode === "both" && installed.length !== 2) || (mode !== "both" && !installed.includes(mode as "claude" | "codex"))) throw new Stop("먼저 code-agent init으로 두 호스트를 준비하세요.");
    const preview = handoffView(root);
    const previous = executionPolicy(root);
    const main = mode === "both" ? options.main ?? previous?.main ?? (previous?.mode === "claude" || previous?.mode === "codex" ? previous.mode : undefined) : undefined;
    if (preview.runs.length) throw new Stop("관리 실행을 중지한 뒤 실행 방식을 바꾸세요.");
    if (options.handoff && preview.blockers.length) throw new Stop(handoffSummary(preview));
    if (!options.handoff && preview.lease && ((mode !== "both" && preview.lease.host !== mode) || main && preview.lease.host !== main)) throw new Stop("기존 작업 임대가 있습니다. execution --json으로 확인하고 --handoff로 인계하세요");
    confirmOnTerminal(`실행 방식: ${mode}${main ? ` · 관리 실행 주 호스트: ${main}` : ""}\n진행 중인 호스트를 먼저 중지하세요. 작업 ID·접수 유형·임대·승인 규칙을 유지합니다. both는 현재 호스트가 개발하고 상대 호스트가 계획·코드 리뷰를 교차 검증합니다.\n${handoffSummary(preview)}${options.handoff ? "\n기존 실행 중지와 위 인계 항목을 함께 확인합니다." : ""}`, mode);
    withLock(root, CONTROL_LOCK, () => {
      if (activeRuns(root).length) throw new Stop("관리 실행을 중지한 뒤 실행 방식을 바꾸세요.");
      if (options.handoff) {
        applyHandoff(root, requireHandoffUnchanged(root, preview));
        recordHostHandoff(root, (main ?? (mode === "both" ? readBinding(root)?.host.kind ?? "claude" : mode)) as "claude" | "codex", preview.questions.map(q => q.requestId));
      }
      writeJson(join(root, EXECUTION_FILE), { version: 1, mode, ...(main ? { main } : {}) });
    });
  }
  const current = executionMode(root) ?? (selectedHosts(root).length > 1 ? "both" : selectedHosts(root)[0]);
  return `실행 방식: ${current === "auto" ? "현재 호스트 단독 (미선택)" : current}\n` +
    (crossNotice(root) ?? "교차 검증 꺼짐 — code-agent execution both로 선택할 수 있습니다.") +
    (executionPolicy(root)?.main ? `\n관리 실행 주 호스트: ${executionPolicy(root)!.main}` : "") +
    (options.handoff ? `\n인계 완료. 같은 브랜치에서 ${skill("ca-next")}로 기존 작업을 재개하세요. 관리 실행은 기존 작업·links로 start하고 다른 호스트의 sessionId를 resume하지 않습니다.` : "");
}
