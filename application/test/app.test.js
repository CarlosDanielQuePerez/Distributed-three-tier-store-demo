import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { CHEAPEST_CACHE_KEY } from "../../shared/catalog.js";
import { createFakeBroker, createFakeCollection, createFakeRedis, silentLogger } from "../../shared/testing/fakes.js";
import { createApp } from "../app.js";

const products = [{ id: 1, sku: "ST-001", name: "Cotton Tote Bag", description: "x", price: "3.49" }];

let deps;
let server;
let baseUrl;

const makeDeps = (overrides = {}) => ({
  pool: {
    queries: [],
    async execute(sql, params) {
      this.queries.push([sql, params]);
      if (sql.startsWith("UPDATE")) return [{ affectedRows: params[1] === "ST-001" ? 1 : 0 }];
      if (sql.startsWith("SELECT 1 FROM products")) return [params[0] === "ST-001" ? [{ 1: 1 }] : []];
      return [products];
    },
    query: async () => [[{ 1: 1 }]],
  },
  mongoDb: { command: async () => ({ ok: 1 }) },
  reviews: createFakeCollection(),
  redis: createFakeRedis(),
  broker: null,
  logger: silentLogger,
  config: {
    node: "app-test",
    version: "test",
    adminToken: "s3cret-token",
    cacheTtlSeconds: 60,
    refreshLockMs: 5000,
    refreshWaitMs: 60,
    refreshPollMs: 10,
    readinessTimeoutMs: 200,
    syncFallback: true,
    legacyTraceHeader: true,
  },
  ...overrides,
});

const start = async (overrides) => {
  deps = makeDeps(overrides);
  const app = createApp(deps);
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return app;
};

const stop = () => new Promise((resolve) => (server ? server.close(resolve) : resolve()));

const postReview = (headers = {}, body = { reviewer: "Taylor", rating: 5, comment: "Great bag." }) =>
  fetch(`${baseUrl}/products/ST-001/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(stop);
after(stop);
before(() => {});

test("/healthz siempre responde 200", async () => {
  await start();
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-served-by"), "app-test");
});

test("/readyz devuelve 503 si una dependencia falla", async () => {
  await start({ mongoDb: { command: async () => { throw new Error("no primary"); } } });
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.checks.mongodb, /no primary/);
  assert.equal(body.checks.mariadb, "ok");
});

test("/readyz tolera RabbitMQ caído si hay modo síncrono", async () => {
  await start({ broker: createFakeBroker({ ready: false }) });
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  assert.match((await response.json()).checks.rabbitmq, /not connected/);
});

test("/readyz responde 503 durante el apagado", async () => {
  const app = await start();
  app.state.shuttingDown = true;
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
});

test("catálogo sin broker: miss → MariaDB → caché, luego hit", async () => {
  await start();
  const first = await fetch(`${baseUrl}/products/cheapest`);
  assert.deepEqual(await first.json(), products);
  assert.match(first.headers.get("x-request-trace"), /cache miss.*mariadb/);
  assert.ok(deps.redis.data.has(CHEAPEST_CACHE_KEY));
  const second = await fetch(`${baseUrl}/products/cheapest`);
  assert.match(second.headers.get("x-request-trace"), /cache hit/);
  assert.equal(deps.pool.queries.length, 1);
});

test("catálogo con broker: miss publica catalog.refresh una sola vez y usa lo que llena el worker", async () => {
  const broker = createFakeBroker();
  await start({ broker });
  // Simula al worker llenando la caché poco después de recibir el mensaje.
  broker.publish = async (exchange, routingKey, payload) => {
    broker.published.push({ exchange, routingKey, payload });
    setTimeout(() => void deps.redis.set(CHEAPEST_CACHE_KEY, JSON.stringify(products)), 15);
  };
  const responses = await Promise.all([1, 2, 3].map(() => fetch(`${baseUrl}/products/cheapest`)));
  for (const response of responses) assert.deepEqual(await response.json(), products);
  assert.equal(broker.published.filter((p) => p.routingKey === "catalog.refresh").length, 1);
  assert.equal(deps.pool.queries.length, 0, "ninguna petición fue a MariaDB");
});

test("catálogo con broker pero worker lento: cae a MariaDB", async () => {
  await start({ broker: createFakeBroker() });
  const response = await fetch(`${baseUrl}/products/cheapest`);
  assert.equal(response.status, 200);
  assert.equal(deps.pool.queries.length, 1);
});

test("POST reseña con broker → 202 y mensaje con idempotencia", async () => {
  const broker = createFakeBroker();
  await start({ broker });
  const response = await postReview({ "idempotency-key": "review-key-0001" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "accepted", idempotencyKey: "review-key-0001", sku: "ST-001" });
  const [message] = broker.published;
  assert.equal(message.routingKey, "reviews.created");
  assert.equal(message.options.messageId, "review-key-0001");
  assert.equal(message.payload.data.reviewer, "Taylor");
  assert.equal(deps.reviews.documents.length, 0);
});

test("POST reseña con broker caído → escritura directa 201, idempotente", async () => {
  await start({ broker: createFakeBroker({ failPublish: true }) });
  assert.equal((await postReview({ "idempotency-key": "review-key-0002" })).status, 201);
  assert.equal((await postReview({ "idempotency-key": "review-key-0002" })).status, 201);
  assert.equal(deps.reviews.documents.length, 1);
});

test("POST reseña sin modo síncrono y broker caído → 503", async () => {
  const overrides = { broker: createFakeBroker({ ready: false }) };
  await start(overrides);
  deps.config.syncFallback = false;
  assert.equal((await postReview()).status, 503);
});

test("POST reseña: validaciones", async () => {
  await start();
  assert.equal((await postReview({}, { reviewer: "", rating: 9 })).status, 400);
  assert.equal((await postReview({ "idempotency-key": "bad key!" })).status, 400);
  const notFound = await fetch(`${baseUrl}/products/ST-999/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewer: "a", rating: 3, comment: "b" }),
  });
  assert.equal(notFound.status, 404);
  const wrongType = await fetch(`${baseUrl}/products/ST-001/reviews`, { method: "POST", body: "x" });
  assert.equal(wrongType.status, 415);
});

