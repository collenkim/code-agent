/**
 * 얇은 HTTP 계층. 라우팅과 직렬화만 하고 판단은 하지 않는다.
 *
 * 기본 바인딩이 127.0.0.1 인 것은 의도다 — 이 서버는 대상 저장소를 읽고 build/test 명령을
 * 이 머신에서 실행한다. 외부에 열면 그게 그대로 원격 명령 실행이 된다.
 */
import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";

import * as api from "./api";
import { JobStore } from "./jobs";
import type { JobInput } from "./jobs";
import { page } from "./ui";

/** 응답 본문 상한. 코드 여러 파일이 오가므로 넉넉하되 무제한은 아니다. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface ServeOptions {
  port: number;
  host: string;
  statePath: string;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`요청이 너무 큽니다 (상한 ${MAX_BODY_BYTES / 1024 / 1024}MB).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (raw.trim() === "") {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`JSON 파싱 실패: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 요청 하나를 처리한다. 던져진 오류는 전부 400으로 나간다 —
 * 여기서 나오는 오류는 대개 경로 오타나 잘못 붙여넣은 응답이라 사용자가 고칠 수 있는 것들이다.
 */
async function route(store: JobStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    const html = page();
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (path === "/api/jobs") {
    if (method === "GET") {
      json(res, 200, { jobs: api.listJobs(store) });
      return;
    }
    if (method === "POST") {
      const input = await readJson<JobInput>(req);
      const job = store.create(input);
      json(res, 201, api.status(store, job.id));
      return;
    }
  }

  const match = /^\/api\/jobs\/([^/]+)(?:\/(prompt|response|questions|log))?$/.exec(path);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];

    if (!action && method === "GET") {
      json(res, 200, api.status(store, id));
      return;
    }
    if (!action && method === "DELETE") {
      store.remove(id);
      json(res, 200, { removed: id });
      return;
    }
    if (action === "prompt" && method === "GET") {
      json(res, 200, api.prompt(store, id));
      return;
    }
    if (action === "response" && method === "POST") {
      const body = await readJson<{ response?: string }>(req);
      json(res, 200, api.respond(store, id, body.response ?? ""));
      return;
    }
    if (action === "questions" && method === "POST") {
      const body = await readJson<{ answers?: { id: number; answer: string }[] }>(req);
      json(res, 200, api.answer(store, id, body.answers ?? []));
      return;
    }
    if (action === "log" && method === "GET") {
      json(res, 200, api.log(store, id));
      return;
    }
  }

  json(res, 404, { error: `그런 경로가 없습니다: ${method} ${path}` });
}

export function serve(options: ServeOptions): void {
  const store = new JobStore(options.statePath);

  const server = createServer((req, res) => {
    route(store, req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        json(res, 400, { error: message });
      } else {
        res.end();
      }
    });
  });

  server.listen(options.port, options.host, () => {
    console.log(`code-agent 서버: http://${options.host}:${options.port}`);
    console.log(`작업 목록: ${options.statePath}`);
    console.log("\n브라우저로 위 주소를 열고, 프롬프트를 Console 에 붙여넣으세요.");
  });
}
