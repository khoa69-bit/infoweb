import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { Storage } from './src/storage.js';
import { runPhase1Scraper } from './src/phase1_scraper.js';
import { runPhase2Enrichment } from './src/phase2_enricher.js';
import { exportToExcel } from './src/excel_exporter.js';
import { getCacheStats, clearCache } from './src/domain_cache.js';

const app = express();
const PORT = parseInt(process.env.PORT || '5007', 10);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.resolve('./public')));

// Server-Sent Events (SSE) subscribers
let sseClients = [];

function sendEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, timestamp: new Date().toISOString(), ...data })}\n\n`;
  sseClients.forEach(client => client.res.write(payload));
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

let currentTask = null; // { type: 'phase1' | 'phase2', stopRequested: false }

// ─── Sessions ──────────────────────────────────────────────────────────────────

app.get('/api/sessions', (req, res) => {
  try {
    const sessions = Storage.listSessions();
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  try {
    const session = Storage.getSession(req.params.id);
    const enriched = Storage.getEnrichedData(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    res.json({ success: true, rawSession: session, enrichedSession: enriched || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Phase 1 ───────────────────────────────────────────────────────────────────

app.post('/api/phase1/start', async (req, res) => {
  const { url, maxPages } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL is required' });
  if (currentTask) return res.status(409).json({ success: false, error: 'A task is already running' });

  const sessionId = `session_${Date.now()}`;
  currentTask = { type: 'phase1', stopRequested: false };
  res.json({ success: true, message: 'Phase 1 started', sessionId });
  sendEvent('phase1_log', { status: 'start', message: `Starting Phase 1 for URL: ${url}` });

  try {
    const companies = await runPhase1Scraper(
      url,
      { maxPages: maxPages ? parseInt(maxPages, 10) : 50, shouldStop: () => currentTask?.stopRequested },
      progress => sendEvent('phase1_progress', progress)
    );
    Storage.saveSession(sessionId, { url, maxPages }, companies);
    sendEvent('phase1_complete', { sessionId, totalCount: companies.length, companies });
  } catch (err) {
    sendEvent('phase1_error', { message: err.message });
  } finally {
    currentTask = null;
  }
});

// ─── Stop Task ─────────────────────────────────────────────────────────────────

app.post('/api/task/stop', (req, res) => {
  if (currentTask) {
    currentTask.stopRequested = true;
    res.json({ success: true, message: 'Stop signal sent' });
  } else {
    res.json({ success: false, message: 'No active task' });
  }
});

// ─── Phase 2 ───────────────────────────────────────────────────────────────────

app.post('/api/phase2/start', async (req, res) => {
  const { sessionId, companies } = req.body;

  let targetCompanies = companies;
  if (!targetCompanies && sessionId) {
    const rawSession = Storage.getSession(sessionId);
    if (rawSession) targetCompanies = rawSession.companies;
  }

  if (!targetCompanies || !Array.isArray(targetCompanies) || targetCompanies.length === 0) {
    return res.status(400).json({ success: false, error: 'No company list provided' });
  }
  if (currentTask) return res.status(409).json({ success: false, error: 'A task is already running' });

  const activeSessionId = sessionId || `enriched_${Date.now()}`;
  currentTask = { type: 'phase2', stopRequested: false };
  res.json({ success: true, message: 'Phase 2 started', sessionId: activeSessionId });

  try {
    const { enrichedList, report } = await runPhase2Enrichment(
      targetCompanies,
      progress => {
        // Forward all progress events to frontend
        sendEvent('phase2_progress', progress);

        // When enrichment is complete, send the final report event
        if (progress.status === 'enriching_complete' && progress.report) {
          sendEvent('pipeline_report', { report: progress.report });
        }
      }
    );

    Storage.saveEnrichedData(activeSessionId, enrichedList);
    sendEvent('phase2_complete', {
      sessionId: activeSessionId,
      totalCount: enrichedList.length,
      companies: enrichedList,
      report
    });
  } catch (err) {
    sendEvent('phase2_error', { message: err.message });
  } finally {
    currentTask = null;
  }
});

// ─── Export Excel ──────────────────────────────────────────────────────────────

app.post('/api/export', async (req, res) => {
  const { companies, filenamePrefix } = req.body;
  if (!companies || !Array.isArray(companies) || companies.length === 0) {
    return res.status(400).json({ success: false, error: 'No data to export' });
  }

  try {
    const result = await exportToExcel(companies, filenamePrefix || 'exhibitors');
    res.json({
      success: true,
      downloadUrl: `/api/download/${encodeURIComponent(result.filename)}`,
      filename: result.filename,
      totalRecords: result.totalRecords
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── File Download ─────────────────────────────────────────────────────────────

app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(Storage.getExportsDir(), filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath);
});

// ─── Domain Cache Management ───────────────────────────────────────────────────

app.get('/api/cache/stats', (req, res) => {
  res.json({ success: true, ...getCacheStats() });
});

app.post('/api/cache/clear', (req, res) => {
  clearCache();
  res.json({ success: true, message: 'Domain cache cleared.' });
});

// ─── Server Start ──────────────────────────────────────────────────────────────

function startServer(portToTry) {
  const server = app.listen(portToTry, () => {
    console.log(`=======================================================`);
    console.log(` Infoweb Company Data Pipeline`);
    console.log(` Running on: http://localhost:${portToTry}`);
    console.log(`=======================================================`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${portToTry} in use, retrying on ${portToTry + 1}...`);
      startServer(portToTry + 1);
    } else {
      console.error(err);
    }
  });
}

startServer(PORT);
