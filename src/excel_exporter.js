import ExcelJS from 'exceljs';
import path from 'path';
import { Storage } from './storage.js';

// ── Color constants ───────────────────────────────────────────────────────────
const COLORS = {
  headerBg: 'FF1E293B',     // Slate 800
  headerFont: 'FFFFFFFF',
  altRow: 'FFF8FAFC',
  border: 'FFE2E8F0',
  liveGreen: 'FF22C55E',
  errorRed: 'FFEF4444',
  warnYellow: 'FFFBBF24',
  searchBlue: 'FF3B82F6',
  mxOkGreen: 'FF16A34A',
  mxFailRed: 'FFDC2626',
  noWebGray: 'FF94A3B8'
};

/**
 * Build a styled status cell based on websiteStatus value
 */
function getWebsiteStatusStyle(status) {
  switch ((status || '').toUpperCase()) {
    case 'LIVE':        return { text: 'LIVE',        color: COLORS.liveGreen };
    case '301':         return { text: '301 Redirect', color: COLORS.warnYellow };
    case '302':         return { text: '302 Redirect', color: COLORS.warnYellow };
    case 'SSL_ERROR':   return { text: 'SSL Error',   color: COLORS.errorRed };
    case 'TIMEOUT':     return { text: 'Timeout',     color: COLORS.errorRed };
    case 'NO_WEBSITE':  return { text: 'No Website',  color: COLORS.noWebGray };
    case 'ERROR':       return { text: 'Error',       color: COLORS.errorRed };
    case 'VALID':       return { text: 'Valid',        color: COLORS.liveGreen };
    case 'INVALID':     return { text: 'Invalid',     color: COLORS.noWebGray };
    default:            return { text: status || '-', color: COLORS.noWebGray };
  }
}

function getEmailStatusStyle(status) {
  switch ((status || '').toUpperCase()) {
    case 'DELIVERABLE': return { text: 'Deliverable', color: COLORS.mxOkGreen };
    case 'MX_OK':       return { text: 'MX OK',       color: COLORS.mxOkGreen };
    case 'MX_FAIL':     return { text: 'MX Fail',     color: COLORS.mxFailRed };
    case 'INVALID_FORMAT': return { text: 'Invalid',  color: COLORS.mxFailRed };
    case 'UNVERIFIABLE':   return { text: 'Unverif.', color: COLORS.warnYellow };
    case 'UNVERIFIED':     return { text: 'Unverif.', color: COLORS.warnYellow };
    default:            return { text: status || '-', color: COLORS.noWebGray };
  }
}

function getSourceStyle(source) {
  if (source === 'found-by-search') return { text: '🔍 Search',   color: COLORS.searchBlue };
  if (source === 'scraped')         return { text: '📄 Scraped',  color: COLORS.liveGreen };
  return                                   { text: '—',           color: COLORS.noWebGray };
}

// ── Style helpers ─────────────────────────────────────────────────────────────

function styleCell(cell, { bold = false, color = null, bgColor = null, horizontal = 'left' } = {}) {
  cell.font = { name: 'Segoe UI', size: 10, bold, color: color ? { argb: 'FF' + color.replace('#', '') } : undefined };
  cell.alignment = { vertical: 'middle', horizontal, wrapText: false };
  if (bgColor) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
  }
  cell.border = {
    bottom: { style: 'thin', color: { argb: COLORS.border } },
    right:  { style: 'thin', color: { argb: COLORS.border } }
  };
}

function applyHeaderStyle(row) {
  row.height = 28;
  row.eachCell(cell => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.font   = { name: 'Segoe UI', size: 11, bold: true, color: { argb: COLORS.headerFont } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF0F172A' } } };
  });
}

