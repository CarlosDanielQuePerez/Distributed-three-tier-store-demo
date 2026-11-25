import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  CHEAPEST_CACHE_KEY,
  CHEAPEST_QUERY,
  CHEAPEST_REFRESH_LOCK,
  deleteCatalogKeys,
} from "../shared/catalog.js";
import {
  ValidationError,
  buildCatalogChanged,
  buildCatalogRefresh,
  buildReviewCreated,
  isValidIdempotencyKey,
  isValidSku,
  validateReviewInput,
} from "../shared/messages.js";

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)),
  ]);

const readJsonBody = async (request, limit = 16_384) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
};

const requireJson = (request) => {
  if (!request.headers["content-type"]?.includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
};

const noopMetrics = { cache: () => {}, review: () => {}, catalogChange: () => {} };

/**
 * Crea el manejador HTTP de la API. Todas las dependencias se inyectan para poder
 * probarlo con dobles (ver test/app.test.js).
 *
 * deps.broker es opcional: sin RabbitMQ la API vuelve al comportamiento síncrono.
 */
export const createApp = ({
  pool,
  mongoDb,
  reviews,
  redis,
  broker = null,
  logger,
  metrics = noopMetrics,
  getTraceId = () => undefined,
  config,
}) => {
  const state = { shuttingDown: false };
  const brokerReady = () => Boolean(broker?.isReady());

  const sendJson = (request, response, statusCode, payload, hops) => {
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-served-by": config.node,
    };
    const traceId = getTraceId();
    if (traceId) headers["x-trace-id"] = traceId;
    if (config.legacyTraceHeader && hops) {
      headers["x-request-trace"] = [
        request.headers["x-presentation-lb"] || "presentation-lb-unknown",
        request.headers["x-web-node"] || "web-node-unknown",
        request.headers["x-application-lb"] || "application-lb-unknown",
        config.node,
        ...hops,
      ].join(" -> ");
    }
    response.writeHead(statusCode, headers);
    response.end(JSON.stringify(payload));
  };

  const requireAdmin = (request) => {
    if (!config.adminToken) throw new HttpError(403, "Admin API is disabled (set API_ADMIN_TOKEN)");
    const header = request.headers.authorization || "";
    const supplied = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    const expected = Buffer.from(config.adminToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new HttpError(401, "Missing or invalid bearer token");
    }
  };

  const waitForCache = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(config.refreshPollMs);
      const value = await redis.get(CHEAPEST_CACHE_KEY);
      if (value) return value;
    }
    return null;
  };

  /**
   * Lectura del catálogo con protección contra estampida (ToDo 4 / plan, caso de uso 3):
   * 1. Cache hit → responde.
   * 2. Cache miss → un solo pod gana el candado en Redis y publica catalog.refresh;
   *    un único worker (single active consumer) repuebla la caché. El resto espera.
   * 3. Si el worker no llega a tiempo (o no hay broker) se lee MariaDB y se escribe
   *    la caché con NX para no pisar lo que haya dejado el worker.
   */
  const loadCheapest = async (hops) => {
    const cached = await redis.get(CHEAPEST_CACHE_KEY);
    if (cached) {
      metrics.cache("hit");
      hops.push("redis (cache hit)");
      return JSON.parse(cached);
    }
    hops.push("redis (cache miss)");

    if (brokerReady()) {
      const acquired = await redis.set(CHEAPEST_REFRESH_LOCK, config.node, { NX: true, PX: config.refreshLockMs });
      if (acquired) {
        try {
          await broker.publish(
            "store.events",
            "catalog.refresh",
            buildCatalogRefresh({ cacheKey: CHEAPEST_CACHE_KEY, reason: "cache-miss" }),
            { type: "catalog.refresh" },
          );
          hops.push("rabbitmq (catalog.refresh)");
        } catch (error) {
          await redis.del(CHEAPEST_REFRESH_LOCK);
          logger.warn("Could not publish catalog.refresh", { error: error.message });
        }
      } else {
        hops.push("redis (refresh already in progress)");
      }
      const filled = await waitForCache(config.refreshWaitMs);
      if (filled) {
        metrics.cache("worker_fill");
        hops.push("redis (filled by worker)");
        return JSON.parse(filled);
      }
    }

    hops.push("mariadb (db proxy)");
    const [products] = await pool.execute(CHEAPEST_QUERY);
    await redis.set(CHEAPEST_CACHE_KEY, JSON.stringify(products), { EX: config.cacheTtlSeconds, NX: true });
    hops.push("redis (cache write)");
    metrics.cache(brokerReady() ? "db_fallback" : "miss");
    return products;
  };

  const checks = async () => {
    const run = async (name, fn) => {
      try {
        await withTimeout(fn(), config.readinessTimeoutMs, name);
        return [name, "ok"];
      } catch (error) {
        return [name, `error: ${error.message}`];
      }
    };
    const results = Object.fromEntries(
      await Promise.all([
        run("mariadb", () => pool.query("SELECT 1")),
        run("mongodb", () => mongoDb.command({ ping: 1 })),
        run("redis", () => redis.get("store:health-probe")),
      ]),
    );
    if (broker) results.rabbitmq = brokerReady() ? "ok" : "error: not connected";
    // RabbitMQ caído no saca a la API de servicio si hay modo síncrono de respaldo.
    const fatal = Object.entries(results).filter(
      ([name, status]) => status !== "ok" && !(name === "rabbitmq" && config.syncFallback),
    );
    return { ready: fatal.length === 0 && !state.shuttingDown, results };
  };

  const routes = async (request, response, pathname, hops) => {
    if (request.method === "GET" && pathname === "/healthz") {
      sendJson(request, response, 200, { status: "alive" });
      return;
    }

    if (request.method === "GET" && (pathname === "/readyz" || pathname === "/health")) {
      const { ready, results } = await checks();
      sendJson(request, response, ready ? 200 : 503, { status: ready ? "ok" : "unavailable", checks: results }, [
        ...hops,
        "mariadb",
        "mongodb",
        "redis",
        ...(broker ? ["rabbitmq"] : []),
      ]);
      return;
    }

    if (request.method === "GET" && pathname === "/") {
      sendJson(
        request,
        response,
        200,
        {
          service: "store-catalog-api",
          version: config.version,
          products: "/products/cheapest",
          reviews: "/products/{sku}/reviews",
          health: { liveness: "/healthz", readiness: "/readyz" },
          queue: broker ? (brokerReady() ? "connected" : "disconnected") : "disabled",
        },
        hops,
      );
      return;
    }

    if (request.method === "GET" && pathname === "/products/cheapest") {
      const products = await loadCheapest(hops);
      sendJson(request, response, 200, products, hops);
      return;
    }

    if (request.method === "POST" && pathname === "/cache/clear") {
      const removed = await deleteCatalogKeys(redis);
      sendJson(
        request,
        response,
        200,
        { cacheKey: CHEAPEST_CACHE_KEY, cacheEntryRemoved: removed > 0, keysRemoved: removed },
        [...hops, "redis (delete catalog keys)"],
      );
      return;
    }

    const priceMatch = pathname.match(/^\/products\/([A-Za-z0-9-]+)\/price$/);
    if (priceMatch && request.method === "PUT") {
      requireAdmin(request);
      requireJson(request);
      const sku = priceMatch[1];
      const body = await readJsonBody(request);
      const price = Number(body?.price);
      if (!Number.isFinite(price) || price < 0 || price > 100_000 || Math.abs(Math.round(price * 100) - price * 100) > 1e-6) {
        throw new HttpError(400, "price must be a number between 0 and 100000 with at most 2 decimals");
      }
      hops.push("mariadb (update price)");
      const [result] = await pool.execute("UPDATE products SET price = ? WHERE sku = ?", [price, sku]);
      if (result.affectedRows === 0) throw new HttpError(404, "Product not found");
      let invalidation = "direct";
      if (brokerReady()) {
        try {
          await broker.publish("store.events", "catalog.changed", buildCatalogChanged({ sku, price }), {
            type: "catalog.changed",
          });
          invalidation = "queued";
          hops.push("rabbitmq (catalog.changed)");
        } catch (error) {
          logger.warn("Could not publish catalog.changed; invalidating directly", { error: error.message });
        }
      }
      if (invalidation === "direct") {
        await deleteCatalogKeys(redis);
        hops.push("redis (delete catalog keys)");
      }
      metrics.catalogChange(invalidation);
      sendJson(request, response, 200, { sku, price, cacheInvalidation: invalidation }, hops);
      return;
    }

    const reviewMatch = pathname.match(/^\/products\/([A-Za-z0-9-]+)\/reviews$/);
    if (reviewMatch && request.method === "GET") {
      const sku = reviewMatch[1];
      const productReviews = await reviews
        .find({ sku })
        .sort({ createdAt: -1 })
        .limit(50)
        .project({ _id: 0, reviewer: 1, rating: 1, comment: 1, createdAt: 1 })
        .toArray();
      sendJson(request, response, 200, { sku, reviews: productReviews }, [...hops, "mongodb"]);
      return;
    }

    if (reviewMatch && request.method === "POST") {
      requireJson(request);
      const sku = reviewMatch[1];
      if (!isValidSku(sku)) throw new HttpError(400, "Invalid sku");
      const idempotencyKey = request.headers["idempotency-key"] || randomUUID();
      if (!isValidIdempotencyKey(idempotencyKey)) {
        throw new HttpError(400, "Idempotency-Key must be 8-128 characters of [A-Za-z0-9._:-]");
      }
      const input = validateReviewInput(await readJsonBody(request));

      hops.push("mariadb (product lookup)");
      const [matches] = await pool.execute("SELECT 1 FROM products WHERE sku = ? LIMIT 1", [sku]);
      if (matches.length === 0) throw new HttpError(404, "Product not found");

      if (brokerReady()) {
        try {
          await broker.publish("store.events", "reviews.created", buildReviewCreated({ idempotencyKey, sku, ...input }), {
            messageId: idempotencyKey,
            type: "review.created",
          });
          metrics.review("queued");
          sendJson(request, response, 202, { status: "accepted", idempotencyKey, sku }, [
            ...hops,
            "rabbitmq (reviews.created)",
          ]);
          return;
        } catch (error) {
          if (!config.syncFallback) throw error;
          logger.warn("Could not publish reviews.created; writing directly", { error: error.message });
        }
      } else if (broker && !config.syncFallback) {
        throw new HttpError(503, "Review queue is unavailable");
      }

      const review = { idempotencyKey, sku, ...input, createdAt: new Date() };
      try {
        await reviews.insertOne(review);
      } catch (error) {
        if (error?.code !== 11000) throw error; // 11000 = misma Idempotency-Key: ya estaba guardada
      }
      metrics.review("direct");
      sendJson(request, response, 201, { status: "stored", ...review }, [...hops, "mongodb (insert review)"]);
      return;
    }

    sendJson(request, response, 404, { error: "Not found" }, hops);
  };

  const handler = (request, response) => {
    const hops = [];
    const pathname = new URL(request.url, "http://localhost").pathname;
    routes(request, response, pathname, hops).catch((error) => {
      const known = error instanceof HttpError || error instanceof ValidationError;
      if (!known) logger.error("Request failed", { method: request.method, path: pathname, error: error.message });
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const statusCode = error instanceof HttpError ? error.statusCode : error instanceof ValidationError ? 400 : 503;
      sendJson(
        request,
        response,
        statusCode,
        { error: known ? error.message : "Service temporarily unavailable" },
        hops,
      );
    });
  };

  return { handler, state, checks };
};
