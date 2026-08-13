/**
 * 작업 하나 = out 디렉토리 하나.
 *
 * 진행 상태(계획·세션·질문)는 이미 out/ 안에 있으므로 여기서 다시 들고 있지 않는다.
 * 서버가 기억하는 것은 "어떤 저장소를 어떤 템플릿으로 어디에 만드는 중인가" 뿐이고,
 * 그것만 파일로 남기면 서버를 껐다 켜도 이어진다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { withResolvedInputs } from "../core/run";
import type { BuildContext } from "../core/types";

export interface Job {
  id: string;
  /** 사람이 목록에서 알아볼 이름. 보통 도메인 이름 */
  label: string;
  createdAt: string;
  context: BuildContext;
}

interface JobFile {
  version: 1;
  nextId: number;
  jobs: Job[];
}

export interface JobInput {
  label?: string;
  repo: string;
  templates: string;
  out: string;
  specs?: string[];
  reference?: string;
  conventions?: string[];
  policy?: string;
  gate?: boolean;
}

function empty(): JobFile {
  return { version: 1, nextId: 1, jobs: [] };
}

/**
 * 작업 목록을 들고 있는 파일. 진행 상태가 아니라 "무엇을 하는 중인지"만 담긴다.
 */
export class JobStore {
  private file: JobFile;

  constructor(private readonly path: string) {
    this.file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as JobFile) : empty();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file, null, 2), "utf-8");
  }

  list(): Job[] {
    return this.file.jobs;
  }

  get(id: string): Job {
    const job = this.file.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      throw new Error(`그런 작업이 없습니다: ${id}`);
    }
    return job;
  }

  /**
   * 작업을 만든다. 만들기 전에 매니페스트·컨벤션·참조 표준을 실제로 읽어 본다 —
   * 경로 오타를 첫 프롬프트 요청까지 끌고 가면 어디가 틀렸는지 알기 어려워진다.
   */
  create(input: JobInput): Job {
    const out = resolve(input.out);
    const duplicate = this.file.jobs.find((job) => resolve(job.context.outDir) === out);
    if (duplicate) {
      throw new Error(
        `이미 같은 출력 디렉토리를 쓰는 작업이 있습니다: ${duplicate.id} (${duplicate.label})\n` +
          "작업마다 out 디렉토리를 따로 두세요 — 계획과 세션이 그 안에 있어 섞이면 이어지지 않습니다.",
      );
    }

    const context: BuildContext = {
      specPaths: input.specs ?? [],
      conventionsPaths: input.conventions,
      templatesDir: input.templates,
      policyPath: input.policy,
      repoRoot: input.repo,
      referenceDomain: input.reference,
      outDir: out,
      gate: input.gate !== false,
      // 서버는 수동 모드만 돌린다 — 자동 재생성은 API를 붙일 때의 이야기다.
      maxRetries: 0,
    };

    // 여기서 던지는 오류가 곧 설정 오류다. 작업으로 만들지 않고 그대로 알린다.
    withResolvedInputs(context);

    const job: Job = {
      id: `job-${this.file.nextId}`,
      label: input.label?.trim() || `job-${this.file.nextId}`,
      createdAt: new Date().toISOString(),
      context,
    };

    this.file.nextId += 1;
    this.file.jobs.push(job);
    this.save();
    return job;
  }

  /** 목록에서만 뺀다. out/ 의 산출물은 건드리지 않는다. */
  remove(id: string): void {
    this.get(id);
    this.file.jobs = this.file.jobs.filter((job) => job.id !== id);
    this.save();
  }

  /** 스펙을 나중에 덧붙일 때. 계획을 세우기 전에만 의미가 있다. */
  setSpecs(id: string, specs: string[]): Job {
    const job = this.get(id);
    job.context.specPaths = specs;
    this.save();
    return job;
  }
}
