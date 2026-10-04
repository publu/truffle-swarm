import test from "node:test";
import assert from "node:assert/strict";
import { waitForInbox, liveInboxUrl } from "../plugins/truffle-swarm/lib/inbox.mjs";
import { SwarmError } from "../plugins/truffle-swarm/lib/errors.mjs";
import { startSwarm } from "./helpers/swarm-server.mjs";

test("the live url is derived from the api base", () => {
  assert.equal(liveInboxUrl("https://host/api/w/product"), "wss://host/api/w/product/live?inbox=1");
  assert.equal(liveInboxUrl("http://127.0.0.1:1/api/w/dev"), "ws://127.0.0.1:1/api/w/dev/live?inbox=1");
});

test("an event already waiting is returned without any notification", async () => {
  const swarm = await startSwarm();
  try {
    const result = await waitForInbox({
      url: liveInboxUrl(swarm.api),
      token: swarm.token,
      timeoutMs: 5000,
      readInbox: async () => ({ events: [{ id: 1, actor: "agent-lead" }], cursor: 1 }),
    });
    assert.equal(result.events.length, 1);
  } finally {
    await swarm.close();
  }
});

test("a notification triggers a fresh durable read", async () => {
  const swarm = await startSwarm();
  let pending = [];
  let reads = 0;
  try {
    const waiting = waitForInbox({
      url: liveInboxUrl(swarm.api),
      token: swarm.token,
      timeoutMs: 8000,
      readInbox: async () => {
        reads++;
        return { events: pending, cursor: pending.length };
      },
    });
    // Let the first (empty) read settle, then deliver work and nudge the socket.
    await new Promise((done) => setTimeout(done, 200));
    pending = [{ id: 7, actor: "agent-lead" }];
    swarm.notify();
    const result = await waiting;
    assert.deepEqual(result.events, [{ id: 7, actor: "agent-lead" }]);
    assert.ok(reads >= 2, `expected a second read, saw ${reads}`);
  } finally {
    await swarm.close();
  }
});

test("the last empty read is returned when a healthy connection times out", async () => {
  const swarm = await startSwarm();
  try {
    const result = await waitForInbox({
      url: liveInboxUrl(swarm.api),
      token: swarm.token,
      timeoutMs: 700,
      readInbox: async () => ({ events: [], cursor: 3 }),
    });
    assert.deepEqual(result, { events: [], cursor: 3 });
  } finally {
    await swarm.close();
  }
});

test("a rejected identity stops the wait instead of retrying forever", async () => {
  const swarm = await startSwarm();
  try {
    await assert.rejects(
      () =>
        waitForInbox({
          url: liveInboxUrl(swarm.api),
          token: swarm.token,
          timeoutMs: 5000,
          readInbox: async () => {
            throw new SwarmError("401: Unauthorized", 401);
          },
        }),
      /Unauthorized/,
    );
  } finally {
    await swarm.close();
  }
});

test("an unreachable swarm times out with advice rather than hanging", async () => {
  await assert.rejects(
    () =>
      waitForInbox({
        url: "ws://127.0.0.1:1/api/w/dev/live?inbox=1",
        token: "t",
        timeoutMs: 600,
        retryBaseMs: 50,
        readInbox: async () => ({ events: [] }),
      }),
    /No live inbox connection was established/,
  );
});

test("a socket rejecting the credential never leaks it into the error", async () => {
  const swarm = await startSwarm({ token: "right-token" });
  try {
    await assert.rejects(
      () =>
        waitForInbox({
          url: liveInboxUrl(swarm.api),
          token: "wrong-token",
          timeoutMs: 600,
          retryBaseMs: 50,
          readInbox: async () => ({ events: [] }),
        }),
      (error) => {
        assert.ok(!error.message.includes("wrong-token"));
        return true;
      },
    );
  } finally {
    await swarm.close();
  }
});
