/** 상태 JSON의 읽기·구조 검증 오류를 파일 경로가 있는 Stop으로 모은다. hook에서도 읽는 작은 모듈이다. */
import { readFileSync } from "fs";
import { Stop } from "./stop";

export function readJson<T>(path: string, schema: { parse(value: unknown): T }, display = path): T {
  try { return schema.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) {
    const detail = error instanceof SyntaxError ? "JSON 형식이 아닙니다"
      : error instanceof Error ? error.message.split(/\r?\n/)[0].slice(0, 240) : "읽기 또는 형식 검증에 실패했습니다";
    throw new Stop(`${display} 을 읽지 못했습니다 — ${detail}`);
  }
}
