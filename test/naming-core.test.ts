import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MAX_RENAME_CHARS,
  redactSecrets,
  sanitizeRenameText,
} from "../src/rename/sanitize.ts"
import {
  DEFAULT_RENAME_LANGUAGE,
  parseRenameLanguage,
} from "../src/rename/language.ts"
import { resolveHandoffBackend } from "../src/backend.ts"

// The vendored naming core is pure; these are the smoke tests that make sure a
// re-vendor from upstream cannot silently change what ends up in a session name
// or a handoff prompt.

test("redactSecrets: cloud and API keys", () => {
  assert.equal(
    redactSecrets("key AKIAIOSFODNN7EXAMPLE here"),
    "key [redacted aws key] here",
  )
  assert.equal(
    redactSecrets("sk-abcdefghijklmnopqrstuvwxyz012345"),
    "[redacted api key]",
  )
})

test("redactSecrets: bearer tokens and KEY=value assignments", () => {
  assert.equal(
    redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz01"),
    "Authorization: Bearer [redacted]",
  )
  assert.equal(redactSecrets("API_TOKEN=supersecret"), "API_TOKEN=[redacted]")
  assert.equal(redactSecrets("DB_PASSWORD=hunter2"), "DB_PASSWORD=[redacted]")
})

test("redactSecrets: private key blocks", () => {
  const text = [
    "before",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA",
    "-----END RSA PRIVATE KEY-----",
    "after",
  ].join("\n")
  const redacted = redactSecrets(text)
  assert.ok(redacted.startsWith("before"))
  assert.ok(redacted.endsWith("after"))
  assert.ok(!redacted.includes("MIIEowIBAAKCAQEA"))
  assert.ok(redacted.includes("[redacted private key]"))
})

test("redactSecrets: leaves ordinary prose alone", () => {
  assert.equal(
    redactSecrets("fix the checkout guard registry"),
    "fix the checkout guard registry",
  )
})

test("sanitizeRenameText: strips labels, bullets and quotes", () => {
  assert.equal(sanitizeRenameText("Name: Fix Checkout Guard"), "fix-checkout-guard")
  assert.equal(sanitizeRenameText("- Fix Checkout Guard"), "fix-checkout-guard")
  assert.equal(sanitizeRenameText('"Fix Checkout Guard"'), "fix-checkout-guard")
  assert.equal(sanitizeRenameText("```\nFix Checkout Guard\n```"), "fix-checkout-guard")
})

test("sanitizeRenameText: collapses separators and trims edges", () => {
  assert.equal(sanitizeRenameText("  fix   the   guard!!  "), "fix-the-guard")
  assert.equal(sanitizeRenameText("--fix--"), "fix")
})

test("sanitizeRenameText: caps at MAX_RENAME_CHARS", () => {
  const long = sanitizeRenameText("a".repeat(200))
  assert.equal(long.length, MAX_RENAME_CHARS)
  const dashed = sanitizeRenameText("ab ".repeat(40))
  assert.ok(dashed.length <= MAX_RENAME_CHARS)
  assert.ok(!dashed.endsWith("-"))
})

test("sanitizeRenameText: keeps unicode only for non-English languages", () => {
  assert.ok(!sanitizeRenameText("日本語 fix", "en").includes("日"))
  assert.ok(sanitizeRenameText("日本語 fix", "ja").includes("日"))
  assert.ok(!sanitizeRenameText("日本語 fix", "en-US").includes("日"))
})

test("parseRenameLanguage: canonicalises and rejects junk", () => {
  assert.equal(parseRenameLanguage("auto"), "auto")
  assert.equal(parseRenameLanguage("  AUTO "), "auto")
  assert.equal(parseRenameLanguage("en-us"), "en-US")
  assert.equal(parseRenameLanguage("   "), undefined)
  assert.equal(parseRenameLanguage("not a language!!"), undefined)
  assert.equal(parseRenameLanguage(42), undefined)
  assert.equal(DEFAULT_RENAME_LANGUAGE, "en")
})

// Backend selection lives in its own import-free module so it is testable
// without the pi runtime (see src/backend.ts).

test("resolveHandoffBackend: defaults to auto", () => {
  assert.equal(resolveHandoffBackend({}), "auto")
  assert.equal(resolveHandoffBackend({ PI_HANDOFF_BACKEND: "  " }), "auto")
  assert.equal(resolveHandoffBackend({ PI_HANDOFF_BACKEND: "nonsense" }), "auto")
})

test("resolveHandoffBackend: aliases for the dependency-free path", () => {
  for (const value of ["in-process", "IN-PROCESS", " inprocess ", "session", "new-session"]) {
    assert.equal(
      resolveHandoffBackend({ PI_HANDOFF_BACKEND: value }),
      "in-process",
      value,
    )
  }
})

test("resolveHandoffBackend: aliases for the tab path", () => {
  for (const value of ["tab", "herdr", " Terminal "]) {
    assert.equal(resolveHandoffBackend({ PI_HANDOFF_BACKEND: value }), "tab", value)
  }
})
