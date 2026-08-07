import fs from 'fs';
import { exportToExcel } from './src/excel_exporter.js';

async function test() {
  try {
    const rawData = JSON.parse(fs.readFileSync('./data/enriched/session_1786031715026.json', 'utf-8'));
    console.log(`Loaded ${rawData.companies.length} companies from session`);
    const res = await exportToExcel(rawData.companies, 'test_export');
    console.log('SUCCESS:', res);
  } catch (err) {
    console.error('EXPORT FAILED WITH ERROR:', err);
  }
}

test();
