/**
 * SalesTrack — Synchronization Engine Service
 * Handles transactional operations, row-locking (SELECT FOR UPDATE),
 * stock validation, deterministic idempotency, soft-delete, versioning,
 * input bounds validation, and incremental changelog.
 */

const crypto = require('crypto');
const { pool, getClient } = require('../db');

function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

// ==================== INPUT VALIDATORS ====================
function isValidId(id) {
  return typeof id === 'string' && id.trim().length > 0 && id.length <= 128;
}

function isValidName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 200;
}

function isValidNotes(notes) {
  return notes === undefined || notes === null || (typeof notes === 'string' && notes.length <= 1000);
}

function isValidQty(qty, max = 100000) {
  return typeof qty === 'number' && Number.isFinite(qty) && Number.isInteger(qty) && qty > 0 && qty <= max;
}

function isValidPrice(price) {
  if (price === null || price === undefined || price === '') return true;
  const p = Number(price);
  return Number.isFinite(p) && p >= 0 && p <= 1000000000;
}

/**
 * Fetch full authoritative snapshot for initial bootstrap/hydration
 * Omits soft-deleted entities.
 */
async function getSnapshot() {
  const client = await pool.connect();
  try {
    const [categoriesRes, productsRes, activitiesRes, settingsRes, seqRes] = await Promise.all([
      client.query('SELECT id, name, version, created_at AS "createdAt", updated_at AS "updatedAt" FROM categories WHERE is_deleted = FALSE ORDER BY created_at ASC'),
      client.query('SELECT id, category_id AS "categoryId", name, quantity::float, sold::float, price::float, notes, version, created_at AS "createdAt", updated_at AS "updatedAt" FROM products WHERE is_deleted = FALSE ORDER BY created_at ASC'),
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
 * Guarantees idempotency, stock validation, soft-delete, versioning, and atomic commits.
 */
async function processSyncBatch(deviceId, operations = []) {
  if (!isValidId(deviceId)) {
    throw new Error('Missing or invalid deviceId');
  }
  if (!Array.isArray(operations)) {
    throw new Error('Operations must be an array');
  }
  if (operations.length > 100) {
    throw new Error('Batch size exceeds maximum limit of 100 operations');
  }

  const startTime = Date.now();
  const accepted = [];
  const rejected = [];
  const client = await getClient();

  try {
    for (const op of operations) {
      if (!op || !isValidId(op.id) || typeof op.type !== 'string') {
        rejected.push({ id: op?.id || 'unknown', code: 'INVALID_OPERATION', message: 'Missing required operation fields' });
        continue;
      }

      await client.query('BEGIN');
      try {
        const now = Date.now();
        const payload = op.payload || {};
        const currentHash = hashPayload(payload);

        // 1. Deterministic Idempotency Check with Hash Matching
        const existingRes = await client.query(
          'SELECT result, payload_hash FROM sync_operations WHERE id = $1',
          [op.id]
        );

        if (existingRes.rows.length > 0) {
          const row = existingRes.rows[0];
          // Reject if operation ID reused with different payload
          if (row.payload_hash && row.payload_hash !== currentHash) {
            const reuseError = {
              code: 'IDEMPOTENCY_KEY_REUSE',
              message: 'Operation ID reused with conflicting payload'
            };
            rejected.push({ id: op.id, ...reuseError });
            await client.query('ROLLBACK');
            continue;
          }

          const cached = row.result;
          if (cached && cached.rejected) {
            rejected.push({ id: op.id, ...cached.rejected });
          } else {
            accepted.push(op.id);
          }
          await client.query('COMMIT');
          continue;
        }

        // 2. Process Operation with Authoritative Backend Validation
        if (op.type === 'SALE') {
          const { productId, quantity, notes, timestamp } = payload;
          const saleQty = Number(quantity);

          if (!isValidId(productId)) {
            throw { code: 'INVALID_PAYLOAD', message: 'Valid productId is required' };
          }
          if (!isValidQty(saleQty, 100000)) {
            throw { code: 'INVALID_PAYLOAD', message: 'Sale quantity must be a positive finite integer <= 100,000' };
          }
          if (!isValidNotes(notes)) {
            throw { code: 'INVALID_PAYLOAD', message: 'Notes must be under 1,000 characters' };
          }

          // Lock product row
          const prodRes = await client.query(
            'SELECT id, name, category_id, quantity::float, sold::float, price::float, is_deleted, version FROM products WHERE id = $1 FOR UPDATE',
            [productId]
          );

          if (prodRes.rows.length === 0) {
            throw { code: 'PRODUCT_NOT_FOUND', message: `Product ${productId} not found` };
          }

          const product = prodRes.rows[0];
          if (product.is_deleted) {
            throw { code: 'PRODUCT_DELETED', message: `Cannot sell soft-deleted product ${productId}` };
          }

          if (product.quantity < saleQty) {
            // Reject: Insufficient stock (never allow negative inventory)
            const rejectInfo = {
              code: 'INSUFFICIENT_STOCK',
              message: `Requested ${saleQty}, but available stock is ${product.quantity}`,
              availableStock: product.quantity
            };

            await client.query(
              'INSERT INTO sync_operations (id, device_id, type, created_at, processed_at, result, payload_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)',
              [op.id, deviceId, op.type, op.createdAt || now, now, { rejected: rejectInfo }, currentHash]
            );
            await client.query('COMMIT');
            rejected.push({ id: op.id, ...rejectInfo });
            continue;
          }

          // Apply stock decrement, sold increment, and version update
          const newQty = product.quantity - saleQty;
          const newSold = product.sold + saleQty;
          const newVersion = (product.version || 1) + 1;

          await client.query(
            'UPDATE products SET quantity = $1, sold = $2, version = $3, updated_at = $4 WHERE id = $5',
            [newQty, newSold, newVersion, now, productId]
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
              notes ? notes.trim() : '',
              product.quantity,
              product.sold
            ]
          );

          // Append delta to changes log for other devices
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', product.id, 'UPDATE', { id: product.id, quantity: newQty, sold: newSold, version: newVersion, isDeleted: false, updatedAt: now }, now]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['activity', activityId, 'CREATE', { id: activityId, type: 'sale', timestamp: timestamp || now, productId: product.id, productName: product.name, quantity: saleQty, notes: notes ? notes.trim() : '' }, now]
          );

        } else if (op.type === 'RESTOCK') {
          const { productId, quantity, notes, timestamp } = payload;
          const restockQty = Number(quantity);

          if (!isValidId(productId)) {
            throw { code: 'INVALID_PAYLOAD', message: 'Valid productId is required' };
          }
          if (!isValidQty(restockQty, 1000000)) {
            throw { code: 'INVALID_PAYLOAD', message: 'Restock quantity must be a positive finite integer <= 1,000,000' };
          }
          if (!isValidNotes(notes)) {
            throw { code: 'INVALID_PAYLOAD', message: 'Notes must be under 1,000 characters' };
          }

          const prodRes = await client.query(
            'SELECT id, name, category_id, quantity::float, sold::float, is_deleted, version FROM products WHERE id = $1 FOR UPDATE',
            [productId]
          );

          if (prodRes.rows.length === 0) {
            throw { code: 'PRODUCT_NOT_FOUND', message: `Product ${productId} not found` };
          }

          const product = prodRes.rows[0];
          if (product.is_deleted) {
            throw { code: 'PRODUCT_DELETED', message: `Cannot restock soft-deleted product ${productId}` };
          }

          const newQty = product.quantity + restockQty;
          const newVersion = (product.version || 1) + 1;

          await client.query(
            'UPDATE products SET quantity = $1, version = $2, updated_at = $3 WHERE id = $4',
            [newQty, newVersion, now, productId]
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
            [activityId, 'update', timestamp || now, product.id, product.name, product.category_id, categoryName, restockQty, notes ? notes.trim() : 'Restocked', product.quantity, product.sold]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', product.id, 'UPDATE', { id: product.id, quantity: newQty, version: newVersion, isDeleted: false, updatedAt: now }, now]
          );

        } else if (op.type === 'CREATE_PRODUCT') {
          const { id, categoryId, name, quantity, sold, price, notes, createdAt } = payload;
          if (!isValidId(id)) throw { code: 'INVALID_PAYLOAD', message: 'Valid product id required' };
          if (!isValidName(name)) throw { code: 'INVALID_PAYLOAD', message: 'Product name must be 1-200 characters' };
          if (categoryId && !isValidId(categoryId)) throw { code: 'INVALID_PAYLOAD', message: 'Invalid categoryId' };
          if (!isValidNotes(notes)) throw { code: 'INVALID_PAYLOAD', message: 'Notes must be under 1,000 characters' };
          if (!isValidPrice(price)) throw { code: 'INVALID_PAYLOAD', message: 'Price must be a non-negative finite number <= 1,000,000,000' };

          const initialQty = Number(quantity);
          const initialSold = Number(sold);
          if (quantity !== undefined && (!Number.isFinite(initialQty) || initialQty < 0 || initialQty > 1000000 || !Number.isInteger(initialQty))) {
            throw { code: 'INVALID_PAYLOAD', message: 'Product quantity must be a non-negative finite integer' };
          }
          if (sold !== undefined && (!Number.isFinite(initialSold) || initialSold < 0 || !Number.isInteger(initialSold))) {
            throw { code: 'INVALID_PAYLOAD', message: 'Product sold must be a non-negative finite integer' };
          }

          const sanitizedPrice = (price !== null && price !== undefined && price !== '') ? Number(price) : null;

          await client.query(
            `INSERT INTO products (id, category_id, name, quantity, sold, price, notes, is_deleted, version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, 1, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               category_id = EXCLUDED.category_id,
               name = EXCLUDED.name,
               quantity = EXCLUDED.quantity,
               sold = EXCLUDED.sold,
               price = EXCLUDED.price,
               notes = EXCLUDED.notes,
               is_deleted = FALSE,
               version = products.version + 1,
               updated_at = EXCLUDED.updated_at`,
            [id, categoryId || null, name.trim(), initialQty || 0, initialSold || 0, sanitizedPrice, notes ? notes.trim() : '', createdAt || now, now]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', id, 'CREATE', { id, categoryId, name: name.trim(), quantity: initialQty || 0, sold: initialSold || 0, price: sanitizedPrice, notes, isDeleted: false, version: 1, createdAt: createdAt || now, updatedAt: now }, now]
          );

        } else if (op.type === 'UPDATE_PRODUCT') {
          const { id, categoryId, name, quantity, sold, price, notes, expectedVersion } = payload;
          if (!isValidId(id)) throw { code: 'INVALID_PAYLOAD', message: 'Product id required for update' };
          if (name !== undefined && !isValidName(name)) throw { code: 'INVALID_PAYLOAD', message: 'Product name must be 1-200 characters' };
          if (categoryId && !isValidId(categoryId)) throw { code: 'INVALID_PAYLOAD', message: 'Invalid categoryId' };
          if (!isValidNotes(notes)) throw { code: 'INVALID_PAYLOAD', message: 'Notes must be under 1,000 characters' };
          if (!isValidPrice(price)) throw { code: 'INVALID_PAYLOAD', message: 'Price must be a non-negative finite number <= 1,000,000,000' };

          const prodRes = await client.query(
            'SELECT id, name, category_id, quantity::float, sold::float, price::float, is_deleted, version FROM products WHERE id = $1 FOR UPDATE',
            [id]
          );

          if (prodRes.rows.length === 0) {
            throw { code: 'PRODUCT_NOT_FOUND', message: `Product ${id} not found` };
          }

          const product = prodRes.rows[0];
          if (product.is_deleted) {
            throw { code: 'PRODUCT_DELETED', message: `Cannot update soft-deleted product ${id}` };
          }

          // Concurrency check: reject stale update if expectedVersion is provided and differs
          if (expectedVersion !== undefined && expectedVersion !== null) {
            const expVer = Number(expectedVersion);
            if (Number.isFinite(expVer) && product.version !== expVer) {
              throw {
                code: 'VERSION_CONFLICT',
                message: `Stale update: product version is ${product.version}, but client expected ${expVer}`,
                currentVersion: product.version
              };
            }
          }

          const newVersion = (product.version || 1) + 1;
          const sanitizedPrice = (price !== null && price !== undefined && price !== '') ? Number(price) : (price === null ? null : undefined);

          await client.query(
            `UPDATE products SET
               category_id = COALESCE($1, category_id),
               name = COALESCE($2, name),
               quantity = COALESCE($3, quantity),
               sold = COALESCE($4, sold),
               price = CASE WHEN $5::boolean THEN $6::float ELSE price END,
               notes = COALESCE($7, notes),
               version = $8,
               updated_at = $9
             WHERE id = $10`,
            [
              categoryId,
              name ? name.trim() : null,
              quantity !== undefined ? Number(quantity) : null,
              sold !== undefined ? Number(sold) : null,
              price !== undefined,
              sanitizedPrice,
              notes !== undefined ? notes.trim() : null,
              newVersion,
              now,
              id
            ]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', id, 'UPDATE', { id, categoryId, name: name ? name.trim() : product.name, quantity: quantity !== undefined ? Number(quantity) : product.quantity, sold: sold !== undefined ? Number(sold) : product.sold, price: price !== undefined ? sanitizedPrice : product.price, notes, version: newVersion, isDeleted: false, updatedAt: now }, now]
          );

        } else if (op.type === 'DELETE_PRODUCT') {
          const { id } = payload;
          if (!isValidId(id)) throw { code: 'INVALID_PAYLOAD', message: 'Valid product id required' };

          const prodRes = await client.query(
            'SELECT id, is_deleted, version FROM products WHERE id = $1 FOR UPDATE',
            [id]
          );

          // Idempotent soft delete: if product does not exist or is already deleted, succeed cleanly
          if (prodRes.rows.length > 0 && !prodRes.rows[0].is_deleted) {
            const newVersion = (prodRes.rows[0].version || 1) + 1;
            await client.query(
              'UPDATE products SET is_deleted = TRUE, version = $1, updated_at = $2 WHERE id = $3',
              [newVersion, now, id]
            );
            await client.query(
              'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
              ['product', id, 'DELETE', { id, isDeleted: true, version: newVersion }, now]
            );
          }

        } else if (op.type === 'CREATE_CATEGORY') {
          const { id, name, createdAt } = payload;
          if (!isValidId(id)) throw { code: 'INVALID_PAYLOAD', message: 'Category id required' };
          if (!isValidName(name)) throw { code: 'INVALID_PAYLOAD', message: 'Category name must be 1-200 characters' };

          await client.query(
            `INSERT INTO categories (id, name, is_deleted, version, created_at, updated_at)
             VALUES ($1, $2, FALSE, 1, $3, $4)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_deleted = FALSE, version = categories.version + 1, updated_at = EXCLUDED.updated_at`,
            [id, name.trim(), createdAt || now, now]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['category', id, 'CREATE', { id, name: name.trim(), isDeleted: false, version: 1, createdAt: createdAt || now, updatedAt: now }, now]
          );

        } else if (op.type === 'UPDATE_CATEGORY') {
          const { id, name, expectedVersion } = payload;
          if (!isValidId(id)) throw { code: 'INVALID_PAYLOAD', message: 'Category id required' };
          if (!isValidName(name)) throw { code: 'INVALID_PAYLOAD', message: 'Category name must be 1-200 characters' };

          const catRes = await client.query('SELECT is_deleted, version FROM categories WHERE id = $1 FOR UPDATE', [id]);
          if (catRes.rows.length === 0 || catRes.rows[0].is_deleted) {
            throw { code: 'CATEGORY_NOT_FOUND', message: `Category ${id} not found` };
          }

          if (expectedVersion !== undefined && expectedVersion !== null) {
            const expVer = Number(expectedVersion);
            if (Number.isFinite(expVer) && catRes.rows[0].version !== expVer) {
              throw {
                code: 'VERSION_CONFLICT',
                message: `Stale update: category version is ${catRes.rows[0].version}, but client expected ${expVer}`,
                currentVersion: catRes.rows[0].version
              };
            }
          }

          const newVersion = (catRes.rows[0].version || 1) + 1;
          await client.query('UPDATE categories SET name = $1, version = $2, updated_at = $3 WHERE id = $4', [name.trim(), newVersion, now, id]);
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['category', id, 'UPDATE', { id, name: name.trim(), isDeleted: false, version: newVersion, updatedAt: now }, now]
          );

        } else if (op.type === 'DELETE_CATEGORY') {
          const { id } = payload;
          if (!isValidId(id)) throw { code: 'INVALID_PAYLOAD', message: 'Category id required' };

          const catRes = await client.query('SELECT is_deleted, version FROM categories WHERE id = $1 FOR UPDATE', [id]);
          if (catRes.rows.length > 0 && !catRes.rows[0].is_deleted) {
            const newVersion = (catRes.rows[0].version || 1) + 1;
            await client.query('UPDATE categories SET is_deleted = TRUE, version = $1, updated_at = $2 WHERE id = $3', [newVersion, now, id]);
            await client.query(
              'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
              ['category', id, 'DELETE', { id, isDeleted: true, version: newVersion }, now]
            );
          }

        } else if (op.type === 'UPDATE_SETTINGS') {
          const { key, value } = payload;
          if (!isValidId(key)) throw { code: 'INVALID_PAYLOAD', message: 'Settings key required' };

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
          'INSERT INTO sync_operations (id, device_id, type, created_at, processed_at, result, payload_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [op.id, deviceId, op.type, op.createdAt || now, now, { success: true }, currentHash]
        );

        await client.query('COMMIT');
        accepted.push(op.id);

      } catch (err) {
        await client.query('ROLLBACK');
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          event: 'sync_operation_rejected',
          opId: op.id,
          code: err.code || 'OPERATION_FAILED',
          message: err.message || 'Operation failed during transaction'
        }));
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

  const durationMs = Date.now() - startTime;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'sync_batch_completed',
    deviceId,
    totalOps: operations.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    durationMs
  }));

  return {
    success: true,
    accepted,
    rejected,
    serverTime: Date.now()
  };
}

/**
 * Prune changes older than retention window (default 60 days)
 */
async function pruneOldChanges(retentionDays = 60) {
  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const client = await pool.connect();
  try {
    const res = await client.query('DELETE FROM changes WHERE created_at < $1', [cutoff]);
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'changelog_pruned',
      prunedCount: res.rowCount,
      cutoffTimestamp: cutoff
    }));
    return res.rowCount;
  } finally {
    client.release();
  }
}

module.exports = {
  getSnapshot,
  getChangesSince,
  processSyncBatch,
  pruneOldChanges
};
