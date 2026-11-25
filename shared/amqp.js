import { assertTopology } from "./topology.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Conexión a RabbitMQ con reconexión automática.
 * - Un ConfirmChannel para publicar (publish() resuelve cuando el broker confirma).
 * - Cada consumidor registrado con consume() recibe su propio canal y se vuelve a
 *   registrar tras una reconexión.
 * `amqp` es el módulo amqplib inyectado por el servicio.
 */
export const createAmqpManager = ({ amqp, url, topology, name, logger }) => {
  let connection;
  let publishChannel;
  let closed = false;
  let connecting;
  const consumers = [];

  const setupConsumer = async ({ queue, prefetch, handler }) => {
    const channel = await connection.createChannel();
    await channel.prefetch(prefetch);
    await channel.consume(queue, (message) => {
      if (message === null) return; // la cola fue borrada o el canal se canceló
      void handler(message, channel, api).catch((error) => {
        logger.error("Unhandled consumer error", { queue, error: error.message });
        try {
          channel.nack(message, false, false);
        } catch {
          // el canal ya está cerrado; RabbitMQ reentregará el mensaje
        }
      });
    });
  };

  const connectOnce = async () => {
    connection = await amqp.connect(url, { clientProperties: { connection_name: name } });
    connection.on("error", (error) => logger.error("RabbitMQ connection error", { error: error.message }));
    connection.on("close", () => {
      publishChannel = undefined;
      connection = undefined;
      if (!closed) {
        logger.warn("RabbitMQ connection closed; reconnecting");
        void connect();
      }
    });
    const channel = await connection.createConfirmChannel();
    channel.on("error", (error) => logger.error("RabbitMQ channel error", { error: error.message }));
    await assertTopology(channel, topology);
    for (const consumer of consumers) await setupConsumer(consumer);
    publishChannel = channel;
    logger.info("RabbitMQ ready", { consumers: consumers.map((c) => c.queue) });
  };

  const connect = () => {
    if (connecting) return connecting;
    connecting = (async () => {
      let delay = 500;
      while (!closed) {
        try {
          await connectOnce();
          return;
        } catch (error) {
          logger.warn("RabbitMQ not available; retrying", { error: error.message, retryInMs: delay });
          try {
            await connection?.close();
          } catch {
            // ignorar
          }
          connection = undefined;
          await sleep(delay);
          delay = Math.min(delay * 2, 15_000);
        }
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };

  const api = {
    connect,
    isReady: () => Boolean(publishChannel),
    /** Publica JSON persistente y espera la confirmación del broker. */
    publish: (exchange, routingKey, payload, options = {}) => {
      const channel = publishChannel;
      if (!channel) return Promise.reject(new Error("RabbitMQ is not connected"));
      return new Promise((resolve, reject) => {
        channel.publish(
          exchange,
          routingKey,
          Buffer.from(JSON.stringify(payload)),
          { persistent: true, contentType: "application/json", timestamp: Math.floor(Date.now() / 1000), ...options },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    },
    consume: async (queue, handler, { prefetch = 10 } = {}) => {
      const consumer = { queue, handler, prefetch };
      consumers.push(consumer);
      if (connection) await setupConsumer(consumer);
    },
    /** Profundidad y consumidores de una cola (para métricas). */
    checkQueue: async (queue) => {
      if (!connection) throw new Error("RabbitMQ is not connected");
      const channel = await connection.createChannel();
      try {
        return await channel.checkQueue(queue);
      } finally {
        await channel.close().catch(() => {});
      }
    },
    close: async () => {
      closed = true;
      await connection?.close().catch(() => {});
    },
  };
  return api;
};
