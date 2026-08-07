// Infoweb — Company Data Pipeline Controller

let state = {
  currentSessionId: null,
  companies: [],
  activeTab: 'ALL',
  searchQuery: '',
  isRunningTask: false,
  lastReport: null
};

// DOM Elements
const inputUrl             = document.getElementById('inputUrl');
const inputMaxPages        = document.getElementById('inputMaxPages');
const btnStartPhase1       = document.getElementById('btnStartPhase1');
const btnStartPhase2       = document.getElementById('btnStartPhase2');
const btnStopTask          = document.getElementById('btnStopTask');
const btnExportExcel       = document.getElementById('btnExportExcel');
const selectSession        = document.getElementById('selectSession');
const btnImportJson        = document.getElementById('btnImportJson');
const jsonFileInput        = document.getElementById('jsonFileInput');
const logTerminal          = document.getElementById('logTerminal');
const btnClearLog          = document.getElementById('btnClearLog');
const btnClearCache        = document.getElementById('btnClearCache');
const cacheCount           = document.getElementById('cacheCount');

const phase1ProgressBox    = document.getElementById('phase1ProgressBox');
const phase1StatusText     = document.getElementById('phase1StatusText');
const phase1PageCount      = document.getElementById('phase1PageCount');
const phase1ProgressBar    = document.getElementById('phase1ProgressBar');

const phase2ProgressBox    = document.getElementById('phase2ProgressBox');
const phase2StatusText     = document.getElementById('phase2StatusText');
const phase2ProgressCounter = document.getElementById('phase2ProgressCounter');
const phase2ProgressBar    = document.getElementById('phase2ProgressBar');

const statTotal            = document.getElementById('statTotal');
const statValidWebsites    = document.getElementById('statValidWebsites');
const statEmails           = document.getElementById('statEmails');
const statPhones           = document.getElementById('statPhones');

const tableBody            = document.getElementById('tableBody');
const displayedCount       = document.getElementById('displayedCount');
const tableSearchInput     = document.getElementById('tableSearchInput');

const reportPanel          = document.getElementById('reportPanel');
const reportGrid           = document.getElementById('reportGrid');
const btnCloseReport       = document.getElementById('btnCloseReport');

// ── Initialize ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSSE();
  loadSavedSessions();
  setupEventListeners();
  loadCacheStats();
});

// ── SSE Stream ────────────────────────────────────────────────────────────────
function initSSE() {
  const evtSource = new EventSource('/api/events');

  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSSEEvent(data);
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };

  evtSource.onerror = () => {
    document.getElementById('serverStatus').textContent = 'Kết nối gián đoạn';
    document.querySelector('.pulse-dot').style.background = '#F43F5E';
  };
}

