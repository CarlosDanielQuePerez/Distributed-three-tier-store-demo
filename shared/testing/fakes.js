// Dobles de prueba en memoria compartidos por las pruebas de la API y del worker.

export const createFakeRedis = () => {
  const data = new Map();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value, options = {}) => {
      if (options.NX && data.has(key)) return null;
      data.set(key, value);
      return "OK";
    },
    del: async (keys) => {
      let removed = 0;
      for (const key of Array.isArray(keys) ? keys : [keys]) if (data.delete(key)) removed += 1;
      return removed;
    },
    scan: async (_cursor, { MATCH }) => {
      const prefix = MATCH.replace(/\*$/, "");
      return { cursor: "0", keys: [...data.keys()].filter((key) => key.startsWith(prefix)) };
    },
  };
};

export const createFakeBroker = ({ ready = true, failPublish = false } = {}) => {
  const published = [];
  return {
    published,
    ready,
    isReady() {
      return this.ready;
    },
    publish: async (exchange, routingKey, payload, options) => {
      if (failPublish) throw new Error("broker down");
      published.push({ exchange, routingKey, payload, options });
    },
  };
};

export const createFakeChannel = () => {
  const calls = [];
  return {
    calls,
    ack: (message) => calls.push(["ack", message]),
    nack: (message, allUpTo, requeue) => calls.push(["nack", message, requeue]),
  };
};

export const createFakeCollection = ({ failWith } = {}) => {
  const documents = [];
  return {
    documents,
    insertOne: async (document) => {
      if (failWith) throw failWith;
      if (document.idempotencyKey && documents.some((d) => d.idempotencyKey === document.idempotencyKey)) {
        const error = new Error("E11000 duplicate key");
        error.code = 11000;
        throw error;
      }
      documents.push(document);
      return { insertedId: String(documents.length) };
    },
    find: (filter) => {
      const rows = documents.filter((d) => d.sku === filter.sku);
      const cursor = { sort: () => cursor, limit: () => cursor, project: () => cursor, toArray: async () => rows };
      return cursor;
    },
  };
};

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
