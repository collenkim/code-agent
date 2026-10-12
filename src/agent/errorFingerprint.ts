import { createHash } from "crypto";

/** 보수적인 v1 규칙. 숫자·오류 코드·경로는 원인일 수 있으므로 일괄 제거하지 않는다. */
export function errorFingerprint(project: string, raw: string): { key: string; family: string; reliable: boolean } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n")
    .filter(line => !/^\s*(?:event[_ ]?id|request[_ ]?id|trace[_ ]?id|timestamp)\s*[:=]/i.test(line))
    .map(line => line.replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/g, "<time>")
      .replace(/\b(?:request[_ ]?id|trace[_ ]?id|event[_ ]?id)\s*[:=]\s*[\w-]+/gi, "<id>")
      .trim()).filter(Boolean);
  const exception = lines.find(line => /\b[\w.]+(?:Error|Exception)\b/.test(line));
  const frames = lines.filter(line => /^(?:at\s|File\s+")/.test(line));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return { key: digest(JSON.stringify(["v1", project, lines])),
    family: digest(JSON.stringify(["v1", project, exception?.match(/\b[\w.]+(?:Error|Exception)\b/)?.[0], frames])),
    reliable: !!exception && frames.length > 0 };
}
