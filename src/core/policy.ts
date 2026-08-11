/**
 * 생성 범위 정책을 user 프롬프트 맨 앞에 덧붙인다.
 *
 * 정책은 "어떤 계층을 만드느냐"(stage)가 아니라 "무엇을 만들고 무엇을 만들지
 * 않느냐"를 정하는 규칙이라 특정 단계에 속하지 않고 전부에 공통 적용된다.
 * 뒤따르는 내용(스펙·참조 표준 코드 등)을 해석하는 틀이 되도록 맨 앞에 둔다.
 */
export function withPolicy(userPrompt: string, policyText?: string): string {
  if (!policyText?.trim()) {
    return userPrompt;
  }

  return (
    "# 생성 범위 정책\n" +
    "아래 정책은 이 실행에서 무엇을 만들고 무엇을 만들지 않을지를 정한다. " +
    "다른 지시와 충돌하면 이 정책을 우선한다.\n\n" +
    `${policyText}\n\n${userPrompt}`
  );
}
