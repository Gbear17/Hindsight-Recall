// Centralized logging utilities for the Electron main process
// Enhancements (2025-09-07):
//  * Added singleton logger with rotation & threshold filtering.
//  * Added setLevel/getLevel helpers (idempotent init support).
//  * Moved rotation logic here (was previously in main.js broadcast path).
//  * All file writes now stamped with timezone-aware timestamp atomically+rotated.

const fs = require('fs');
const path = require('path');

function dataDir() { return path.join(__dirname, '..', 'data'); }
function frontendLogPath() { return path.join(dataDir(), 'frontend.log'); }

// Advanced timestamp with user-configurable timezone / DST adjustment.
// Expects prefs object (optional) with logTimezone, dstAdjust fields.
function tzTimestamp(prefs) {
  const spec = (prefs && typeof prefs.logTimezone === 'string') ? prefs.logTimezone.trim().toUpperCase() : 'LOCAL';
  const pad = (n, l=2) => String(n).padStart(l,'0');
  const now = new Date();
  let year, mon, day, hr, min, sec, ms, offSign, offH, offM;
  let dstAddHour = prefs && prefs.dstAdjust ? 1 : 0;
  if (spec === 'UTC') {
    year = now.getUTCFullYear(); mon = pad(now.getUTCMonth()+1); day = pad(now.getUTCDate());
    hr = pad((now.getUTCHours()+dstAddHour)%24); min = pad(now.getUTCMinutes()); sec = pad(now.getUTCSeconds()); ms = pad(now.getUTCMilliseconds(),3);
    offSign='+'; offH='00'; offM='00';
  } else if (/^[+-]\d{4}$/.test(spec)) {
    const sign = spec[0] === '-' ? -1 : 1; const h = parseInt(spec.slice(1,3),10); const m = parseInt(spec.slice(3,5),10);
    const totalMin = sign*(h*60+m); let adjustedMin = totalMin; if (dstAddHour) adjustedMin = totalMin + 60;
    const d = new Date(now.getTime() + adjustedMin*60000);
    year = d.getUTCFullYear(); mon = pad(d.getUTCMonth()+1); day = pad(d.getUTCDate()); hr = pad(d.getUTCHours());
    min = pad(d.getUTCMinutes()); sec = pad(d.getUTCSeconds()); ms = pad(d.getUTCMilliseconds(),3);
    const adjAbs = Math.abs(adjustedMin); const adjSign = adjustedMin <= 0 ? '-' : '+'; offSign = adjSign; offH = pad(Math.floor(adjAbs/60)); offM = pad(adjAbs % 60);
  } else {
    year = now.getFullYear(); mon = pad(now.getMonth()+1); day = pad(now.getDate()); hr = pad((now.getHours()+dstAddHour)%24);
    min = pad(now.getMinutes()); sec = pad(now.getSeconds()); ms = pad(now.getMilliseconds(),3);
    const offMin = now.getTimezoneOffset(); const sign = offMin <= 0 ? '+' : '-'; const abs = Math.abs(offMin); offH = pad(Math.floor(abs/60)); offM = pad(abs % 60); offSign = sign;
  }
  let abbrev = '';
  try {
    const baseSpec = spec;
    const stdMap = { '-0800':'PST','-0700':'MST','-0600':'CST','-0500':'EST','-0400':'AST','+0000':'UTC','+0100':'CET','+0200':'EET'};
    const dstMap = { '-0800':'PDT','-0700':'MDT','-0600':'CDT','-0500':'EDT','-0400':'ADT','+0100':'CEST','+0200':'EEST'};
    if (baseSpec === 'LOCAL') {
      try { const fmt = new Intl.DateTimeFormat(undefined, {timeZoneName:'short'}); const parts = fmt.formatToParts(new Date()); const tzp = parts.find(p=>p.type==='timeZoneName'); if (tzp && tzp.value) abbrev = tzp.value.toUpperCase(); } catch(_) {}
    } else if (/^[+-]\d{4}$/.test(baseSpec)) {
      const norm = baseSpec.toUpperCase(); if (prefs && prefs.dstAdjust && dstMap[norm]) abbrev = dstMap[norm]; if (!abbrev && stdMap[norm]) abbrev = stdMap[norm]; if (!abbrev) abbrev = 'UTC'+(offSign==='+'?'+':'-')+offH+(offM!=='00'?(':'+offM):'');
    } else if (baseSpec === 'UTC') { abbrev = 'UTC'; }
  } catch(_) {}
  return `${year}-${mon}-${day}T${hr}:${min}:${sec}.${ms}${offSign}${offH}:${offM}${abbrev?(' '+abbrev):''}`;
}

function deriveLevelFromCategory(category, line) {
  const lower = (line||'').toLowerCase();
  const cat = (category||'').toLowerCase();
  if (cat.includes('error') || lower.includes('traceback') || /\berror\b/i.test(line)) return 'ERROR';
  if (cat.includes('warn') || /\b(degraded|retry|slow)\b/i.test(line)) return 'WARNING';
  if (cat.includes('debug')) return 'DEBUG';
  if (cat.includes('heartbeat')) return 'TRACE';
  if (cat.includes('duplicate')) return 'DEBUG';
  if (cat.includes('capture')) {
    if (/saved|wrote|encrypted|ocr done/i.test(line)) return 'INFO';
  }
  if (/success|started|listening|unlocked/i.test(lower)) return 'INFO';
  return 'INFO';
}

