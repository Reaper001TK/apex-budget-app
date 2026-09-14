const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const https = require('https');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const compression = require('compression');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'apex_budget_super_secret_jwt_key_2026';
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'apex_budget_super_secret_32byte_key_1234';

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

// --- AES-256-GCM BANK ENCRYPTION HELPERS ---
function encryptToken(text) {
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(ENCRYPTION_SECRET, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptToken(encryptedData) {
    if (!encryptedData) return null;
    const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = crypto.scryptSync(ENCRYPTION_SECRET, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// --- TELLER API CLIENT (Native mTLS & HTTPS) ---
function tellerRequest(endpoint, accessToken) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.teller.io',
            port: 443,
            path: endpoint,
            method: 'GET',
            auth: `${accessToken}:`,
            headers: {
                'Teller-Version': '2020-10-12',
                'Content-Type': 'application/json'
            }
        };

        // If client certificates are provided in Render environment, attach for mTLS
        if (process.env.TELLER_CERT && process.env.TELLER_KEY) {
            options.cert = process.env.TELLER_CERT.replace(/\\n/g, '\n');
            options.key = process.env.TELLER_KEY.replace(/\\n/g, '\n');
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        return reject(new Error(parsed.error?.message || `Teller error (${res.statusCode})`));
                    }
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Failed to parse Teller response: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
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
                is_verified BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
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
            CREATE TABLE IF NOT EXISTS teller_enrollments (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                enrollment_id TEXT UNIQUE NOT NULL,
                access_token_encrypted TEXT NOT NULL,
                institution_name TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS financial_accounts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                type TEXT CHECK(type IN ('checking', 'savings', 'investment', 'credit_card', 'loan')) NOT NULL,
                balance NUMERIC DEFAULT 0,
                teller_account_id TEXT,
                teller_enrollment_id INTEGER REFERENCES teller_enrollments(id) ON DELETE CASCADE
            );
        `);

        // Migration: Ensure teller columns exist
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='financial_accounts' AND column_name='teller_account_id') THEN
                    ALTER TABLE financial_accounts ADD COLUMN teller_account_id TEXT;
                    ALTER TABLE financial_accounts ADD COLUMN teller_enrollment_id INTEGER REFERENCES teller_enrollments(id) ON DELETE CASCADE;
                END IF;
            END $$;
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
                receipt_image TEXT,
                teller_transaction_id TEXT UNIQUE
            );
        `);

        // Migration: Add teller_transaction_id if missing
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='teller_transaction_id') THEN
                    ALTER TABLE transactions ADD COLUMN teller_transaction_id TEXT UNIQUE;
                END IF;
            END $$;
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

        console.log('⚡ PostgreSQL Database & Teller.io Sync Engine Ready!');
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

// --- TELLER INTEGRATION ENDPOINTS ---

// 1. Get Teller Connect Configuration for Frontend
app.get('/api/teller/config', authenticateToken, (req, res) => {
    res.json({
        applicationId: process.env.TELLER_APPLICATION_ID || 'app_test_sandbox',
        environment: process.env.TELLER_ENV || 'sandbox'
    });
});

// 2. Connect Bank via Teller Token
app.post('/api/teller/connect', authenticateToken, async (req, res) => {
    try {
        const { accessToken, enrollmentId, institutionName } = req.body;
        if (!accessToken || !enrollmentId) {
            return res.status(400).json({ error: 'Teller access token and enrollment ID required.' });
        }

        // Encrypt Teller token before saving to database
        const encryptedToken = encryptToken(accessToken);

        // Save Enrollment
        const enrollRes = await pool.query(
            `INSERT INTO teller_enrollments (user_id, enrollment_id, access_token_encrypted, institution_name)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (enrollment_id) DO UPDATE SET access_token_encrypted = EXCLUDED.access_token_encrypted
             RETURNING id`,
            [req.user.id, enrollmentId, encryptedToken, institutionName || 'Bank']
        );
        const enrollmentDbId = enrollRes.rows[0].id;

        // Fetch Accounts from Teller API
        const accounts = await tellerRequest('/accounts', accessToken);

        for (const acc of accounts) {
            let accType = 'checking';
            if (acc.type === 'depository') {
                accType = acc.subtype === 'savings' ? 'savings' : 'checking';
            } else if (acc.type === 'credit') {
                accType = 'credit_card';
            }

            // Fetch live balances for account
            let balance = 0;
            try {
                const balData = await tellerRequest(`/accounts/${acc.id}/balances`, accessToken);
                balance = parseFloat(balData.available || balData.ledger || 0);
            } catch (bErr) {
                console.warn('Balance fetch note:', bErr.message);
            }

            const accName = `${institutionName || acc.institution?.name || 'Bank'} ${acc.name}`;

            await pool.query(
                `INSERT INTO financial_accounts (user_id, name, type, balance, teller_account_id, teller_enrollment_id)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [req.user.id, accName, accType, balance, acc.id, enrollmentDbId]
            );
        }

        res.json({ success: true, count: accounts.length, message: `Connected ${accounts.length} bank accounts successfully via Teller!` });
    } catch (err) {
        console.error('Teller Connect Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 3. Sync Live Bank Balances and Transactions from Teller
app.post('/api/teller/sync', authenticateToken, async (req, res) => {
    try {
        const enrollments = await pool.query('SELECT * FROM teller_enrollments WHERE user_id = $1', [req.user.id]);
        if (enrollments.rows.length === 0) {
            return res.status(400).json({ error: 'No linked bank accounts found. Click "Link Bank Account" first.' });
        }

        let totalSynced = 0;

        for (const enroll of enrollments.rows) {
            const accessToken = decryptToken(enroll.access_token_encrypted);
            if (!accessToken) continue;

            const accounts = await tellerRequest('/accounts', accessToken);

            for (const acc of accounts) {
                // Update live balance
                try {
                    const balData = await tellerRequest(`/accounts/${acc.id}/balances`, accessToken);
                    const balance = parseFloat(balData.available || balData.ledger || 0);
                    await pool.query(
                        'UPDATE financial_accounts SET balance = $1 WHERE teller_account_id = $2 AND user_id = $3',
                        [balance, acc.id, req.user.id]
                    );
                } catch (bErr) {
                    console.warn(bErr.message);
                }

                // Fetch live transactions
                try {
                    const transactions = await tellerRequest(`/accounts/${acc.id}/transactions`, accessToken);
                    
                    const dbAccRes = await pool.query('SELECT id FROM financial_accounts WHERE teller_account_id = $1 AND user_id = $2', [acc.id, req.user.id]);
                    const accountId = dbAccRes.rows.length > 0 ? dbAccRes.rows[0].id : null;

                    for (const tx of transactions) {
                        const rawAmount = parseFloat(tx.amount);
                        const amount = Math.abs(rawAmount);
                        const type = rawAmount > 0 ? 'expense' : 'income';
                        const desc = tx.description || 'Card Transaction';

                        const insRes = await pool.query(
                            `INSERT INTO transactions (user_id, account_id, description, amount, type, category_name, date, teller_transaction_id)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                             ON CONFLICT (teller_transaction_id) DO NOTHING`,
                            [req.user.id, accountId, desc, amount, type, 'Groceries', tx.date, tx.id]
                        );
                        if (insRes.rowCount > 0) totalSynced++;
                    }
                } catch (tErr) {
                    console.warn(tErr.message);
                }
            }
        }

        res.json({ success: true, syncedCount: totalSynced });
    } catch (err) {
        console.error('Teller Sync Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- AUTH ROUTES ---

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const emailLower = email.toLowerCase().trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(emailLower)) {
            return res.status(400).json({ error: 'Please enter a valid email address.' });
        }

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [emailLower]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'This email is already registered. Please sign in.' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const userRes = await pool.query(
            'INSERT INTO users (email, password_hash, currency, is_verified) VALUES ($1, $2, $3, TRUE) RETURNING id, email, currency',
            [emailLower, passwordHash, '$']
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
        await pool.query('DELETE FROM teller_enrollments WHERE user_id = $1', [uid]);
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

        const existing = await pool.query('SELECT id FROM categories WHERE user_id = $1 AND LOWER(name) = LOWER($2)', [req.user.id, cleanName]);

        let result;
        if (existing.rows.length > 0) {
            result = await pool.query('UPDATE categories SET target_limit = $1 WHERE id = $2 AND user_id = $3 RETURNING *', [limitNum, existing.rows[0].id, req.user.id]);
        } else {
            result = await pool.query('INSERT INTO categories (user_id, name, target_limit) VALUES ($1, $2, $3) RETURNING *', [req.user.id, cleanName, limitNum]);
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
        const result = await pool.query('UPDATE categories SET target_limit = $1 WHERE id = $2 AND user_id = $3 RETURNING *', [limit, id, req.user.id]);
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
                const isDebt = ['credit_card', 'loan'].includes(accRes.rows[0].type);
                if (type === 'expense') {
                    await pool.query(isDebt ? 'UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3' : 'UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [amountNum, account_id, req.user.id]);
                } else if (type === 'income') {
                    await pool.query(isDebt ? 'UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3' : 'UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [amountNum, account_id, req.user.id]);
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
                    const isDebt = ['credit_card', 'loan'].includes(accRes.rows[0].type);
                    if (tx.type === 'expense') {
                        await pool.query(isDebt ? 'UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3' : 'UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [tx.amount, tx.account_id, req.user.id]);
                    } else if (tx.type === 'income') {
                        await pool.query(isDebt ? 'UPDATE financial_accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3' : 'UPDATE financial_accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [tx.amount, tx.account_id, req.user.id]);
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
        const result = await pool.query('UPDATE savings_goals SET current_amount = $1 WHERE id = $2 AND user_id = $3 RETURNING *', [current_amount, id, req.user.id]);
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
        const result = await pool.query('SELECT id, name, type, balance::float, teller_account_id FROM financial_accounts WHERE user_id = $1 ORDER BY id ASC', [req.user.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts', authenticateToken, async (req, res) => {
    try {
        const { name, type, balance } = req.body;
        const result = await pool.query('INSERT INTO financial_accounts (user_id, name, type, balance) VALUES ($1, $2, $3, $4) RETURNING *', [req.user.id, name, type, balance || 0]);
        res.json(result.rows[0]);
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/accounts/:id', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { balance } = req.body;
        const result = await pool.query('UPDATE financial_accounts SET balance = $1 WHERE id = $2 AND user_id = $3 RETURNING *', [balance, id, req.user.id]);
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

app.listen(PORT, () => console.log(`🚀 Multi-User Budget App running with Teller on http://localhost:${PORT}`));