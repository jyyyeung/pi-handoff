import assert from "node:assert/strict";
import { test } from "node:test";
import {
  submitHerdrPrompt,
  waitForEngagement,
  type HerdrCommandResult,
} from "../src/herdr-prompt.ts";

const OK: HerdrCommandResult = { code: 0, stdout: "", stderr: "" };
const REJECTED: HerdrCommandResult = {
  code: 1,
  stdout: "",
  stderr: "error: agent_blocked",
};

function neverEngaged(): () => Promise<boolean> {
  return async () => false;
}

test("waitForEngagement: returns true on the first engaged probe", async () => {
  let probes = 0;
  const engaged = await waitForEngagement(
    async () => {
      probes += 1;
      return true;
    },
    3,
    1,
  );
  assert.equal(engaged, true);
  assert.equal(probes, 1);
});

test("waitForEngagement: exhausts probes when never engaged", async () => {
  let probes = 0;
  const engaged = await waitForEngagement(
    async () => {
      probes += 1;
      return false;
    },
    3,
    1,
  );
  assert.equal(engaged, false);
  assert.equal(probes, 3);
});

test("submit: single successful submission, no engagement probing", async () => {
  let submissions = 0;
  let probes = 0;
  await submitHerdrPrompt(
    async () => {
      submissions += 1;
      return OK;
    },
    async () => {
      probes += 1;
      return true;
    },
    2,
    1,
  );
  assert.equal(submissions, 1);
  assert.equal(probes, 0);
});

test("submit: stalled first submission that engaged is not re-sent", async () => {
  // Regression: the 2026-11 double-delivery bug. A nonzero first submission
  // whose agent then engages must never produce a second identical prompt.
  let submissions = 0;
  let probes = 0;
  await submitHerdrPrompt(
    async () => {
      submissions += 1;
      return REJECTED;
    },
    async () => {
      probes += 1;
      return probes >= 2;
    },
    3,
    1,
  );
  assert.equal(submissions, 1);
  assert.equal(probes, 2);
});

test("submit: rejected submission with no engagement retries once, then throws", async () => {
  let submissions = 0;
  await assert.rejects(
    submitHerdrPrompt(
      async () => {
        submissions += 1;
        return REJECTED;
      },
      neverEngaged(),
      1,
      1,
    ),
    /Could not deliver the handoff prompt: error: agent_blocked/,
  );
  assert.equal(submissions, 2);
});

test("submit: second attempt succeeding ends the loop without probing", async () => {
  let submissions = 0;
  let probes = 0;
  await submitHerdrPrompt(
    async () => {
      submissions += 1;
      return submissions === 1 ? REJECTED : OK;
    },
    async () => {
      probes += 1;
      return false;
    },
    1,
    1,
  );
  assert.equal(submissions, 2);
  assert.equal(probes, 1);
});