function handleSSEEvent(data) {
  // Log message
  if (data.message) {
    const isErr = data.type?.includes('error');
    const isSuccess = data.type?.includes('complete') || data.message?.includes('✅') || data.message?.includes('🎉');
    appendLog(data.message, isErr ? 'error' : isSuccess ? 'success' : 'info');
  }

  // ── Phase 1 Progress ─────────────────────────────────────────────────────
  if (data.type === 'phase1_progress') {
    phase1ProgressBox.classList.remove('hidden');
    if (data.page) phase1PageCount.textContent = `Trang ${data.page}`;
    if (data.message) phase1StatusText.textContent = data.message;
    if (data.totalFound !== undefined) {
      const est = Math.min(70 + (data.page || 1), 98);
      phase1ProgressBar.style.width = `${est}%`;
    }
  }

  // ── Phase 1 Complete ──────────────────────────────────────────────────────
  if (data.type === 'phase1_complete') {
    phase1ProgressBox.classList.add('hidden');
    phase1ProgressBar.style.width = '100%';
    state.currentSessionId = data.sessionId;
    state.companies = data.companies;
    state.isRunningTask = false;
    appendLog(`✅ Pha 1 hoàn thành! Thu thập ${data.totalCount} doanh nghiệp.`, 'success');
    updateUIState();
    loadSavedSessions();
  }

  // ── Phase 2 Progress ─────────────────────────────────────────────────────
  if (data.type === 'phase2_progress') {
    phase2ProgressBox.classList.remove('hidden');
    if (data.processed !== undefined && data.total) {
      const pct = Math.round((data.processed / data.total) * 100);
      phase2ProgressCounter.textContent = `${data.processed} / ${data.total}`;
      phase2ProgressBar.style.width = `${pct}%`;
    }
    if (data.message) phase2StatusText.textContent = data.message;

    // Live stats update during enrichment
    if (data.stats) {
      const s = data.stats;
      const t = data.total || 1;
      statTotal.textContent = data.processed || state.companies.length;
      statValidWebsites.textContent = (s.websiteFromScrape || 0) + (s.websiteFromSearch || 0);
      statEmails.textContent = s.emailFound || 0;
      statPhones.textContent = s.phoneFound || 0;
    }

    // Update table live (last batch)
    if (data.currentBatch && data.currentBatch.length > 0) {
      loadCacheStats();
    }
  }

  // ── Pipeline Report ───────────────────────────────────────────────────────
  if (data.type === 'pipeline_report' && data.report) {
    state.lastReport = data.report;
    renderPipelineReport(data.report);
    reportPanel.classList.remove('hidden');
  }

  // ── Phase 2 Complete ──────────────────────────────────────────────────────
  if (data.type === 'phase2_complete') {
    phase2ProgressBox.classList.add('hidden');
    phase2ProgressBar.style.width = '100%';
    state.companies = data.companies;
    state.isRunningTask = false;
    if (data.report) {
      state.lastReport = data.report;
      renderPipelineReport(data.report);
      reportPanel.classList.remove('hidden');
    }
    appendLog(`🎉 Pha 2 hoàn thành! Đã làm giàu ${data.totalCount} doanh nghiệp.`, 'success');
    updateUIState();
    loadCacheStats();
  }
}

// ── Pipeline Report Renderer (Step 14) ────────────────────────────────────────
function renderPipelineReport(report) {
  if (!report || !reportGrid) return;

  const pct = (n, t) => t > 0 ? `${((n / t) * 100).toFixed(1)}%` : '0%';
  const t = report.total || 1;

  const metrics = [
    { label: 'Total Companies',    value: report.total,                     icon: 'ri-building-4-line',    color: '#3B82F6' },
    { label: 'Website Found',      value: (report.websiteFromScrape || 0) + (report.websiteFromSearch || 0),
                                                                             icon: 'ri-earth-line',         color: '#22C55E',
      sub: `${report.websiteFromScrape || 0} direct + ${report.websiteFromSearch || 0} via search` },
    { label: 'No Website',         value: report.noWebsite || 0,            icon: 'ri-close-circle-line',  color: '#94A3B8' },
    { label: 'Email Found',        value: report.emailFound || 0,           icon: 'ri-mail-check-line',    color: '#A855F7',
      sub: `${report.emailMxOk || 0} MX verified` },
    { label: 'Phone Found',        value: report.phoneFound || 0,           icon: 'ri-phone-line',         color: '#F59E0B' },
    { label: 'Address Found',      value: report.addressFound || 0,         icon: 'ri-map-pin-line',       color: '#06B6D4' },
    { label: 'Country Identified', value: report.countryFound || 0,         icon: 'ri-flag-line',          color: '#10B981' }
  ];

  reportGrid.innerHTML = metrics.map(m => `
    <div class="report-metric">
      <div class="rm-icon" style="color: ${m.color}; background: ${m.color}1a">
        <i class="${m.icon}"></i>
      </div>
      <div class="rm-data">
        <div class="rm-label">${m.label}</div>
        <div class="rm-value">${m.value} <span class="rm-pct">${pct(m.value, t)}</span></div>
        ${m.sub ? `<div class="rm-sub">${m.sub}</div>` : ''}
      </div>
    </div>
  `).join('');
}