// ── Column definitions ────────────────────────────────────────────────────────
const COLUMNS = [
  { header: 'STT',           key: 'stt',           width: 6  },
  { header: 'Company',       key: 'company',        width: 36 },
  { header: 'Product',       key: 'product',        width: 28 },
  { header: 'Booth',         key: 'booth',          width: 12 },
  { header: 'Website',       key: 'website',        width: 34 },
  { header: 'Site Status',   key: 'websiteStatus',  width: 14 },
  { header: 'Source',        key: 'websiteSource',  width: 14 },
  { header: 'Email',         key: 'email',          width: 32 },
  { header: 'Email Status',  key: 'emailStatus',    width: 14 },
  { header: 'Phone',         key: 'phone',          width: 22 },
  { header: 'Address',       key: 'address',        width: 46 },
  { header: 'Country',       key: 'country',        width: 16 }
];

// ── Sheet definitions ─────────────────────────────────────────────────────────
const SHEET_DEFINITIONS = [
  { name: 'All Data',    filter: () => true },
  { name: 'Hồ Chí Minh', filter: c => c.sheetGroup === 'Hồ Chí Minh' },
  { name: 'Hà Nội',      filter: c => c.sheetGroup === 'Hà Nội' },
  { name: 'Đà Nẵng',     filter: c => c.sheetGroup === 'Đà Nẵng' },
  { name: 'Khác',        filter: c => c.sheetGroup === 'Khác' },
  { name: 'Quốc tế',     filter: c => c.sheetGroup === 'Quốc tế' }
];

// ── Main export function ──────────────────────────────────────────────────────

