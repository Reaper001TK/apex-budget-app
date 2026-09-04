const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const compression = require('compression');
const nodemailer = require('nodemailer');
const dns = require('dns').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'apex_budget_super_secret_jwt_key_2026';

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// Connect to PostgreSQL Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Configure Email Transporter (Supports custom SMTP or Ethereal/Console fallback)
let mailTransporter;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    mailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_PORT == 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
} else {
    // Ethereal/Console Fallback Transporter
    mailTransporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        auth: { user: 'ethereal.user@ethereal.email', pass: 'ethereal_pass' }
    });
}

// Function: Verify Domain MX Records (Checks if domain can actually receive mail)
async function isValidEmailDomain(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return false;

    const domain = email.split('@')[1];
    try {
        const mxRecords = await dns.resolveMx(domain);
        return mxRecords && mxRecords.length > 0;
    } catch (err) {
        return false; // Domain has no MX records or doesn't exist
    }
}

// --- LIVE CURRENCY EXCHANGE RATE ENGINE ---
let cachedRates = { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 155.0, INR: 83.5, CAD: 1.36, AUD: 1.51, BRL: 5.4, MXN: 18.2, CHF: 0.89, KRW: 1375.0 };
let lastRatesFetch = 0;

async function getExchangeRates() {
    const now = Date.now();
    if (now - lastRatesFetch > 3600000) {
        try {
            const response = await fetch('https://open.er-api.com/v6/latest/USD');
            if (response.ok) {
                const data = await response.json();
                if (data && data.rates) {
                    cachedRates = data.rates;
                    lastRatesFetch = now;
                    console.log('🌐 Live Currency Exchange Rates updated successfully!');
                }
            }
        } catch (err) {
            console.error('Exchange Rate API Error (using cached fallback):', err.message);
        }
    }
    return cachedRates;
}

// Initialize Relational Schema & Migration
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                currency TEXT DEFAULT '$',
                is_verified BOOLEAN DEFAULT FALSE,
                verification_code TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migration: Add columns to users if missing
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_verified'
                ) THEN
                    ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT FALSE;
                    ALTER TABLE users ADD COLUMN verification_code TEXT;
                END IF;
            END $$;
        `);

        // Auto-verify existing accounts so older accounts aren't locked out
        await pool.query(`UPDATE users SET is_verified = TRUE WHERE is_verified IS NULL;`);
        await pool.query(`UPDATE users SET currency = '$' WHERE currency IS NULL;`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                target_limit NUMERIC NOT NULL
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS financial_accounts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                type TEXT CHECK(type IN ('checking', 'savings', 'investment', 'credit_card', 'loan')) NOT NULL,
                balance NUMERIC DEFAULT 0
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                account_id INTEGER REFERENCES financial_accounts(id) ON DELETE SET NULL,
                description TEXT NOT NULL,
                amount NUMERIC NOT NULL,
                type TEXT NOT NULL,
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

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date DESC);
            CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
            CREATE INDEX IF NOT EXISTS idx_goals_user ON savings_goals(user_id);
            CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_bills(user_id);
            CREATE INDEX IF NOT EXISTS idx_accounts_user ON financial_accounts(user_id);
        `);

        console.log('⚡ PostgreSQL Database & Email Verification System Ready!');
    } catch (err) {
        console.error('Database Initialization Error:', err.message);
    }
}

initDb();

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

// Live Exchange Rates Endpoint
app.get('/api/rates', async (req, res) => {
    const rates = await getExchangeRates();
    res.json({ base: 'USD', rates, last_updated: lastRatesFetch });
});

// --- AUTHENTICATION ROUTES WITH EMAIL VERIFICATION ---

