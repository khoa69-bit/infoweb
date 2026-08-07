import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('./data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const ENRICHED_DIR = path.join(DATA_DIR, 'enriched');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');

// Ensure directories exist
[DATA_DIR, SESSIONS_DIR, ENRICHED_DIR, EXPORTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export const Storage = {
  saveSession(sessionId, metadata, data) {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    const payload = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata,
      totalCount: data.length,
      companies: data
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return payload;
  },

  getSession(sessionId) {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  },

  listSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const files = fs.readdirSync(SESSIONS_DIR);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
          return {
            id: content.id,
            createdAt: content.createdAt,
            url: content.metadata?.url,
            totalCount: content.totalCount || content.companies?.length || 0
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  saveEnrichedData(sessionId, data) {
    const filePath = path.join(ENRICHED_DIR, `${sessionId}.json`);
    const payload = {
      id: sessionId,
      updatedAt: new Date().toISOString(),
      totalCount: data.length,
      companies: data
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return payload;
  },

  getEnrichedData(sessionId) {
    const filePath = path.join(ENRICHED_DIR, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  },

  getExportsDir() {
    return EXPORTS_DIR;
  }
};
