/**
 * Control API — lets the iOS app manage Linux services, IBKR, and analysis runs.
 * Mounted at /api/v1 in http-server.js (requires Bearer/API key auth, same as MCP).
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const HOME = process.env.HOME || '/home/mgadiraju';
const AUTOTRADING = path.join(HOME, 'AutoTrading');
const EVENTS_FILE = path.join(AUTOTRADING, 'ios-events.json');
const SERVICES = ['tv-mcp-http', 'cloudflared', 'sa-reports', 'ibgateway', 'ticker-api', 'ticker-ui'];

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, ...opts }).trim();
  } catch (e) {
    return (e.stdout || e.stderr || e.message || '').trim();
  }
}

function serviceStatus(name) {
  const active = sh(`systemctl --user is-active ${name}`);
  const enabled = sh(`systemctl --user is-enabled ${name}`);
  const pid = sh(`systemctl --user show ${name} --property=MainPID --value`);
  const since = sh(`systemctl --user show ${name} --property=ActiveEnterTimestamp --value`);
  return { name, active, enabled, pid: pid === '0' ? null : pid, since };
}

function ibkrMode() {
  try {
    const mode = fs.readFileSync(path.join(HOME, 'IBC', '.mode'), 'utf8').trim();
    return mode || 'paper';
  } catch { return 'paper'; }
}

function ibkrConnected() {
  try {
    sh('nc -z -w2 127.0.0.1 4002 2>/dev/null || nc -z -w2 127.0.0.1 4001');
    const port = ibkrMode() === 'live' ? '4001' : '4002';
    const result = sh(`nc -z -w2 127.0.0.1 ${port} && echo ok || echo fail`);
    return result === 'ok';
  } catch { return false; }
}

function listReports() {
  try {
    return fs.readdirSync(AUTOTRADING)
      .filter(f => f.startsWith('sa-stocks-') && f.endsWith('.html'))
      .sort()
      .reverse()
      .slice(0, 30)
      .map(f => ({ filename: f, date: f.replace('sa-stocks-', '').replace('.html', '') }));
  } catch { return []; }
}

const RULES_FILE     = path.join(AUTOTRADING, 'rules.json');
const STRATEGY_FILE  = path.join(AUTOTRADING, 'strategy_results.json');
const NOTES_FILE     = path.join(AUTOTRADING, 'notes.json');
const WATCHLIST_FILE = path.join(AUTOTRADING, 'watchlist.json');
const NTFY_TOPIC     = 'autotrading-mgadiraju';

let analysisState = { running: false, pid: null, startedAt: null };

function loadRules() {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); } catch { return []; }
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
  rebuildRuleCron(rules);
}

function loadStrategyResults() {
  try { return JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8')); } catch { return []; }
}

function saveStrategyResults(results) {
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(results, null, 2));
}

function loadNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch { return []; }
}

function saveNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

function loadWatchlist() {
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); } catch { return []; }
}

function saveWatchlist(wl) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2));
}

// Remove all auto-generated backend data for a symbol (call on watchlist remove or SA portfolio change).
// Preserves manually created notes so the user doesn't lose their own work.
function purgeSymbolData(sym) {
  const symbol = sym.toUpperCase();
  const notes  = loadNotes();
  const kept   = notes.filter(n => !(n.tags?.includes('auto-earnings') && (n.ticker || '').toUpperCase() === symbol));
  const removed = notes.length - kept.length;
  if (removed > 0) saveNotes(kept);
  return { notesRemoved: removed };
}

// Fetch earnings date for sym and upsert an auto-earnings note. Fire-and-forget — no response needed.
async function fetchAndCreateEarningsNote(sym) {
  const http = require('http');
  const symbol = sym.toUpperCase();
  try {
    const data = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:8766/api/earnings?ticker=${encodeURIComponent(symbol)}`, (resp) => {
        let raw = '';
        resp.on('data', c => { raw += c; });
        resp.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });
    if (!data?.earningsDate) return;
    const notes = loadNotes();
    // Skip if already up-to-date
    if (notes.find(n => n.type === 'earnings' && (n.ticker||'').toUpperCase() === symbol && n.dueDate === data.earningsDate)) return;
    // Remove stale auto-earnings note for this ticker if date changed
    const cleaned = notes.filter(n => !(n.type === 'earnings' && (n.ticker||'').toUpperCase() === symbol && n.tags?.includes('auto-earnings')));
    cleaned.push({
      id: `earnings-${symbol}-${data.earningsDate}`,
      title: `${symbol} Earnings`,
      body: `Upcoming earnings report for ${symbol}. Review position before market open.`,
      ticker: symbol, type: 'earnings', dueDate: data.earningsDate,
      completed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      tags: ['auto-earnings'], source: 'auto-sync',
    });
    saveNotes(cleaned);
  } catch { /* best-effort */ }
}

