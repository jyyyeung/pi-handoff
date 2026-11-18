import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createJiti } from "jiti"
import { buildWorkIdLaunchSeed } from "../src/workid.ts"

// Herdr-tab backend seed delivery (SEEDARG). The seed must ride the
// `herdr agent start` argv as pi's positional initial prompt — auto-submitted
// by pi after TUI init — instead of a follow-up `herdr agent prompt`, whose
// Enter gets swallowed during successor boot and whose text concatenates onto
// the stale editor prefill. These tests pin the argv, the work-id/fallback
// seed strings, and the warn-only engagement check that must never re-send.

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

interface ExecCall {
  command: string
  args: string[]
}

const ROOT_PANE_STDOUT = JSON.stringify({
  result: { root_pane: { pane_id: "pane-42" } },
})

function agentStatusStdout(status: string): string {
  return JSON.stringify({ result: { agent: { agent_status: status } } })
}

function makeTabHarness(options: { cwd: string; agentStatus?: string }) {
  const execs: ExecCall[] = []
  const notifications: string[] = []
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
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (text: string) => notifications.push(text),
      custom: async () => "Generated handoff body.",
    },
  }
  const pi = {
    getCommands: () => [],
    getSessionName: () => undefined,
    setSessionName: () => undefined,
    exec: async (command: string, args: string[]) => {
      execs.push({ command, args })
      if (args[0] === "tab" && args[1] === "create") {
        return { code: 0, stdout: ROOT_PANE_STDOUT, stderr: "" }
      }
      if (args[0] === "agent" && args[1] === "get") {
        return {
          code: 0,
          stdout: agentStatusStdout(options.agentStatus ?? "working"),
          stderr: "",
        }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
  return { ctx, pi, execs, notifications }
}

function agentStarts(execs: ExecCall[]): ExecCall[] {
  return execs.filter(
    (call) =>
      call.command === "herdr" &&
      call.args[0] === "agent" &&
      call.args[1] === "start",
  )
}

function agentPrompts(execs: ExecCall[]): ExecCall[] {
  return execs.filter(
    (call) =>
      call.command === "herdr" &&
      call.args[0] === "agent" &&
      call.args[1] === "prompt",
  )
}

function handoffPathFrom(notifications: string[]): string {
  const notified = notifications.find((text) =>
    text.startsWith("Handoff opened in a new Herdr tab: "),
  )
  assert.ok(notified, "no tab handoff notification recorded")
  const match = /Herdr tab: (\S+\.md)/.exec(notified)
  assert.ok(match, `no handoff path in: ${notified}`)
  return match[1]
}

/** Force the tab backend for one test; session writes stay inside `agentDir`. */
function forceTabBackend(
  t: { after: (fn: () => void) => void },
  agentDir: string,
): void {
  const saved = {
    HERDR_ENV: process.env["HERDR_ENV"],
    HERDR_WORKSPACE_ID: process.env["HERDR_WORKSPACE_ID"],
    PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"],
  }
  process.env["HERDR_ENV"] = "1"
  process.env["HERDR_WORKSPACE_ID"] = "test-workspace"
  process.env["PI_CODING_AGENT_DIR"] = agentDir
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function clearWorkIdEnv(): void {
  delete process.env["PI_WORKID_MODE"]
  delete process.env["PI_WORKID_HOME"]
}

test("tab backend: seed is the last positional arg after `--` in the start argv", async (t) => {
  t.after(clearWorkIdEnv)
  clearWorkIdEnv()
  const agentDir = await mkdtemp(join(tmpdir(), "pi-handoff-tab-"))
  const cwd = await mkdtemp(join(tmpdir(), "pi-handoff-cwd-"))
  forceTabBackend(t, agentDir)
  const runHandoff = await loadRunHandoff()
  const { ctx, pi, execs, notifications } = makeTabHarness({ cwd })

  await runHandoff(pi, ctx, "Fix the checkout guard", "voluntary")

  const starts = agentStarts(execs)
  assert.equal(starts.length, 1, "expected exactly one herdr agent start")
  const args = starts[0].args
  assert.deepEqual(args.slice(0, 2), ["agent", "start"])
  assert.match(args[2], /^handoff-[0-9a-f]{8}$/)

  const sep = args.indexOf("--")
  assert.ok(sep > 0, "no `--` separator in the start argv")
  const [
    sessionFlag,
    sessionPath,
    nameFlag,
    nameValue,
    providerFlag,
    providerValue,
    modelFlag,
    modelValue,
    seed,
  ] = args.slice(sep + 1)
  assert.equal(sessionFlag, "--session")
  assert.match(sessionPath, /sessions\/.*\.jsonl$/)
  assert.equal(nameFlag, "--name")
  assert.equal(nameValue, "[handoff] fix-the-checkout-guard")
  assert.equal(providerFlag, "--provider")
  assert.equal(providerValue, "test-provider")
  assert.equal(modelFlag, "--model")
  assert.equal(modelValue, "test-model")

  assert.equal(args.at(-1), seed, "seed must be the final argv element")
  assert.ok(!seed.startsWith("--"), "seed must be a positional, not a flag")
  assert.equal(
    seed,
    [
      "Continue from this handoff:",
      handoffPathFrom(notifications),
      "Read the handoff, load any suggested skills, then continue the work.",
    ].join("\n\n"),
  )
  assert.equal(agentPrompts(execs).length, 0, "no herdr agent prompt call")
})

test("tab backend: work-id seed string is passed when a work-id plan commits", async (t) => {
  t.after(clearWorkIdEnv)
  const home = await mkdtemp(join(tmpdir(), "pi-handoff-home-"))
  const agentDir = await mkdtemp(join(tmpdir(), "pi-handoff-tab-"))
  const cwd = await mkdtemp(join(tmpdir(), "pi-handoff-cwd-"))
  process.env["PI_WORKID_MODE"] = "1"
  process.env["PI_WORKID_HOME"] = home
  forceTabBackend(t, agentDir)
  const runHandoff = await loadRunHandoff()
  const { ctx, pi, execs, notifications } = makeTabHarness({ cwd })

  await runHandoff(pi, ctx, "Ship the checkout fix", "voluntary")

  const starts = agentStarts(execs)
  assert.equal(starts.length, 1)
  const seed = starts[0].args.at(-1)!
  assert.ok(seed, "no seed arg recorded")
  assert.equal(
    seed,
    buildWorkIdLaunchSeed({
      workIdRef: "ship-the-checkout-fix#g1",
      handoffPath: handoffPathFrom(notifications),
    }),
  )
  assert.ok(
    seed.startsWith("You own workid ship-the-checkout-fix#g1."),
    `ownership first, got: ${seed.split("\n")[0]}`,
  )
  assert.ok(
    seed.includes(handoffPathFrom(notifications)),
    "launch seed must point at the handoff document",
  )
  assert.equal(agentPrompts(execs).length, 0, "no herdr agent prompt call")
})

test("tab backend: work-id launch seed is single-line with no double quotes", async (t) => {
  t.after(clearWorkIdEnv)
  const home = await mkdtemp(join(tmpdir(), "pi-handoff-home-"))
  const agentDir = await mkdtemp(join(tmpdir(), "pi-handoff-tab-"))
  const cwd = await mkdtemp(join(tmpdir(), "pi-handoff-cwd-"))
  process.env["PI_WORKID_MODE"] = "1"
  process.env["PI_WORKID_HOME"] = home
  forceTabBackend(t, agentDir)
  const runHandoff = await loadRunHandoff()
  const { ctx, pi, execs } = makeTabHarness({ cwd })

  // D5fix: herdr rejects any agent arg containing a newline
  // (invalid_agent_argument), and double quotes complicate shell encoding —
  // the launch seed must carry neither.
  await runHandoff(pi, ctx, "Ship the checkout fix", "voluntary")

  const starts = agentStarts(execs)
  assert.equal(starts.length, 1)
  const seed = starts[0].args.at(-1)!
  assert.ok(seed, "no seed arg recorded")
  assert.ok(
    !seed.includes("\n"),
    `launch seed must not contain a newline, got: ${JSON.stringify(seed)}`,
  )
  assert.ok(
    !seed.includes('"'),
    `launch seed must not contain a double quote, got: ${JSON.stringify(seed)}`,
  )
})

test("tab backend: engagement timeout warns once, never re-prompts or re-starts", async (t) => {
  t.after(clearWorkIdEnv)
  clearWorkIdEnv()
  const agentDir = await mkdtemp(join(tmpdir(), "pi-handoff-tab-"))
  const cwd = await mkdtemp(join(tmpdir(), "pi-handoff-cwd-"))
  forceTabBackend(t, agentDir)
  const runHandoff = await loadRunHandoff()
  const { ctx, pi, execs } = makeTabHarness({ cwd, agentStatus: "idle" })
  const errors: unknown[][] = []
  t.mock.method(console, "error", (...callArgs: unknown[]) => {
    errors.push(callArgs)
  })

  // No timer mocking: the real engagement wait (6 probes x 2s) runs to its
  // natural timeout so the test observes the same path production takes.
  await runHandoff(pi, ctx, "Fix the checkout guard", "voluntary")

  assert.equal(agentStarts(execs).length, 1, "agent must not be started twice")
  assert.equal(agentPrompts(execs).length, 0, "no re-prompt after timeout")
  const probes = execs.filter(
    (call) => call.args[0] === "agent" && call.args[1] === "get",
  )
  assert.equal(probes.length, 6, "exactly the default engagement probes")
  const warned = errors.some((call) =>
    call.some(
      (part) =>
        typeof part === "string" &&
        part.includes("seed prompt not confirmed engaged"),
    ),
  )
  assert.ok(
    warned,
    `expected the warn-only engagement message, got: ${JSON.stringify(errors)}`,
  )
})
