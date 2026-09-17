/**
 * 작업별 줄 세우기.
 *
 * 두 가지를 동시에 지켜야 한다.
 *
 * **같은 작업 안에서는 순서가 있다.** 상태를 바꾸는 요청(응답 반영·질문 답변·판정)은
 * 읽고-고쳐-쓰기라, 둘이 겹치면 나중 것이 앞 것을 지운다. `spawnSync` 이던 시절에는
 * 노드가 단일 스레드라 그게 저절로 막혔는데, 검증 명령을 비동기로 돌리기 시작한 순간
 * 그 보호가 사라졌다 — 그래서 여기서 명시적으로 줄을 세운다.
 *
 * **다른 작업끼리는 기다리지 않는다.** 줄을 작업 하나로 묶으면 A 의 gradle 빌드가
 * B 의 왕복을 세운다. 그것을 없애려고 비동기로 바꾼 것이므로, 줄은 작업 단위로 갈린다.
 *
 * 조회는 줄에 세우지 않는다. 상태 파일은 원자적으로 쓰이므로(`core/atomic.ts`) 읽는 쪽은
 * 언제나 완결된 판본을 보고, 빌드가 도는 동안에도 "지금 무엇을 하는 중인지"는 보여야 한다.
 */

/** 실행 하나의 상태. 실패도 상태다 — 202 를 받은 클라이언트가 나중에 받아 가야 한다 */
export type RunState =
  | { status: "running" }
  | { status: "done"; value: unknown }
  | { status: "failed"; error: unknown };

export interface Run {
  id: string;
  jobId: string;
  /** 사람에게 보여 줄 한 마디 — "응답 반영" 처럼 */
  what: string;
  startedAt: string;
  /** **거부되지 않는다.** 결과는 state 로 읽는다 — 아무도 안 기다리는 사이 터지면 프로세스가 죽는다 */
  settled: Promise<void>;
  state: RunState;
}

/** 진행 중인 것을 화면에 알릴 때의 형태 */
export interface RunningView {
  runId: string;
  what: string;
  since: string;
}

/** 끝난 결과를 들고 있는 시간. 202 를 받은 쪽이 받아 갈 틈은 줘야 하고, 영원히 들 수는 없다 */
const KEEP_RESULT_MS = 30 * 60 * 1000;

export class JobQueue {
  /** 작업마다 마지막으로 예약된 것. 다음 요청은 이것 뒤에 붙는다 */
  private readonly tail = new Map<string, Promise<unknown>>();
  private readonly runs = new Map<string, Run>();
  private sequence = 0;

  /**
   * 그 작업의 줄 맨 뒤에 붙인다. 앞의 것이 실패해도 줄은 이어진다 —
   * 한 번의 실패로 그 작업이 영영 막히면 고칠 방법이 없다.
   */
  submit<T>(jobId: string, what: string, task: () => Promise<T>): Run {
    this.sequence += 1;
    const id = `run-${this.sequence}`;

    const previous = this.tail.get(jobId) ?? Promise.resolve();
    const run: Run = {
      id,
      jobId,
      what,
      startedAt: new Date().toISOString(),
      state: { status: "running" },
      settled: undefined as unknown as Promise<void>,
    };

    run.settled = previous.then(task).then(
      (value) => {
        run.state = { status: "done", value };
        this.forgetLater(id);
      },
      (error) => {
        run.state = { status: "failed", error };
        this.forgetLater(id);
      },
    );

    this.tail.set(jobId, run.settled);
    this.runs.set(id, run);
    return run;
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  /** 그 작업에서 지금 도는 것. 줄을 세우므로 하나를 넘지 않는다 */
  runningOn(jobId: string): RunningView | undefined {
    for (const run of this.runs.values()) {
      if (run.jobId === jobId && run.state.status === "running") {
        return { runId: run.id, what: run.what, since: run.startedAt };
      }
    }
    return undefined;
  }

  /** 작업을 지울 때 그 작업의 줄도 놓아 준다 */
  release(jobId: string): void {
    this.tail.delete(jobId);
  }

  private forgetLater(runId: string): void {
    const timer = setTimeout(() => this.runs.delete(runId), KEEP_RESULT_MS);
    // 이 타이머 때문에 프로세스가 안 죽으면 테스트가 끝나지 않는다.
    timer.unref?.();
  }
}

/**
 * 주어진 시간 안에 끝나는지 본다. 끝나지 않아도 실행은 그대로 둔다.
 *
 * 왕복 대부분은 파일 몇 개를 쓰는 일이라 눈 깜짝할 새 끝난다. 그런 것까지 202 로 돌려주고
 * 폴링하게 만들면 화면이 괜히 느려 보인다. 반대로 빌드는 몇 분이 걸려 붙잡고 있으면
 * 프록시가 먼저 끊는다 — 그래서 **빠른 것은 그 자리에서, 느린 것만 202** 로 가른다.
 */
export function settledWithin(run: Run, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void run.settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
