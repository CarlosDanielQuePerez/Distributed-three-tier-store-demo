import assert from "node:assert/strict";
import { test } from "node:test";
import { CHEAPEST_CACHE_KEY, CHEAPEST_REFRESH_LOCK } from "../../shared/catalog.js";
import { buildCatalogChanged, buildCatalogRefresh, buildReviewCreated } from "../../shared/messages.js";
import { createFakeBroker, createFakeChannel, createFakeCollection, createFakeRedis, silentLogger } from "../../shared/testing/fakes.js";
import { loadTopology } from "../../shared/topology.js";
import { createHandlers } from "../handlers.js";

const topology = loadTopology();
const products = [{ id: 1, sku: "ST-001", price: "3.49" }];

const setup = (overrides = {}) => {
  const deps = {
    broker: createFakeBroker(),
    topology,
    reviews: createFakeCollection(),
    redis: createFakeRedis(),
    pool: { execute: async () => [products] },
    logger: silentLogger,
    metrics: { outcomes: [], message(queue, outcome) { this.outcomes.push(`${queue}:${outcome}`); } },
    config: { cacheTtlSeconds: 60, failureRate: 0 },
    ...overrides,
  };
  return { deps, handlers: createHandlers(deps), channel: createFakeChannel() };
};

const amqpMessage = (payload, headers = {}, redelivered = false) => ({
  content: Buffer.from(JSON.stringify(payload)),
  properties: { messageId: payload.idempotencyKey, type: payload.type, headers },
  fields: { redelivered },
});

const review = buildReviewCreated({ idempotencyKey: "key-00000001", sku: "ST-001", reviewer: "A", rating: 5, comment: "ok" });

test("reviews.created se guarda y se confirma (ack)", async () => {
  const { deps, handlers, channel } = setup();
  await handlers.onReviewCreated(amqpMessage(review), channel);
  assert.equal(deps.reviews.documents.length, 1);
  assert.equal(channel.calls[0][0], "ack");
});

test("entrega duplicada: no inserta dos veces y confirma", async () => {
  const { deps, handlers, channel } = setup();
  await handlers.onReviewCreated(amqpMessage(review), channel);
  await handlers.onReviewCreated(amqpMessage(review, {}, true), channel);
  assert.equal(deps.reviews.documents.length, 1);
  assert.deepEqual(channel.calls.map((c) => c[0]), ["ack", "ack"]);
  assert.ok(deps.metrics.outcomes.includes("reviews.created:duplicate"));
});

test("fallo de MongoDB: reintento 1s → 5s → 30s → DLQ", async () => {
  const { deps, handlers, channel } = setup({ reviews: createFakeCollection({ failWith: new Error("not primary") }) });
  for (const attempt of [0, 1, 2, 3]) {
    await handlers.onReviewCreated(amqpMessage(review, attempt ? { "x-attempt": attempt } : {}), channel);
  }
  assert.deepEqual(
    deps.broker.published.map((p) => p.routingKey),
    ["reviews.retry.1s", "reviews.retry.5s", "reviews.retry.30s", "reviews.dlq"],
  );
  assert.deepEqual(deps.broker.published.map((p) => p.options.headers["x-attempt"]), [1, 2, 3, 3]);
  assert.equal(deps.broker.published[0].options.messageId, "key-00000001");
  assert.ok(channel.calls.every((c) => c[0] === "ack"), "el original se confirma tras republicar");
});

test("mensaje inválido va directo a la DLX (nack sin requeue)", async () => {
  const { handlers, channel } = setup();
  await handlers.onReviewCreated(amqpMessage({ type: "review.created", version: 1 }), channel);
  assert.deepEqual(channel.calls[0].slice(0, 1).concat(channel.calls[0][2]), ["nack", false]);
});

test("catalog.changed borra llaves del catálogo y pide refresh", async () => {
  const { deps, handlers, channel } = setup();
  await deps.redis.set(CHEAPEST_CACHE_KEY, "[]");
  await handlers.onCatalogInvalidate(amqpMessage(buildCatalogChanged({ sku: "ST-001", price: 2 })), channel);
  assert.equal(deps.redis.data.has(CHEAPEST_CACHE_KEY), false);
  assert.equal(deps.broker.published[0].routingKey, "catalog.refresh");
  assert.equal(channel.calls[0][0], "ack");
});

test("catalog.refresh repuebla la caché y libera el candado", async () => {
  const { deps, handlers, channel } = setup();
  await deps.redis.set(CHEAPEST_REFRESH_LOCK, "app1");
  await handlers.onCatalogRefresh(amqpMessage(buildCatalogRefresh({ cacheKey: CHEAPEST_CACHE_KEY, reason: "cache-miss" })), channel);
  assert.deepEqual(JSON.parse(deps.redis.data.get(CHEAPEST_CACHE_KEY)), products);
  assert.equal(deps.redis.data.has(CHEAPEST_REFRESH_LOCK), false);
  assert.equal(channel.calls[0][0], "ack");
});

test("catalog.refresh con MariaDB caída: nack y libera el candado", async () => {
  const { deps, handlers, channel } = setup({ pool: { execute: async () => { throw new Error("db down"); } } });
  await deps.redis.set(CHEAPEST_REFRESH_LOCK, "app1");
  await handlers.onCatalogRefresh(amqpMessage(buildCatalogRefresh({ cacheKey: CHEAPEST_CACHE_KEY, reason: "cache-miss" })), channel);
  assert.equal(channel.calls[0][0], "nack");
  assert.equal(deps.redis.data.has(CHEAPEST_REFRESH_LOCK), false);
});
