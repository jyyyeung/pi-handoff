import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createJiti } from "jiti"
import { WorkIdStore } from "pi-workid/src/store.ts"
import {
  buildWorkIdRosterLines,
  buildWorkIdSeedPrompt,
  deriveWorkIdSlug,
  extractNextSessionFocus,
  isWorkIdModeEnabled,
  MAX_SEED_PROMPT_CHARS,
  WORK_ID_FALLBACK_SLUG,
} from "../src/workid.ts"

// Work-ID identity tests. Registry tests point PI_WORKID_HOME at a mkdtemp
// home so the real ~/.pi/agent/workid is never touched; runHandoff is loaded
// through jiti because src/index.ts uses .js specifiers for intra-package
// imports (the same loader pi uses).

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
})

type RunHandoff = (
  pi: unknown,
  ctx: unknown,
  focus: string,
  reason?: string,
) => Promise<void>

async function loadRunHandoff(): Promise<RunHandoff> {
  const mod = (await jiti.import(join(root, "src", "index.ts"))) as {
    runHandoff: RunHandoff
  }
  assert.equal(typeof mod.runHandoff, "function")
  return mod.runHandoff
}

interface Recording {
  sessionName?: string
  prompt?: string
}

function makeHarness(options: { cwd: string; parentSessionFile?: string }) {
  const recorded: Recording = {}
  const childSessionFile = join(options.cwd, "child-session.jsonl")

  const childSessionManager = {
    getSessionFile: () => childSessionFile,
    appendSessionInfo: (name: string) => {
      recorded.sessionName = name
      return "info-1"
    },
  }
  const childCtx = {
    ui: { notify: () => {} },
    sendUserMessage: async (text: string) => {
      recorded.prompt = text
    },
  }
  const ctx = {
    cwd: options.cwd,
    model: { provider: "test-provider", id: "test-model" },
    sessionManager: {
      buildContextEntries: () => [
        {
          type: "message" as const,
          id: "entry-1",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "user" as const,
            content: [{ type: "text" as const, text: "ship the checkout fix" }],
            timestamp: Date.now(),
          },
        },
      ],
      getSessionFile: () => options.parentSessionFile,
    },
    ui: {
      notify: () => {},
      custom: async () => "Generated handoff body.",
    },
    newSession: async (options: {
      setup?: (sessionManager: unknown) => Promise<void>
      withSession?: (ctx: unknown) => Promise<void>
    }) => {
      await options.setup?.(childSessionManager)
      await options.withSession?.(childCtx)
      return { cancelled: false }
    },
  }
  const pi = {
    getCommands: () => [],
    getSessionName: () => undefined,
    setSessionName: () => undefined,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  }
  return { ctx, pi, recorded, childSessionFile }
}

function clearWorkIdEnv(): void {
  delete process.env["PI_WORKID_MODE"]
  delete process.env["PI_WORKID_HOME"]
}

