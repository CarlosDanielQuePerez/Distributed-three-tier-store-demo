-- Marca de tiempo de la última modificación; la usa PUT /products/{sku}/price.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
