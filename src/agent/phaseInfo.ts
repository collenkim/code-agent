/**
 * 스테이지 이름표와 구현 단계 — commands.ts(status·next)와 contextRender.ts(context)가 같이 쓴다(순환 import 를 피해 따로 둔다).
 */
import type { StageDef } from "../core/manifest";
import type { Phase } from "./layout";
import type { Work } from "./work";

export const PHASE_LABEL: Record<Phase, string> = {
  analysis: "요구사항 분석",
  impact: "영향도 분석",
  design: "설계·정의",
  plan: "구현 계획",
  implement: "구현",
  check: "정적 분석·컴파일",
  test: "테스트",
  review: "코드 리뷰",
  integrate: "통합 검증",
  deliver: "반영",
};

/** implement 가 도는 단계 — 검증 단계는 verify 스테이지가 맡는다 */
export function codeStages(work: Work): StageDef[] {
  return work.stages.filter((stage) => stage.kind !== "verify");
}
