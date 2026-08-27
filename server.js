const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'apex_budget_super_secret_jwt_key_2026';

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

        // Migration check for categories
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
            EXCEPTION WHEN OTHERS THEN NULL;
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

        await pool.query(`
            CREATE TABLE IF NOT EXISTS savings_goals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                target_amount NUMERIC NOT NULL,
                current_amount NUMERIC DEFAULT 0,
                target_date TEXT
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS recurring_bills (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                amount NUMERIC NOT NULL,
                billing_cycle TEXT CHECK(billing_cycle IN ('monthly', 'yearly')) DEFAULT 'monthly',
                category_name TEXT NOT NULL,
                due_day INTEGER DEFAULT 1
            );
        `);

        // New Table: Financial Accounts & Net Worth Tracker
        await pool.query(`
            CREATE TABLE IF NOT EXISTS financial_accounts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                type TEXT CHECK(type IN ('checking', 'savings', 'investment', 'credit_card', 'loan')) NOT NULL,
                balance NUMERIC DEFAULT 0
            );
        `);

        console.log('⚡ PostgreSQL Multi-User Schema with Accounts & AI Insights Ready!');
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

// --- AUTH ROUTES ---

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

        // Seed default starter categories
        await pool.query(`
            INSERT INTO categories (user_id, name, target_limit) VALUES
            ($1, 'Housing & Utilities', 1500),
            ($1, 'Groceries', 600),
            ($1, 'Dining & Fun', 300),
            ($1, 'Investments & Savings', 1000),
            ($1, 'Transportation', 250);
        `, [user.id]);

        // Seed starter accounts
        await pool.query(`
            INSERT INTO financial_accounts (user_id, name, type, balance) VALUES
            ($1, 'Primary Checking', 'checking', 2500),
            ($1, 'Emergency Savings', 'savings', 5000),
            ($1, 'Main Credit Card', 'credit_card', 450);
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

// --- SUMMARY API ---

app.get('/api/summary', authenticateToken, async (req, res) => {
    try {
        const month = req.query.month || new Date().toISOString().slice(0, 7);
        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expenses
            FROM transactions
            WHERE user_id = $1 AND date LIKE $2 || '%';
        `;
        const result = await pool.query(query, [req.user.id, month]);
        const income = parseFloat(result.rows[0].total_income);
        const expenses = parseFloat(result.rows[0].total_expenses);
        const savings = income - expenses;
        const savingsRate = income > 0 ? ((savings / income) * 100).toFixed(1) : 0;

        res.json({ income, expenses, savings, savingsRate: parseFloat(savingsRate), month });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- CATEGORIES API ---

app.get('/api/categories', authenticateToken, async (req, res) => {
    try {
        const month = req.query.month || new Date().toISOString().slice(0, 7);
        const query = `
            SELECT c.id, c.name, c.target_limit::float AS target_limit,
                   COALESCE(SUM(t.amount), 0)::float AS total_spent
            FROM categories c
            LEFT JOIN transactions t ON t.category_name = c.name 
                                    AND t.user_id = c.user_id 
                                    AND t.type = 'expense'
                                    AND t.date LIKE $2 || '%'
            WHERE c.user_id = $1
            GROUP BY c.id, c.name, c.target_limit
            ORDER BY c.id ASC;
        `;
        const result = await pool.query(query, [req.user.id, month]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/categories', authenticateToken, async (req, res) => {
    try {
        const { name, limit } = req.body;
        if (!name || isNaN(limit)) return res.status(400).json({ error: 'Valid category name and limit are required' });

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

// --- TRANSACTIONS API ---

app.get('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const month = req.query.month;
        let query = 'SELECT id, description, amount::float, type, category_name, date, receipt_image FROM transactions WHERE user_id = $1';
        let params = [req.user.id];
        
        if (month) {
            query += ' AND date LIKE $2 || \'%\'';
            params.push(month);
        }
        
        query += ' ORDER BY date DESC, id DESC';
        const result = await pool.query(query, params);
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

// --- SAVINGS GOALS API ---

app.get('/api/goals', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, title, target_amount::float, current_amount::float, target_date FROM savings_goals WHERE user_id = $1 ORDER BY id ASC', [req.user.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/goals', authenticateToken, async (req, res) => {
    try {
        const { title, target_amount, current_amount, target_date } = req.body;
        const result = await pool.query(
            'INSERT INTO savings_goals (user_id, title, target_amount, current_amount, target_date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [req.user.id, title, target_amount, current_amount || 0, target_date || null]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/goals/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { current_amount } = req.body;
        const result = await pool.query(
            'UPDATE savings_goals SET current_amount = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
            [current_amount, id, req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/goals/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM savings_goals WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        res.json({ success: true, deletedId: id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- RECURRING BILLS API ---

app.get('/api/recurring', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, amount::float, billing_cycle, category_name, due_day FROM recurring_bills WHERE user_id = $1 ORDER BY due_day ASC', [req.user.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/recurring', authenticateToken, async (req, res) => {
    try {
        const { name, amount, billing_cycle, category_name, due_day } = req.body;
        const result = await pool.query(
            'INSERT INTO recurring_bills (user_id, name, amount, billing_cycle, category_name, due_day) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [req.user.id, name, amount, billing_cycle || 'monthly', category_name, due_day || 1]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/recurring/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM recurring_bills WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        res.json({ success: true, deletedId: id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- FINANCIAL ACCOUNTS / NET WORTH API ---

app.get('/api/accounts', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, type, balance::float FROM financial_accounts WHERE user_id = $1 ORDER BY id ASC', [req.user.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts', authenticateToken, async (req, res) => {
    try {
        const { name, type, balance } = req.body;
        const result = await pool.query(
            'INSERT INTO financial_accounts (user_id, name, type, balance) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.user.id, name, type, balance || 0]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/accounts/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { balance } = req.body;
        const result = await pool.query(
            'UPDATE financial_accounts SET balance = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
            [balance, id, req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/accounts/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM financial_accounts WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        res.json({ success: true, deletedId: id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`🚀 Multi-User Budget App running on http://localhost:${PORT}`));