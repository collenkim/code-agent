import { pidAlive } from "../agent/lock";

/**
 * 시험용 죽은 pid. 방금 끝난 자식 프로세스의 pid 는 쓰지 않는다 — 병렬 부하에서 Windows 는 그 pid 를 곧바로 다른 프로세스(다른 시험의 git·node 자식)에
 * 다시 주고, 그러면 생존 판정(`pidAlive` — `process.kill(pid, 0)`)이 살아 있다고 답해 고아 보기·잠금 회수 시험이 간헐로 깨진다.
 *
 * 그래서 OS 가 배정하지 않는 범위에서 고른다 — Linux pid 는 PID_MAX_LIMIT(2^22)를 넘지 않고, macOS 는 99,999 를 넘지 않으며,
 * Windows pid 는 4의 배수로 핸들 표(최대 2^24 항목) 안에서 배정된다. 그 범위 밖이라도 실제 판정 함수로 지금 살아 있지 않음을 확인한 값만 돌려준다.
 * 판정 동작은 바꾸지 않는다 — 시험이 넘기는 값만 결정적으로 만든다.
 */
export const UNASSIGNED_PID_FLOOR = 0x3fff_0000;

export function deadPid(): number {
  for (let pid = 0x3fff_fffc; pid > UNASSIGNED_PID_FLOOR; pid -= 4) if (!pidAlive(pid)) return pid;
  throw new Error("살아 있지 않은 pid 를 찾지 못했습니다");
}