function defaultAlerts() {
  return {
    enabled: true,
    onBuySignal: true, onSellSignal: true, onHoldSignal: false,
    rsiOverbought: null, rsiOversold: null,
    priceAbove: null, priceBelow: null,
    sma200CrossAbove: false, sma200CrossBelow: false,
    macdSignalCross: false,
  };
}

// ── Claude analysis via subprocess ───────────────────────────────────────────
const CLAUDE_BIN = (() => {
  try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return null; }
})();

function claudeAnalyze(signal, symbol, price, sr) {
  if (!CLAUDE_BIN) return Promise.resolve(null);
  const rsi    = sr?.currentRSI  != null ? sr.currentRSI.toFixed(1)  : 'N/A';
  const macd   = sr?.currentMACD != null ? sr.currentMACD.toFixed(3) : 'N/A';
  const trend  = sr ? (sr.aboveSMA ? '↑ above SMA200' : '↓ below SMA200') : 'unknown trend';
  const bt     = sr?.backtestSummary || 'no backtest data';
  const prompt =
    `TradingView ${signal} alert for ${symbol} @ $${price}.\n` +
    `Technical: RSI ${rsi} | MACD hist ${macd} | ${trend}\n` +
    `Backtest: ${bt}\n\n` +
    `In 2 sentences: should I act on this signal? Flag any conflicting indicators or risks.`;

  return new Promise(resolve => {
    let output = '';
    const proc = spawn(CLAUDE_BIN, ['-p', prompt, '--print'], {
      env: { ...process.env },
    });
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.on('close', () => resolve(output.trim() || null));
    proc.on('error', () => resolve(null));
    setTimeout(() => { proc.kill(); resolve(output.trim() || null); }, 25000);
  });
}

function ntfySend(title, message, priority = 'default') {
  try {
    const https = require('https');
    const data  = Buffer.from(message);
    const req = https.request({
      hostname: 'ntfy.sh', path: `/${NTFY_TOPIC}`, method: 'POST',
      headers: { 'Title': title, 'Priority': priority, 'Content-Type': 'text/plain', 'Content-Length': data.length },
    });
    req.on('error', () => {});
    req.write(data);
    req.end();
  } catch {}
}

function rebuildRuleCron(rules) {
  try {
    const existing = sh('crontab -l 2>/dev/null || true');
    const py = path.join(HOME, 'venv/bin/python3');
    const evaluator = path.join(AUTOTRADING, 'rule_evaluator.py');
    const logFile = path.join(AUTOTRADING, 'logs/rules.log');
    const kept = existing.split('\n')
      .filter(l => !l.includes('# autotrading-rule') && !l.includes('# autotrading-ios-event'))
      .join('\n').trim();
    const eventLines = (loadEvents()).filter(e => e.enabled)
      .map(e => `${e.cron} ${e.command} # autotrading-ios-event:${e.id}`).join('\n');
    const ruleLines = rules.filter(r => r.enabled)
      .map(r => `${r.schedule} ${py} ${evaluator} ${r.id} >> ${logFile} 2>&1 # autotrading-rule:${r.id}`)
      .join('\n');
    const full = [kept, 'TZ=America/New_York', eventLines, ruleLines].filter(Boolean).join('\n') + '\n';
    execSync(`echo ${JSON.stringify(full)} | crontab -`, { encoding: 'utf8' });
  } catch (err) {
    console.error('rule cron rebuild failed:', err.message);
  }
}

function loadEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch { return []; }
}

function saveEvents(events) {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
  // Rebuild crontab from events
  rebuildCron(events);
}

function rebuildCron(events) {
  try {
    const existing = sh('crontab -l 2>/dev/null || true');
    const kept = existing.split('\n')
      .filter(l => !l.includes('# autotrading-ios-event'))
      .join('\n').trim();

    const newLines = events
      .filter(e => e.enabled)
      .map(e => `${e.cron} ${e.command} # autotrading-ios-event:${e.id}`)
      .join('\n');

    const full = [kept, 'TZ=America/New_York', newLines].filter(Boolean).join('\n') + '\n';
    const tmp = '/tmp/autotrading_crontab.tmp';
    fs.writeFileSync(tmp, full);
    execSync(`crontab ${tmp}`);
    fs.unlinkSync(tmp);
  } catch (err) {
    console.error('cron rebuild failed:', err.message);
  }
}

