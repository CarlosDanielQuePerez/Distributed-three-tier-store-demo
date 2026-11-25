import { createServer } from "node:http";
import { hostname } from "node:os";
import amqp from "amqplib";
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import { createSentinel } from "redis";
import { createAmqpManager } from "../shared/amqp.js";
import { cacheTtlSeconds } from "../shared/catalog.js";
import { mariaDbConfig, mongoConfig, redisSentinelConfig, required } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { loadTopology } from "../shared/topology.js";
import { createHandlers } from "./handlers.js";
import { createWorkerMetrics, getTraceContext } from "./observability.js";

const logger = createLogger({ service: "store-worker", getTraceContext });
const node = process.env.WORKER_NODE || hostname();
const config = {
  port: Number(process.env.PORT || 8081),
  cacheTtlSeconds: cacheTtlSeconds(),
  prefetch: Number(process.env.WORKER_PREFETCH || 20),
  failureRate: Number(process.env.WORKER_FAILURE_RATE || 0),
  statsIntervalMs: Number(process.env.WORKER_STATS_INTERVAL_MS || 15_000),
};

const topology = loadTopology();
const pool = mysql.createPool({ ...mariaDbConfig(), connectionLimit: Number(process.env.DB_POOL_SIZE || 4) });
const mongo = mongoConfig();
const mongoClient = new MongoClient(mongo.url, mongo.options);
const redis = createSentinel(redisSentinelConfig());
redis.on("error", (error) => logger.error("Redis client error", { error: error.message }));
const broker = createAmqpManager({ amqp, url: required("RABBITMQ_URL"), topology, name: `store-worker@${node}`, logger });
const metrics = createWorkerMetrics();

const sampleStats = async () => {
  for (const queue of topology.monitoredQueues) {
    try {
      metrics.snapshot.queues.set(queue, await broker.checkQueue(queue));
    } catch {
      // broker desconectado: se conserva el último valor
    }
  }
  try {
    const [rows] = await pool.query("SHOW STATUS LIKE 'wsrep_cluster_size'");
    metrics.snapshot.galeraClusterSize = rows[0] ? Number(rows[0].Value) : undefined;
  } catch {
    metrics.snapshot.galeraClusterSize = 0;
  }
};

const start = async () => {
  await Promise.all([mongoClient.connect(), redis.connect()]);
  const reviews = mongoClient.db(mongo.database).collection("product_reviews");
  await reviews.createIndex(
    { idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
  );

  const handlers = createHandlers({ broker, topology, reviews, redis, pool, logger, metrics, config });
  await broker.consume("reviews.created", handlers.onReviewCreated, { prefetch: config.prefetch });
  await broker.consume("catalog.invalidate", handlers.onCatalogInvalidate, { prefetch: 1 });
  await broker.consume("catalog.refresh", handlers.onCatalogRefresh, { prefetch: 1 });
  await broker.connect();

  const statsTimer = setInterval(() => void sampleStats(), config.statsIntervalMs);
  void sampleStats();

  // Sondas para Kubernetes: /healthz (vivo) y /readyz (conectado a RabbitMQ).
  const server = createServer((request, response) => {
    const ready = broker.isReady();
    const status = request.url === "/readyz" ? (ready ? 200 : 503) : request.url === "/healthz" ? 200 : 404;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: status === 200 ? "ok" : "unavailable", rabbitmq: ready, node }));
  });
  server.listen(config.port, "0.0.0.0", () => logger.info("Store worker started", { node, port: config.port }));

  const shutdown = (signal) => {
    logger.info("Shutting down worker", { signal });
    clearInterval(statsTimer);
    server.close();
    // Cerrar el broker primero: los mensajes sin ack vuelven a la cola para otro worker.
    void broker
      .close()
      .then(() => Promise.allSettled([pool.end(), mongoClient.close(), redis.close?.() ?? redis.destroy()]))
      .then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

start().catch((error) => {
  logger.error("Worker startup failed", { error: error.message });
  process.exitCode = 1;
});
