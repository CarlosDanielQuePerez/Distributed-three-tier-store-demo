import { metrics, trace } from "@opentelemetry/api";

export const getTraceContext = () => {
  const context = trace.getActiveSpan()?.spanContext();
  return context ? { trace_id: context.traceId, span_id: context.spanId } : {};
};

/**
 * Métricas del worker. queueStats y galeraClusterSize se actualizan con un muestreo
 * periódico y se exportan como gauges observables:
 *   store_queue_messages / store_queue_consumers  (profundidad y "consumer lag")
 *   store_galera_cluster_size                     (salud de Galera)
 */
export const createWorkerMetrics = () => {
  const meter = metrics.getMeter("store-worker");
  const processed = meter.createCounter("store.messages.processed", {
    description: "Mensajes procesados por cola y resultado",
  });
  const snapshot = { queues: new Map(), galeraClusterSize: undefined };

  meter
    .createObservableGauge("store.queue.messages", { description: "Mensajes listos en la cola" })
    .addCallback((result) => {
      for (const [queue, stats] of snapshot.queues) result.observe(stats.messageCount, { queue });
    });
  meter
    .createObservableGauge("store.queue.consumers", { description: "Consumidores conectados a la cola" })
    .addCallback((result) => {
      for (const [queue, stats] of snapshot.queues) result.observe(stats.consumerCount, { queue });
    });
  meter
    .createObservableGauge("store.galera.cluster_size", { description: "wsrep_cluster_size visto por el worker" })
    .addCallback((result) => {
      if (snapshot.galeraClusterSize !== undefined) result.observe(snapshot.galeraClusterSize);
    });

  return {
    snapshot,
    message: (queue, outcome) => processed.add(1, { queue, outcome }),
  };
};
