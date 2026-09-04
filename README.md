# ⚡ ApexBudget SaaS - Advanced Multi-User Financial & Budget Manager

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-v4.19-blue.svg)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15%2B-blue.svg)](https://www.postgresql.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v3.0-38bdf8.svg)](https://tailwindcss.com/)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Render.com-brightgreen.svg)](https://apex-budget-app.onrender.com)

ApexBudget is a full-stack, multi-user SaaS personal finance platform built with Node.js, Express, and PostgreSQL. It enables users to track Net Worth, manage category spending caps, capture receipt photos via smartphone camera, track savings milestones, manage recurring subscriptions, convert real-time global currencies, and receive automated AI financial coaching.

---

## 🌐 Live Cloud Application

Try the live application deployed on Render:
👉 **[https://apex-budget-app.onrender.com](https://apex-budget-app.onrender.com)**

---

## ✨ Comprehensive Feature Matrix

### 🔐 1. Multi-User Authentication & Data Privacy
* Secure account registration and login with encrypted passwords (`bcryptjs`) and session tokens (`jsonwebtoken` JWT).
* Isolated database records per user in PostgreSQL.

### 🏦 2. Net Worth & Financial Accounts Tracker
* Track Checking, Savings, Investment, Credit Card, and Loan/Mortgage balances.
* Real-time calculation of **Total Net Worth** (Assets minus Liabilities).

### 🤖 3. Smart AI Financial Coach & Insights
* Real-time dashboard engine calculating savings pace, debt-to-asset safety buffers, emergency goal velocity forecasts, and cashflow warnings.

### 💱 4. Multi-Currency Support & Live Exchange Rates
* Switch currency symbols (**$** USD, **€** EUR, **£** GBP, **¥** JPY/CNY, **₹** INR, **CA$** CAD, **A$** AUD, **R$** BRL, **MX$** MXN, **CHF**, **₩** KRW).
* Integrated live market exchange rate API (`open.er-api.com`) automatically updating values across all screens.

### 🎯 5. Category Budget Planner (Zero-Based Budgeting)
* Set and edit custom monthly spending limits per category.
* Progress bars dynamically shift colors (Emerald $\rightarrow$ Amber $\rightarrow$ Rose) as spending caps are approached or exceeded.

### 📷 6. Camera Receipt Scanner & Modal Inspector
* Snap receipt photos using mobile cameras (`capture="environment"`) or desktop uploads.
* HTML5 Canvas photo compression reduces image sizes to **~50KB** for fast network transmission.
* Modal inspector to view high-res receipts or download them directly.

### 📅 7. Backdated & Historical Expense Logging
* Log past expenses for previous days or months using quick date presets (`Today`, `Yesterday`, `Last Month`).
* Automatically switches the global month view to the logged transaction's month.

### 📅 8. Global Month/Year Date Filter
* Calendar month picker (`YYYY-MM`) filtering analytics, charts, transactions, and categories by specific months.

### 🎯 9. Savings Goals & Emergency Funds
* Milestone tracking for vacations, emergency funds, and major purchases with quick `+$50` / `-$50` deposit/withdraw controls.

### 🔄 10. Recurring Bills & Subscriptions Manager
* Manage monthly subscriptions (e.g., Rent, Netflix, Gym, Insurance) with due day tracking and 1-click **"⚡ Log as Transaction"** conversion.

### 📊 11. Interactive Analytics Dashboard
* **Chart.js** Expense Category Doughnut Breakdown.
* Side-by-side **Budget Cap vs. Actual Spend** Bar Chart.
* Real-time Net Savings Rate (%) & Cashflow Summary.

### 📖 12. Interactive Onboarding Tutorial
* Built-in modal tutorial providing new users with a 1-minute visual walkthrough.

### 🗑️ 13. Permanent Account Deletion
* GDPR-compliant permanent account removal that purges all user data across all database tables.

---

## 🚀 Performance & Security Optimizations

* **PostgreSQL Composite Indexing**: Indexes on `(user_id, date)` allow sub-millisecond query execution as transaction history grows.
* **Gzip HTTP Response Compression**: Express `compression` middleware reduces JSON payloads and static assets by up to 70%.
* **Client-Side Image Resizing**: HTML5 Canvas resizes images to 600px width @ 65% JPEG quality before upload.

---

## 📁 Repository Structure & File Overview

```text
apex-budget-app/
├── package.json         # Dependencies (express, pg, bcryptjs, jsonwebtoken, compression, cors)
├── server.js            # Express API server, PostgreSQL database pool, JWT auth & REST endpoints
├── .gitignore           # Ignores node_modules/ and sensitive database files from Git tracking
├── README.md            # Comprehensive project documentation
└── public/
    └── index.html       # Single-Page Application (SPA) UI (Tailwind CSS, Chart.js, Canvas compression)