// ── Logger ────────────────────────────────────────────────────────────────────
function appendLog(text, level = 'info') {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${time}] ${text}`;
  logTerminal.appendChild(line);
  // Keep terminal manageable
  if (logTerminal.children.length > 500) logTerminal.removeChild(logTerminal.firstChild);
  logTerminal.scrollTop = logTerminal.scrollHeight;
}

// ── Load Sessions ─────────────────────────────────────────────────────────────
async function loadSavedSessions() {
  try {
    const res = await fetch('/api/sessions');
    const json = await res.json();
    if (json.success && json.sessions) {
      selectSession.innerHTML = '<option value="">-- Dùng dữ liệu vừa thu thập --</option>';
      json.sessions.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        const dateStr = new Date(s.createdAt).toLocaleString();
        opt.textContent = `${dateStr} — (${s.totalCount} DN) — ${s.url || 'Imported'}`;
        selectSession.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

// ── Cache Stats ───────────────────────────────────────────────────────────────
async function loadCacheStats() {
  try {
    const res = await fetch('/api/cache/stats');
    const json = await res.json();
    if (json.success && cacheCount) {
      cacheCount.textContent = json.totalCachedDomains ?? '–';
    }
  } catch {}
}

// ── Event Listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {

  // Start Phase 1
  btnStartPhase1.addEventListener('click', async () => {
    const url = inputUrl.value.trim();
    const maxPages = inputMaxPages.value || 50;
    if (!url) { alert('Vui lòng nhập URL trang danh sách triển lãm!'); return; }

    state.isRunningTask = true;
    reportPanel.classList.add('hidden');
    updateUIState();
    appendLog(`🚀 Khởi chạy Pha 1 cho URL: ${url}`, 'info');

    try {
      const res = await fetch('/api/phase1/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, maxPages })
      });
      const json = await res.json();
      if (!json.success) {
        alert(json.error || 'Lỗi bắt đầu Pha 1');
        state.isRunningTask = false;
        updateUIState();
      }
    } catch (err) {
      appendLog(`Lỗi kết nối: ${err.message}`, 'error');
      state.isRunningTask = false;
      updateUIState();
    }
  });

  // Select Saved Session
  selectSession.addEventListener('change', async () => {
    const selectedId = selectSession.value;
    if (!selectedId) return;
    try {
      appendLog(`📂 Đang tải session: ${selectedId}...`, 'info');
      const res = await fetch(`/api/sessions/${selectedId}`);
      const json = await res.json();
      if (json.success) {
        state.currentSessionId = selectedId;
        state.companies = json.enrichedSession?.companies || json.rawSession?.companies || [];
        appendLog(`✅ Đã tải ${state.companies.length} doanh nghiệp từ session.`, 'success');
        updateUIState();
      }
    } catch (err) {
      appendLog(`Không thể tải session: ${err.message}`, 'error');
    }
  });

  // Start Phase 2
  btnStartPhase2.addEventListener('click', async () => {
    if (state.companies.length === 0) { alert('Chưa có danh sách doanh nghiệp!'); return; }

    state.isRunningTask = true;
    reportPanel.classList.add('hidden');
    updateUIState();
    appendLog(`⚙️ Khởi chạy Pha 2 cho ${state.companies.length} doanh nghiệp...`, 'info');

    try {
      const res = await fetch('/api/phase2/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.currentSessionId, companies: state.companies })
      });
      const json = await res.json();
      if (!json.success) {
        alert(json.error || 'Lỗi bắt đầu Pha 2');
        state.isRunningTask = false;
        updateUIState();
      }
    } catch (err) {
      appendLog(`Lỗi kết nối Pha 2: ${err.message}`, 'error');
      state.isRunningTask = false;
      updateUIState();
    }
  });

  // Stop Task
  btnStopTask.addEventListener('click', async () => {
    try {
      await fetch('/api/task/stop', { method: 'POST' });
      appendLog('⏹ Gửi tín hiệu dừng tác vụ...', 'warning');
    } catch (err) { console.error(err); }
  });

  // Export Excel
  btnExportExcel.addEventListener('click', async () => {
    if (state.companies.length === 0) return;
    appendLog('📊 Đang tạo workbook Excel multi-sheet...', 'info');
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companies: state.companies,
          report: state.lastReport,
          filenamePrefix: 'exhibitors_pipeline'
        })
      });
      const json = await res.json();
      if (json.success && json.downloadUrl) {
        appendLog(`✅ Xuất Excel thành công: ${json.filename}`, 'success');
        window.location.href = json.downloadUrl;
      } else {
        alert(json.error || 'Lỗi xuất Excel');
      }
    } catch (err) {
      appendLog(`Lỗi xuất Excel: ${err.message}`, 'error');
    }
  });

  // Import JSON File
  btnImportJson.addEventListener('click', () => jsonFileInput.click());
  jsonFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        const list = Array.isArray(parsed) ? parsed : (parsed.companies || []);
        if (list.length > 0) {
          state.companies = list;
          state.currentSessionId = `imported_${Date.now()}`;
          appendLog(`📥 Import thành công (${list.length} doanh nghiệp)`, 'success');
          updateUIState();
        } else { alert('File JSON không chứa danh sách hợp lệ!'); }
      } catch (err) { alert('File JSON không hợp lệ: ' + err.message); }
    };
    reader.readAsText(file);
  });

  // Clear Log
  btnClearLog.addEventListener('click', () => {
    logTerminal.innerHTML = '<div class="log-line text-muted">[--:--:--] Đã dọn dẹp nhật ký.</div>';
  });

  // Clear Domain Cache
  if (btnClearCache) {
    btnClearCache.addEventListener('click', async () => {
      if (!confirm('Xóa toàn bộ domain cache? Lần chạy tiếp theo sẽ crawl lại từ đầu.')) return;
      try {
        await fetch('/api/cache/clear', { method: 'POST' });
        appendLog('🗑 Domain cache đã được xóa.', 'warning');
        loadCacheStats();
      } catch (err) { appendLog(`Lỗi xóa cache: ${err.message}`, 'error'); }
    });
  }

  // Close Report Panel
  if (btnCloseReport) {
    btnCloseReport.addEventListener('click', () => reportPanel.classList.add('hidden'));
  }

  // Tab Filter
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.group;
      renderTable();
    });
  });

  // Search
  tableSearchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    renderTable();
  });
}

// ── Update UI State & Stats ───────────────────────────────────────────────────
function updateUIState() {
  const hasData = state.companies.length > 0;

  btnStartPhase1.disabled = state.isRunningTask;
  btnStartPhase2.disabled = !hasData || state.isRunningTask;
  btnExportExcel.disabled = !hasData;

  btnStopTask.classList.toggle('hidden', !state.isRunningTask);

  // KPI Metrics
  const total = state.companies.length;
  const validWebs = state.companies.filter(c =>
    ['LIVE', '301', '302', 'Valid', 'live'].includes(c.websiteStatus)
  ).length;
  const emailsCount = state.companies.filter(c => c.email?.length > 0).length;
  const phonesCount = state.companies.filter(c => c.phone?.length > 0).length;

  statTotal.textContent = total;
  statValidWebsites.textContent = validWebs;
  statEmails.textContent = emailsCount;
  statPhones.textContent = phonesCount;

  // Tab counts
  document.getElementById('countAll').textContent     = total;
  document.getElementById('countHcm').textContent     = state.companies.filter(c => c.sheetGroup === 'Hồ Chí Minh').length;
  document.getElementById('countHanoi').textContent   = state.companies.filter(c => c.sheetGroup === 'Hà Nội').length;
  document.getElementById('countDanang').textContent  = state.companies.filter(c => c.sheetGroup === 'Đà Nẵng').length;
  document.getElementById('countKhac').textContent    = state.companies.filter(c => c.sheetGroup === 'Khác').length;
  document.getElementById('countQuocTe').textContent  = state.companies.filter(c => c.sheetGroup === 'Quốc tế').length;

  renderTable();
}

// ── Render Data Table ──────────────────────────────────────────────────────────
function renderTable() {
  if (state.companies.length === 0) {
    tableBody.innerHTML = `
      <tr class="empty-row"><td colspan="9">
        <div class="empty-state">
          <i class="ri-inbox-archive-line"></i>
          <p>Chưa có dữ liệu. Nhập URL ở Pha 1 hoặc tải session cũ để bắt đầu.</p>
        </div>
      </td></tr>`;
    displayedCount.textContent = '0';
    return;
  }

  const filtered = state.companies.filter(item => {
    if (state.activeTab !== 'ALL' && item.sheetGroup !== state.activeTab) return false;
    if (state.searchQuery) {
      const target = [
        item.company, item.product, item.booth,
        item.websiteRaw, item.websiteNormalized,
        item.email, item.phone, item.address, item.country
      ].join(' ').toLowerCase();
      if (!target.includes(state.searchQuery)) return false;
    }
    return true;
  });

  displayedCount.textContent = filtered.length;

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr class="empty-row"><td colspan="9">
        <div class="empty-state">
          <i class="ri-search-line"></i>
          <p>Không tìm thấy kết quả phù hợp.</p>
        </div>
      </td></tr>`;
    return;
  }

  tableBody.innerHTML = filtered.map((item, idx) => {
    // Site Status badge
    const status = (item.websiteStatus || '').toUpperCase();
    let statusClass = 'badge-no-web';
    let statusText = item.websiteStatus || 'Unknown';
    if (status === 'LIVE')        { statusClass = 'badge-200';     statusText = '🟢 LIVE'; }
    else if (status === '301' || status === '302') { statusClass = 'badge-301'; statusText = '↩ ' + status; }
    else if (status === 'SSL_ERROR')  { statusClass = 'badge-error'; statusText = '🔒 SSL Error'; }
    else if (status === 'TIMEOUT')    { statusClass = 'badge-error'; statusText = '⏱ Timeout'; }
    else if (status === 'ERROR')      { statusClass = 'badge-error'; statusText = '❌ Error'; }
    else if (status === 'NO_WEBSITE') { statusClass = 'badge-no-web'; statusText = '— No Site'; }
    else if (status === 'VALID')      { statusClass = 'badge-200';   statusText = '✓ Valid'; }

    // Source badge
    const source = item.websiteSource || '';
    let sourceBadge = '';
    if (source === 'found-by-search') {
      sourceBadge = '<span class="source-badge badge-search"><i class="ri-search-line"></i> Search</span>';
    } else if (source === 'scraped') {
      sourceBadge = '<span class="source-badge badge-scraped"><i class="ri-code-line"></i> Scraped</span>';
    }

    // Email status icon
    const emailStatus = (item.emailStatus || '').toUpperCase();
    let emailStatusIcon = '';
    if (emailStatus === 'MX_OK' || emailStatus === 'DELIVERABLE') {
      emailStatusIcon = '<span class="email-status-ok" title="MX Verified">✓</span>';
    } else if (emailStatus === 'MX_FAIL') {
      emailStatusIcon = '<span class="email-status-fail" title="MX Failed">✗</span>';
    }

    const webDisplay = item.websiteNormalized || item.websiteRaw;

    return `
      <tr>
        <td style="text-align:center; color:var(--text-muted);">${idx + 1}</td>
        <td><div class="company-name">${escapeHtml(item.company || 'N/A')}</div></td>
        <td>
          <div class="product-tag">${escapeHtml(item.product || '—')}</div>
          ${item.booth ? `<span class="booth-badge"><i class="ri-store-2-line"></i> ${escapeHtml(item.booth)}</span>` : ''}
        </td>
        <td>
          ${webDisplay
            ? `<a href="${escapeHtml(webDisplay)}" target="_blank" class="web-link">
                 <i class="ri-external-link-line"></i> ${escapeHtml(truncate(webDisplay.replace(/^https?:\/\//, ''), 26))}
               </a>`
            : '<span style="color:var(--text-dim)">—</span>'}
        </td>
        <td><span class="badge-status ${statusClass}">${statusText}</span></td>
        <td>${sourceBadge || '<span style="color:var(--text-dim)">—</span>'}</td>
        <td>
          ${item.email
            ? `<div class="contact-email"><i class="ri-mail-line"></i> ${escapeHtml(item.email)} ${emailStatusIcon}</div>`
            : ''}
          ${item.phone
            ? `<div class="contact-phone"><i class="ri-phone-line"></i> ${escapeHtml(item.phone)}</div>`
            : ''}
          ${!item.email && !item.phone ? '<span style="color:var(--text-dim)">—</span>' : ''}
        </td>
        <td style="font-size:12px; max-width:200px; white-space:normal;">
          ${escapeHtml(truncate(item.address || '—', 55))}
        </td>
        <td>
          <span class="phase-badge ${item.sheetGroup === 'Hồ Chí Minh' ? 'badge-emerald' : ''}">
            ${escapeHtml(item.sheetGroup || 'Khác')}
          </span>
        </td>
      </tr>`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len = 30) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '…' : str;
}
