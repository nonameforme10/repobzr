/**
 * SalesTrack — Synchronization Engine Service
 * Handles transactional operations, row-locking (SELECT FOR UPDATE),
 * stock validation, deterministic idempotency, and incremental changelog.
 */

const { pool, getClient } = require('../db');

/**
 * Fetch full authoritative snapshot for initial bootstrap/hydration
 */
async function getSnapshot() {
  const client = await pool.connect();
  try {
    const [categoriesRes, productsRes, activitiesRes, settingsRes, seqRes] = await Promise.all([
      client.query('SELECT id, name, created_at AS "createdAt", updated_at AS "updatedAt" FROM categories ORDER BY created_at ASC'),
      client.query('SELECT id, category_id AS "categoryId", name, quantity::float, sold::float, price::float, notes, created_at AS "createdAt", updated_at AS "updatedAt" FROM products ORDER BY created_at ASC'),
      client.query('SELECT id, type, timestamp, product_id AS "productId", product_name AS "productName", category_id AS "categoryId", category_name AS "categoryName", quantity::float, notes, previous_quantity::float AS "previousQuantity", previous_sold::float AS "previousSold" FROM activities ORDER BY timestamp DESC LIMIT 500'),
      client.query('SELECT key, value FROM settings'),
      client.query('SELECT COALESCE(MAX(seq), 0)::bigint AS max_seq FROM changes')
    ]);

    const settings = {};
    for (const row of settingsRes.rows) {
      settings[row.key] = row.value;
    }

    return {
      categories: categoriesRes.rows,
      products: productsRes.rows,
      activities: activitiesRes.rows,
      settings,
      currentSeq: Number(seqRes.rows[0]?.max_seq || 0),
      serverTime: Date.now()
    };
  } finally {
    client.release();
  }
}

/**
 * Fetch incremental delta changes since client's cursor
 */
async function getChangesSince(sinceSeq = 0) {
  const client = await pool.connect();
  try {
    const cursor = Number(sinceSeq) || 0;
    const statsRes = await client.query('SELECT COALESCE(MIN(seq), 0)::bigint AS min_seq, COALESCE(MAX(seq), 0)::bigint AS max_seq FROM changes');
    const minSeq = Number(statsRes.rows[0]?.min_seq || 0);
    const maxSeq = Number(statsRes.rows[0]?.max_seq || 0);

    // If client cursor is behind oldest retained change (and database has changes)
    if (cursor > 0 && minSeq > 0 && cursor < minSeq) {
      return {
        requiresBootstrap: true,
        currentSeq: maxSeq,
        serverTime: Date.now()
      };
    }

    const changesRes = await client.query(
      'SELECT seq::bigint, entity_type AS "entityType", entity_id AS "entityId", action, data, created_at AS "createdAt" FROM changes WHERE seq > $1 ORDER BY seq ASC LIMIT 200',
      [cursor]
    );

    return {
      requiresBootstrap: false,
      changes: changesRes.rows.map(r => ({ ...r, seq: Number(r.seq) })),
      currentSeq: maxSeq,
      serverTime: Date.now()
    };
  } finally {
    client.release();
  }
}

/**
 * Process a batch of sync operations from a client device.
 * Guarantees idempotency, stock validation, and atomic commits.
 */
