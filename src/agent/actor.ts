import { userInfo } from "os";

/** 원장의 표시 이름이며 신원 증명이 아니다. Windows 샌드박스는 OS 사용자 조회를 거부할 수 있다. */
export function actorName(read: () => { username: string } = userInfo, env: NodeJS.ProcessEnv = process.env): string {
  try { const name = read().username.trim(); if (name) return name; } catch { /* 표시 이름만 환경으로 보완한다 */ }
  return env.USERNAME?.trim() || env.USER?.trim() || "사용자 이름 확인 불가";
}
