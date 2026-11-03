import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { readDocLedger } from "../agent/docs";
import { prepareConsentFixture, setupConsentProject } from "./consentFixture";
import type { PreparedConsentFixture } from "./consentFixture";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-consent-")));
  setupConsentProject(root);
});
afterEach(() => {
  // Resolve and constrain the recursive cleanup to this test's newly allocated temp directory.
  const target = resolve(root);
  const temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-consent-"));
  rmSync(target, { recursive: true, force: true });
});

function docsFixture(): PreparedConsentFixture { return prepareConsentFixture(root, { action: "docs" }); }

export { root, docsFixture };
export function assertNoDocs(): void { assert.equal(readDocLedger(root).length, 0); }