// 1. Register User & Send OTP
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const emailLower = email.toLowerCase().trim();

        // REAL EMAIL DOMAIN CHECK
        const validDomain = await isValidEmailDomain(emailLower);
        if (!validDomain) {
            const domain = emailLower.split('@')[1] || 'entered';
            return res.status(400).json({ error: `The domain '${domain}' cannot receive emails. Please enter a valid email address.` });
        }

        const existing = await pool.query('SELECT id, is_verified FROM users WHERE email = $1', [emailLower]);
        if (existing.rows.length > 0) {
            if (existing.rows[0].is_verified) {
                return res.status(400).json({ error: 'Email is already registered. Please sign in.' });
            }
        }

        // Generate 6-Digit OTP Code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const passwordHash = await bcrypt.hash(password, 10);

        let user;
        if (existing.rows.length > 0) {
            // Update unverified existing record
            const updateRes = await pool.query(
                'UPDATE users SET password_hash = $1, verification_code = $2 WHERE email = $3 RETURNING id, email',
                [passwordHash, verificationCode, emailLower]
            );
            user = updateRes.rows[0];
        } else {
            // Insert new user
            const userRes = await pool.query(
                'INSERT INTO users (email, password_hash, verification_code, is_verified) VALUES ($1, $2, $3, FALSE) RETURNING id, email',
                [emailLower, passwordHash, verificationCode]
            );
            user = userRes.rows[0];

            // Seed starter categories & accounts
            await pool.query(`
                INSERT INTO categories (user_id, name, target_limit) VALUES
                ($1, 'Housing & Utilities', 1500),
                ($1, 'Groceries', 600),
                ($1, 'Dining & Fun', 300),
                ($1, 'Investments & Savings', 1000),
                ($1, 'Transportation', 250);
            `, [user.id]);

            await pool.query(`
                INSERT INTO financial_accounts (user_id, name, type, balance) VALUES
                ($1, 'Primary Checking', 'checking', 2500),
                ($1, 'Emergency Savings', 'savings', 5000),
                ($1, 'Main Credit Card', 'credit_card', 450);
            `, [user.id]);
        }

        // Send Email Verification Code
        console.log(`✉️ VERIFICATION CODE FOR ${emailLower}: [ ${verificationCode} ]`);
        try {
            await mailTransporter.sendMail({
                from: '"ApexBudget SaaS" <no-reply@apexbudget.com>',
                to: emailLower,
                subject: 'Your ApexBudget Verification Code',
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #0f172a; color: #f8fafc; rounded-corner: 10px;">
                        <h2 style="color: #3b82f6;">⚡ ApexBudget Verification</h2>
                        <p>Welcome to ApexBudget! Your 6-digit email verification code is:</p>
                        <h1 style="font-size: 32px; letter-spacing: 5px; color: #10b981; background: #1e293b; padding: 10px 20px; width: fit-content; border-radius: 8px;">${verificationCode}</h1>
                        <p style="font-size: 12px; color: #94a3b8;">Enter this code on the registration screen to activate your account.</p>
                    </div>
                `
            });
        } catch (mailErr) {
            console.error('Mail dispatch notice:', mailErr.message);
        }

        res.json({ requires_verification: true, email: emailLower, message: 'Verification code sent to your email.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Verify OTP & Activate Account
app.post('/api/auth/verify-email', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.status(400).json({ error: 'Email and 6-digit code required.' });

        const emailLower = email.toLowerCase().trim();
        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [emailLower]);

        if (userRes.rows.length === 0) return res.status(400).json({ error: 'User not found.' });

        const user = userRes.rows[0];
        if (user.verification_code !== code.trim()) {
            return res.status(400).json({ error: 'Invalid 6-digit verification code. Please check your inbox or logs.' });
        }

        // Mark User as Verified
        await pool.query('UPDATE users SET is_verified = TRUE, verification_code = NULL WHERE id = $1', [user.id]);

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, currency: user.currency || '$' } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const emailLower = email.toLowerCase().trim();

        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [emailLower]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password.' });

        const user = userRes.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(400).json({ error: 'Invalid email or password.' });

        if (user.is_verified === false) {
            return res.status(400).json({ error: 'Email not verified. Please register again to receive a new code.' });
        }

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, currency: user.currency || '$' } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/user/currency', authenticateToken, async (req, res) => {
    try {
        const { currency } = req.body;
        if (!currency) return res.status(400).json({ error: 'Currency symbol required' });

        await pool.query('UPDATE users SET currency = $1 WHERE id = $2', [currency, req.user.id]);
        res.json({ success: true, currency });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/user/account', authenticateToken, async (req, res) => {
    try {
        const uid = req.user.id;
        await pool.query('DELETE FROM transactions WHERE user_id = $1', [uid]);
        await pool.query('DELETE FROM categories WHERE user_id = $1', [uid]);
        await pool.query('DELETE FROM savings_goals WHERE user_id = $1', [uid]);
        await pool.query('DELETE FROM recurring_bills WHERE user_id = $1', [uid]);
        await pool.query('DELETE FROM financial_accounts WHERE user_id = $1', [uid]);
        await pool.query('DELETE FROM users WHERE id = $1', [uid]);

        res.json({ success: true, message: 'Account permanently deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ACCOUNT TRANSFER API ---

app.post('/api/transfers', authenticateToken, async (req, res) => {
    try {
        const { from_account_id, to_account_id, amount, date, description } = req.body;
        const amountNum = parseFloat(amount);

        if (!from_account_id || !to_account_id || isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ error: 'Source account, destination account, and positive amount required.' });
        }

        if (parseInt(from_account_id) === parseInt(to_account_id)) {
            return res.status(400).json({ error: 'Source and destination accounts must be different.' });
        }

        const fromAccRes = await pool.query('SELECT name FROM financial_accounts WHERE id = $1 AND user_id = $2', [from_account_id, req.user.id]);
        const toAccRes = await pool.query('SELECT name FROM financial_accounts WHERE id = $1 AND user_id = $2', [to_account_id, req.user.id]);

        if (fromAccRes.rows.length === 0 || toAccRes.rows.length === 0) {
            return res.status(404).json({ error: 'One or both financial accounts not found.' });
        }

        const fromAcc = fromAccRes.rows[0];
        const toAcc = toAccRes.rows[0];

        await pool.query('UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [amountNum, from_account_id, req.user.id]);
        await pool.query('UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [amountNum, to_account_id, req.user.id]);

        const desc = description ? `${description} (${fromAcc.name} ➔ ${toAcc.name})` : `Transfer: ${fromAcc.name} ➔ ${toAcc.name}`;
        const txRes = await pool.query(
            'INSERT INTO transactions (user_id, account_id, description, amount, type, category_name, date) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [req.user.id, from_account_id, desc, amountNum, 'transfer', 'Transfer', date || new Date().toISOString().slice(0, 10)]
        );

        res.json({ success: true, transaction: txRes.rows[0], fromAccount: fromAcc.name, toAccount: toAcc.name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SUMMARY API ---

app.get('/api/summary', authenticateToken, async (req, res) => {
    try {
        const month = req.query.month || new Date().toISOString().slice(0, 7);
        
        const userRes = await pool.query('SELECT currency FROM users WHERE id = $1', [req.user.id]);
        const currency = userRes.rows[0]?.currency || '$';

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

        res.json({ income, expenses, savings, savingsRate: parseFloat(savingsRate), month, currency });
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
        if (!name || isNaN(limit)) return res.status(400).json({ error: 'Valid category name and limit required' });

        const cleanName = name.trim();
        const limitNum = parseFloat(limit);

        const existing = await pool.query(
            'SELECT id FROM categories WHERE user_id = $1 AND LOWER(name) = LOWER($2)',
            [req.user.id, cleanName]
        );

        let result;
        if (existing.rows.length > 0) {
            result = await pool.query(
                'UPDATE categories SET target_limit = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
                [limitNum, existing.rows[0].id, req.user.id]
            );
        } else {
            result = await pool.query(
                'INSERT INTO categories (user_id, name, target_limit) VALUES ($1, $2, $3) RETURNING *',
                [req.user.id, cleanName, limitNum]
            );
        }

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
        let query = `
            SELECT t.id, t.description, t.amount::float, t.type, t.category_name, t.date, t.receipt_image, t.account_id,
                   a.name AS account_name, a.type AS account_type
            FROM transactions t
            LEFT JOIN financial_accounts a ON a.id = t.account_id
            WHERE t.user_id = $1
        `;
        let params = [req.user.id];
        
        if (month) {
            query += ' AND t.date LIKE $2 || \'%\'';
            params.push(month);
        }
        
        query += ' ORDER BY t.date DESC, t.id DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const { description, amount, type, category_name, date, receipt_image, account_id } = req.body;
        const amountNum = parseFloat(amount);

        if (isNaN(amountNum) || !type || !category_name) {
            return res.status(400).json({ error: 'Valid amount, type, and category required.' });
        }

        const result = await pool.query(
            'INSERT INTO transactions (user_id, account_id, description, amount, type, category_name, date, receipt_image) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [req.user.id, account_id || null, description, amountNum, type, category_name, date, receipt_image || null]
        );

        if (account_id) {
            const accRes = await pool.query('SELECT type FROM financial_accounts WHERE id = $1 AND user_id = $2', [account_id, req.user.id]);
            if (accRes.rows.length > 0) {
                const isDebtAccount = ['credit_card', 'loan'].includes(accRes.rows[0].type);

                if (type === 'expense') {
                    if (isDebtAccount) {
                        await pool.query('UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [amountNum, account_id, req.user.id]);
                    } else {
                        await pool.query('UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [amountNum, account_id, req.user.id]);
                    }
                } else if (type === 'income') {
                    if (isDebtAccount) {
                        await pool.query('UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [amountNum, account_id, req.user.id]);
                    } else {
                        await pool.query('UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [amountNum, account_id, req.user.id]);
                    }
                }
            }
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/transactions/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        const txRes = await pool.query('SELECT amount::float, type, account_id FROM transactions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        
        if (txRes.rows.length > 0) {
            const tx = txRes.rows[0];
            if (tx.account_id) {
                const accRes = await pool.query('SELECT type FROM financial_accounts WHERE id = $1 AND user_id = $2', [tx.account_id, req.user.id]);
                if (accRes.rows.length > 0) {
                    const isDebtAccount = ['credit_card', 'loan'].includes(accRes.rows[0].type);

                    if (tx.type === 'expense') {
                        if (isDebtAccount) {
                            await pool.query('UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [tx.amount, tx.account_id, req.user.id]);
                        } else {
                            await pool.query('UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [tx.amount, tx.account_id, req.user.id]);
                        }
                    } else if (tx.type === 'income') {
                        if (isDebtAccount) {
                            await pool.query('UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [tx.amount, tx.account_id, req.user.id]);
                        } else {
                            await pool.query('UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [tx.amount, tx.account_id, req.user.id]);
                        }
                    }
                }
            }
        }

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

// --- FINANCIAL ACCOUNTS API ---

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