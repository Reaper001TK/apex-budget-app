const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'apex_budget_super_secret_jwt_key_2026';

// Middleware (Increased payload limit to 10MB to handle photo uploads)
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Connect to PostgreSQL Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize Relational Schema & Migration
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migration: ensure categories table has user_id
        await pool.query(`
            DO $$ 
            BEGIN 
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables WHERE table_name='categories'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns WHERE table_name='categories' AND column_name='user_id'
                ) THEN 
                    DROP TABLE IF EXISTS transactions CASCADE;
                    DROP TABLE IF EXISTS categories CASCADE;
                END IF;
            END $$;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                target_limit NUMERIC NOT NULL
            );
        `);

        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'categories_user_id_name_key'
                ) THEN
                    ALTER TABLE categories ADD CONSTRAINT categories_user_id_name_key UNIQUE (user_id, name);
                END IF;
            EXCEPTION
                WHEN OTHERS THEN NULL;
            END $$;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                description TEXT NOT NULL,
                amount NUMERIC NOT NULL,
                type TEXT CHECK(type IN ('income', 'expense')) NOT NULL,
                category_name TEXT NOT NULL,
                date TEXT NOT NULL,
                receipt_image TEXT
            );
        `);

        // Migration: Add receipt_image column if missing
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='receipt_image'
                ) THEN
                    ALTER TABLE transactions ADD COLUMN receipt_image TEXT;
                END IF;
            END $$;
        `);

        console.log('⚡ PostgreSQL Multi-User Schema with Receipts Ready!');
    } catch (err) {
        console.error('Database Initialization Error:', err.message);
    }
}

initDb();

// Middleware: Authenticate JWT Token
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required. Please log in.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired or invalid. Please log in again.' });
        req.user = user;
        next();
    });
}

// --- AUTHENTICATION ROUTES ---

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const emailLower = email.toLowerCase().trim();
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [emailLower]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Email is already registered.' });

        const passwordHash = await bcrypt.hash(password, 10);
        const userRes = await pool.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
            [emailLower, passwordHash]
        );
        const user = userRes.rows[0];

        await pool.query(`
            INSERT INTO categories (user_id, name, target_limit) VALUES
            ($1, 'Housing & Utilities', 1500),
            ($1, 'Groceries', 600),
            ($1, 'Dining & Fun', 300),
            ($1, 'Investments & Savings', 1000),
            ($1, 'Transportation', 250);
        `, [user.id]);

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const emailLower = email.toLowerCase().trim();

        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [emailLower]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password.' });

        const user = userRes.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(400).json({ error: 'Invalid email or password.' });

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- PROTECTED USER API ENDPOINTS ---

app.get('/api/summary', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expenses
            FROM transactions
            WHERE user_id = $1;
        `;
        const result = await pool.query(query, [req.user.id]);
        const income = parseFloat(result.rows[0].total_income);
        const expenses = parseFloat(result.rows[0].total_expenses);
        const savings = income - expenses;
        const savingsRate = income > 0 ? ((savings / income) * 100).toFixed(1) : 0;

        res.json({ income, expenses, savings, savingsRate: parseFloat(savingsRate) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/categories', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT c.id, c.name, c.target_limit::float AS target_limit,
                   COALESCE(SUM(t.amount), 0)::float AS total_spent
            FROM categories c
            LEFT JOIN transactions t ON t.category_name = c.name AND t.user_id = c.user_id AND t.type = 'expense'
            WHERE c.user_id = $1
            GROUP BY c.id, c.name, c.target_limit
            ORDER BY c.id ASC;
        `;
        const result = await pool.query(query, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/categories', authenticateToken, async (req, res) => {
    try {
        const { name, limit } = req.body;
        if (!name || isNaN(limit)) {
            return res.status(400).json({ error: 'Valid category name and limit are required' });
        }

        const result = await pool.query(
            `INSERT INTO categories (user_id, name, target_limit) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (user_id, name) 
             DO UPDATE SET target_limit = EXCLUDED.target_limit 
             RETURNING *`,
            [req.user.id, name.trim(), limit]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/categories/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const limit = parseFloat(req.body.limit);
        const result = await pool.query(
            'UPDATE categories SET target_limit = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
            [limit, id, req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/categories/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        res.json({ success: true, deletedId: id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, description, amount::float, type, category_name, date, receipt_image FROM transactions WHERE user_id = $1 ORDER BY date DESC, id DESC',
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const { description, amount, type, category_name, date, receipt_image } = req.body;
        const result = await pool.query(
            'INSERT INTO transactions (user_id, description, amount, type, category_name, date, receipt_image) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [req.user.id, description, amount, type, category_name, date, receipt_image || null]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/transactions/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        res.json({ success: true, deletedId: id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Multi-User Budget App running on http://localhost:${PORT}`));