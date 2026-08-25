const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to PostgreSQL (Reads DATABASE_URL from Render automatically)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize Database Tables & Seed Default Data
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                target_limit NUMERIC NOT NULL
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                description TEXT NOT NULL,
                amount NUMERIC NOT NULL,
                type TEXT CHECK(type IN ('income', 'expense')) NOT NULL,
                category_name TEXT NOT NULL,
                date TEXT NOT NULL
            );
        `);

        const catRes = await pool.query('SELECT COUNT(*) FROM categories');
        if (parseInt(catRes.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO categories (name, target_limit) VALUES
                ('Housing & Utilities', 1500),
                ('Groceries', 600),
                ('Dining & Fun', 300),
                ('Investments & Savings', 1000),
                ('Transportation', 250);
            `);

            await pool.query(`
                INSERT INTO transactions (description, amount, type, category_name, date) VALUES
                ('Monthly Salary', 4500, 'income', 'Income', '2026-08-01'),
                ('Apartment Rent', 1200, 'expense', 'Housing & Utilities', '2026-08-02'),
                ('Supermarket Groceries', 185.50, 'expense', 'Groceries', '2026-08-05');
            `);
        }
        console.log('⚡ PostgreSQL Database connected & initialized successfully!');
    } catch (err) {
        console.error('Error initializing PostgreSQL database:', err.message);
    }
}

initDb();

// --- REST API ENDPOINTS ---

app.get('/api/summary', async (req, res) => {
    try {
        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expenses
            FROM transactions;
        `;
        const result = await pool.query(query);
        const income = parseFloat(result.rows[0].total_income);
        const expenses = parseFloat(result.rows[0].total_expenses);
        const savings = income - expenses;
        const savingsRate = income > 0 ? ((savings / income) * 100).toFixed(1) : 0;

        res.json({
            income,
            expenses,
            savings,
            savingsRate: parseFloat(savingsRate)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/categories', async (req, res) => {
    try {
        const query = `
            SELECT c.id, c.name, c.target_limit::float AS target_limit,
                   COALESCE(SUM(t.amount), 0)::float AS total_spent
            FROM categories c
            LEFT JOIN transactions t ON t.category_name = c.name AND t.type = 'expense'
            GROUP BY c.id, c.name, c.target_limit
            ORDER BY c.id ASC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/categories', async (req, res) => {
    try {
        const { name, limit } = req.body;
        const result = await pool.query(
            'INSERT INTO categories (name, target_limit) VALUES ($1, $2) RETURNING *',
            [name, limit]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/categories/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const limit = parseFloat(req.body.limit);
        const result = await pool.query(
            'UPDATE categories SET target_limit = $1 WHERE id = $2 RETURNING *',
            [limit, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/categories/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM categories WHERE id = $1', [id]);
        res.json({ success: true, deletedId: id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/transactions', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, description, amount::float, type, category_name, date FROM transactions ORDER BY date DESC, id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/transactions', async (req, res) => {
    try {
        const { description, amount, type, category_name, date } = req.body;
        const result = await pool.query(
            'INSERT INTO transactions (description, amount, type, category_name, date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [description, amount, type, category_name, date]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
        res.json({ success: true, deletedId: id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Budget App running with PostgreSQL on http://localhost:${PORT}`));