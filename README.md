# ⚡ ApexBudget SaaS - Advanced Multi-User Financial Manager

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-v4.19-blue.svg)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15%2B-blue.svg)](https://www.postgresql.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v3.0-38bdf8.svg)](https://tailwindcss.com/)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Render.com-brightgreen.svg)](https://apex-budget-app.onrender.com)

ApexBudget is a full-stack, multi-user SaaS personal finance platform built with Node.js, Express, and PostgreSQL. It empowers users to track their Net Worth, manage category spending caps, capture receipt photos via smartphone camera, track savings goals, manage recurring subscriptions, and receive AI-driven financial insights in real time.

---

## 🌐 Live Cloud Application

Try the live application deployed on Render:
👉 **[https://apex-budget-app.onrender.com](https://apex-budget-app.onrender.com)**

---

## ✨ Feature Highlights

### 1. 🔐 Multi-User Authentication & Data Isolation
* Secure registration and login with encrypted passwords (`bcryptjs`) and session tokens (`JWT`).
* Complete database user isolation in PostgreSQL.

### 2. 🏦 Net Worth & Financial Accounts Tracker
* Track Checking, Savings, Investment, Credit Card, and Loan balances.
* Real-time calculation of **Total Net Worth** (Assets minus Liabilities/Debts).

### 3. 🤖 Smart AI Insights & Financial Coach
* Automated dashboard engine analyzing savings pace, debt-to-asset safety ratios, upcoming subscription bills, and savings goal time-to-completion forecasts.

### 4. 🎯 Category Budget Planner (Zero-Based Budgeting)
* Set and edit custom monthly spending limits per category.
* Color-coded progress bars (Emerald $\rightarrow$ Amber $\rightarrow$ Rose) as spending caps are approached.

### 5. 📷 Camera Receipt Scanner & Modal Viewer
* Snap receipt photos using mobile camera (`capture="environment"`) or desktop upload.
* Client-side HTML5 Canvas compression keeps database storage light and fast.
* High-res modal viewer for inspecting or downloading saved receipts from the transaction history.

### 6. 📅 Global Month/Year Filter
* Calendar month picker (`YYYY-MM`) filtering analytics, charts, transactions, and categories by specific months.

### 7. 🎯 Savings Goals & Emergency Funds
* Set financial targets (e.g., *Vacation*, *Emergency Fund*) with progress completion percentages and quick `+$50` / `-$50` deposit/withdraw controls.

### 8. 🔄 Recurring Bills & Subscriptions Manager
* Manage monthly subscriptions (e.g., Rent, Netflix, Gym, Insurance) with due day tracking and 1-click **"⚡ Log as Transaction"** conversion.

### 9. 📊 Interactive Analytics Dashboard
* **Chart.js** Expense Category Doughnut Breakdown.
* Side-by-side **Budget Cap vs. Actual Spend** Bar Chart.
* Real-time Net Savings Rate (%) & Cashflow Summary.

### 10. 📖 Interactive Onboarding Guide
* Built-in modal tutorial providing first-time users with a 1-minute visual walkthrough.

---

## 📁 Project Architecture & File Overview

```text
apex-budget-app/
├── package.json         # Project metadata, dependencies (express, pg, bcryptjs, jsonwebtoken, cors)
├── server.js            # Express REST API, PostgreSQL database pool, JWT auth & business logic
├── .gitignore           # Ignores node_modules/ and sensitive environment database files
├── README.md            # Comprehensive project documentation
└── public/
    └── index.html       # Single-Page Application (SPA) UI (Tailwind CSS, Chart.js, Canvas compression)