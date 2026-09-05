const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();

// ─── Config ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
// Comma-separated list of allowed origins, e.g. "https://medlens.example.com,http://localhost:3000"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
// Optional shared-secret for simple app-level auth. If unset, auth is skipped (fine for local dev only).
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || null;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️  WARNING: ANTHROPIC_API_KEY is not set. Set it in your .env file to enable AI extraction and summaries.');
}
if (ALLOWED_ORIGINS.length === 0) {
  console.warn('ℹ️  ALLOWED_ORIGINS not specified — CORS is allowing all origins for local development.');
}
if (!APP_SHARED_SECRET) {
  console.log('ℹ️  APP_SHARED_SECRET is not set — /api routes are open for local development.');
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'dummy_key_for_initialization',
});

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*',
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '2mb' })); // structured payloads only; files go through multer below

// Serve static frontend files (index.html, styles, etc.)
app.use(express.static(__dirname));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10MB, single file
});

// Very small in-memory sliding-window rate limiter (per IP).
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const rateLimitHits = new Map(); // ip -> [timestamps]
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  if (hits.length > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
  }
  next();
}

function requireAppAuth(req, res, next) {
  if (!APP_SHARED_SECRET) return next(); // dev mode, see warning above
  if (req.get('x-app-key') !== APP_SHARED_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Helpers ─────────────────────────────────────────────────────────────

// Detects file type from magic bytes, ignoring whatever the client claims.
// Returns 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | null
function sniffMimeType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

// Strips markdown fences and grabs the outermost JSON object/array from a
// model response. Throws if nothing parseable is found.
function parseJsonLoose(text) {
  let t = String(text || '').trim()
    .replace(/^```json/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
  const first = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start = -1;
  if (first === -1) start = firstArr;
  else if (firstArr === -1) start = first;
  else start = Math.min(first, firstArr);
  if (start === -1) throw new Error('No JSON object or array found in model response');
  if (start > 0) t = t.slice(start);
  const lastCurly = t.lastIndexOf('}');
  const lastSq = t.lastIndexOf(']');
  const end = Math.max(lastCurly, lastSq);
  if (end !== -1 && end < t.length - 1) t = t.slice(0, end + 1);
  return JSON.parse(t);
}

// Pulls the text out of an Anthropic response, tolerating multiple/odd blocks.
function extractText(response) {
  const blocks = response && response.content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('Model returned no content');
  }
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('Model returned no text content');
  return text;
}

async function callClaude({ system, content, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_api_key_here') {
    throw new Error('ANTHROPIC_API_KEY is not set on the server. Please add your Anthropic API key to the .env file.');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens || 1000,
    system,
    messages: [{ role: 'user', content }],
  });
  return extractText(response);
}

// ─── System prompts ───────────────────────────────────────────────────────

const EXTRACTION_SYSTEM = `You are a clinical document extraction assistant. You will be shown an image or PDF of a medical report (lab results, prescription, discharge note, etc.).
Extract ONLY information that is visibly present in the document. Never invent, estimate, or infer a reference range, value, or unit that is not printed in the source. If the document has multiple pages, extract tests from every page.
Respond with STRICT JSON ONLY (no markdown fences, no commentary) matching exactly this schema:
{
  "reportDate": string|null,
  "reportType": string,
  "labName": string|null,
  "patientNameOnDoc": string|null,
  "tests": [ { "name": string, "value": string, "unit": string|null, "referenceRange": string|null, "flag": "low"|"normal"|"high"|"unknown", "observation": string|null, "confidence": "high"|"medium"|"low" } ],
  "clinicalNotes": string|null,
  "extractionConfidence": "high"|"medium"|"low"
}
Rules:
- Set "flag" only when the printed value and printed reference range are both numeric and directly comparable; otherwise "unknown". Never fabricate a reference range to compute a flag.
- "confidence" reflects legibility/certainty of that specific field in the source.
- No diagnosis, treatment suggestion, or clinical interpretation beyond what is literally printed.
- If unreadable or not a medical report, return "tests": [] and "reportType": "Unrecognized document".`;

const SUMMARY_SYSTEM = `You are helping a patient understand their own medical record in plain, accessible language. You are not a doctor and must not diagnose, must not suggest treatment, must not recommend medication or dosage changes, and must not state uncertain information as fact.
Write a concise (under 230 words) patient-friendly summary of the structured data provided: what was reported, what conditions/medications/allergies are on file, and which lab values fall outside their own printed reference range (state this neutrally as "outside the reference range printed on the report"). If a reference range wasn't available for a value, say so plainly rather than guessing.
End with one sentence encouraging the patient to review these results with a licensed clinician. Plain prose paragraphs, no markdown headers.`;

const CONFLICT_SYSTEM = `You review structured patient medical data for clerical inconsistencies only — not clinical judgment. Look for things like: a medication listed that matches a listed allergy, contradictory values for the same test on the same date across different report entries, missing units next to a numeric value, or duplicate report entries. Do not diagnose or assess clinical severity.
Respond with STRICT JSON ONLY: an array like [{"issue": string, "detail": string, "severity": "warning"|"info"}]. If nothing notable, respond with [].`;

// ─── Routes ──────────────────────────────────────────────────────────────

// Health check endpoint
app.get('/api/health', (req, res) => res.json({ status: 'MedLens API Active', version: '1.0.0' }));

// Root route serves index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/extract', rateLimit, requireAppAuth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });

    const sniffed = sniffMimeType(file.buffer);
    if (!sniffed) {
      return res.status(415).json({ error: 'Unsupported or unrecognized file type. Please upload a PDF, PNG, JPEG, or WEBP.' });
    }
    const isPdf = sniffed === 'application/pdf';

    const text = await callClaude({
      system: EXTRACTION_SYSTEM,
      maxTokens: 4096,
      content: [
        {
          type: isPdf ? 'document' : 'image',
          source: { type: 'base64', media_type: sniffed, data: file.buffer.toString('base64') },
        },
        { type: 'text', text: 'Extract the structured data from this medical report per your instructions. JSON only.' },
      ],
    });

    let parsed;
    try {
      parsed = parseJsonLoose(text);
    } catch (parseErr) {
      return res.status(502).json({ error: 'Could not parse a structured response from the model. Try a clearer scan or a single-page report.' });
    }
    res.json(parsed);
  } catch (err) {
    console.error('[/api/extract]', err);
    res.status(500).json({ error: err.message || 'Extraction failed. Please try again.' });
  }
});

app.post('/api/summary', rateLimit, requireAppAuth, async (req, res) => {
  try {
    const payload = req.body && req.body.payload;
    if (!payload) return res.status(400).json({ error: 'Missing "payload" in request body.' });

    const text = await callClaude({
      system: SUMMARY_SYSTEM,
      maxTokens: 700,
      content: [{ type: 'text', text: 'Structured patient data (JSON):\n' + JSON.stringify(payload) }],
    });
    res.json({ text });
  } catch (err) {
    console.error('[/api/summary]', err);
    res.status(500).json({ error: err.message || 'Could not generate a summary. Please try again.' });
  }
});

app.post('/api/conflict-check', rateLimit, requireAppAuth, async (req, res) => {
  try {
    const payload = req.body && req.body.payload;
    if (!payload) return res.status(400).json({ error: 'Missing "payload" in request body.' });

    const text = await callClaude({
      system: CONFLICT_SYSTEM,
      maxTokens: 700,
      content: [{ type: 'text', text: 'Structured patient data (JSON):\n' + JSON.stringify(payload) }],
    });
    let issues;
    try {
      issues = parseJsonLoose(text);
    } catch (parseErr) {
      return res.status(502).json({ error: 'Could not parse the consistency-check response.' });
    }
    res.json({ issues: Array.isArray(issues) ? issues : [] });
  } catch (err) {
    console.error('[/api/conflict-check]', err);
    res.status(500).json({ error: err.message || 'Consistency check failed. Please try again.' });
  }
});

// Multer errors (e.g. file too large) land here rather than the generic 500 handler.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`==============================================`);
  console.log(`🩺 MedLens Server running at http://localhost:${PORT}`);
  console.log(`==============================================`);
});
