import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { StageResult } from "./types";

/**
 * 생성 결과를 staging 디렉토리에 쓴다. 저장소 루트 기준 상대경로를 그대로 유지하므로,
 * 확인 후 outDir 내용을 저장소에 복사하면 그대로 반영된다.
 * 대상 저장소는 이 함수가 건드리지 않는다.
 */
export function emitFiles(outDir: string, stages: StageResult[]): string[] {
  const written: string[] = [];

  for (const stage of stages) {
    for (const file of stage.files) {
      const target = join(outDir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf-8");
      written.push(target);
    }
  }

  return written;
}