async function processSyncBatch(deviceId, operations = []) {
  if (!deviceId) {
    throw new Error('Missing deviceId');
  }
  if (!Array.isArray(operations)) {
    throw new Error('Operations must be an array');
  }
  if (operations.length > 100) {
    throw new Error('Batch size exceeds maximum limit of 100 operations');
  }

  const accepted = [];
  const rejected = [];
  const client = await getClient();

  try {
    for (const op of operations) {
      if (!op || !op.id || !op.type) {
        rejected.push({ id: op?.id || 'unknown', code: 'INVALID_OPERATION', message: 'Missing required operation fields' });
        continue;
      }

      await client.query('BEGIN');
      try {
        // 1. Deterministic Idempotency Check
        const existingRes = await client.query(
          'SELECT result FROM sync_operations WHERE id = $1',
          [op.id]
        );

        if (existingRes.rows.length > 0) {
          const cached = existingRes.rows[0].result;
          if (cached && cached.rejected) {
            rejected.push({ id: op.id, ...cached.rejected });
          } else {
            accepted.push(op.id);
          }
          await client.query('COMMIT');
          continue;
        }

        // 2. Process Operation
        const now = Date.now();
        const payload = op.payload || {};

        if (op.type === 'SALE') {
          const { productId, quantity, notes, timestamp } = payload;
          const saleQty = Number(quantity);

          if (!productId || isNaN(saleQty) || saleQty <= 0) {
            throw { code: 'INVALID_PAYLOAD', message: 'Sale quantity must be a positive number' };
          }

          // Lock product row
          const prodRes = await client.query(
            'SELECT id, name, category_id, quantity::float, sold::float, price::float FROM products WHERE id = $1 FOR UPDATE',
            [productId]
          );

          if (prodRes.rows.length === 0) {
            throw { code: 'PRODUCT_NOT_FOUND', message: `Product ${productId} not found` };
          }

          const product = prodRes.rows[0];
          if (product.quantity < saleQty) {
            // Reject: Insufficient stock (never allow negative inventory)
            const rejectInfo = {
              code: 'INSUFFICIENT_STOCK',
              message: `Requested ${saleQty}, but available stock is ${product.quantity}`,
              availableStock: product.quantity
            };

            await client.query(
              'INSERT INTO sync_operations (id, device_id, type, created_at, processed_at, result) VALUES ($1, $2, $3, $4, $5, $6)',
              [op.id, deviceId, op.type, op.createdAt || now, now, { rejected: rejectInfo }]
            );
            await client.query('COMMIT');
            rejected.push({ id: op.id, ...rejectInfo });
            continue;
          }

          // Apply stock decrement and sold increment
          const newQty = product.quantity - saleQty;
          const newSold = product.sold + saleQty;

          await client.query(
            'UPDATE products SET quantity = $1, sold = $2, updated_at = $3 WHERE id = $4',
            [newQty, newSold, now, productId]
          );

          // Category name lookup
          let categoryName = 'Unknown';
          if (product.category_id) {
            const catRes = await client.query('SELECT name FROM categories WHERE id = $1', [product.category_id]);
            if (catRes.rows.length > 0) categoryName = catRes.rows[0].name;
          }

          // Insert immutable activity event
          const activityId = payload.activityId || `act_${now}_${Math.random().toString(36).substr(2, 7)}`;
          await client.query(
            `INSERT INTO activities (id, type, timestamp, product_id, product_name, category_id, category_name, quantity, notes, previous_quantity, previous_sold)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              activityId,
              'sale',
              timestamp || now,
              product.id,
              product.name,
              product.category_id,
              categoryName,
              saleQty,
              notes || '',
              product.quantity,
              product.sold
            ]
          );

          // Append delta to changes log for other devices
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', product.id, 'UPDATE', { id: product.id, quantity: newQty, sold: newSold, updatedAt: now }, now]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['activity', activityId, 'CREATE', { id: activityId, type: 'sale', timestamp: timestamp || now, productId: product.id, productName: product.name, quantity: saleQty, notes: notes || '' }, now]
          );

        } else if (op.type === 'RESTOCK') {
          const { productId, quantity, notes, timestamp } = payload;
          const restockQty = Number(quantity);

          if (!productId || isNaN(restockQty) || restockQty <= 0) {
            throw { code: 'INVALID_PAYLOAD', message: 'Restock quantity must be positive' };
          }

          const prodRes = await client.query(
            'SELECT id, name, category_id, quantity::float, sold::float FROM products WHERE id = $1 FOR UPDATE',
            [productId]
          );

          if (prodRes.rows.length === 0) {
            throw { code: 'PRODUCT_NOT_FOUND', message: `Product ${productId} not found` };
          }

          const product = prodRes.rows[0];
          const newQty = product.quantity + restockQty;

          await client.query(
            'UPDATE products SET quantity = $1, updated_at = $2 WHERE id = $3',
            [newQty, now, productId]
          );

          let categoryName = 'Unknown';
          if (product.category_id) {
            const catRes = await client.query('SELECT name FROM categories WHERE id = $1', [product.category_id]);
            if (catRes.rows.length > 0) categoryName = catRes.rows[0].name;
          }

          const activityId = payload.activityId || `act_${now}_${Math.random().toString(36).substr(2, 7)}`;
          await client.query(
            `INSERT INTO activities (id, type, timestamp, product_id, product_name, category_id, category_name, quantity, notes, previous_quantity, previous_sold)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [activityId, 'update', timestamp || now, product.id, product.name, product.category_id, categoryName, restockQty, notes || 'Restocked', product.quantity, product.sold]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', product.id, 'UPDATE', { id: product.id, quantity: newQty, updatedAt: now }, now]
          );

        } else if (op.type === 'CREATE_PRODUCT') {
          const { id, categoryId, name, quantity, sold, price, notes, createdAt } = payload;
          if (!id || !name) throw { code: 'INVALID_PAYLOAD', message: 'Product requires id and name' };

          await client.query(
            `INSERT INTO products (id, category_id, name, quantity, sold, price, notes, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               category_id = EXCLUDED.category_id,
               name = EXCLUDED.name,
               quantity = EXCLUDED.quantity,
               sold = EXCLUDED.sold,
               price = EXCLUDED.price,
               notes = EXCLUDED.notes,
               updated_at = EXCLUDED.updated_at`,
            [id, categoryId || null, name, Number(quantity) || 0, Number(sold) || 0, Number(price) || 0, notes || '', createdAt || now, now]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', id, 'CREATE', { id, categoryId, name, quantity, sold, price, notes, createdAt: createdAt || now, updatedAt: now }, now]
          );

        } else if (op.type === 'UPDATE_PRODUCT') {
          const { id, categoryId, name, quantity, sold, price, notes } = payload;
          if (!id) throw { code: 'INVALID_PAYLOAD', message: 'Product id required for update' };

          await client.query(
            `UPDATE products SET
               category_id = COALESCE($1, category_id),
               name = COALESCE($2, name),
               quantity = COALESCE($3, quantity),
               sold = COALESCE($4, sold),
               price = COALESCE($5, price),
               notes = COALESCE($6, notes),
               updated_at = $7
             WHERE id = $8`,
            [categoryId, name, quantity !== undefined ? Number(quantity) : null, sold !== undefined ? Number(sold) : null, price !== undefined ? Number(price) : null, notes, now, id]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', id, 'UPDATE', { id, categoryId, name, quantity, sold, price, notes, updatedAt: now }, now]
          );

        } else if (op.type === 'DELETE_PRODUCT') {
          const { id } = payload;
          if (!id) throw { code: 'INVALID_PAYLOAD', message: 'Product id required' };

          await client.query('DELETE FROM products WHERE id = $1', [id]);
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', id, 'DELETE', { id }, now]
          );

        } else if (op.type === 'CREATE_CATEGORY') {
          const { id, name, createdAt } = payload;
          if (!id || !name) throw { code: 'INVALID_PAYLOAD', message: 'Category requires id and name' };

          await client.query(
            `INSERT INTO categories (id, name, created_at, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
            [id, name, createdAt || now, now]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['category', id, 'CREATE', { id, name, createdAt: createdAt || now, updatedAt: now }, now]
          );

        } else if (op.type === 'UPDATE_CATEGORY') {
          const { id, name } = payload;
          if (!id || !name) throw { code: 'INVALID_PAYLOAD', message: 'Category requires id and name' };

          await client.query('UPDATE categories SET name = $1, updated_at = $2 WHERE id = $3', [name, now, id]);
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['category', id, 'UPDATE', { id, name, updatedAt: now }, now]
          );

        } else if (op.type === 'DELETE_CATEGORY') {
          const { id } = payload;
          if (!id) throw { code: 'INVALID_PAYLOAD', message: 'Category id required' };

          await client.query('DELETE FROM categories WHERE id = $1', [id]);
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['category', id, 'DELETE', { id }, now]
          );

        } else if (op.type === 'UPDATE_SETTINGS') {
          const { key, value } = payload;
          if (!key) throw { code: 'INVALID_PAYLOAD', message: 'Settings key required' };

          await client.query(
            `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
            [key, JSON.stringify(value), now]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['settings', key, 'UPDATE', { key, value, updatedAt: now }, now]
          );

        } else {
          throw { code: 'UNSUPPORTED_TYPE', message: `Operation type ${op.type} is not supported` };
        }

        // Record successful operation in sync_operations table for idempotency
        await client.query(
          'INSERT INTO sync_operations (id, device_id, type, created_at, processed_at, result) VALUES ($1, $2, $3, $4, $5, $6)',
          [op.id, deviceId, op.type, op.createdAt || now, now, { success: true }]
        );

        await client.query('COMMIT');
        accepted.push(op.id);

      } catch (err) {
        await client.query('ROLLBACK');
        console.warn(`[sync operation rejected] ${op.id}:`, err.code || err.message);
        rejected.push({
          id: op.id,
          code: err.code || 'OPERATION_FAILED',
          message: err.message || 'Operation failed during transaction'
        });
      }
    }
  } finally {
    client.release();
  }

  return {
    success: true,
    accepted,
    rejected,
    serverTime: Date.now()
  };
}

module.exports = {
  getSnapshot,
  getChangesSince,
  processSyncBatch
};
