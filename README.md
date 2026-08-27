# ⚡ ApexBudget SaaS - Advanced Multi-User Financial Manager

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-v4.19-blue.svg)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v15%2B-blue.svg)](https://www.postgresql.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v3.0-38bdf8.svg)](https://tailwindcss.com/)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Render.com-brightgreen.svg)](https://apex-budget-app.onrender.com)

ApexBudget is a full-stack, multi-user web application designed for modern personal wealth and budget management. Built with Node.js, Express, and PostgreSQL, it allows multiple users to securely register, set custom category budgets, log transactions, attach receipt photos via camera/upload, and track analytics in real-time.

---

## 🌐 Live Demo

Visit the deployed cloud application:
👉 **[https://apex-budget-app.onrender.com](https://apex-budget-app.onrender.com)**

---

## ✨ Key Features

- 🔐 **Multi-User Authentication**: Secure Sign-Up and Login with encrypted passwords (`bcryptjs`) and session tokens (`JWT`). Each user's financial data is completely isolated.
- 🎯 **Category Target Planner**: Set and edit custom monthly spending limits per category. Visual progress bars dynamically shift color (Emerald $\rightarrow$ Amber $\rightarrow$ Rose) as spending caps are approached or exceeded.
- 📷 **Receipt Photo Attachment**: Capture receipts using smartphone cameras or desktop uploads. Features client-side HTML5 Canvas image compression for fast uploads.
- 🔍 **Receipt Inspector Modal**: Inspect high-resolution receipt photos directly from the transaction log with single-click download support.
- 📊 **Real-Time Analytics Dashboard**:
  - Net Savings & Savings Rate (%) calculations.
  - Interactive **Chart.js** Category Doughnut Breakdown.
  - Side-by-side **Budget Cap vs. Actual Spend** Bar Chart.
- 📖 **Built-in Interactive Quick Guide**: An onboarding modal tutorial that helps first-time users navigate the platform seamlessly.

---

## 📁 Repository Structure & File Overview

```text
apex-budget-app/
├── package.json         # Project dependencies, scripts, and package metadata
├── server.js            # Express API server, PostgreSQL database pool, JWT auth & REST endpoints
├── .gitignore           # Ignores node_modules/ and local database files from Git tracking
├── README.md            # Comprehensive project documentation
└── public/
    └── index.html       # Single-Page Web App UI (Tailwind CSS, Chart.js, Auth & REST API Client)