import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { assertTopology, loadTopology, nextRetryTarget } from "../topology.js";

const topology = loadTopology();
const queues = new Set(topology.queues.map((q) => q.name));
const exchanges = new Set(topology.exchanges.map((e) => e.name));

test("cada binding apunta a colas y exchanges declarados", () => {
  for (const binding of topology.bindings) {
    assert.ok(queues.has(binding.queue), binding.queue);
    assert.ok(exchanges.has(binding.exchange), binding.exchange);
  }
});

test("las colas de datos son quorum (HA en 3 réplicas)", () => {
  for (const queue of topology.queues) assert.equal(queue.arguments["x-queue-type"], "quorum", queue.name);
});

test("los niveles de reintento existen y regresan a la cola original", () => {
  const policy = topology.retry["reviews.created"];
  for (const tier of policy.tiers) {
    const queue = topology.queues.find((q) => q.name === tier);
    assert.ok(queue, tier);
    assert.equal(queue.arguments["x-dead-letter-exchange"], "store.events");
    assert.equal(queue.arguments["x-dead-letter-routing-key"], "reviews.created");
  }
  assert.ok(queues.has(policy.deadLetter.routingKey));
});

test("nextRetryTarget: 1s, 5s, 30s y luego DLQ", () => {
  const targets = [0, 1, 2, 3].map((attempt) => nextRetryTarget(topology, "reviews.created", attempt));
  assert.deepEqual(targets.map((t) => t.routingKey), ["reviews.retry.1s", "reviews.retry.5s", "reviews.retry.30s", "reviews.dlq"]);
  assert.deepEqual(targets.map((t) => t.deadLetter), [false, false, false, true]);
  assert.equal(nextRetryTarget(topology, "catalog.refresh", 0), null);
});

test("assertTopology declara todo en orden", async () => {
  const calls = [];
  const channel = {
    assertExchange: async (name) => calls.push(["exchange", name]),
    assertQueue: async (name) => calls.push(["queue", name]),
    bindQueue: async (queue) => calls.push(["bind", queue]),
  };
  await assertTopology(channel, topology);
  assert.equal(calls.filter((c) => c[0] === "exchange").length, topology.exchanges.length);
  assert.equal(calls.filter((c) => c[0] === "bind").length, topology.bindings.length);
  assert.equal(calls.at(-1)[0], "bind");
});

test("existe un JSON Schema por cada tipo de mensaje", () => {
  const dir = new URL("../../messaging/schemas/", import.meta.url);
  const ids = readdirSync(dir).map((file) => JSON.parse(readFileSync(new URL(file, dir), "utf8")).$id);
  assert.deepEqual(ids.sort(), ["store/catalog.changed/v1", "store/catalog.refresh/v1", "store/review.created/v1"]);
});
