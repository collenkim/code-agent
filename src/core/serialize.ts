/** 기존 승인·상태·요청 해시의 바이트 규약을 공유한다. 배열 순서는 보존하고 객체의 undefined만 뺀다. */
import { createHash } from "crypto";

export function canonicalJson(value: unknown, undefinedAsNull = false): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry, undefinedAsNull)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, undefinedAsNull)}`).join(",")}}`;
  }
  return JSON.stringify(undefinedAsNull ? value ?? null : value);
}
// 승인 해시는 배열의 undefined를 null로 쓰는 기존 규약을 유지한다.
export const approvalJson = (value: unknown): string => canonicalJson(value, true);
export const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
export const shortDigest = (text: string): string => sha256(text).slice(0, 16);
export const shortHash = (text: string): string => `sha256:${shortDigest(text)}`;
