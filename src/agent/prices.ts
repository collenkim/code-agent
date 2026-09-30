/**
 * 토큰 단가표 — `code-agent usage` 의 비용 **추정**에만 쓴다.
 *
 * 출처는 번들 `claude-api` 스킬의 Current Models 표와 `shared/prompt-caching.md` § Economics 다.
 * 단가는 바뀌고 이 파일은 그 시점의 사본이라, 출력 꼬리에 `PRICES_AS_OF` 를 찍어 **언제 기준인지**를
 * 늘 함께 보여 준다. 실제 청구서가 정본이고 여기 숫자는 어디에 토큰이 쏠렸는지를 보는 자다.
 *
 * 캐시 읽기를 배수가 아니라 **값**으로 박는 이유: 배수가 모델마다 다르다
 * (opus-5 0.1× · opus-5.5 0.05× · fable-5.1 0.025×). 하나의 배수로 계산하면 fable 이 10배 틀린다.
 * 캐시 쓰기는 모델을 가리지 않고 5분 1.25× · 1시간 2× 라서 입력가에서 곧바로 나온다.
 */
export const PRICES_AS_OF = "2026-06-24";

/** $/1M 토큰 */
export interface Price {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-fable-5-1": { input: 10, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 },
};

/** 표에 없는 모델은 **0 으로 세고 이름을 남긴다** — 지어낸 단가로 합계를 물들이지 않는다 */
export function priceOf(model: string): Price | undefined {
  return PRICES[model];
}
