// Llaves y consultas del catálogo compartidas por la API y el worker (ToDo, punto 4).

export const CACHE_PREFIX = "store:products:";
export const CHEAPEST_CACHE_KEY = `${CACHE_PREFIX}cheapest:v1`;
export const CHEAPEST_REFRESH_LOCK = "store:lock:products:cheapest";
export const CHEAPEST_QUERY =
  "SELECT id, sku, name, description, price FROM products ORDER BY price ASC, id ASC LIMIT 10";

export const cacheTtlSeconds = () => Number(process.env.CACHE_TTL_SECONDS || 60);

/** Borra solo las llaves del catálogo (SCAN, nunca FLUSHDB). Devuelve cuántas borró. */
export const deleteCatalogKeys = async (redis) => {
  let removed = 0;
  let cursor = "0";
  do {
    const reply = await redis.scan(cursor, { MATCH: `${CACHE_PREFIX}*`, COUNT: 100 });
    cursor = String(reply.cursor);
    if (reply.keys.length > 0) removed += await redis.del(reply.keys);
  } while (cursor !== "0");
  return removed;
};