test("PUT precio requiere token y publica catalog.changed", async () => {
  const broker = createFakeBroker();
  await start({ broker });
  const put = (token, price = 3.99, sku = "ST-001") =>
    fetch(`${baseUrl}/products/${sku}/price`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ price }),
    });
  assert.equal((await put()).status, 401);
  assert.equal((await put("wrong")).status, 401);
  assert.equal((await put("s3cret-token", 19.99)).status, 200);
  assert.equal((await put("s3cret-token", 1.234)).status, 400);
  assert.equal((await put("s3cret-token", 2, "ST-404")).status, 404);
  assert.equal(broker.published.at(-1).routingKey, "catalog.changed");
});

test("PUT precio sin broker invalida la caché directamente", async () => {
  await start();
  await deps.redis.set(CHEAPEST_CACHE_KEY, "[]");
  await deps.redis.set("unrelated:key", "1");
  const response = await fetch(`${baseUrl}/products/ST-001/price`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: "Bearer s3cret-token" },
    body: JSON.stringify({ price: 5 }),
  });
  assert.equal((await response.json()).cacheInvalidation, "direct");
  assert.equal(deps.redis.data.has(CHEAPEST_CACHE_KEY), false);
  assert.equal(deps.redis.data.has("unrelated:key"), true, "solo borra llaves del catálogo");
});

test("PUT precio deshabilitado sin API_ADMIN_TOKEN", async () => {
  await start();
  deps.config.adminToken = undefined;
  const response = await fetch(`${baseUrl}/products/ST-001/price`, { method: "PUT" });
  assert.equal(response.status, 403);
});

test("POST /cache/clear borra solo llaves store:products:*", async () => {
  await start();
  await deps.redis.set(CHEAPEST_CACHE_KEY, "[]");
  await deps.redis.set("store:health-probe", "1");
  const body = await (await fetch(`${baseUrl}/cache/clear`, { method: "POST" })).json();
  assert.equal(body.cacheEntryRemoved, true);
  assert.equal(deps.redis.data.has("store:health-probe"), true);
});

test("ruta desconocida → 404", async () => {
  await start();
  assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
});
