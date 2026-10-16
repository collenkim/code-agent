/** hook·상태 조회도 읽는 순수 계약. LangGraph·SQLite 실행기를 import하지 않는다. */
export const GRAPH_VERSION = 1;
export const GRAPH_DIR = ".code-agent/graph";
export type GraphRunStatus = "running" | "waiting" | "completed" | "failed" | "interrupted";

export interface GraphView {
  version: number;
  latest: null | { id: string; threadId: string; graph: string; status: GraphRunStatus; node: string | null; startedAt: string; finishedAt: string | null };
  latestSeq: number;
}