export function registerControlRoutes(app, validateToken) {
  const router = Router();

  // ── Status ────────────────────────────────────────────────────────────────
  router.get('/status', (req, res) => {
    const services = SERVICES.map(serviceStatus);
    const mode = ibkrMode();
    const port = mode === 'live' ? 4001 : 4002;
    const connected = sh(`nc -z -w2 127.0.0.1 ${port} && echo ok || echo fail`) === 'ok';
    const uptime = sh('uptime -p');
    const load = sh("awk '{print $1,$2,$3}' /proc/loadavg");

    res.json({
      services,
      ibkr: { mode, port, connected },
      system: { uptime, load },
      reports: listReports().slice(0, 5),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Service control ───────────────────────────────────────────────────────
  router.post('/services/:name/:action', (req, res) => {
    const { name, action } = req.params;
    if (!SERVICES.includes(name)) return res.status(400).json({ error: 'Unknown service' });
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'Unknown action' });

    // Restarting ourselves: delay so response can be sent first
    if (name === 'tv-mcp-http' && action !== 'stop') {
      res.json({ ok: true, message: `${action} scheduled in 1s` });
      setTimeout(() => sh(`systemctl --user ${action} ${name}`), 1000);
      return;
    }

    sh(`systemctl --user ${action} ${name}`);
    const delay = name === 'ibgateway' ? 3000 : (action === 'restart' ? 2000 : 800);
    setTimeout(() => {
      res.json({ ok: true, service: serviceStatus(name) });
    }, delay);
  });

  // ── IBKR ─────────────────────────────────────────────────────────────────
  router.get('/ibkr/status', (req, res) => {
    const mode = ibkrMode();
    const port = mode === 'live' ? 4001 : 4002;
    const connected = sh(`nc -z -w2 127.0.0.1 ${port} && echo ok || echo fail`) === 'ok';
    const svc = serviceStatus('ibgateway');
    res.json({ mode, port, connected, service: svc });
  });

  router.get('/ibkr/portfolio', (req, res) => {
    const py = path.join(HOME, 'venv/bin/python3');
    const script = path.join(AUTOTRADING, 'ibkr_api/get_portfolio.py');
    try {
      const out = sh(`${py} ${script}`, { timeout: 20000 });
      const data = JSON.parse(out);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/ibkr/orders', (req, res) => {
    const py = path.join(HOME, 'venv/bin/python3');
    const script = path.join(AUTOTRADING, 'ibkr_api/get_orders.py');
    try {
      const out = sh(`${py} ${script}`, { timeout: 20000 });
      const data = JSON.parse(out);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/ibkr/order', (req, res) => {
    const { symbol, action, qty, orderType = 'MKT', price } = req.body;
    if (!symbol || !action || !qty) return res.status(400).json({ ok: false, error: 'symbol, action, qty required' });
    if (!/^[A-Z]{1,5}$/.test(symbol)) return res.status(400).json({ ok: false, error: 'Invalid symbol' });
    if (!['BUY','SELL'].includes(action)) return res.status(400).json({ ok: false, error: 'action must be BUY or SELL' });
    if (!['MKT','LMT'].includes(orderType)) return res.status(400).json({ ok: false, error: 'orderType must be MKT or LMT' });

    const py = path.join(HOME, 'venv/bin/python3');
    const script = path.join(AUTOTRADING, 'ibkr_api/place_order.py');
    const args = [symbol, action, Number(qty), orderType, price != null ? Number(price) : ''].filter(v => v !== '').join(' ');
    try {
      const out = sh(`${py} ${script} ${args}`, { timeout: 25000 });
      const data = JSON.parse(out);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.delete('/ibkr/order/:orderId', (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    if (isNaN(orderId)) return res.status(400).json({ ok: false, error: 'Invalid orderId' });
    const py = path.join(HOME, 'venv/bin/python3');
    const script = path.join(AUTOTRADING, 'ibkr_api/cancel_order.py');
    try {
      const out = sh(`${py} ${script} ${orderId}`, { timeout: 20000 });
      const data = JSON.parse(out);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/ibkr/mode/:mode', (req, res) => {
    const { mode } = req.params;
    if (!['paper', 'live'].includes(mode)) return res.status(400).json({ error: 'mode must be paper or live' });
    const script = path.join(AUTOTRADING, 'switch_gateway.sh');
    if (!fs.existsSync(script)) return res.status(500).json({ error: 'switch_gateway.sh not found' });

    res.json({ ok: true, message: `Switching to ${mode}…` });
    setTimeout(() => sh(`bash ${script} ${mode}`), 200);
  });

  // ── Analysis ──────────────────────────────────────────────────────────────
  router.post('/analysis/run', (req, res) => {
    if (analysisState.running) {
      return res.status(409).json({ ok: false, error: 'Analysis already running', ...analysisState });
    }
    const event = req.body.event || 'manual';
    const script = path.join(AUTOTRADING, 'run_sa_analysis.sh');
    const proc = spawn('bash', [script, event], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    analysisState = { running: true, pid: proc.pid, startedAt: new Date().toISOString() };
    proc.on('exit', () => { analysisState = { running: false, pid: null, startedAt: null }; });
    proc.unref();
    res.json({ ok: true, message: `Analysis started (${event})`, pid: proc.pid });
  });

  router.get('/analysis/status', (req, res) => {
    res.json(analysisState);
  });

  router.get('/analysis/logs', (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const events = ['market_open', 'market_close', 'manual'];
    let content = '';
    for (const ev of events) {
      const f = path.join(AUTOTRADING, 'logs', `${ev}_${today}.log`);
      if (fs.existsSync(f)) content += fs.readFileSync(f, 'utf8');
    }
    const lines = content.split('\n').filter(Boolean);
    res.json({ lines: lines.slice(-200), total: lines.length });
  });

  router.get('/reports', (req, res) => {
    res.json({ reports: listReports() });
  });

  router.delete('/reports/:filename', (req, res) => {
    const { filename } = req.params;
    // Only allow deleting sa-stocks-*.html files to prevent path traversal
    if (!filename.match(/^sa-stocks-\d{4}-\d{2}-\d{2}\.html$/)) {
      return res.status(400).json({ ok: false, error: 'Invalid filename' });
    }
    const filePath = path.join(AUTOTRADING, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'Report not found' });
    }
    fs.unlinkSync(filePath);
    res.json({ ok: true, deleted: filename });
  });

  // ── Events ────────────────────────────────────────────────────────────────
  router.get('/events', (req, res) => {
    res.json({ events: loadEvents() });
  });

  // Read-only view of real crontab entries (excludes rule_* and housekeeping lines)
  router.get('/cron', (req, res) => {
    try {
      const raw = execSync('crontab -l', { encoding: 'utf8' });
      const events = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('TZ=')) continue;
        if (t.includes('autotrading-rule:')) continue;
        if (t.includes('autotrading-ios-event')) continue;
        if (t.includes('clean_lean_logs.sh')) continue;

        // Parse: cron-expr(5 fields) command [# comment]
        const m = t.match(/^((?:\S+\s+){4}\S+)\s+(.+?)(?:\s+#\s*(.*))?$/);
        if (!m) continue;
        const [, cronExpr, rawCmd, comment] = m;
        const cmd = rawCmd.trim();

        let name = comment?.trim() || '';
        if (!name) {
          if (cmd.includes('market_open'))      name = 'Market Open Analysis';
          else if (cmd.includes('market_close')) name = 'Market Close Analysis';
          else if (cmd.includes('strategy_builder') || cmd.includes('sa_strategy')) name = 'Strategy Builder';
          else name = cmd.split('/').pop().replace('.sh', '');
        }

        const id = `cron-${Buffer.from(t).toString('base64').slice(0, 12)}`;
        events.push({ id, name, cron: cronExpr.trim(), command: cmd, enabled: true, source: 'system', readOnly: true, createdAt: '' });
      }
      res.json({ events });
    } catch (e) {
      res.status(500).json({ error: e.message, events: [] });
    }
  });

  // Add a raw crontab line (system-level, not tracked in ios-events.json)
  router.post('/cron', (req, res) => {
    const { cron, command } = req.body;
    if (!cron || !command) return res.status(400).json({ error: 'cron and command required' });
    try {
      let current = '';
      try { current = execSync('crontab -l', { encoding: 'utf8' }); } catch {}
      const newLine = `${cron} ${command}`;
      if (current.includes(newLine)) return res.json({ ok: true, message: 'Already exists' });
      const updated = current.trimEnd() + '\n' + newLine + '\n';
      const tmp = '/tmp/autotrading_crontab.tmp';
      fs.writeFileSync(tmp, updated);
      execSync(`crontab ${tmp}`);
      fs.unlinkSync(tmp);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Delete a system crontab line by matching its content (not ios-event managed)
  router.delete('/cron', (req, res) => {
    const { cron, command } = req.body;
    if (!cron || !command) return res.status(400).json({ error: 'cron and command required' });
    try {
      const current = execSync('crontab -l', { encoding: 'utf8' });
      const match = `${cron} ${command}`;
      const filtered = current.split('\n')
        .filter(l => !l.trim().startsWith(match.trim().split(' ').slice(0, 6).join(' ')))
        .join('\n');
      const tmp = '/tmp/autotrading_crontab.tmp';
      fs.writeFileSync(tmp, filtered);
      execSync(`crontab ${tmp}`);
      fs.unlinkSync(tmp);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/events', (req, res) => {
    const { name, cron, command, enabled = true } = req.body;
    if (!name || !cron || !command) return res.status(400).json({ error: 'name, cron, command required' });

    const events = loadEvents();
    const id = `evt_${Date.now()}`;
    events.push({ id, name, cron, command, enabled, createdAt: new Date().toISOString() });
    saveEvents(events);
    res.json({ ok: true, event: events.at(-1) });
  });

  router.patch('/events/:id', (req, res) => {
    const events = loadEvents();
    const idx = events.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Event not found' });
    events[idx] = { ...events[idx], ...req.body, id: events[idx].id };
    saveEvents(events);
    res.json({ ok: true, event: events[idx] });
  });

  router.delete('/events/:id', (req, res) => {
    const events = loadEvents();
    const idx = events.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Event not found' });
    events.splice(idx, 1);
    saveEvents(events);
    res.json({ ok: true });
  });

  // ── Rules ─────────────────────────────────────────────────────────────────
  router.get('/rules', (req, res) => {
    res.json({ rules: loadRules() });
  });

  router.post('/rules', (req, res) => {
    const { name, schedule, condition, action, cooldownMinutes = 60 } = req.body;
    if (!name || !schedule || !condition || !action)
      return res.status(400).json({ error: 'name, schedule, condition, action required' });
    const rules = loadRules();
    const rule = {
      id: `rule_${Date.now()}`, name, schedule, condition, action,
      cooldownMinutes, enabled: true,
      createdAt: new Date().toISOString(),
      lastChecked: null, lastFired: null, lastResult: null,
    };
    rules.push(rule);
    saveRules(rules);
    res.json({ rule });
  });

  router.patch('/rules/:id', (req, res) => {
    const rules = loadRules();
    const idx = rules.findIndex(r => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Rule not found' });
    rules[idx] = { ...rules[idx], ...req.body, id: rules[idx].id };
    saveRules(rules);
    res.json({ rule: rules[idx] });
  });

  router.delete('/rules/:id', (req, res) => {
    const rules = loadRules();
    const idx = rules.findIndex(r => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Rule not found' });
    rules.splice(idx, 1);
    saveRules(rules);
    res.json({ ok: true });
  });

  router.post('/rules/:id/run', (req, res) => {
    const rules = loadRules();
    if (!rules.find(r => r.id === req.params.id))
      return res.status(404).json({ error: 'Rule not found' });
    const py = path.join(HOME, 'venv/bin/python3');
    const evaluator = path.join(AUTOTRADING, 'rule_evaluator.py');
    res.json({ ok: true, message: 'Rule evaluation triggered' });
    const proc = spawn(py, [evaluator, req.params.id, '--force'],
                       { detached: true, stdio: 'ignore' });
    proc.unref();
  });

  // ── Notes ─────────────────────────────────────────────────────────────────

  router.get('/notes', (req, res) => {
    let notes = loadNotes();
    const { type, ticker, date, completed } = req.query;
    if (type)      notes = notes.filter(n => n.type === type);
    if (ticker)    notes = notes.filter(n => n.ticker?.toUpperCase() === ticker.toUpperCase());
    if (date)      notes = notes.filter(n => n.dueDate === date);
    if (completed !== undefined) notes = notes.filter(n => n.completed === (completed === 'true'));

    const sort = req.query.sort || 'dueDate';
    const sortFns = {
      dueDate:   (a, b) => (a.dueDate  || '9999') < (b.dueDate  || '9999') ? -1 : 1,
      ticker:    (a, b) => (a.ticker   || 'ZZZ')  < (b.ticker   || 'ZZZ')  ? -1 : 1,
      type:      (a, b) => a.type < b.type ? -1 : 1,
      createdAt: (a, b) => b.createdAt < a.createdAt ? -1 : 1,
    };
    notes.sort(sortFns[sort] || sortFns.dueDate);
    res.json({ notes });
  });

  router.post('/notes', (req, res) => {
    const { title, body = '', ticker, type = 'note', dueDate, tags = [] } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const notes = loadNotes();
    const note = {
      id: `note_${Date.now()}`,
      title, body,
      ticker: ticker ? ticker.toUpperCase() : null,
      type, dueDate: dueDate || null, tags,
      completed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    notes.push(note);
    saveNotes(notes);
    res.json({ note });
  });

  router.patch('/notes/:id', (req, res) => {
    const notes = loadNotes();
    const idx = notes.findIndex(n => n.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Note not found' });
    const { id: _id, createdAt: _ca, ...patch } = req.body;
    notes[idx] = { ...notes[idx], ...patch, id: notes[idx].id, createdAt: notes[idx].createdAt, updatedAt: new Date().toISOString() };
    saveNotes(notes);
    res.json({ note: notes[idx] });
  });

  router.delete('/notes/:id', (req, res) => {
    const notes = loadNotes();
    const idx = notes.findIndex(n => n.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Note not found' });
    notes.splice(idx, 1);
    saveNotes(notes);
    res.json({ ok: true });
  });

  // ── Watchlist ──────────────────────────────────────────────────────────────

  router.get('/watchlist', (req, res) => {
    res.json({ watchlist: loadWatchlist() });
  });

  router.post('/watchlist', async (req, res) => {
    const { symbol, notes = '', alerts } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const sym = symbol.toUpperCase().trim();
    const wl = loadWatchlist();
    if (wl.find(w => w.symbol === sym)) return res.status(409).json({ error: 'Already in watchlist' });
    const item = {
      symbol: sym, addedAt: new Date().toISOString(), notes,
      alerts: alerts || defaultAlerts(),
      autoCreateRule: false,
      lastSignal: null, lastScore: null, lastChecked: null, lastAlerted: null,
      currentPrice: null, currentRSI: null, currentSMA200: null, currentMACD: null,
    };
    wl.push(item);
    saveWatchlist(wl);

    // Fire-and-forget: fetch earnings for the new symbol and create a note immediately
    fetchAndCreateEarningsNote(sym);

    res.json({ item });
  });

  router.patch('/watchlist/:symbol', (req, res) => {
    const wl = loadWatchlist();
    const sym = req.params.symbol.toUpperCase();
    const idx = wl.findIndex(w => w.symbol === sym);
    if (idx < 0) return res.status(404).json({ error: 'Symbol not in watchlist' });
    const { symbol: _s, addedAt: _a, ...patch } = req.body;
    wl[idx] = { ...wl[idx], ...patch };
    saveWatchlist(wl);
    res.json({ item: wl[idx] });
  });

  router.delete('/watchlist/:symbol', (req, res) => {
    const wl = loadWatchlist();
    const sym = req.params.symbol.toUpperCase();
    const idx = wl.findIndex(w => w.symbol === sym);
    if (idx < 0) return res.status(404).json({ error: 'Symbol not in watchlist' });
    wl.splice(idx, 1);
    saveWatchlist(wl);
    const purged = purgeSymbolData(sym);
    res.json({ ok: true, ...purged });
  });

  // Proxy to ticker-api for live technical data (keeps auth on one port)
  router.get('/watchlist/:symbol/data', (req, res) => {
    const http = require('http');
    const sym = encodeURIComponent(req.params.symbol.toUpperCase());
    http.get(`http://127.0.0.1:8766/api/analyze?ticker=${sym}`, (resp) => {
      let raw = '';
      resp.on('data', c => { raw += c; });
      resp.on('end', () => {
        try { res.json(JSON.parse(raw)); }
        catch { res.status(502).json({ error: 'Parse error from ticker-api' }); }
      });
    }).on('error', e => res.status(502).json({ error: e.message }));
  });

  // Trigger watchlist scanner (runs watchlist_evaluator.py)
  router.post('/watchlist/scan', (req, res) => {
    const py  = path.join(HOME, 'venv-trading/bin/python');
    const scr = path.join(AUTOTRADING, 'watchlist_evaluator.py');
    if (!fs.existsSync(scr)) return res.status(404).json({ error: 'watchlist_evaluator.py not found' });
    res.json({ ok: true, message: 'Watchlist scan triggered' });
    const proc = spawn(py, [scr], { detached: true, stdio: 'ignore' });
    proc.unref();
  });

  // ── SA Portfolio hooks (called by sa-stocks-analysis-linux after each run) ──
  // Purge all auto-generated data for a ticker removed from SAStocks
  router.delete('/sa-portfolio/:symbol', (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    const purged = purgeSymbolData(sym);
    res.json({ ok: true, symbol: sym, ...purged });
  });

  // Fetch and upsert earnings note for a ticker newly added to SAStocks
  router.post('/sa-portfolio/:symbol/sync-earnings', async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    await fetchAndCreateEarningsNote(sym);
    res.json({ ok: true, symbol: sym });
  });

  // ── Ticker Search (proxy to ticker-api) ───────────────────────────────────
  router.get('/search', (req, res) => {
    const http = require('http');
    const q = encodeURIComponent((req.query.q || '').trim());
    if (!q) return res.json([]);
    http.get(`http://127.0.0.1:8766/api/search?q=${q}`, (resp) => {
      let raw = '';
      resp.on('data', c => { raw += c; });
      resp.on('end', () => {
        try { res.json(JSON.parse(raw)); }
        catch { res.json([]); }
      });
    }).on('error', () => res.json([]));
  });

  // ── Trading Ideas — scan SA portfolio + watchlist for actionable signals ───
  router.get('/trading-ideas', (req, res) => {
    const http = require('http');
    http.get('http://127.0.0.1:8766/api/trading-ideas', (resp) => {
      let raw = '';
      resp.on('data', c => { raw += c; });
      resp.on('end', () => {
        try { res.json(JSON.parse(raw)); }
        catch { res.json({ ideas: [], count: 0, scanned: 0 }); }
      });
    }).on('error', () => res.json({ ideas: [], count: 0, scanned: 0 }));
  });

  // ── Earnings Sync — auto-create notes for watchlist + portfolio ────────────
  router.post('/earnings/sync', async (req, res) => {
    const http = require('http');

    function proxyGet(url) {
      return new Promise((resolve) => {
        http.get(url, (resp) => {
          let raw = '';
          resp.on('data', c => { raw += c; });
          resp.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch { resolve(null); }
          });
        }).on('error', () => resolve(null));
      });
    }

    const wl = loadWatchlist();
    const symbols = [...new Set(wl.map(w => w.symbol))];

    // Pull SA portfolio tickers (best-effort — falls back to cached file if cookie is stale)
    try {
      const py  = path.join(HOME, 'venv-trading/bin/python');
      const scr = path.join(AUTOTRADING, 'get_sa_tickers.py');
      if (fs.existsSync(scr) && fs.existsSync(py)) {
        const out = execSync(`${py} ${scr}`, { encoding: 'utf8', timeout: 25000 });
        const tickers = JSON.parse(out.trim());
        if (Array.isArray(tickers)) tickers.forEach(t => { if (t) symbols.push(t); });
      }
    } catch { /* SA unavailable — skip */ }

    // Also try IBKR portfolio (best-effort — IBKR may be offline)
    try {
      const py  = path.join(HOME, 'venv-trading/bin/python');
      const scr = path.join(AUTOTRADING, 'ibkr_api/get_portfolio.py');
      if (fs.existsSync(scr) && fs.existsSync(py)) {
        const out = execSync(`${py} ${scr}`, { encoding: 'utf8', timeout: 8000 });
        const rows = JSON.parse(out);
        if (Array.isArray(rows)) rows.forEach(r => { if (r.symbol) symbols.push(r.symbol); });
      }
    } catch { /* IBKR offline — skip */ }

    const uniqueSymbols = new Set(symbols.map(s => s.toUpperCase()));
    let notes = loadNotes();
    const synced = [], removed = [], skipped = [], errors = [];

    // ── 1. Remove auto-earnings notes for symbols no longer in any portfolio/watchlist ──
    const before = notes.length;
    notes = notes.filter(n => {
      if (n.type !== 'earnings' || !n.tags?.includes('auto-earnings')) return true;
      const keep = uniqueSymbols.has((n.ticker || '').toUpperCase());
      if (!keep) removed.push(n.ticker);
      return keep;
    });

    // ── 2. Add/refresh earnings notes for every current symbol ──
    for (const sym of uniqueSymbols) {
      try {
        const data = await proxyGet(`http://127.0.0.1:8766/api/earnings?ticker=${encodeURIComponent(sym)}`);
        if (!data || !data.earningsDate) { skipped.push(sym); continue; }

        // Already have an up-to-date note — nothing to do
        const upToDate = notes.find(n =>
          n.type === 'earnings' && (n.ticker || '').toUpperCase() === sym && n.dueDate === data.earningsDate
        );
        if (upToDate) { skipped.push(sym); continue; }

        // Replace any stale auto-earnings note for this ticker (date changed)
        notes = notes.filter(n =>
          !(n.type === 'earnings' && (n.ticker || '').toUpperCase() === sym && n.tags?.includes('auto-earnings'))
        );

        notes.push({
          id: `earnings-${sym}-${data.earningsDate}`,
          title: `${sym} Earnings`,
          body: `Upcoming earnings report for ${sym}. Review position before market open.`,
          ticker: sym,
          type: 'earnings',
          dueDate: data.earningsDate,
          completed: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: ['auto-earnings'],
          source: 'auto-sync',
        });
        synced.push(sym);
      } catch { errors.push(sym); }
    }

    saveNotes(notes);
    res.json({ ok: true, synced, removed, skipped, errors });
  });

  // ── Strategy Results ───────────────────────────────────────────────────────
  router.get('/strategy-results', (req, res) => {
    res.json({ results: loadStrategyResults() });
  });

  router.post('/strategy-results', (req, res) => {
    const { results } = req.body;
    if (!Array.isArray(results)) return res.status(400).json({ error: 'results must be an array' });
    saveStrategyResults(results);
    res.json({ ok: true, count: results.length });
  });

  // ── TradingView Alert Webhook ───────────────────────────────────────────────
  // Expected body (plain text): "BUY AAPL @ 175.50" or "SELL TSLA @ 245.30"
  // To wire up: In TV alert dialog → Notifications → Webhook URL →
  //   https://control.mgnetworks.us/api/v1/webhooks/tv-alert
  router.post('/webhooks/tv-alert', async (req, res) => {
    const raw = typeof req.body === 'string'
      ? req.body
      : (req.body?.message || req.body?.text || JSON.stringify(req.body));

    const match = (raw || '').match(/^(BUY|SELL)\s+([A-Z.]{1,10})\s+@\s+([\d.]+)/i);
    if (!match) {
      return res.status(400).json({ error: 'Cannot parse — expected "BUY/SELL SYMBOL @ PRICE"' });
    }

    const [, rawSignal, rawSymbol, price] = match;
    const signal = rawSignal.toUpperCase();
    const symbol = rawSymbol.toUpperCase();
    const isBuy  = signal === 'BUY';

    const sr = loadStrategyResults().find(r => r.symbol === symbol);
    const backtestSummary = sr?.backtestSummary || '';

    // Ask Claude to analyse the signal before creating the rule
    const analysis = await claudeAnalyze(signal, symbol, price, sr);

    const now  = new Date().toISOString();
    const notifyLines = [
      `TradingView ${signal} signal @ $${price}`,
      backtestSummary,
      analysis ? `🤖 ${analysis}` : null,
    ].filter(Boolean).join('\n');

    const rule = {
      id: `rule_tv_${Date.now()}`,
      name: `TV Signal: ${signal} ${symbol}`,
      enabled: false,
      schedule: '*/30 9-16 * * 1-5',
      condition: { type: 'always' },
      action: {
        type: 'notify',
        notifyTitle: `${isBuy ? '📈' : '📉'} ${signal} ${symbol}`,
        notifyMessage: notifyLines,
        notifyPriority: isBuy ? 'high' : 'urgent',
      },
      cooldownMinutes: 1440,
      createdFrom: 'tv_alert',
      alertSignal: signal,
      alertSymbol: symbol,
      alertPrice: price,
      backtestSummary,
      claudeAnalysis: analysis || null,
      createdAt: now,
      lastChecked: null,
      lastFired: null,
      lastResult: `pending — TV ${signal} signal @ $${price}`,
    };

    const rules = loadRules();
    rules.push(rule);
    saveRules(rules);

    const ntfyBody = [
      `@ $${price} — rule created (disabled). Enable in app to auto-execute.`,
      backtestSummary,
      analysis ? `🤖 ${analysis}` : null,
    ].filter(Boolean).join('\n');

    ntfySend(
      `📡 TV Signal: ${signal} ${symbol}`,
      ntfyBody,
      isBuy ? 'high' : 'urgent'
    );

    res.json({ ok: true, ruleId: rule.id, claudeAnalysis: analysis });
  });

  // Mount with auth (webhooks endpoint is also protected by API key)
  app.use('/api/v1', (req, res, next) => {
    if (!validateToken(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }, router);
}