export async function exportToExcel(companies, filenamePrefix = 'exhibitors_export', report = null) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Infoweb Company Data Pipeline';
  workbook.created = new Date();

  const validCompanies = companies.filter(c => c && c.company && c.company.length > 1);

  for (const sheetDef of SHEET_DEFINITIONS) {
    const sheet = workbook.addWorksheet(sheetDef.name);
    sheet.columns = COLUMNS;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // Apply header styling
    applyHeaderStyle(sheet.getRow(1));

    // Populate data
    const filteredData = validCompanies.filter(sheetDef.filter);

    filteredData.forEach((item, idx) => {
      const isEven = idx % 2 === 0;
      const rowBg = isEven ? null : COLORS.altRow;

      const websiteDisplay = item.websiteNormalized || item.websiteRaw || '';
      const webStat = getWebsiteStatusStyle(item.websiteStatus);
      const emailStat = getEmailStatusStyle(item.emailStatus);
      const sourceStat = getSourceStyle(item.websiteSource);

      const row = sheet.addRow({
        stt:           idx + 1,
        company:       item.company || '',
        product:       item.product || '',
        booth:         item.booth   || '',
        website:       websiteDisplay,
        websiteStatus: webStat.text,
        websiteSource: sourceStat.text,
        email:         item.email   || '',
        emailStatus:   emailStat.text,
        phone:         item.phone   || '',
        address:       item.address || '',
        country:       item.country || 'Unknown'
      });

      row.height = 22;

      // Style each cell individually for color-coding
      row.eachCell((cell, colNum) => {
        const baseOpts = { bgColor: rowBg };

        switch (colNum) {
          case 1:  styleCell(cell, { ...baseOpts, horizontal: 'center', color: '#64748B' }); break;
          case 6:  // Site Status — colored
            styleCell(cell, { ...baseOpts, horizontal: 'center' });
            cell.font = { ...cell.font, bold: true, color: { argb: webStat.color } };
            break;
          case 7:  // Source
            styleCell(cell, { ...baseOpts, horizontal: 'center' });
            cell.font = { ...cell.font, color: { argb: sourceStat.color } };
            break;
          case 9:  // Email Status
            styleCell(cell, { ...baseOpts, horizontal: 'center' });
            cell.font = { ...cell.font, bold: true, color: { argb: emailStat.color } };
            break;
          case 12: // Country
            styleCell(cell, { ...baseOpts, horizontal: 'center' });
            break;
          default:
            styleCell(cell, baseOpts);
        }
      });

      // Make website URL a hyperlink if available
      if (websiteDisplay && websiteDisplay.startsWith('http')) {
        try {
          sheet.getCell(`E${idx + 2}`).value = {
            text: websiteDisplay.replace(/^https?:\/\//, ''),
            hyperlink: websiteDisplay
          };
          sheet.getCell(`E${idx + 2}`).font = {
            name: 'Segoe UI', size: 10, underline: true, color: { argb: 'FF3B82F6' }
          };
        } catch {}
      }
    });

    // Auto-fit column widths
    sheet.columns.forEach(col => {
      let maxLen = col.header ? String(col.header).length : 10;
      sheet.eachRow({ includeEmpty: false }, row => {
        const val = String(row.getCell(col.key).value || '');
        if (val.length > maxLen) maxLen = Math.min(val.length, 55);
      });
      col.width = Math.max(maxLen + 4, 12);
    });
  }

  // ── Step 14: Optional Summary Report Sheet ─────────────────────────────────
  if (report) {
    const summarySheet = workbook.addWorksheet('📊 Pipeline Report');
    summarySheet.columns = [
      { key: 'metric', width: 30 },
      { key: 'value',  width: 20 },
      { key: 'pct',    width: 12 }
    ];

    const total = report.total || validCompanies.length;
    const pct = n => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';

    const reportRows = [
      ['📋 PIPELINE SUMMARY REPORT', '', ''],
      ['Generated', new Date().toLocaleString(), ''],
      ['', '', ''],
      ['METRIC', 'COUNT', 'RATE'],
      ['Total Companies', total, '100%'],
      ['Website Found (Total)', (report.websiteFromScrape || 0) + (report.websiteFromSearch || 0), pct((report.websiteFromScrape || 0) + (report.websiteFromSearch || 0))],
      ['  ↳ Direct Scraped', report.websiteFromScrape || 0, pct(report.websiteFromScrape || 0)],
      ['  ↳ Found by Search', report.websiteFromSearch || 0, pct(report.websiteFromSearch || 0)],
      ['No Website', report.noWebsite || 0, pct(report.noWebsite || 0)],
      ['Email Found', report.emailFound || 0, pct(report.emailFound || 0)],
      ['  ↳ MX Verified', report.emailMxOk || 0, pct(report.emailMxOk || 0)],
      ['Phone Found', report.phoneFound || 0, pct(report.phoneFound || 0)],
      ['Address Found', report.addressFound || 0, pct(report.addressFound || 0)],
      ['Country Identified', report.countryFound || 0, pct(report.countryFound || 0)],
      ['', '', ''],
      ['REGION BREAKDOWN', 'COUNT', ''],
      ['Ho Chi Minh', validCompanies.filter(c => c.sheetGroup === 'Hồ Chí Minh').length, ''],
      ['Hanoi', validCompanies.filter(c => c.sheetGroup === 'Hà Nội').length, ''],
      ['Da Nang', validCompanies.filter(c => c.sheetGroup === 'Đà Nẵng').length, ''],
      ['Other Vietnam', validCompanies.filter(c => c.sheetGroup === 'Khác').length, ''],
      ['International', validCompanies.filter(c => c.sheetGroup === 'Quốc tế').length, '']
    ];

    reportRows.forEach((rowData, i) => {
      const row = summarySheet.addRow(rowData);
      if (i === 0) {
        row.font = { name: 'Segoe UI', size: 14, bold: true };
        row.height = 32;
      } else if (rowData[0] === 'METRIC' || rowData[0] === 'REGION BREAKDOWN') {
        applyHeaderStyle(row);
      } else {
        row.font = { name: 'Segoe UI', size: 10 };
        row.height = 20;
      }
    });
  }

  // ── Save file ──────────────────────────────────────────────────────────────
  const exportsDir = Storage.getExportsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${filenamePrefix}_${timestamp}.xlsx`;
  const filePath = path.join(exportsDir, filename);

  await workbook.xlsx.writeFile(filePath);

  return { filename, filePath, totalRecords: validCompanies.length };
}
