import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForEngagement } from "../src/herdr-prompt.ts";

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
