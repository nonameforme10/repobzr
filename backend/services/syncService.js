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
  if (price === null || price === undefined || price === '') return false;
  const p = Number(price);
  return Number.isFinite(p) && p > 0 && p <= 1000000000;
}

let _hasActDetailsCols = null;
async function checkActivitiesDetailsColumns(client) {
  if (_hasActDetailsCols !== null) return _hasActDetailsCols;
  try {
    const res = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'activities' AND column_name = 'sale_id'");
    _hasActDetailsCols = res.rows.length > 0;
  } catch (e) {
    _hasActDetailsCols = false;
  }
  return _hasActDetailsCols;
}

/**
 * Fetch full authoritative snapshot for initial bootstrap/hydration
 * Omits soft-deleted entities.
 */
async function getSnapshot() {
  const client = await pool.connect();
  try {
    const hasDetails = await checkActivitiesDetailsColumns(client);
    const [categoriesRes, productsRes, activitiesRes, settingsRes, seqRes] = await Promise.all([
      client.query('SELECT id, name, version, created_at AS "createdAt", updated_at AS "updatedAt" FROM categories WHERE is_deleted = FALSE ORDER BY created_at ASC'),
      client.query('SELECT id, category_id AS "categoryId", name, quantity::float, sold::float, price::float, notes, image, translations, version, created_at AS "createdAt", updated_at AS "updatedAt" FROM products WHERE is_deleted = FALSE ORDER BY created_at ASC'),
      client.query(`
        SELECT 
          a.id, 
          a.type, 
          a.timestamp::bigint AS timestamp, 
          a.product_id AS "productId", 
          a.product_name AS "productName", 
          a.category_id AS "categoryId", 
          a.category_name AS "categoryName", 
          a.quantity::float, 
          a.notes, 
          a.previous_quantity::float AS "previousQuantity", 
          a.previous_sold::float AS "previousSold",
          CASE 
            WHEN a.type = 'cash_out' THEN a.quantity::float 
            ELSE 0 
          END AS "amount",
          CASE 
            WHEN a.type = 'cash_out' THEN a.product_name 
            ELSE NULL 
          END AS "reason",
          CASE 
            WHEN a.type = 'sale' AND (${hasDetails ? 'COALESCE(s.total, NULLIF(a.subtotal, 0) - COALESCE(a.discount, 0), 0)' : '0'}) > 0 AND a.quantity > 0 
              THEN ROUND((${hasDetails ? 'COALESCE(s.total, a.subtotal - COALESCE(a.discount, 0))' : '0'})::numeric / a.quantity::numeric, 0)::float
            ELSE COALESCE(p.price::float, 0) 
          END AS "sellingPrice",
          CASE 
            WHEN a.type = 'sale' AND (${hasDetails ? 'COALESCE(s.total, NULLIF(a.subtotal, 0) - COALESCE(a.discount, 0), 0)' : '0'}) > 0 
              THEN (${hasDetails ? 'COALESCE(s.total::float, (a.subtotal::float - COALESCE(a.discount::float, 0)))' : '0'})::float
            ELSE (COALESCE(p.price::float, 0) * COALESCE(a.quantity::float, 1))
          END AS "totalSaleValue"
          ${hasDetails ? `, a.sale_id AS "saleId", COALESCE(s.discount::bigint, a.discount::bigint, 0) AS discount, COALESCE(s.subtotal::bigint, a.subtotal::bigint, 0) AS subtotal, COALESCE(a.items_count, 1) AS "itemsCount", COALESCE(a.items_json, '[]'::jsonb) AS items, (COALESCE(a.items_count, 1) > 1 OR COALESCE(a.discount, 0) > 0 OR a.product_name ILIKE '%optom%') AS "isOptom"` : ''}
        FROM activities a
        LEFT JOIN products p ON a.product_id = p.id
        ${hasDetails ? 'LEFT JOIN sales s ON a.sale_id = s.id' : ''}
        ORDER BY a.timestamp DESC 
        LIMIT 500
      `),
      client.query('SELECT key, value FROM settings'),
      client.query('SELECT COALESCE(MAX(seq), 0)::bigint AS max_seq FROM changes')
    ]);

    let salesRows = [];
    try {
      const salesRes = await client.query(`
        SELECT s.id, s.seller_id AS "sellerId", s.status, s.subtotal::bigint AS subtotal, 
               s.discount::bigint AS discount, s.total::bigint AS total, s.currency, 
               s.notes, s.created_at AS "createdAt", s.updated_at AS "updatedAt",
               COALESCE(json_agg(
                 json_build_object(
                   'id', si.id,
                   'productId', si.product_id,
                   'productName', si.product_name_snapshot,
                   'quantity', si.quantity,
                   'basePrice', si.base_price::bigint,
                   'salePrice', si.sale_price::bigint,
                   'subtotal', si.subtotal::bigint,
                   'allocatedDiscount', si.allocated_discount::bigint
                 )
               ) FILTER (WHERE si.id IS NOT NULL), '[]'::json) AS items
        FROM sales s
        LEFT JOIN sale_items si ON s.id = si.sale_id
        WHERE s.is_deleted = FALSE
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 200
      `);
      salesRows = salesRes.rows.map(r => ({
        ...r,
        createdAt: Number(r.createdAt),
        updatedAt: Number(r.updatedAt),
        subtotal: Number(r.subtotal),
        discount: Number(r.discount),
        total: Number(r.total)
      }));
    } catch (e) {
      // If table doesn't exist yet prior to migration, fallback gracefully
      salesRows = [];
    }

    const settings = {};
    for (const row of settingsRes.rows) {
      settings[row.key] = row.value;
    }

    return {
      categories: categoriesRes.rows,
      products: productsRes.rows,
      activities: activitiesRes.rows.map(r => ({ ...r, timestamp: Number(r.timestamp) })),
      sales: salesRows,
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

    // If client cursor is behind oldest retained change OR ahead of maxSeq (db was wiped/reset)
    if ((cursor > 0 && maxSeq === 0) || (cursor > maxSeq) || (minSeq > 1 && cursor < minSeq) || (cursor > 0 && minSeq > 0 && cursor < minSeq)) {
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
        if (op.type === 'SALE_TRANSACTION') {
          const { saleId, sellerId, items, discount = 0, notes, timestamp } = payload;

          if (!isValidId(saleId)) {
            throw { code: 'INVALID_PAYLOAD', message: 'Valid saleId is required' };
          }
          if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
            throw { code: 'INVALID_PAYLOAD', message: 'items must be a non-empty array with max 100 items' };
          }
          const manualDiscount = Math.max(0, Math.floor(Number(discount) || 0));

          // 1. Idempotency check: has this saleId already been committed?
          const existingSale = await client.query('SELECT id, total FROM sales WHERE id = $1', [saleId]);
          if (existingSale.rows.length > 0) {
            accepted.push(op.id);
            await client.query('COMMIT');
            continue;
          }

          // 2. Validate individual items in payload
          for (const item of items) {
            if (!item || !isValidId(item.productId)) {
              throw { code: 'INVALID_PAYLOAD', message: 'Valid productId is required for each line item' };
            }
            const q = Math.floor(Number(item.quantity) || 0);
            if (!Number.isInteger(q) || q <= 0 || q > 100000) {
              throw { code: 'INVALID_PAYLOAD', message: `Invalid quantity ${item.quantity} for product ${item.productId}` };
            }
            const sp = Math.floor(Number(item.salePrice) || 0);
            if (!Number.isFinite(sp) || sp < 0) {
              throw { code: 'INVALID_PAYLOAD', message: `Invalid salePrice ${item.salePrice} for product ${item.productId}` };
            }
          }

          // 3. Lock products in deterministic alphabetical order to avoid deadlocks
          const sortedProductIds = [...new Set(items.map(i => i.productId))].sort();
          const prodRes = await client.query(
            `SELECT id, name, category_id, quantity::float, sold::float, price::bigint, is_deleted, version 
             FROM products 
             WHERE id = ANY($1::varchar[]) 
             ORDER BY id ASC 
             FOR UPDATE`,
            [sortedProductIds]
          );

          const productMap = new Map();
          for (const row of prodRes.rows) {
            productMap.set(row.id, row);
          }

          // Check all products exist and are not deleted
          for (const pid of sortedProductIds) {
            const prod = productMap.get(pid);
            if (!prod) {
              throw { code: 'PRODUCT_NOT_FOUND', message: `Product ${pid} not found` };
            }
            if (prod.is_deleted) {
              throw { code: 'PRODUCT_DELETED', message: `Cannot sell soft-deleted product ${pid}` };
            }
          }

          // Aggregate requested quantities per product (in case cart has separate lines with different prices)
          const requestedQtyMap = new Map();
          for (const item of items) {
            const q = Math.floor(Number(item.quantity));
            requestedQtyMap.set(item.productId, (requestedQtyMap.get(item.productId) || 0) + q);
          }

          // 4. Validate stock for all tracked items
          let stockError = null;
          for (const [pid, reqQty] of requestedQtyMap.entries()) {
            const prod = productMap.get(pid);
            if (prod.quantity !== null && prod.quantity !== undefined) {
              if (prod.quantity < reqQty) {
                stockError = {
                  code: 'INSUFFICIENT_STOCK',
                  message: `Requested ${reqQty} for "${prod.name}", but available stock is ${prod.quantity}`,
                  productId: pid,
                  productName: prod.name,
                  availableStock: prod.quantity,
                  requestedQty: reqQty
                };
                break;
              }
            }
          }

          if (stockError) {
            await client.query(
              'INSERT INTO sync_operations (id, device_id, type, created_at, processed_at, result, payload_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)',
              [op.id, deviceId, op.type, op.createdAt || now, now, { rejected: stockError }, currentHash]
            );
            await client.query('COMMIT');
            rejected.push({ id: op.id, ...stockError });
            continue;
          }

          // 5. Server calculates line subtotals, overall subtotal, validates manual discount, and computes total
          let calculatedSubtotal = 0n;
          const processedItems = [];

          for (const item of items) {
            const prod = productMap.get(item.productId);
            const qty = BigInt(Math.floor(Number(item.quantity)));
            const salePrice = BigInt(Math.floor(Number(item.salePrice)));
            const basePrice = BigInt(Math.floor(Number(prod.price || 0)));
            const subtotal = qty * salePrice;
            calculatedSubtotal += subtotal;

            processedItems.push({
              id: 'si_' + now.toString(36) + '_' + Math.random().toString(36).substr(2, 7),
              productId: prod.id,
              productName: prod.name,
              categoryId: prod.category_id,
              quantity: Number(qty),
              basePrice: Number(basePrice),
              salePrice: Number(salePrice),
              subtotal: Number(subtotal)
            });
          }

          const subtotalNum = Number(calculatedSubtotal);
          if (manualDiscount > subtotalNum) {
            throw {
              code: 'INVALID_DISCOUNT',
              message: `Discount (${manualDiscount}) cannot exceed transaction subtotal (${subtotalNum})`
            };
          }

          const totalNum = subtotalNum - manualDiscount;

          // 6. Calculate allocated_discount for each line item (proportional allocation with remainder on final item)
          let allocatedSum = 0;
          for (let i = 0; i < processedItems.length; i++) {
            const it = processedItems[i];
            if (i === processedItems.length - 1) {
              it.allocatedDiscount = manualDiscount - allocatedSum;
            } else {
              const alloc = subtotalNum > 0
                ? Math.floor((manualDiscount * it.subtotal) / subtotalNum)
                : 0;
              it.allocatedDiscount = alloc;
              allocatedSum += alloc;
            }
          }

          // 7. Deduct stock and increment sold for all products
          for (const [pid, reqQty] of requestedQtyMap.entries()) {
            const prod = productMap.get(pid);
            const newQty = (prod.quantity !== null && prod.quantity !== undefined)
              ? (prod.quantity - reqQty)
              : null;
            const newSold = prod.sold + reqQty;
            const newVersion = (prod.version || 1) + 1;

            await client.query(
              'UPDATE products SET quantity = $1, sold = $2, version = $3, updated_at = $4 WHERE id = $5',
              [newQty, newSold, newVersion, now, pid]
            );

            // Append product update delta to changes
            await client.query(
              'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
              ['product', pid, 'UPDATE', { id: pid, quantity: newQty, sold: newSold, version: newVersion, isDeleted: false, updatedAt: now }, now]
            );
          }

          // 8. Insert into sales table
          await client.query(
            `INSERT INTO sales (id, seller_id, status, subtotal, discount, total, currency, notes, created_at, updated_at, is_deleted)
             VALUES ($1, $2, 'COMPLETED', $3, $4, $5, 'UZS', $6, $7, $8, FALSE)`,
            [
              saleId,
              sellerId || 'seller-01',
              subtotalNum,
              manualDiscount,
              totalNum,
              notes ? notes.trim() : null,
              timestamp || now,
              now
            ]
          );

          // 9. Insert into sale_items table
          for (const it of processedItems) {
            await client.query(
              `INSERT INTO sale_items (id, sale_id, product_id, product_name_snapshot, quantity, base_price, sale_price, subtotal, allocated_discount, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                it.id,
                saleId,
                it.productId,
                it.productName,
                it.quantity,
                it.basePrice,
                it.salePrice,
                it.subtotal,
                it.allocatedDiscount,
                timestamp || now
              ]
            );
          }

          // 10. Insert activity record for audit timeline
          const totalUnitsSold = processedItems.reduce((sum, i) => sum + i.quantity, 0);
          const firstProduct = processedItems[0];
          const isOptom = processedItems.length > 1 || manualDiscount > 0;
          const displayProductName = isOptom ? 'Optom sale' : (firstProduct ? firstProduct.productName : 'Sale');
          const summaryNote = processedItems.length === 1
            ? `POS sale (${firstProduct.quantity}x @ ${firstProduct.salePrice})`
            : `POS multi-item sale (${processedItems.length} items, ${totalUnitsSold} units, total: ${totalNum} UZS${manualDiscount > 0 ? `, discount: -${manualDiscount}` : ''})`;

          const activityId = payload.activityId || `act_${now}_${Math.random().toString(36).substr(2, 7)}`;
          const hasDetails = await checkActivitiesDetailsColumns(client);

          if (hasDetails) {
            await client.query(
              `INSERT INTO activities (id, type, timestamp, product_id, product_name, category_id, category_name, quantity, notes, previous_quantity, previous_sold, sale_id, discount, subtotal, items_count, items_json)
               VALUES ($1, 'sale', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
              [
                activityId,
                timestamp || now,
                firstProduct ? firstProduct.productId : null,
                displayProductName,
                firstProduct ? firstProduct.categoryId : null,
                isOptom ? 'Optom Multi-Sale' : 'POS Sale',
                totalUnitsSold,
                notes ? notes.trim() : summaryNote,
                firstProduct ? (productMap.get(firstProduct.productId)?.quantity ?? 0) : 0,
                firstProduct ? (productMap.get(firstProduct.productId)?.sold ?? 0) : 0,
                saleId,
                manualDiscount,
                subtotalNum,
                processedItems.length,
                JSON.stringify(processedItems)
              ]
            );
          } else {
            await client.query(
              `INSERT INTO activities (id, type, timestamp, product_id, product_name, category_id, category_name, quantity, notes, previous_quantity, previous_sold)
               VALUES ($1, 'sale', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                activityId,
                timestamp || now,
                firstProduct ? firstProduct.productId : null,
                displayProductName,
                firstProduct ? firstProduct.categoryId : null,
                isOptom ? 'Optom Multi-Sale' : 'POS Sale',
                totalUnitsSold,
                notes ? notes.trim() : summaryNote,
                firstProduct ? (productMap.get(firstProduct.productId)?.quantity ?? 0) : 0,
                firstProduct ? (productMap.get(firstProduct.productId)?.sold ?? 0) : 0
              ]
            );
          }

          // Append activity delta to changes
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['activity', activityId, 'CREATE', {
              id: activityId,
              type: 'sale',
              saleId,
              timestamp: Number(timestamp || now),
              productId: firstProduct ? firstProduct.productId : null,
              productName: displayProductName,
              categoryId: firstProduct ? firstProduct.categoryId : null,
              categoryName: isOptom ? 'Optom Multi-Sale' : 'POS Sale',
              quantity: totalUnitsSold,
              sellingPrice: processedItems.length === 1 ? firstProduct.salePrice : Math.round(totalNum / totalUnitsSold),
              totalSaleValue: totalNum,
              subtotal: subtotalNum,
              discount: manualDiscount,
              itemsCount: processedItems.length,
              items: processedItems,
              isOptom,
              notes: notes ? notes.trim() : summaryNote
            }, now]
          );

          // Append sale delta to changes
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['sale', saleId, 'CREATE', {
              id: saleId,
              sellerId: sellerId || 'seller-01',
              status: 'COMPLETED',
              subtotal: subtotalNum,
              discount: manualDiscount,
              total: totalNum,
              currency: 'UZS',
              notes: notes ? notes.trim() : null,
              items: processedItems,
              createdAt: Number(timestamp || now),
              updatedAt: now
            }, now]
          );

          // Record sync operation idempotency
          await client.query(
            'INSERT INTO sync_operations (id, device_id, type, created_at, processed_at, result, payload_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [op.id, deviceId, op.type, op.createdAt || now, now, { accepted: true, saleId }, currentHash]
          );

          await client.query('COMMIT');
          accepted.push(op.id);
          continue;
        } else if (op.type === 'SALE') {
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

          // If product.quantity !== null, stock is tracked: enforce availability
          if (product.quantity !== null && product.quantity !== undefined) {
            if (product.quantity <= 0 || product.quantity < saleQty) {
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
          }

          // Apply stock decrement if tracked, otherwise preserve null (untracked inventory)
          const newQty = (product.quantity !== null && product.quantity !== undefined)
            ? (product.quantity - saleQty)
            : null;
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

          const unitPrice = Number(payload.sellingPrice) || Number(product.price) || 0;
          const totalValue = unitPrice * saleQty;
          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['activity', activityId, 'CREATE', {
              id: activityId,
              type: 'sale',
              timestamp: Number(timestamp || now),
              productId: product.id,
              productName: product.name,
              categoryId: product.category_id,
              categoryName: categoryName,
              quantity: saleQty,
              sellingPrice: unitPrice,
              totalSaleValue: totalValue,
              notes: notes ? notes.trim() : `POS sale (${saleQty}x @ ${unitPrice})`
            }, now]
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

          const newQty = (product.quantity !== null && product.quantity !== undefined)
            ? (product.quantity + restockQty)
            : restockQty;
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
          const { id, categoryId, name, quantity, sold, price, notes, image, translations, createdAt } = payload;
          if (!isValidId(id)) throw { code: 'INVALID_PAYLOAD', message: 'Valid product id required' };
          if (!isValidName(name)) throw { code: 'INVALID_PAYLOAD', message: 'Product name must be 1-200 characters' };
          if (categoryId && !isValidId(categoryId)) throw { code: 'INVALID_PAYLOAD', message: 'Invalid categoryId' };
          if (!isValidNotes(notes)) throw { code: 'INVALID_PAYLOAD', message: 'Notes must be under 1,000 characters' };
          if (!isValidPrice(price)) throw { code: 'INVALID_PAYLOAD', message: 'Base catalog price is required and must be a positive number > 0' };

          let initialQty = null;
          if (quantity !== undefined && quantity !== null && quantity !== '') {
            const q = Number(quantity);
            if (!Number.isFinite(q) || q < 0 || q > 1000000 || !Number.isInteger(q)) {
              throw { code: 'INVALID_PAYLOAD', message: 'Product quantity must be a non-negative finite integer' };
            }
            initialQty = q;
          }

          const initialSold = Number(sold);
          if (sold !== undefined && (!Number.isFinite(initialSold) || initialSold < 0 || !Number.isInteger(initialSold))) {
            throw { code: 'INVALID_PAYLOAD', message: 'Product sold must be a non-negative finite integer' };
          }

          const sanitizedPrice = Number(price);
          const imageRef = (typeof image === 'string' && image.trim().length > 0) ? image.trim() : null;
          const translationsObj = (translations && typeof translations === 'object') ? translations : {};
          const translationsData = JSON.stringify(translationsObj);

          await client.query(
            `INSERT INTO products (id, category_id, name, quantity, sold, price, notes, image, translations, is_deleted, version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, FALSE, 1, $10, $11)
             ON CONFLICT (id) DO UPDATE SET
               category_id = EXCLUDED.category_id,
               name = EXCLUDED.name,
               quantity = EXCLUDED.quantity,
               sold = EXCLUDED.sold,
               price = EXCLUDED.price,
               notes = EXCLUDED.notes,
               image = EXCLUDED.image,
               translations = EXCLUDED.translations,
               is_deleted = FALSE,
               version = products.version + 1,
               updated_at = EXCLUDED.updated_at`,
            [id, categoryId || null, name.trim(), initialQty, initialSold || 0, sanitizedPrice, notes ? notes.trim() : '', imageRef, translationsData, createdAt || now, now]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', id, 'CREATE', { id, categoryId: categoryId || null, name: name.trim(), quantity: initialQty, sold: initialSold || 0, price: sanitizedPrice, notes: notes ? notes.trim() : '', image: imageRef, translations: translationsObj, isDeleted: false, version: 1, createdAt: createdAt || now, updatedAt: now }, now]
          );

        } else if (op.type === 'UPDATE_PRODUCT') {
          const { id, categoryId, name, quantity, sold, price, notes, image, translations, expectedVersion } = payload;
          if (!isValidId(id)) throw { code: 'INVALID_PAYLOAD', message: 'Product id required for update' };
          if (name !== undefined && !isValidName(name)) throw { code: 'INVALID_PAYLOAD', message: 'Product name must be 1-200 characters' };
          if (categoryId && !isValidId(categoryId)) throw { code: 'INVALID_PAYLOAD', message: 'Invalid categoryId' };
          if (!isValidNotes(notes)) throw { code: 'INVALID_PAYLOAD', message: 'Notes must be under 1,000 characters' };
          if (price !== undefined && !isValidPrice(price)) throw { code: 'INVALID_PAYLOAD', message: 'Base catalog price must be a positive number > 0' };

          const prodRes = await client.query(
            'SELECT id, name, category_id, quantity::float, sold::float, price::float, notes, image, translations, is_deleted, version FROM products WHERE id = $1 FOR UPDATE',
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

          let updatedQty = product.quantity;
          if (quantity !== undefined) {
            if (quantity === null || quantity === '') {
              updatedQty = null;
            } else {
              const q = Number(quantity);
              if (!Number.isFinite(q) || q < 0 || q > 1000000 || !Number.isInteger(q)) {
                throw { code: 'INVALID_PAYLOAD', message: 'Product quantity must be a non-negative finite integer' };
              }
              updatedQty = q;
            }
          }

          const newVersion = (product.version || 1) + 1;
          const sanitizedPrice = (price !== undefined) ? Number(price) : product.price;
          const imageRef = (image !== undefined) ? (typeof image === 'string' && image.trim().length > 0 ? image.trim() : null) : product.image;
          const translationsObj = (translations !== undefined)
            ? ((translations && typeof translations === 'object') ? translations : {})
            : (product.translations || {});
          const translationsData = (translations !== undefined) ? JSON.stringify(translationsObj) : null;

          await client.query(
            `UPDATE products SET
               category_id = COALESCE($1, category_id),
               name = COALESCE($2, name),
               quantity = $3,
               sold = COALESCE($4, sold),
               price = $5,
               notes = CASE WHEN $6::boolean THEN $7::text ELSE notes END,
               image = CASE WHEN $8::boolean THEN $9::text ELSE image END,
               translations = CASE WHEN $10::boolean THEN $11::jsonb ELSE translations END,
               version = $12,
               updated_at = $13
             WHERE id = $14`,
            [
              categoryId,
              name ? name.trim() : null,
              updatedQty,
              sold !== undefined ? Number(sold) : null,
              sanitizedPrice,
              notes !== undefined,
              notes !== undefined ? (notes ? notes.trim() : '') : null,
              image !== undefined,
              imageRef,
              translations !== undefined,
              translationsData,
              newVersion,
              now,
              id
            ]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['product', id, 'UPDATE', { id, categoryId: categoryId || product.category_id, name: name ? name.trim() : product.name, quantity: updatedQty, sold: sold !== undefined ? Number(sold) : product.sold, price: sanitizedPrice, notes: notes !== undefined ? notes : product.notes, image: imageRef, translations: translationsObj, version: newVersion, isDeleted: false, updatedAt: now }, now]
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

        } else if (op.type === 'CASH_OUT') {
          const { amount, reason, notes, timestamp } = payload;
          const cashAmount = Number(amount);
          if (!Number.isFinite(cashAmount) || cashAmount <= 0) {
            throw { code: 'INVALID_PAYLOAD', message: 'Valid cash out amount required' };
          }
          const activityId = payload.activityId || `act_${now}_${Math.random().toString(36).substr(2, 7)}`;
          const reasonStr = typeof reason === 'string' ? reason : 'lunch';
          const notesStr = notes ? String(notes).trim() : '';

          await client.query(
            `INSERT INTO activities (id, type, timestamp, product_name, quantity, notes)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [activityId, 'cash_out', timestamp || now, reasonStr, cashAmount, notesStr]
          );

          await client.query(
            'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
            ['activity', activityId, 'CREATE', { id: activityId, type: 'cash_out', timestamp: Number(timestamp || now), amount: cashAmount, quantity: cashAmount, reason: reasonStr, notes: notesStr }, now]
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
