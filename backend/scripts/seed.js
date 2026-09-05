/**
 * SalesTrack — Administrative Database Seeder
 * Safely seeds default categories, products, and settings ONLY if database is completely empty.
 * Run manually via: node scripts/seed.js
 */

require('dotenv').config();
const { pool, runMigrations } = require('../db');

async function seed() {
  console.log('[seed] Checking database status...');
  await runMigrations();

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM products');
    if (rows[0].count > 0) {
      console.log(`[seed] Database already contains ${rows[0].count} products. Aborting seed to prevent overwriting.`);
      return;
    }

    console.log('[seed] Database is empty. Seeding initial default catalog...');
    const now = Date.now();

    await client.query('BEGIN');

    // 1. Categories
    const categories = [
      { id: 'cat_clothes', name: 'Clothes', createdAt: now },
      { id: 'cat_shoes', name: 'Shoes', createdAt: now },
      { id: 'cat_electronics', name: 'Electronics', createdAt: now },
      { id: 'cat_accessories', name: 'Accessories', createdAt: now },
    ];

    for (const c of categories) {
      await client.query(
        'INSERT INTO categories (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)',
        [c.id, c.name, c.createdAt, now]
      );
      await client.query(
        'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
        ['category', c.id, 'CREATE', { ...c, updatedAt: now }, now]
      );
    }

    // 2. Products
    const products = [
      { id: 'prod_1', categoryId: 'cat_clothes', name: 'Atlas Jacket', quantity: 12, sold: 5, price: 89.99, notes: 'Premium winter collection' },
      { id: 'prod_2', categoryId: 'cat_clothes', name: 'Shuba Coat', quantity: 8, sold: 3, price: 149.99, notes: 'Russian style fur coat' },
      { id: 'prod_3', categoryId: 'cat_clothes', name: 'Hoodie Pro', quantity: 25, sold: 12, price: 59.99, notes: '' },
      { id: 'prod_4', categoryId: 'cat_shoes', name: 'Running Sneakers', quantity: 18, sold: 7, price: 79.99, notes: 'Size 42-45 available' },
      { id: 'prod_5', categoryId: 'cat_shoes', name: 'Leather Boots', quantity: 6, sold: 2, price: 129.99, notes: 'Handmade leather' },
      { id: 'prod_6', categoryId: 'cat_electronics', name: 'Wireless Earbuds', quantity: 30, sold: 15, price: 49.99, notes: 'Bluetooth 5.3' },
      { id: 'prod_7', categoryId: 'cat_electronics', name: 'Smart Watch', quantity: 10, sold: 4, price: 199.99, notes: 'Heart rate monitor' },
      { id: 'prod_8', categoryId: 'cat_accessories', name: 'Leather Belt', quantity: 20, sold: 6, price: 34.99, notes: '' },
      { id: 'prod_9', categoryId: 'cat_accessories', name: 'Sunglasses', quantity: 15, sold: 3, price: 44.99, notes: 'UV400 protection' },
    ];

    for (const p of products) {
      await client.query(
        `INSERT INTO products (id, category_id, name, quantity, sold, price, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [p.id, p.categoryId, p.name, p.quantity, p.sold, p.price, p.notes, now, now]
      );
      await client.query(
        'INSERT INTO changes (entity_type, entity_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
        ['product', p.id, 'CREATE', { ...p, createdAt: now, updatedAt: now }, now]
      );
    }

    // 3. Settings
    const defaultSettings = {
      lastResetDate: null,
      currency: 'UZS'
    };
    await client.query(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)',
      ['general', JSON.stringify(defaultSettings), now]
    );

    await client.query('COMMIT');
    console.log(`[seed] Successfully seeded ${categories.length} categories and ${products.length} products!`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] Failed to seed database:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('[seed error]', err);
  process.exit(1);
});
