import { existsSync } from "node:fs";
import { join } from "node:path";
import { GRAPH_DIR, GRAPH_VERSION, type GraphView } from "./types";
import { readJson } from "../stateJson";

/** SQLite readOnly 연결의 WAL 파일 생성도 피한다. 실행기가 발행한 관찰 사본을 읽기만 한다. */
export function graphView(root: string): GraphView | undefined {
  const path = join(root, GRAPH_DIR, "view.json");
  if (!existsSync(path)) {
    if (existsSync(join(root, GRAPH_DIR, "state.sqlite"))) throw new Error("그래프 관찰 사본이 없습니다. 다음 그래프 실행에서 다시 관찰하세요.");
    return undefined;
  }
  return readJson(path, { parse(raw) {
    const view = raw as GraphView | null;
    if (!view || view.version !== GRAPH_VERSION || !Number.isSafeInteger(view.latestSeq) || view.latestSeq < 0 ||
        (view.latest !== null && (typeof view.latest?.id !== "string" || typeof view.latest.threadId !== "string" ||
          !["running", "waiting", "completed", "failed", "interrupted"].includes(view.latest.status)))) throw new Error("그래프 관찰 사본의 형식을 확인할 수 없습니다.");
    return view;
  } });
}
