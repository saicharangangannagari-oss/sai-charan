# 🩺 MedLens — Clinical Information Intelligence

> **Clinical Information Intelligence** — An AI-assisted clinical record organization system that extracts and structures data from patient intakes and medical documents. Built to assist in patient record organization, **never diagnoses**.

---

## ✨ System Architecture

MedLens is a full-stack application featuring an Express backend with Anthropic Claude Sonnet AI integration and a responsive Vanilla JS client:

```text
┌─────────────────────────────────────────────────────────────┐
│                    MedLens Web Interface                    │
│      (Dashboard, Intake, Reports, Records, Timeline,        │
│       Summaries, Audit History, Multi-Patient Switcher)     │
└──────────────────────────────┬──────────────────────────────┘
                               │ Multipart / JSON
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Express.js Backend API                    │
│   • Multer (10MB upload memory storage & mime validation)   │
│   • Rate Limiting & optional shared secret security         │
│   • Static file hosting for index.html                      │
└──────────────────────────────┬──────────────────────────────┘
                               │ Secure Server-to-Server
                               ▼
┌─────────────────────────────────────────────────────────────┐
│            Anthropic Claude Messages API                    │
│   • claude-sonnet-4-6 for clinical extraction & analysis    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Open `.env` and add your Anthropic API Key:
```env
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=5000
```

### 3. Start the Server
```bash
npm start
```
Then open your browser to:
👉 **`http://localhost:5000`**

---

## 📋 Features

1. **Patient Dashboard (`00`):** Overview of out-of-range test counts, pending review items, and average extraction confidence.
2. **Patient Intake (`01`):** Patient-provided demographic, symptom, medication, and allergy tracking.
3. **Medical Reports (`02`):** Drag-and-drop upload for lab results, prescriptions, and scans (PDF, PNG, JPEG, WEBP).
4. **Advisory Range Cross-Checking:** Automatic algorithmic check flagging discrepancies between printed values and reference ranges.
5. **Structured Record (`03`):** Unified searchable and filterable table with clear labeling of AI-extracted vs. patient-reported values.
6. **Timeline (`04`):** Chronological progression with trend indicators (↑ higher, ↓ lower, or unchanged vs prior test).
7. **AI Summary & Consistency (`05`):** Plain-language recap and automated clerical inconsistency checks.
8. **Audit History (`06`):** Complete timestamped log of all edits, saves, and AI tasks.
9. **Multi-Patient Switcher & Privacy:** Switch between different patient profiles, export/import JSON backups, and lock the app with a PIN.

---

## 🛠️ API Endpoints

- `GET /api/health` — Service health check
- `POST /api/extract` — Multipart file upload (PDF/Images) extracting structured clinical test data
- `POST /api/summary` — Patient-friendly summary generation
- `POST /api/conflict-check` — Clerical consistency and conflict analysis

---

## ⚠️ Clinical Disclaimer
*MedLens is a clinical information organization tool and demo, not a certified medical device. It does not provide medical diagnoses, treatment recommendations, or medication adjustments. Always review clinical records and lab reports with a licensed healthcare provider.*
