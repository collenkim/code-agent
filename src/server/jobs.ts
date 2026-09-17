/**
 * 작업 하나 = out 디렉토리 하나.
 *
 * 진행 상태(계획·세션·질문)는 이미 out/ 안에 있으므로 여기서 다시 들고 있지 않는다.
 * 서버가 기억하는 것은 "어떤 저장소를 어떤 템플릿으로 어디에 만드는 중인가" 뿐이고,
 * 그것만 파일로 남기면 서버를 껐다 켜도 이어진다.
 */
import { existsSync, readFileSync } from "fs";
import { resolve, sep } from "path";

import { writeAtomic } from "../core/atomic";
import { resolveAgainstRepo } from "../core/conventions";
import { withResolvedInputs } from "../core/run";
import type { BuildContext } from "../core/types";

export interface Job {
  id: string;
  /** 사람이 목록에서 알아볼 이름. 보통 도메인 이름 */
  label: string;
  /**
   * 이 작업을 만든 사람. **인증이 켜진 뒤에 만들어진 작업만 갖는다.**
   *
   * 요청 본문에서 오지 않는다 — 클라이언트가 정할 수 있으면 소유권이 아니라 장식이다.
   * 값은 프록시가 넣어 준 인증 주체이고, 승인 원장의 approver 도 같은 값을 쓴다.
   */
  owner?: string;
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

/** 경로 하나가 허용된 뿌리 안에 드는가. Windows 는 대소문자를 가리지 않는다 */
function underRoot(target: string, root: string): boolean {
  const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  const inside = fold(resolve(target));
  const base = fold(resolve(root));
  return inside === base || inside.startsWith(base + sep);
}

/**
 * 작업 목록을 들고 있는 파일. 진행 상태가 아니라 "무엇을 하는 중인지"만 담긴다.
 */
export class JobStore {
  private file: JobFile;

  /**
   * `roots` 를 주면 작업이 가리킬 수 있는 경로가 그 아래로 묶인다.
   *
   * 여러 명이 쓰는 서버에서 이것이 없으면, 요청 본문의 절대경로 하나로 이 프로세스가 읽고
   * 쓸 수 있는 모든 곳이 사정권에 든다. 비워 두면 제한하지 않는다 — 혼자 쓰는 로컬에서는
   * 그게 맞고, 인증을 켠 서버에서는 CLI 가 비워 두지 말라고 경고한다.
   */
  constructor(
    private readonly path: string,
    private readonly roots: string[] = [],
  ) {
    this.file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as JobFile) : empty();
  }

  /** 허용된 뿌리 밖을 가리키는 경로가 있으면 거기서 멈춘다 */
  private checkRoots(paths: (string | undefined)[]): void {
    if (this.roots.length === 0) {
      return;
    }
    const outside = paths
      .filter((path): path is string => typeof path === "string" && path.trim() !== "")
      .filter((path) => !this.roots.some((root) => underRoot(path, root)));

    if (outside.length > 0) {
      throw new Error(
        `허용된 경로 밖입니다:\n${outside.map((path) => `  - ${path}`).join("\n")}\n` +
          `  이 서버가 다룰 수 있는 곳: ${this.roots.join(", ")}\n` +
          "  --root 로 선언된 디렉토리 안에서만 저장소·템플릿·출력을 잡을 수 있습니다.",
      );
    }
  }

  /** 주인이 있는 작업만 그 주인에게 보인다. 인증이 꺼진 서버에는 주인 개념이 없다 */
  visibleTo(job: Job, requester: string | undefined): boolean {
    return requester === undefined || job.owner === requester;
  }

  /** 주인이 없는 작업 — 인증을 켜기 전에 만들어진 것들 */
  ownerless(): Job[] {
    return this.file.jobs.filter((job) => job.owner === undefined);
  }

  private save(): void {
    writeAtomic(this.path, JSON.stringify(this.file, null, 2));
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
  create(input: JobInput, owner?: string): Job {
    const out = resolve(input.out);
    const duplicate = this.file.jobs.find((job) => resolve(job.context.outDir) === out);
    if (duplicate) {
      throw new Error(
        `이미 같은 출력 디렉토리를 쓰는 작업이 있습니다: ${duplicate.id} (${duplicate.label})\n` +
          "작업마다 out 디렉토리를 따로 두세요 — 계획과 세션이 그 안에 있어 섞이면 이어지지 않습니다.",
      );
    }

    // 울타리 검사가 먼저다. 설정을 읽어 보기 전에 막아야 밖의 파일을 건드리지 않는다.
    //
    // 파이프라인이 푸는 것과 **같은 방식으로** 풀어야 한다. 템플릿·정책·컨벤션의 상대경로는
    // 실행 위치가 아니라 대상 저장소 기준이라(`resolveAgainstRepo`), 여기서 다르게 풀면
    // 실제로는 저장소 안을 가리키는 경로가 밖으로 읽혀 멀쩡한 작업이 거부된다.
    const againstRepo = (path?: string) =>
      path === undefined ? undefined : resolveAgainstRepo(input.repo, path);

    this.checkRoots([
      input.repo,
      out,
      againstRepo(input.templates),
      againstRepo(input.policy),
      ...(input.specs ?? []),
      ...(input.conventions ?? []).map((path) => againstRepo(path)!),
    ]);

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
      ...(owner ? { owner } : {}),
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
