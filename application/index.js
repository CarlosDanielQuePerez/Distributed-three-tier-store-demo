import { createServer } from "node:http";
import { hostname } from "node:os";
import amqp from "amqplib";
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import { createSentinel } from "redis";
import { createAmqpManager } from "../shared/amqp.js";
import { cacheTtlSeconds } from "../shared/catalog.js";
import { bool, mariaDbConfig, mongoConfig, optional, redisSentinelConfig } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { loadTopology } from "../shared/topology.js";
import { createApp } from "./app.js";
import { createApiMetrics, getTraceContext, getTraceId } from "./observability.js";

const logger = createLogger({ service: "store-api", getTraceContext });

const config = {
  port: Number(process.env.PORT || 8080),
  node: optional("APPLICATION_NODE", hostname()),
  version: optional("APP_VERSION", "dev"),
  adminToken: optional("API_ADMIN_TOKEN"),
  cacheTtlSeconds: cacheTtlSeconds(),
  refreshLockMs: Number(process.env.CACHE_REFRESH_LOCK_MS || 5000),
  refreshWaitMs: Number(process.env.CACHE_REFRESH_WAIT_MS || 1500),
  refreshPollMs: Number(process.env.CACHE_REFRESH_POLL_MS || 50),
  readinessTimeoutMs: Number(process.env.READINESS_TIMEOUT_MS || 2000),
  syncFallback: bool("REVIEWS_SYNC_FALLBACK", true),
  legacyTraceHeader: bool("LEGACY_TRACE_HEADER", false),
  shutdownGraceMs: Number(process.env.SHUTDOWN_GRACE_MS || 5000),
};

const pool = mysql.createPool(mariaDbConfig());
const mongo = mongoConfig();
const mongoClient = new MongoClient(mongo.url, mongo.options);
const redis = createSentinel(redisSentinelConfig());
redis.on("error", (error) => logger.error("Redis client error", { error: error.message }));

const rabbitUrl = optional("RABBITMQ_URL");
const broker = rabbitUrl
  ? createAmqpManager({ amqp, url: rabbitUrl, topology: loadTopology(), name: `store-api@${config.node}`, logger })
  : null;

const start = async () => {
  await Promise.all([mongoClient.connect(), redis.connect()]);
  if (broker) {
    // No bloquea el arranque: la API funciona en modo síncrono hasta que RabbitMQ conecte.
    void broker.connect();
  } else {
    logger.warn("RABBITMQ_URL not set: reviews and cache refresh run synchronously");
  }

  const mongoDb = mongoClient.db(mongo.database);
  const app = createApp({
    pool,
    mongoDb,
    reviews: mongoDb.collection("product_reviews"),
    redis,
    broker,
    logger,
    metrics: createApiMetrics(),
    getTraceId,
    config,
  });

  const server = createServer(app.handler);
  server.keepAliveTimeout = 65_000;
  server.listen(config.port, "0.0.0.0", () => {
    logger.info("Store catalog API listening", { port: config.port, node: config.node, queue: Boolean(broker) });
  });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    // 1) readyz pasa a 503 para que el Service deje de enviar tráfico,
    // 2) se espera a que el endpoint se retire, 3) se cierran conexiones.
    app.state.shuttingDown = true;
    logger.info("Shutting down", { signal });
    setTimeout(() => {
      server.close(() => {
        void Promise.allSettled([pool.end(), mongoClient.close(), redis.close?.() ?? redis.destroy(), broker?.close()]).then(
          () => process.exit(0),
        );
      });
      server.closeIdleConnections?.();
    }, config.shutdownGraceMs).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

start().catch((error) => {
  logger.error("Application startup failed", { error: error.message });
  process.exitCode = 1;
});