const levelTokenRegex = /^\s*\[[A-Z]+\]/;

function levelizeExistingFrontendLog() {
  const fp = frontendLogPath();
  if (!fs.existsSync(fp)) return;
  try {
    const lines = fs.readFileSync(fp,'utf8').split(/\r?\n/);
    let dirty = false;
    const out = lines.map(l => {
      if (!l.trim()) return l; // keep empty
      if (levelTokenRegex.test(l)) return l; // already tagged
      // attempt to detect category in brackets after timestamp: [ts tz] [cat]
      const m = l.match(/^\[[^\]]+\]\s+\[([^\]]+)\]\s+(.*)$/);
      let cat = '', rest = l;
      if (m) { cat = m[1]; rest = m[2]; }
      const lvl = deriveLevelFromCategory(cat, rest);
      dirty = true;
      return l.replace(/^\[[^\]]+\]/, matchTs => matchTs + ' [' + lvl + ']');
    });
    if (dirty) fs.writeFileSync(fp, out.join('\n'));
  } catch (_) {}
}

function appendFrontendLog(line) { // retained for backward compatibility (unused after centralization)
  try { fs.appendFileSync(frontendLogPath(), line + '\n'); } catch(_) {}
}

// ---- Singleton Logger Implementation ----
let _singletonLogger = null;
const LEVEL_ORDER = ['TRACE','DEBUG','INFO','WARNING','ERROR','CRITICAL'];
function levelIndex(l) { const u = String(l||'INFO').toUpperCase(); const i = LEVEL_ORDER.indexOf(u); return i === -1 ? 2 : i; }
const _recent = [];
const _RECENT_MAX = 500;

function rotateIfNeeded(logPath, prefs) {
  let mb = 2;
  try { if (prefs && typeof prefs.logRotationMB === 'number' && prefs.logRotationMB > 0) mb = prefs.logRotationMB; } catch(_) {}
  if (mb > 64) mb = 64; // safety cap
  const maxBytes = mb * 1024 * 1024;
  try {
    const st = fs.statSync(logPath);
    if (st.size > maxBytes) {
      const rotated = logPath + '.1';
      try { fs.unlinkSync(rotated); } catch(_) {}
      try { fs.renameSync(logPath, rotated); } catch(_) {}
    }
  } catch(_) {}
}

function makeLogger(opts) {
  // Idempotent: return existing instance if already created.
  if (_singletonLogger) return _singletonLogger;
  const {broadcast, getPrefs} = opts || {};
  function writeStamped(line, prefs) {
    try { fs.mkdirSync(path.dirname(frontendLogPath()), {recursive:true}); } catch(_) {}
    rotateIfNeeded(frontendLogPath(), prefs);
    // Atomic-ish append (line writes are effectively atomic on POSIX for small lines).
    fs.appendFileSync(frontendLogPath(), line + '\n');
  }
  function logger(category, message, levelOverride) {
    const prefs = typeof getPrefs === 'function' ? getPrefs() : null;
    const rawMsg = (message == null ? '' : String(message)).trim();
    const derivedLevel = (levelOverride || deriveLevelFromCategory(category||'', rawMsg) || 'INFO').toUpperCase();
    const threshold = (prefs && prefs.logLevel ? String(prefs.logLevel) : 'INFO').toUpperCase();
    if (levelIndex(derivedLevel) < levelIndex(threshold)) return null; // below threshold
    let ts;
    try { ts = tzTimestamp(prefs); } catch(_) { try { ts = new Date().toISOString(); } catch(_) { ts = '1970-01-01T00:00:00.000Z'; } }
    const lineNoTs = `[${derivedLevel}] [${category||'misc'}] ${rawMsg}`;
    const stamped = ts + ' ' + lineNoTs;
    try { writeStamped(stamped, prefs); } catch(_) {}
    try { if (typeof broadcast === 'function') broadcast('log:line', lineNoTs); } catch(_) {}
    try {
      _recent.push(lineNoTs); if (_recent.length > _RECENT_MAX) _recent.splice(0, _recent.length - _RECENT_MAX);
    } catch(_) {}
    return lineNoTs;
  }
  logger.setLevel = (lvl) => {
    if (!lvl) return; try { const p = getPrefs && getPrefs(); if (p) p.logLevel = String(lvl).toUpperCase(); } catch(_) {}
  };
  logger.getLevel = () => { try { const p = getPrefs && getPrefs(); return (p && p.logLevel) ? String(p.logLevel).toUpperCase() : 'INFO'; } catch(_) { return 'INFO'; } };
  _singletonLogger = logger;
  return _singletonLogger;
}

module.exports = {
  tzTimestamp,
  deriveLevelFromCategory,
  levelizeExistingFrontendLog,
  appendFrontendLog,
  makeLogger, // now returns a singleton
  getRecentLines: () => _recent.slice(),
};
