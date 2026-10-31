-- Catalog (categories, taxes, products, outlet-specific prices) and outlet-based inventory.

CREATE TABLE categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_categories_name (name),
  KEY idx_categories_status (status, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE taxes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(80) NOT NULL,
  rate DECIMAL(7,4) NOT NULL COMMENT 'fraction, e.g. 0.1200 = 12%',
  is_inclusive TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'prices already include this tax',
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_taxes_code (code),
  CONSTRAINT chk_taxes_rate CHECK (rate >= 0 AND rate < 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL COMMENT 'SKU / product code',
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,
  category_id INT UNSIGNED NOT NULL,
  item_type ENUM('PRODUCT','SERVICE') NOT NULL DEFAULT 'PRODUCT',
  unit VARCHAR(20) NOT NULL DEFAULT 'pc',
  image_path VARCHAR(255) NULL,
  tax_id INT UNSIGNED NULL,
  is_inventory_tracked TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('AVAILABLE','UNAVAILABLE','ARCHIVED') NOT NULL DEFAULT 'AVAILABLE',
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_products_code (code),
  KEY idx_products_name (name),
  KEY idx_products_category (category_id, status),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id),
  CONSTRAINT fk_products_tax FOREIGN KEY (tax_id) REFERENCES taxes (id) ON DELETE SET NULL,
  CONSTRAINT fk_products_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_products_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outlet-specific price history. The current price has effective_to = NULL; a product is
-- sold at an outlet exactly when it has a current price row there.
CREATE TABLE product_prices (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id INT UNSIGNED NOT NULL,
  outlet_id INT UNSIGNED NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  is_available TINYINT(1) NOT NULL DEFAULT 1,
  effective_from DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_to DATETIME NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  current_key VARCHAR(30) GENERATED ALWAYS AS (IF(effective_to IS NULL, CONCAT(product_id, '-', outlet_id), NULL)) STORED,
  UNIQUE KEY uq_product_prices_current (current_key),
  KEY idx_product_prices_lookup (outlet_id, effective_to, product_id),
  KEY idx_product_prices_product (product_id, outlet_id, effective_from),
  CONSTRAINT fk_product_prices_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_product_prices_outlet FOREIGN KEY (outlet_id) REFERENCES outlets (id),
  CONSTRAINT fk_product_prices_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_product_prices_price CHECK (price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_locations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  outlet_id INT UNSIGNED NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'location sales deduct from',
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  default_key INT UNSIGNED GENERATED ALWAYS AS (IF(is_default = 1, outlet_id, NULL)) STORED,
  UNIQUE KEY uq_stock_locations_code (code),
  UNIQUE KEY uq_stock_locations_default (default_key),
  CONSTRAINT fk_stock_locations_outlet FOREIGN KEY (outlet_id) REFERENCES outlets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Stock-keeping items (retail goods or ingredients).
CREATE TABLE inventory_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  unit VARCHAR(20) NOT NULL DEFAULT 'pc',
  description VARCHAR(255) NULL,
  default_reorder_level DECIMAL(12,3) NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inventory_items_sku (sku),
  KEY idx_inventory_items_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bill of materials: what one unit of a product consumes. Retail goods use a 1:1 recipe.
CREATE TABLE product_recipes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id INT UNSIGNED NOT NULL,
  inventory_item_id INT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product_recipes (product_id, inventory_item_id),
  KEY idx_product_recipes_item (inventory_item_id),
  CONSTRAINT fk_product_recipes_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_product_recipes_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id),
  CONSTRAINT chk_product_recipes_qty CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_levels (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stock_location_id INT UNSIGNED NOT NULL,
  inventory_item_id INT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL DEFAULT 0,
  reorder_level DECIMAL(12,3) NOT NULL DEFAULT 0,
  allow_negative TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stock_levels (stock_location_id, inventory_item_id),
  KEY idx_stock_levels_item (inventory_item_id),
  CONSTRAINT fk_stock_levels_location FOREIGN KEY (stock_location_id) REFERENCES stock_locations (id),
  CONSTRAINT fk_stock_levels_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable stock movement ledger. Quantity is signed (+ in, - out).
CREATE TABLE inventory_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transaction_number VARCHAR(30) NOT NULL,
  inventory_item_id INT UNSIGNED NOT NULL,
  stock_location_id INT UNSIGNED NOT NULL,
  transaction_type ENUM('STOCK_IN','STOCK_OUT','SALE','ADJUSTMENT','DAMAGE','WASTE','RETURN','REFUND_RETURN') NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  balance_after DECIMAL(12,3) NOT NULL,
  unit_cost DECIMAL(12,2) NULL,
  reference_type VARCHAR(30) NULL,
  reference_id VARCHAR(40) NULL,
  idempotency_key VARCHAR(120) NULL COMMENT 'prevents duplicate deductions, e.g. SALE:<order_item>:<item>',
  reason VARCHAR(255) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_inventory_transactions_number (transaction_number),
  UNIQUE KEY uq_inventory_transactions_idem (idempotency_key),
  KEY idx_inventory_transactions_item (inventory_item_id, created_at),
  KEY idx_inventory_transactions_location (stock_location_id, created_at),
  KEY idx_inventory_transactions_type (transaction_type, created_at),
  KEY idx_inventory_transactions_reference (reference_type, reference_id),
  CONSTRAINT fk_inventory_transactions_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id),
  CONSTRAINT fk_inventory_transactions_location FOREIGN KEY (stock_location_id) REFERENCES stock_locations (id),
  CONSTRAINT fk_inventory_transactions_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER trg_inventory_transactions_no_update BEFORE UPDATE ON inventory_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_transactions is append-only';
CREATE TRIGGER trg_inventory_transactions_no_delete BEFORE DELETE ON inventory_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_transactions is append-only';
