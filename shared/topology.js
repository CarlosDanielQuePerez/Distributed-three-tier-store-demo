import { readFileSync } from "node:fs";

export const defaultTopologyPath = new URL("../messaging/topology.json", import.meta.url);

export const loadTopology = (path = process.env.MESSAGING_TOPOLOGY_PATH || defaultTopologyPath) =>
  JSON.parse(readFileSync(path, "utf8"));

/** Declara exchanges, colas y bindings. Es idempotente si los argumentos no cambian. */
export const assertTopology = async (channel, topology) => {
  for (const exchange of topology.exchanges) {
    await channel.assertExchange(exchange.name, exchange.type, {
      durable: exchange.durable ?? true,
      arguments: exchange.arguments,
    });
  }
  for (const queue of topology.queues) {
    await channel.assertQueue(queue.name, { durable: true, arguments: queue.arguments });
  }
  for (const binding of topology.bindings) {
    await channel.bindQueue(binding.queue, binding.exchange, binding.routingKey);
  }
};

/**
 * Decide a dónde va un mensaje que falló: el siguiente nivel de reintento o la DLQ.
 * attempt = número de reintentos ya hechos (header x-attempt, 0 en la primera entrega).
 */
export const nextRetryTarget = (topology, queueName, attempt) => {
  const policy = topology.retry?.[queueName];
  if (!policy) return null;
  if (attempt < policy.tiers.length) {
    return { exchange: policy.exchange, routingKey: policy.tiers[attempt], attempt: attempt + 1, deadLetter: false };
  }
  return { ...policy.deadLetter, attempt, deadLetter: true };
};
