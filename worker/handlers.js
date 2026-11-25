import {
  CHEAPEST_CACHE_KEY,
  CHEAPEST_QUERY,
  CHEAPEST_REFRESH_LOCK,
  deleteCatalogKeys,
} from "../shared/catalog.js";
import {
  ValidationError,
  buildCatalogRefresh,
  parseCatalogChanged,
  parseCatalogRefresh,
  parseReviewCreated,
} from "../shared/messages.js";
import { nextRetryTarget } from "../shared/topology.js";

const decode = (message) => JSON.parse(message.content.toString("utf8"));

/**
 * Manejadores de los tres casos de uso de colas del plan:
 *  1. reviews.created   → persistir en MongoDB (idempotente, reintentos con backoff, DLQ)
 *  2. catalog.invalidate → borrar llaves store:products:* y pedir un refresh
 *  3. catalog.refresh   → un solo consumidor activo repuebla la caché desde MariaDB
 */
export const createHandlers = ({ broker, topology, reviews, redis, pool, logger, metrics, config }) => {
  /** Reintento con backoff por niveles (1s, 5s, 30s) y DLQ al agotarse. */
  const retryOrDeadLetter = async (message, channel, queue, error) => {
    const attempt = Number(message.properties.headers?.["x-attempt"] ?? 0);
    const target = nextRetryTarget(topology, queue, attempt);
    if (!target) {
      channel.nack(message, false, false);
      return;
    }
    await broker.publish(target.exchange, target.routingKey, decode(message), {
      messageId: message.properties.messageId,
      type: message.properties.type,
      headers: {
        ...message.properties.headers,
        "x-attempt": target.attempt,
        "x-last-error": String(error.message).slice(0, 200),
        "x-original-queue": queue,
      },
    });
    channel.ack(message);
    metrics.message(queue, target.deadLetter ? "dead_lettered" : "retried");
    logger.warn(target.deadLetter ? "Message sent to DLQ" : "Message scheduled for retry", {
      queue,
      messageId: message.properties.messageId,
      attempt: target.attempt,
      via: target.routingKey,
      error: error.message,
    });
  };

  const onReviewCreated = async (message, channel) => {
    let review;
    try {
      review = parseReviewCreated(decode(message));
    } catch (error) {
      // Mensaje malformado: no tiene sentido reintentar. nack → DLX → reviews.dlq
      logger.error("Invalid reviews.created message", { error: error.message });
      metrics.message("reviews.created", "invalid");
      channel.nack(message, false, false);
      return;
    }
    try {
      if (config.failureRate > 0 && Math.random() < config.failureRate) {
        throw new Error("Injected failure (WORKER_FAILURE_RATE)");
      }
      await reviews.insertOne({
        idempotencyKey: review.idempotencyKey,
        sku: review.sku,
        reviewer: review.reviewer,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.occurredAt,
        processedAt: new Date(),
      });
      metrics.message("reviews.created", "stored");
    } catch (error) {
      if (error?.code === 11000) {
        metrics.message("reviews.created", "duplicate"); // entrega repetida: ya estaba guardada
      } else {
        await retryOrDeadLetter(message, channel, "reviews.created", error);
        return;
      }
    }
    channel.ack(message);
  };

  const onCatalogInvalidate = async (message, channel) => {
    try {
      const change = parseCatalogChanged(decode(message));
      const removed = await deleteCatalogKeys(redis);
      await broker.publish(
        "store.events",
        "catalog.refresh",
        buildCatalogRefresh({ cacheKey: CHEAPEST_CACHE_KEY, reason: "catalog-changed" }),
        { type: "catalog.refresh" },
      );
      logger.info("Catalog cache invalidated", { sku: change.sku, keysRemoved: removed });
      metrics.message("catalog.invalidate", "processed");
      channel.ack(message);
    } catch (error) {
      metrics.message("catalog.invalidate", error instanceof ValidationError ? "invalid" : "failed");
      logger.error("Catalog invalidation failed", { error: error.message });
      // Si falla Redis se reencola una vez; la caché expira sola por TTL en el peor caso.
      channel.nack(message, false, !message.fields.redelivered && !(error instanceof ValidationError));
    }
  };

  const onCatalogRefresh = async (message, channel) => {
    try {
      const request = parseCatalogRefresh(decode(message));
      if (request.cacheKey !== CHEAPEST_CACHE_KEY) throw new ValidationError(`Unknown cache key ${request.cacheKey}`);
      const [products] = await pool.execute(CHEAPEST_QUERY);
      await redis.set(CHEAPEST_CACHE_KEY, JSON.stringify(products), { EX: config.cacheTtlSeconds });
      logger.info("Catalog cache refreshed", { reason: request.reason, products: products.length });
      metrics.message("catalog.refresh", "processed");
      channel.ack(message);
    } catch (error) {
      metrics.message("catalog.refresh", "failed");
      logger.error("Catalog refresh failed", { error: error.message });
      channel.nack(message, false, false); // la API cae a MariaDB si nadie llena la caché
    } finally {
      await redis.del(CHEAPEST_REFRESH_LOCK).catch(() => {});
    }
  };

  return { onReviewCreated, onCatalogInvalidate, onCatalogRefresh, retryOrDeadLetter };
};