/** Force the in-process backend regardless of the host herdr environment. */
function forceInProcessBackend(t: { after: (fn: () => void) => void }): void {
  const saved = {
    HERDR_ENV: process.env["HERDR_ENV"],
    HERDR_WORKSPACE_ID: process.env["HERDR_WORKSPACE_ID"],
  }
  delete process.env["HERDR_ENV"]
  delete process.env["HERDR_WORKSPACE_ID"]
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test("mode off (env unset): session name and prompt match pre-workid behavior", async (t) => {
  t.after(clearWorkIdEnv)
  clearWorkIdEnv()
  forceInProcessBackend(t)
  const runHandoff = await loadRunHandoff()

  const cwd = await mkdtemp(join(tmpdir(), "pi-handoff-off-"))
  const { ctx, pi, recorded } = makeHarness({
    cwd,
    parentSessionFile: join(cwd, "parent.jsonl"),
  })
  await runHandoff(pi, ctx, "Fix the checkout guard", "voluntary")

  assert.equal(recorded.sessionName, "[handoff] fix-the-checkout-guard")
  assert.ok(recorded.prompt, "no prompt recorded")
  const [open, handoffPath, close] = recorded.prompt!.split("\n\n")
  assert.equal(open, "Continue from this handoff:")
  assert.equal(close, "Read the handoff, load any suggested skills, then continue the work.")
  const document = await readFile(handoffPath, "utf8")
  assert.ok(document.startsWith("# Handoff: Fix the checkout guard"))
})

test("mode on: inherits parent workId, retires with handoffDoc, claims successor", async (t) => {
  t.after(clearWorkIdEnv)
  forceInProcessBackend(t)
  const home = await mkdtemp(join(tmpdir(), "pi-handoff-home-"))
  const cwd = await mkdtemp(join(tmpdir(), "pi-handoff-cwd-"))
  process.env["PI_WORKID_MODE"] = "1"
  process.env["PI_WORKID_HOME"] = home

  const parentSessionFile = join(cwd, "parent-session.jsonl")
  const seed = await WorkIdStore.open()
  await seed.claim("fix-checkout-guard", {
    sessionId: parentSessionFile,
    sessionName: "parent session",
    cwd,
    startedAt: new Date().toISOString(),
  })

  const runHandoff = await loadRunHandoff()
  const { ctx, pi, recorded, childSessionFile } = makeHarness({
    cwd,
    parentSessionFile,
  })
  await runHandoff(pi, ctx, "Ship the checkout fix", "voluntary")

  assert.equal(recorded.sessionName, "[handoff] fix-checkout-guard#g2")

  const after = await WorkIdStore.open()
  const entry = after.get("fix-checkout-guard")
  assert.ok(entry, "work-id entry missing after handoff")
  assert.equal(entry.status, "active")
  assert.equal(entry.generation, 2)
  assert.equal(entry.current?.sessionId, childSessionFile)
  assert.equal(entry.current?.sessionName, "[handoff] fix-checkout-guard#g2")

  const parentLine = entry.lineage.find((line) => line.generation === 1)
  assert.ok(parentLine, "parent generation missing from lineage")
  assert.equal(parentLine.sessionId, parentSessionFile)
  assert.equal(parentLine.endedReason, "voluntary")
  const handoffPath = /Continue from this handoff:\n(\S+)/.exec(
    recorded.prompt!,
  )![1]!
  assert.equal(parentLine.handoffDoc, handoffPath)
  assert.match(handoffPath, /fix-checkout-guard-g2(?:-\d+)?\.md$/)

  assert.ok(
    recorded.prompt!.startsWith(
      "You own workid fix-checkout-guard#g2 — peers address you by that id.",
    ),
    `ownership line first, got: ${recorded.prompt!.split("\n")[0]}`,
  )
  assert.ok(recorded.prompt!.includes("Next session focus:\nShip the checkout fix"))
  assert.ok(
    recorded.prompt!.includes(
      "fix-checkout-guard#g2 — [handoff] fix-checkout-guard#g2",
    ),
    "successor missing from roster",
  )
  assert.ok(recorded.prompt!.length <= MAX_SEED_PROMPT_CHARS)
})

test("mode on: registry claim failure falls back to derived naming, no crash", async (t) => {
  t.after(clearWorkIdEnv)
  forceInProcessBackend(t)
  // A file where the registry directory chain should be: every store save
  // fails with ENOTDIR, so the successor claim cannot persist.
  const blocker = join(tmpdir(), `pi-handoff-blocker-${Date.now()}`)
  await writeFile(blocker, "not a directory", "utf8")
  process.env["PI_WORKID_MODE"] = "1"
  process.env["PI_WORKID_HOME"] = blocker

  const runHandoff = await loadRunHandoff()
  const cwd = await mkdtemp(join(tmpdir(), "pi-handoff-cwd-"))
  const { ctx, pi, recorded } = makeHarness({
    cwd,
    parentSessionFile: join(cwd, "parent.jsonl"),
  })
  await runHandoff(pi, ctx, "Ship the checkout fix", "voluntary")

  assert.equal(recorded.sessionName, "[handoff] ship-the-checkout-fix")
  assert.equal(
    recorded.prompt!.split("\n\n")[0],
    "Continue from this handoff:",
    "prompt falls back to the legacy form",
  )
})

test("mode on: retire failure on inherited workId falls back to derived naming", async (t) => {
  t.after(clearWorkIdEnv)
  forceInProcessBackend(t)
  const home = await mkdtemp(join(tmpdir(), "pi-handoff-home-"))
  const cwd = await mkdtemp(join(tmpdir(), "pi-handoff-cwd-"))
  process.env["PI_WORKID_MODE"] = "1"
  process.env["PI_WORKID_HOME"] = home

  const parentSessionFile = join(cwd, "parent-session.jsonl")
  const seed = await WorkIdStore.open()
  await seed.claim("fix-checkout-guard", {
    sessionId: parentSessionFile,
    sessionName: "parent session",
    cwd,
    startedAt: new Date().toISOString(),
  })
  const registryDir = join(home, ".pi", "agent", "workid")
  await chmod(registryDir, 0o500)
  t.after(() => chmod(registryDir, 0o700))

  const runHandoff = await loadRunHandoff()
  const { ctx, pi, recorded } = makeHarness({
    cwd,
    parentSessionFile,
  })
  await runHandoff(pi, ctx, "Ship the checkout fix", "voluntary")

  assert.equal(recorded.sessionName, "[handoff] ship-the-checkout-fix")
  assert.equal(recorded.prompt!.split("\n\n")[0], "Continue from this handoff:")

  const after = await WorkIdStore.open()
  const entry = after.get("fix-checkout-guard")
  assert.ok(entry)
  assert.equal(entry.status, "active", "failed retire must not corrupt the entry")
  assert.equal(entry.generation, 1)
})

test("deriveWorkIdSlug: slugifies, truncates, and falls back", () => {
  assert.equal(deriveWorkIdSlug("Fix the Checkout Guard!!"), "fix-the-checkout-guard")
  assert.equal(deriveWorkIdSlug("  --Nested--  Components--  "), "nested-components")
  assert.equal(deriveWorkIdSlug("A"), WORK_ID_FALLBACK_SLUG)
  assert.equal(deriveWorkIdSlug("!!!"), WORK_ID_FALLBACK_SLUG)
  assert.equal(deriveWorkIdSlug(""), WORK_ID_FALLBACK_SLUG)
  assert.equal(deriveWorkIdSlug("УМНЫЙ АГЕНТ"), WORK_ID_FALLBACK_SLUG)

  const long = deriveWorkIdSlug("a".repeat(45) + " tail")
  assert.equal(long.length, 40)
  assert.match(long, /^[a-z0-9][a-z0-9-]{2,39}$/)

  const trailingDash = deriveWorkIdSlug("a".repeat(39) + " " + "b".repeat(5))
  assert.equal(trailingDash, "a".repeat(39), "trailing dash after the cap is trimmed")
})

test("isWorkIdModeEnabled: only explicit off values disable the mode", () => {
  assert.equal(isWorkIdModeEnabled({}), false)
  assert.equal(isWorkIdModeEnabled({ PI_WORKID_MODE: undefined }), false)
  assert.equal(isWorkIdModeEnabled({ PI_WORKID_MODE: "" }), false)
  assert.equal(isWorkIdModeEnabled({ PI_WORKID_MODE: "0" }), false)
  assert.equal(isWorkIdModeEnabled({ PI_WORKID_MODE: "off" }), false)
  assert.equal(isWorkIdModeEnabled({ PI_WORKID_MODE: " FALSE " }), false)
  assert.equal(isWorkIdModeEnabled({ PI_WORKID_MODE: "1" }), true)
  assert.equal(isWorkIdModeEnabled({ PI_WORKID_MODE: "on" }), true)
  assert.equal(isWorkIdModeEnabled({ PI_WORKID_MODE: "true" }), true)
})

test("buildWorkIdSeedPrompt: bounded, ownership first, roster and doc path present", () => {
  const prompt = buildWorkIdSeedPrompt({
    handoffPath: "/tmp/pi-handoffs/doc.md",
    workId: "fix-checkout-guard",
    generation: 2,
    focus: "Ship the checkout fix",
    rosterLines: ["a-work#g1 — [handoff] a-work#g1", "fix-checkout-guard#g2 — [handoff] fix-checkout-guard#g2"],
  })
  assert.ok(prompt.length <= MAX_SEED_PROMPT_CHARS)
  assert.ok(
    prompt.startsWith(
      "You own workid fix-checkout-guard#g2 — peers address you by that id.",
    ),
  )
  assert.ok(prompt.includes("/tmp/pi-handoffs/doc.md"))
  assert.ok(prompt.includes("Next session focus:\nShip the checkout fix"))
  assert.ok(prompt.includes("a-work#g1 — [handoff] a-work#g1"))
  assert.ok(prompt.includes("Read the handoff, load any suggested skills, then continue the work."))

  const oversized = buildWorkIdSeedPrompt({
    handoffPath: "/tmp/doc.md",
    workId: "fix-checkout-guard",
    generation: 2,
    focus: "x".repeat(5_000),
    rosterLines: Array.from({ length: 30 }, (_, i) => `w${i}#g1 — ${"n".repeat(80)}`),
  })
  assert.ok(oversized.length <= MAX_SEED_PROMPT_CHARS)
})

test("buildWorkIdRosterLines: active entries in cwd only", () => {
  const entry = (
    workId: string,
    cwd: string | null,
    status: "active" | "retired" = "active",
    generation = 1,
  ) => ({
    workId,
    status,
    generation,
    taskRef: null,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    current: cwd
      ? {
          sessionId: `${workId}-session`,
          sessionName: `[handoff] ${workId}#g${generation}`,
          cwd,
          startedAt: "2026-11-16T00:00:00.000Z",
        }
      : null,
    lineage: [],
  })
  const lines = buildWorkIdRosterLines(
    [entry("b-work", "/repo"), entry("a-work", "/repo"), entry("c-work", "/elsewhere"), entry("d-work", null, "retired")],
    "/repo",
  )
  assert.deepEqual(lines, [
    "a-work#g1 — [handoff] a-work#g1",
    "b-work#g1 — [handoff] b-work#g1",
  ])
})

test("extractNextSessionFocus: returns the section body or undefined", () => {
  const document = [
    "# Handoff: ship it",
    "",
    "## Next session focus",
    "",
    "Ship the checkout fix.",
    "",
    "## Previous session",
    "",
    "- Session file: `x`",
  ].join("\n")
  assert.equal(extractNextSessionFocus(document), "Ship the checkout fix.")
  assert.equal(extractNextSessionFocus("# No section here"), undefined)
  assert.equal(
    extractNextSessionFocus("## Next session focus\n\n   \n\n## Previous session"),
    undefined,
  )
})
