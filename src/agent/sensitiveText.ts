/**
 * 기록에 남기는 글의 민감 정보·로그 전문 검사 — 작업 경험(experience)·발견 보고(finding)가 쓰기 전에 같은 함수를 지난다.
 *
 * 기록은 반영 커밋으로 저장소에 남는다. 자격 증명은 한 번 커밋되면 되돌릴 수 없으므로 의심되면 쓰지 않고, 무엇이 걸렸는지는
 * 칸 이름과 종류만 알린다(걸린 값을 다시 출력하지 않는다). 로그는 요약 한두 줄과 로그 경로로 쓰게 한다 — 전문을 복제하지 않는다.
 * 패턴 검사라 놓치는 형식이 있다. 통과가 안전하다는 보장은 아니다.
 */

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["개인 키", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS 접근 키", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub 토큰", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Slack 토큰", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["API 키", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["인증 헤더", /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+\S{8,}/i],
  ["URL 의 계정 정보", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  // 앞은 경계를 보지 않는다 — `DB_PASSWORD=`·`csrftoken=` 처럼 이름 끝에 붙은 것도 잡는다(바로 뒤가 `:`·`=` 일 때만)
  ["비밀 값 대입", /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[^\s"'`,;]{6,}/i],
];

/** 한 칸의 줄 수 상한 — 넘으면 로그·출력 전문으로 본다 */
export const MAX_FIELD_LINES = 6;

/** 칸 이름 → 글. 문제마다 한 줄(칸 이름과 종류만) */
export function sensitiveProblems(fields: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(value)) problems.push(`${name}: ${label}로 보이는 값이 있습니다 — 값을 지우고 "<가림>" 이나 설정 위치로 쓰세요`);
    }
    if (/```/.test(value) || value.split("\n").length > MAX_FIELD_LINES) {
      problems.push(`${name}: 로그·출력 전문으로 보입니다(${MAX_FIELD_LINES}줄 초과 또는 코드 블록) — 요약 한두 줄과 로그 경로로 쓰세요`);
    }
  }
  return problems;
}
