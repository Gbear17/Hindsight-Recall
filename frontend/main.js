/* SPDX-License-Identifier: GPL-3.0-only */
// Entry point for Electron frontend
const {app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, powerMonitor} = require('electron');
const {AuthManager} = require('./authManager');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {spawn, spawnSync} = require('child_process');
// Logging utilities (all provided by ./logging; tzTimestamp now sourced there)
let deriveLevelFromCategory, tzTimestamp, makeLogger; // lazy-required below to avoid early refactor breakages
let tray = null;
// Capture key availability (data key accessible for service restarts)
let unlockedSuccessfully = false; // legacy mirror of authManager.isUnlocked()
// Removed legacy unlockedUI flag: UI prompts every open.
let suppressNextUiPrompt = false; // one-shot bypass after an immediate pre-prompt
// Stronger guarantee that a main window is visible & focused shortly after unlock/open attempts.
function forceShowMainWindow(retries=4, skipPrompt=false) {
  try {
    let win = BrowserWindow.getAllWindows()[0];
    if (!win) {
  // Only suppress the auth prompt when caller explicitly requests it
  if (skipPrompt) suppressNextUiPrompt = true; // skip prompt in createWindow path
      createWindow();
      win = BrowserWindow.getAllWindows()[0];
    }
    if (win) {
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
  // Removed win.moveTop() to avoid triggering X11 _NET_RESTACK_WINDOW atom warning
      } catch(_) {}
    }
    if (retries > 0) {
      // In some DEs initial show can be overridden; retry a few times.
  setTimeout(()=>forceShowMainWindow(retries-1, skipPrompt), 180);
    }
  } catch(_) {}
}
// Expose passphrase prompt function & needPass flag to tray handlers after initialization.
let _promptAndValidateBlocking = null;
let _needPassGlobal = false; // mirrors authManager.needsPass()
let authManager = null;
let mainWindow = null; // persistent reference to keep window alive

// Path & Python helpers (restored)
function projectRoot() { return path.resolve(__dirname, '..'); }

function getPythonCommand() {
  const venv = path.join(projectRoot(), '.venv');
  if (process.platform === 'win32') {
    const pyw = path.join(venv, 'Scripts', 'pythonw.exe');
    const py = path.join(venv, 'Scripts', 'python.exe');
    if (fs.existsSync(pyw)) return pyw;
    if (fs.existsSync(py)) return py;
    return 'python';
  } else {
    const exe = path.join(venv, 'bin', 'python');
    if (fs.existsSync(exe)) return exe;
    return 'python3';
  }
}

// Read PID of detached capture process (returns number or null if invalid/nonexistent)
function readPid() {
  try {
    const txt = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (!txt) return null;
    const n = Number(txt);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Optionally verify process existence (best-effort)
    try { process.kill(n, 0); } catch(_) { return null; }
    return n;
  } catch(_) {
    return null;
  }
}

// Synchronous python helper runner (used for keymgr operations & one-off helpers)
function runPyHelper(pyArgs, opts={}) {
  try {
    const py = getPythonCommand();
    const args = Array.isArray(pyArgs) ? pyArgs.slice() : [];
    const env = {...process.env};
    // Ensure data directory variables propagate if needed
    if (!env.HINDSIGHT_BASE_DIR) {
      try { env.HINDSIGHT_BASE_DIR = path.join(projectRoot(), 'data'); } catch(_) {}
    }
    const res = spawnSync(py, args, {
      input: opts.input || undefined,
      encoding: 'utf8',
      env,
      timeout: opts.timeout || 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {status: res.status, stdout: res.stdout, stderr: res.stderr, error: res.error};
  } catch (e) {
    return {status: -1, stdout: '', stderr: '', error: e};
  }
}

function tzTsWrapper() {
  if (!tzTimestamp) { try { ({tzTimestamp} = require('./logging')); } catch(_) {} }
  let ts = '1970-01-01T00:00:00.000+00:00';
  try { ts = tzTimestamp(prefs); } catch(_) {}
  return ts;
}

// ---- Preferences Handling ----
const PREFS_PATH = path.join(projectRoot(), 'data', 'prefs.json');
function loadPrefs() {
  try {
    const raw = fs.readFileSync(PREFS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
  return Object.assign({autostart:false, interval:5, delaySeconds:0, backend:'auto', logTimezone:'LOCAL', dstAdjust:false, logLevel:'INFO', logRotationMB:2}, parsed);
  } catch {
  return {autostart:false, interval:5, delaySeconds:0, backend:'auto', logTimezone:'LOCAL', dstAdjust:false, logLevel:'INFO', logRotationMB:2};
  }
}
function savePrefs(p) {
  fs.mkdirSync(path.dirname(PREFS_PATH), {recursive: true});
  fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2), 'utf8');
}
let prefs = loadPrefs();

// Resolve icon path (prefers packaged / dev icon file)
function resolveIconPath() {
  try {
    const candidate = path.join(__dirname, 'hindsight_icon.png');
    if (fs.existsSync(candidate)) return candidate;
    const rootCandidate = path.join(projectRoot(), 'frontend', 'hindsight_icon.png');
    if (fs.existsSync(rootCandidate)) return rootCandidate;
  } catch(_) {}
  return null;
}

function createTray() {
  if (tray) return tray;
  try {
    const iconPath = resolveIconPath();
    const image = iconPath ? nativeImage.createFromPath(iconPath) : undefined;
    tray = new Tray(image || nativeImage.createEmpty());
    const ctx = Menu.buildFromTemplate([
      {label: 'Show', click: ()=> { try {
          const wrappedKey = path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass');
          if (fs.existsSync(wrappedKey) && authManager && typeof authManager.needsPass === 'function' && authManager.needsPass()) {
            if (typeof _promptAndValidateBlocking === 'function') { _promptAndValidateBlocking(); return; }
          }
          forceShowMainWindow();
        } catch(_) {} }},
      {label: 'Start Capture', click: ()=> { try { startDetached(prefs.interval||5,{userInitiated:true}); } catch(_) {} }},
      {label: 'Stop Capture', click: ()=> { try { stopDetached(); } catch(_) {} }},
      {label: 'Quit', click: ()=> { try { app.quit(); } catch(_) {} }},
    ]);
    tray.setToolTip('Hindsight Recall');
    tray.setContextMenu(ctx);
    tray.on('click', ()=> {
      try {
        // If encrypted key exists and auth manager says we're locked, force the auth prompt.
        const wrappedKey = path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass');
        if (fs.existsSync(wrappedKey) && authManager && typeof authManager.needsPass === 'function' && authManager.needsPass() && typeof authManager.isUnlocked === 'function' && !authManager.isUnlocked()) {
          if (typeof _promptAndValidateBlocking === 'function') { _promptAndValidateBlocking(); return; }
        }
        forceShowMainWindow();
      } catch(_) {}
    });
    return tray;
  } catch(e) {
    try { console.error('tray create failed', e); } catch(_) {}
    return null;
  }
}

// Early bootstrap diagnostic log
try { console.log('[diag] main bootstrap start'); } catch(_) {}
try { (global.__EARLY_DIAG = Date.now()); } catch(_) {}
try { if (typeof log === 'function') log('lifecycle','bootstrap phase reached'); } catch(_) {}

// ---- Detached Capture Supervisory Control ----
const PID_FILE = path.join(projectRoot(), 'data', 'capture.pid');
const STATUS_FILE = path.join(projectRoot(), 'data', 'status.json');
let consecutiveDisplayErrors = 0;
let lastHealthRestart = 0;
let lastSuccessfulStatus = 0;
let userRequestedStop = false; // suppress health auto-restart when true
let pendingRestartTimer = null; // holds timeout id for scheduled restarts
let lastLoggedCaptureCount = -1;
let lastLoggedError = null;
let lastLoggedUtc = null;
let lastHeartbeat = 0;
let lastInstanceId = null; // track capture service instance to avoid false anomaly logs across restarts
let lastSequence = -1; // monotonic status sequence to skip stale overwrites
let lastStatusUtc = null; // track last_capture_utc for legacy comparisons
let lastSequenceTs = 0; // timestamp of last sequence advancement
let lastServiceInstance = null; // to detect restarts and reset sequence baseline
let consecutiveUnidentified = 0; // track consecutive UnidentifiedImageError statuses
let backendSwitchReason = null; // reason for a forced backend change persisted for next spawn
let systemPaused = false; // true while system is locked/suspended and capture intentionally paused
let lastPolledLockState = null; // track last known lock state (linux)
let spawnInFlight = false; // prevent overlapping spawns when pid file never appears
let captureProc = null; // hold child process reference when not detached for diagnostics
// Renderer status broadcast tracking
let lastBroadcastSequence = -1;
let lastBroadcastCaptureCount = -1;
let lastBroadcastError = null;
let lastBroadcastInstance = null;
let _statusHash = null; // hash of last written status content for dedupe
// Duplicate frame logging aggregation state to reduce noise
let duplicateStreak = 0;
let duplicateWindow = null;
let lastDuplicateLogTs = 0;
const DUP_LOG_INTERVAL_MS = 15000; // summarize at most every 15s
const DUP_LOG_MIN_BATCH = 3; // minimum duplicates before summary

function stableHash(str) {
  // Simple FNV-1a 32-bit hash for small JSON strings
  try {
    let h = 0x811c9dc5;
    for (let i=0;i<str.length;i++) { h ^= str.charCodeAt(i); h = (h >>> 0) * 0x01000193; }
    return (h >>> 0).toString(16);
  } catch { return null; }
}

function writeStatusAtomic(obj) {
  try {
    const json = JSON.stringify(obj);
    const h = stableHash(json);
    if (h && _statusHash === h) return; // unchanged, skip write
    const tmp = STATUS_FILE + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, STATUS_FILE);
    _statusHash = h;
  } catch(_) {}
}

function pauseCaptureForSystem(kind) {
  if (systemPaused) return;
  systemPaused = true;
  log('lifecycle', 'capture paused (system)');
  const pid = readPid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch(_) {}
    setTimeout(()=>{ try { if (readPid() === pid) process.kill(pid, 'SIGKILL'); } catch(_) {} }, 1000);
  }
}

function resumeCaptureAfterSystem(kind) {
  if (!systemPaused) return;
  log('lifecycle', 'capture resumed (system)');
  systemPaused = false;
  if (!readPid() && !userRequestedStop) {
    // slight delay to allow display/session to fully restore
    setTimeout(()=>{ if (!readPid() && !userRequestedStop) startDetached(prefs.interval||5); }, 1200);
  }
}

function setupLinuxLockPolling() {
  if (process.platform !== 'linux') return;
  const username = os.userInfo().username;
  const {spawnSync} = require('child_process');
  function loginctlSessionId() {
    let sid = process.env.XDG_SESSION_ID || null;
    if (sid) return sid;
    try {
      const out = spawnSync('loginctl', ['list-sessions', '--no-legend']).stdout.toString();
      for (const line of out.split(/\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === username) return parts[0];
      }
    } catch(_) {}
    return null;
  }
  function tryLoginctl() {
    const sid = loginctlSessionId();
    if (!sid) return null;
    try {
      const out = spawnSync('loginctl', ['show-session', sid, '-p', 'LockedHint']).stdout.toString();
      const m = out.match(/LockedHint=(yes|no)/i);
      if (m) return m[1].toLowerCase() === 'yes';
    } catch(_) {}
    return null;
  }
  function tryDbusScreensaver() {
    // GNOME
    try {
      const out = spawnSync('gdbus', ['call','--session','--dest','org.gnome.ScreenSaver','--object-path','/org/gnome/ScreenSaver','--method','org.gnome.ScreenSaver.GetActive']).stdout.toString();
      if (/true/i.test(out)) return true; if (/false/i.test(out)) return false;
    } catch(_) {}
    // freedesktop / KDE
    try {
      const out = spawnSync('qdbus', ['org.freedesktop.ScreenSaver','/ScreenSaver','GetActive']).stdout.toString();
      if (/^true/i.test(out.trim())) return true; if (/^false/i.test(out.trim())) return false;
    } catch(_) {}
    try {
      const out = spawnSync('dbus-send', ['--session','--print-reply','--dest=org.freedesktop.ScreenSaver','/ScreenSaver','org.freedesktop.ScreenSaver.GetActive']).stdout.toString();
      if (/boolean true/.test(out)) return true; if (/boolean false/.test(out)) return false;
    } catch(_) {}
    return null;
  }
  function detectLocked() {
    // Order: DBus (fast, DE specific) then loginctl fallback.
    const dbus = tryDbusScreensaver();
    if (dbus !== null) return dbus;
    const lc = tryLoginctl();
    if (lc !== null) return lc;
    return null; // unknown
  }
  function poll() {
    if (systemPaused && userRequestedStop) {
      // user explicitly stopped while paused; don't auto resume later
    }
    const state = detectLocked();
    if (state !== null && state !== lastPolledLockState) {
      lastPolledLockState = state;
      if (state) pauseCaptureForSystem('lock-detect'); else resumeCaptureAfterSystem('lock-detect');
    }
    setTimeout(poll, 4000);
  }
  poll();
}

function scanForOtherCaptureProcesses(callback) {
  // Linux/mac/macOS/WSL: use ps to detect stray capture.cli processes.
  const ps = spawn('ps', ['-eo', 'pid,command']);
  let out='';
  ps.stdout.on('data', d=> out += d.toString());
  ps.on('close', ()=>{
    try {
      const lines = out.split(/\n/).filter(l=>/capture\.cli/.test(l));
      const currentPid = readPid();
      const others = [];
      for (const line of lines) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        if (currentPid && pid === currentPid) continue;
        // ignore our own electron/node process
        if (pid === process.pid) continue;
        others.push({pid, cmd: m[2]});
      }
      if (others.length) {
  log('anomaly', `detected ${others.length} additional capture process(es): ${others.map(o=>o.pid).join(',')}`);
      }
      if (callback) callback(others);
    } catch(_) { if (callback) callback([]); }
  });
}

function supervisorArgs(action, extra=[]) {
  const py = getPythonCommand();
  const base = [py, '-m', 'capture.cli']; // only used for start; stop/status handled locally
  return {py, base, extra};
}

function startDetached(interval, opts={}) {
  // If already running (pid file valid) skip.
  const pid = readPid();
  if (pid) return {action:'already', pid};
  if (userRequestedStop && !opts.userInitiated) {
  log('control', 'auto start suppressed (user stop active)');
    return {action:'suppressed'};
  }
  if (spawnInFlight) {
  log('control', 'spawn already in-flight; skipping duplicate start request');
    return {action:'in-flight'};
  }
  // If a passphrase is required but not yet unlocked, defer.
  if (_needPassGlobal && !unlockedSuccessfully) {
  log('control', 'start requested but key not yet unlocked; deferring');
    return {action:'deferred'};
  }
  if (opts.userInitiated) {
    userRequestedStop = false; // only clear suppression when user explicitly starts
  }
  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
  // Pre-start purge: scan and forcibly kill any stray capture processes
  scanForOtherCaptureProcesses(list => {
    if (list.length) {
      for (const procInfo of list) {
        try { process.kill(procInfo.pid, 'SIGTERM'); } catch(_) {}
      }
      setTimeout(()=>{
        for (const procInfo of list) {
          try { process.kill(procInfo.pid, 0); process.kill(procInfo.pid, 'SIGKILL'); log('control', `escalated SIGKILL stray pid=${procInfo.pid}`); } catch(_) {}
        }
      }, 700);
    }
  });
  // If existing status file is legacy (no sequence marker), archive it to avoid stale reads.
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const txt = fs.readFileSync(STATUS_FILE,'utf8');
      if (!/"sequence"\s*:/.test(txt)) {
        const archived = STATUS_FILE + '.legacy-' + Date.now();
        fs.renameSync(STATUS_FILE, archived);
  log('lifecycle', `archived legacy status file -> ${path.basename(archived)}`);
      }
    }
  } catch(_) {}
  const py = getPythonCommand();
  // Removed '--print-status' to avoid very long STATUS:: JSON lines in stdout (status file still polled separately)
  const args = [py, '-m', 'capture.cli', '--dir', path.join(projectRoot(),'data'), '--interval', String(interval||5), '--pid-file', PID_FILE];
  // Append log level argument (safe even if capture.cli ignores unknown flag in older versions)
  try { if (prefs && prefs.logLevel) args.push('--log-level', String(prefs.logLevel)); } catch(_) {}
  const env = {...process.env};
  if (prefs.backend && prefs.backend !== 'auto') {
    env.HINDSIGHT_FORCE_BACKEND = prefs.backend;
  }
  // Propagate timezone preferences to backend for filename timestamping.
  try {
    if (prefs && typeof prefs.logTimezone === 'string') {
      env.HINDSIGHT_TZ_SPEC = String(prefs.logTimezone).trim();
    }
    if (prefs && typeof prefs.dstAdjust !== 'undefined') {
      env.HINDSIGHT_DST_ADJUST = prefs.dstAdjust ? '1' : '0';
    }
  } catch(_) {}
  if (backendSwitchReason) {
    env.HINDSIGHT_BACKEND_SWITCH_REASON = backendSwitchReason;
  }
  try {
    const logDir = path.join(projectRoot(), 'data');
    try { fs.mkdirSync(logDir, {recursive:true}); } catch(_) {}
    const outPath = path.join(logDir, 'capture.stdout.log');
    const errPath = path.join(logDir, 'capture.stderr.log');
    const outFd = fs.openSync(outPath, 'a');
  } catch (_) {}
  // spawn child detached
  try {
    const child = spawn(py, args.slice(1), {detached:true, stdio:['ignore', 'ignore', 'ignore'], env});
    child.unref();
    spawnInFlight = true;
    log('control', `started capture (interval=${interval||5}s)`);
    setTimeout(()=>{ if (!readPid()) log('anomaly', 'capture spawn produced no pid file (will retry later)'); else spawnInFlight = false; }, 1800);
  } catch (e) {
    log('error', `failed to spawn capture: ${e.message}`, 'ERROR');
  }
  setTimeout(pollStatus, 2000);
}
setTimeout(pollStatus, 1500);

function stopDetached() {
  const pid = readPid();
  if (!pid) {
    userRequestedStop = true; // still suppress auto restarts
    return {action:'none'};
  }
  try { process.kill(pid, 'SIGTERM'); } catch(_) {}
  setTimeout(()=>{ try { if (readPid() === pid) process.kill(pid, 'SIGKILL'); } catch(_) {} }, 1200);
  userRequestedStop = true; // suppress auto restarts until user starts again
  log('control', 'stop requested (SIGTERM)');
  log('control', 'auto-restart suppressed until user starts capture again');
  return {action:'signaled', pid};
}

// Stall detector: if no sequence progress for > 20s while pid alive, restart.
setInterval(() => {
  const pid = readPid();
  if (!pid) return;
  if (!systemPaused && lastSequence !== -1 && Date.now() - lastSequenceTs > 20000) {
  log('health', 'capture appears stalled (no sequence advance >20s); restarting');
    internalStopForHealth();
    setTimeout(()=>{ if (!userRequestedStop) startDetached(prefs.interval||5); }, 1200);
  }
}, 5000);

function killOtherCaptureProcesses() {
  scanForOtherCaptureProcesses(list => {
    for (const p of list) {
      try { process.kill(p.pid, 'SIGTERM'); } catch(_) {}
      setTimeout(()=>{ try { process.kill(p.pid, 0); process.kill(p.pid, 'SIGKILL'); } catch(_) {} }, 600);
    }
  if (list.length) log('control', `signaled stray capture processes (${list.map(x=>x.pid).join(',')})`);
    setTimeout(()=>{
  scanForOtherCaptureProcesses(remain => { if (remain.length) log('anomaly', `stray processes still alive after kill attempt: ${remain.map(r=>r.pid).join(',')}`); });
    }, 1500);
  });
  return {requested:true};
}

// Poll and process status.json periodically.
function pollStatus() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return; // nothing yet
    let dataRaw;
    try { dataRaw = fs.readFileSync(STATUS_FILE,'utf8'); } catch(_) { return; }
    let data;
    try { data = JSON.parse(dataRaw); } catch(_) { return; }
    if (data) {
      // Detect instance change earlier (before stale check) so we can accept a lower sequence
      if (data.service_instance_id && lastServiceInstance && data.service_instance_id !== lastServiceInstance) {
        log('lifecycle', `new service instance detected (sequence baseline reset) ${data.service_instance_id}`);
        lastSequence = -1; // reset baseline
      }
      if (typeof data.sequence === 'number') {
        if (lastSequence !== -1 && data.sequence < lastSequence) {
          log('stale', `ignoring out-of-order status sequence=${data.sequence} < ${lastSequence}`);
          return;
        }
      } else if (lastSequence !== -1) {
        log('stale', 'ignoring legacy status without sequence');
        return;
      }
      if (data.service_instance_id && data.service_instance_id !== lastInstanceId) {
        log('lifecycle', `detected new capture service instance ${data.service_instance_id}`);
        lastInstanceId = data.service_instance_id;
        lastLoggedCaptureCount = -1;
        lastLoggedError = null;
        lastSequence = -1;
        lastStatusUtc = null;
        scanForOtherCaptureProcesses();
      }
      if (typeof data.capture_count === 'number' && data.capture_count !== lastLoggedCaptureCount) {
        log('capture', `#${data.capture_count} window="${data.window_title}" backend=${data.capture_backend||'n/a'}`);
        if (lastInstanceId && lastLoggedCaptureCount !== -1 && data.capture_count < lastLoggedCaptureCount - 3) {
          log('anomaly', `capture_count regressed from ${lastLoggedCaptureCount} to ${data.capture_count}; possible stale secondary process`);
        }
        lastLoggedCaptureCount = data.capture_count;
        // Flush duplicate streak summary when a real capture occurs
        if (duplicateStreak >= DUP_LOG_MIN_BATCH) {
          log('duplicate', `skipped ${duplicateStreak} identical frame(s) window="${duplicateWindow}"`);
        } else if (duplicateStreak > 0) {
          // Still log small streaks for visibility but grouped
          log('duplicate', `skipped ${duplicateStreak} identical frame(s) window="${duplicateWindow}"`);
        }
        duplicateStreak = 0;
        duplicateWindow = null;
      } else if (data.duplicate === true) {
        // Aggregate duplicate notifications to prevent per-interval spam.
        if (duplicateWindow && data.window_title !== duplicateWindow) {
          // Window changed mid-streak; flush existing streak first
            if (duplicateStreak >= DUP_LOG_MIN_BATCH) {
              log('duplicate', `skipped ${duplicateStreak} identical frame(s) window="${duplicateWindow}"`);
            } else if (duplicateStreak > 0) {
              log('duplicate', `skipped ${duplicateStreak} identical frame(s) window="${duplicateWindow}"`);
            }
            duplicateStreak = 0;
        }
        duplicateWindow = data.window_title;
        duplicateStreak += 1;
        const now = Date.now();
        if (duplicateStreak === 1) {
          log('duplicate', `started duplicate streak window="${data.window_title}"`);
          lastDuplicateLogTs = now;
        } else if (now - lastDuplicateLogTs >= DUP_LOG_INTERVAL_MS) {
          log('duplicate', `continuing duplicate streak (${duplicateStreak} frames) window="${data.window_title}"`);
          lastDuplicateLogTs = now;
        }
      }
      if (typeof data.sequence === 'number' && data.sequence > lastSequence) {
        lastSequence = data.sequence;
        lastSequenceTs = Date.now();
        if (data.service_instance_id) lastServiceInstance = data.service_instance_id;
      }
      if (!data.sequence && lastInstanceId) {
        const lc = data.last_capture_utc || 'unknown';
        log('anomaly', `legacy status overwrite detected (utc=${lc}); possible old process still running`);
        scanForOtherCaptureProcesses();
      }
      if (data.last_capture_utc) lastStatusUtc = data.last_capture_utc;
      if (data.last_capture_utc && data.last_capture_utc !== lastLoggedUtc) {
        lastLoggedUtc = data.last_capture_utc;
      }
      const errNow = data.error || null;
      if (errNow !== lastLoggedError) {
        if (errNow) log('error', errNow, 'ERROR'); else if (lastLoggedError) log('recovery', 'error cleared');
        lastLoggedError = errNow;
      }
      // Decide if we should broadcast status to renderer (avoid flooding)
      const seqChanged = (typeof data.sequence === 'number' && data.sequence !== lastBroadcastSequence);
      const capChanged = (typeof data.capture_count === 'number' && data.capture_count !== lastBroadcastCaptureCount);
      const errChanged = (errNow !== lastBroadcastError);
      const instChanged = (data.service_instance_id && data.service_instance_id !== lastBroadcastInstance);
      if (seqChanged || capChanged || errChanged || instChanged) {
        try {
          broadcast('status:update', {
            capture_count: data.capture_count,
            window_title: data.window_title,
            last_capture_utc: data.last_capture_utc,
            error: errNow,
            capture_backend: data.capture_backend,
            duplicate: !!data.duplicate,
            service_instance_id: data.service_instance_id,
            sequence: data.sequence,
            backend_switch_reason: data.backend_switch_reason,
            interval: prefs.interval || 5,
          });
        } catch(_) {}
        if (typeof data.sequence === 'number') lastBroadcastSequence = data.sequence;
        if (typeof data.capture_count === 'number') lastBroadcastCaptureCount = data.capture_count;
        lastBroadcastError = errNow;
        if (data.service_instance_id) lastBroadcastInstance = data.service_instance_id;
      }
    }
    const nowTs = Date.now();
    if (nowTs - lastHeartbeat > 30000) {
      log('heartbeat', `pid=${readPid()||'none'} captures=${lastLoggedCaptureCount} displayErrs=${consecutiveDisplayErrors}`);
      lastHeartbeat = nowTs;
    }
    const threshold = lastSuccessfulStatus === 0 ? 1 : 3;
    if (!userRequestedStop && !systemPaused && consecutiveDisplayErrors >= threshold) {
      const now = Date.now();
      if (now - lastHealthRestart > 15000) {
        log('health', 'Display error detected repeatedly; scheduling restart');
        internalStopForHealth();
        if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); }
        pendingRestartTimer = setTimeout(()=>{ if (!userRequestedStop) startDetached(prefs.interval || 5); pendingRestartTimer=null; }, 1200);
        lastHealthRestart = now;
        consecutiveDisplayErrors = 0;
      }
    }
  } catch (_) {}
  setTimeout(pollStatus, 2000);
}
setTimeout(pollStatus, 1500);
// ---- Shared Log Level Derivation Helper ----
// deriveLevelFromCategory now provided by ./logging
// Use shared logger factory.
let log = function(category, message, levelOverride) {
  try {
    if (!makeLogger) { ({makeLogger} = require('./logging')); }
    // create once when first needed
  log = makeLogger({broadcast, getPrefs: ()=> prefs});
  try { console.log('[diag] logger initialized'); } catch(_) {}
  const out = log(category, message, levelOverride);
  return out;
  } catch(e) {
    try { broadcast('log:line', `[ERROR] [log] logger init failure ${e.message}`); } catch(_) {}
  }
};
function broadcast(channel, payload) {
  // File writing & rotation handled centrally in logging.js singleton; here we only forward to renderer.
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload); } catch (_) {}
  }
}

// One-time retroactive level annotation for existing frontend.log entries without [INFO]/[ERROR]/etc.
// levelizeExistingFrontendLog now provided by ./logging


function autostartPaths() {
  if (process.platform === 'win32') {
    const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return {type: 'windows', file: path.join(startupDir, 'HindsightRecallCapture.bat')};
  } else if (process.platform === 'darwin') {
    const launchDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    return {type: 'mac', file: path.join(launchDir, 'com.hindsight.recall.capture.plist')};
  } else { // linux / others
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  return {type: 'linux', file: path.join(autostartDir, 'hindsight-recall-capture.desktop')};
  }
}

function getAutostartEnabled() {
  const p = autostartPaths();
  return fs.existsSync(p.file);
}

function createLinuxAutostart(py, args) {
  const p = autostartPaths();
  const deEnv = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase();
  let deTag = 'generic';
  if (deEnv.includes('gnome')) deTag = 'gnome';
  else if (deEnv.includes('kde')) deTag = 'kde';
  else if (deEnv.includes('xfce')) deTag = 'xfce';
  else if (deEnv.includes('cinnamon')) deTag = 'cinnamon';
  else if (deEnv.includes('lxqt') || deEnv.includes('lxde')) deTag = 'lxqt';
  else if (deEnv.includes('mate')) deTag = 'mate';
  const delay = Number(prefs.delaySeconds || 0);
  const effectiveDelay = delay < 8 ? 8 : delay; // ensure session fully up (panels, DISPLAY perms)
  // Create a wrapper script to avoid complex Exec quoting & ensure environment readiness.
  const pr = projectRoot();
  const dataDir = path.join(pr, 'data');
  const wrapperPath = path.join(pr, 'hindsight_capture_wrapper.sh');
  const backendEnv = (prefs.backend && prefs.backend !== 'auto') ? `export HINDSIGHT_FORCE_BACKEND=${prefs.backend}\n` : '';
  // Determine Electron binary robustly; prefer local project electron dist, then node_modules/.bin, then global electron, then npx.
  const localDist = path.join(projectRoot(), 'node_modules', 'electron', 'dist', 'electron');
  const localBin = path.join(projectRoot(), 'node_modules', '.bin', 'electron');
  let electronBin = '';
  if (process.env.HINDSIGHT_ELECTRON_CMD) {
    electronBin = process.env.HINDSIGHT_ELECTRON_CMD;
  } else if (fs.existsSync(localDist)) {
    electronBin = localDist;
  } else if (fs.existsSync(localBin)) {
    electronBin = localBin;
  } else if (process.env.PATH && process.env.PATH.split(':').some(p=> fs.existsSync(path.join(p,'electron')))) {
    electronBin = 'electron';
  } else {
    electronBin = 'npx electron';
  }
  const mainAbs = path.join(projectRoot(), 'frontend', 'main.js');
  const script = `#!/usr/bin/env bash\nset -euo pipefail\nLOGDIR=\"${dataDir}\"\nmkdir -p \"$LOGDIR\"\nTS() { date -Iseconds; }\nlog() { echo \"$(TS) [wrapper] $*\" >> \"$LOGDIR/autostart.log\"; }\nlog start pid=$$ DISPLAY=$DISPLAY USER=$USER PATH=$PATH\n${effectiveDelay>0?`sleep ${effectiveDelay}\n`:''}cd \"${pr}\"\nexport HINDSIGHT_AUTOSTART=1\n# Resolve electron binary if placeholder chosen\nELECTRON_CMD='${electronBin}'\nif [[ $ELECTRON_CMD == 'npx electron' ]]; then\n  if ! command -v npx >/dev/null 2>&1; then log 'npx not found; cannot launch electron'; exit 1; fi\nfi\nlog launching electron cmd=\"$ELECTRON_CMD\" main=${mainAbs}\n( $ELECTRON_CMD \"${mainAbs}\" >> \"$LOGDIR/electron.autostart.out\" 2>&1 & echo $! > \"$LOGDIR/autostart.spawned.pid\" )\nSPAWNED=$(cat \"$LOGDIR/autostart.spawned.pid\")\nlog spawned electron_pid=$SPAWNED\n`;
  try {
    fs.writeFileSync(wrapperPath, script, {mode: 0o755});
  } catch (e) {
  log('error', `failed writing wrapper script: ${e.message}`, 'ERROR');
  }
  const execLine = wrapperPath; // simpler & robust
  const chosenIcon = path.join(projectRoot(), 'frontend', 'hindsight_icon.png');
  const iconLine = fs.existsSync(chosenIcon) ? `Icon=${chosenIcon}\n` : '';
  const onlyShowInLine = deTag === 'kde' ? 'OnlyShowIn=KDE;\n' : '';
  const content = `[Desktop Entry]\nType=Application\nVersion=1.0\nName=Hindsight Recall Capture\nComment=Background capture service (auto-start)\nExec=${execLine}\n${iconLine}X-GNOME-Autostart-enabled=true\nX-KDE-autostart-after=panel\nX-Desktop-Environment=${deTag}\n${onlyShowInLine}Terminal=false\nHidden=false\nCategories=Utility;\n`;
  fs.writeFileSync(p.file, content, {mode: 0o644});
  return {deTag, delay: effectiveDelay, file: p.file, mode: 'electron'};
}

function enableAutostart(enable) {
  const p = autostartPaths();
  if (!enable) {
    if (fs.existsSync(p.file)) try { fs.unlinkSync(p.file); } catch (e) { /* ignore */ }
    prefs.autostart = false;
    savePrefs(prefs);
    return false;
  }
  fs.mkdirSync(path.dirname(p.file), {recursive: true});
  const py = getPythonCommand();
  const args = [
    '-m','capture.cli',
    '--dir', path.join(projectRoot(), 'data'),
    '--interval', String(prefs.interval || 5),
    '--print-status','--pid-file', PID_FILE
  ];
  if (p.type === 'windows') {
    const content = `@echo off\ncd /d "${projectRoot()}"\n"${py}" ${args.map(a=>`"${a}"`).join(' ')}\n`;
    fs.writeFileSync(p.file, content, 'utf8');
  } else if (p.type === 'mac') {
    const plist = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>com.hindsight.recall.capture</string>\n  <key>ProgramArguments</key><array>\n    <string>${py}</string>${args.map(a=>`\n    <string>${a}</string>`).join('')}\n  </array>\n  <key>WorkingDirectory</key><string>${projectRoot()}</string>\n  <key>RunAtLoad</key><true/>\n  <key>StandardOutPath</key><string>${path.join(projectRoot(),'data','capture.log')}</string>\n  <key>StandardErrorPath</key><string>${path.join(projectRoot(),'data','capture.err')}</string>\n</dict></plist>`;
    fs.writeFileSync(p.file, plist, 'utf8');
  } else { // linux
    createLinuxAutostart(py, args);
  }
  prefs.autostart = true;
  savePrefs(prefs);
  log('lifecycle', `autostart enabled file=${p.file}`);
  return true;
}

function validateAutostart() {
  const result = {platform: process.platform, exists: false, file: null, issues: [], exec: null};
  const p = autostartPaths();
  result.file = p.file;
  if (!fs.existsSync(p.file)) {
    result.issues.push('Autostart file not found');
    return result;
  }
  result.exists = true;
  try {
    const content = fs.readFileSync(p.file, 'utf8');
    if (p.type === 'linux') {
      const lines = content.split(/\n/);
      const map = {};
      for (const l of lines) {
        const idx = l.indexOf('=');
        if (idx > 0) map[l.slice(0, idx)] = l.slice(idx + 1);
      }
      result.exec = map.Exec || null;
      if (!map.Type || map.Type !== 'Application') result.issues.push('Type is missing or not Application');
      if (!result.exec) result.issues.push('Exec line missing');
      else {
        // Heuristic validation: legacy direct python invocation included 'capture' and '--interval'.
        // Current design uses a wrapper script (hindsight_capture_wrapper.sh) that launches Electron.
        const execPath = result.exec.split(/\s+/)[0];
        const isWrapper = /hindsight_capture_wrapper\.sh$/.test(execPath);
        if (!isWrapper) {
          if (!result.exec.includes('capture') || !result.exec.includes('--interval')) {
            result.issues.push('Exec line may be incomplete');
          }
        } else {
          // For wrapper, ensure file exists & is executable.
          try {
            if (!fs.existsSync(execPath)) result.issues.push('Wrapper script missing: ' + execPath);
            else {
              const st = fs.statSync(execPath);
              if (!(st.mode & 0o111)) result.issues.push('Wrapper script not executable: ' + execPath);
            }
          } catch (e) {
            result.issues.push('Wrapper validation error: ' + e.message);
          }
        }
        // crude check for quoting issues (still applies)
        if ((result.exec.match(/"/g) || []).length % 2 !== 0) result.issues.push('Unbalanced quotes in Exec line');
      }
    } else if (p.type === 'mac') {
      if (!content.includes('<plist')) result.issues.push('Not a valid plist');
      if (!content.includes('<key>ProgramArguments</key>')) result.issues.push('ProgramArguments missing');
    } else if (p.type === 'windows') {
      if (!content.toLowerCase().includes('python')) result.issues.push('Batch file missing python invocation');
    }
  } catch (e) {
    result.issues.push('Error reading autostart file: ' + e.message);
  }
  return result;
}

ipcMain.handle('autostart:get', () => getAutostartEnabled());
ipcMain.handle('autostart:set', (_evt, enable) => enableAutostart(!!enable));
ipcMain.handle('autostart:validate', () => validateAutostart());
ipcMain.handle('prefs:get', () => ({...prefs}));
ipcMain.handle('prefs:set', (_evt, newPrefs) => {
  const oldInterval = prefs.interval;
  const oldLevel = prefs.logLevel;
  prefs = Object.assign(prefs, newPrefs || {});
  if (!prefs.logLevel) prefs.logLevel = 'INFO';
  if (typeof prefs.logRotationMB !== 'number' || !(prefs.logRotationMB > 0)) prefs.logRotationMB = 2;
  if (prefs.logRotationMB > 64) prefs.logRotationMB = 64;
  savePrefs(prefs);
  try { log('prefs', `updated interval=${prefs.interval} delay=${prefs.delaySeconds} tz=${prefs.logTimezone} dst=${prefs.dstAdjust} level=${prefs.logLevel} rotMB=${prefs.logRotationMB}`); } catch(_) {}
  if (prefs.autostart) enableAutostart(true); // regenerate with new settings
  if (prefs.interval !== oldInterval || prefs.logLevel !== oldLevel) {
    // Restart detached service by signaling stop then start.
    stopDetached();
    setTimeout(()=>startDetached(prefs.interval || 5), 500);
  }
  return {...prefs};
});
// IPC: runtime python log level change (best-effort via control file read by future processes)
ipcMain.handle('loglevel:set', (_evt, lvl) => {
  try {
    if (typeof lvl === 'string' && lvl.trim()) {
      prefs.logLevel = lvl.trim().toUpperCase();
      savePrefs(prefs);
      // For already running capture process we cannot safely inject level without a custom IPC; future restarts will apply.
      log('control', `python log level updated (takes effect next restart) level=${prefs.logLevel}`);
      return {ok:true, level:prefs.logLevel};
    }
  } catch(e) { return {ok:false, error:String(e)}; }
  return {ok:false, error:'invalid'};
});
ipcMain.handle('loglevel:get', () => ({level: (prefs.logLevel||'INFO').toUpperCase()}));
ipcMain.handle('logs:recent', () => {
  try { const lg = require('./logging'); if (lg && typeof lg.getRecentLines === 'function') return {lines: lg.getRecentLines()}; } catch(_) {}
  return {lines: []};
});
// Auth handler: accept passphrase from renderer and stash into env for child processes.
ipcMain.handle('auth:submit', (_evt, passphrase) => {
  if (typeof passphrase === 'string' && passphrase.length) {
    process.env.HINDSIGHT_PASSPHRASE = passphrase;
    return {ok: true};
  }
  return {ok: false, error: 'empty'};
});
// Supervisor control IPC
ipcMain.handle('capture:start', ()=> startDetached(prefs.interval || 5,{userInitiated:true}));
ipcMain.handle('capture:stop', ()=> stopDetached());
ipcMain.handle('capture:status', ()=> ({pid: readPid()}));
ipcMain.handle('capture:kill-others', ()=> killOtherCaptureProcesses());
ipcMain.handle('data:purge', () => {
  stopDetached();
  const dataDir = path.join(projectRoot(), 'data');
  const encDir = path.join(dataDir, 'encrypted');
  const plainDir = path.join(dataDir, 'plain');
  let removed = 0;
  function wipeDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f === 'key.fernet' && dir === encDir) continue;
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).isDirectory()) { fs.rmSync(p, {recursive:true, force:true}); }
        else { fs.unlinkSync(p); }
        removed++;
      } catch(_) {}
    }
  }
  wipeDir(encDir);
  wipeDir(plainDir);
  try { fs.unlinkSync(STATUS_FILE); removed++; } catch(_){}
  try { fs.unlinkSync(PID_FILE); removed++; } catch(_){}
  log('control', `data purge removed ~${removed} items`);
  return {removed};
});
ipcMain.handle('auth:change', (_evt, payload) => {
  try {
    const {auth, next, useRecovery} = payload || {};
    if (!auth || !next) return {ok:false, err:'missing_fields'};
    const args = ['-m','capture.keymgr','--base-dir', path.join(projectRoot(),'data'),'--change'];
    if (useRecovery) args.push('--use-recovery');
    const res = runPyHelper(args, {input: auth + '\n' + next + '\n'});
    if (res.status === 0) {
      let recovery = null;
      try { const parsed = JSON.parse(res.stdout||''); recovery = parsed.recovery || null; } catch(_) {}
      if (recovery) { try { promptForRecoveryModal(recovery); } catch(_) {} }
      return {ok:true};
    }
    return {ok:false, code: res.status, err: (res.stderr||res.stdout||'').toString().trim()};
  } catch (e) { return {ok:false, err:String(e)}; }
});

// Manual debug logging IPC: emit arbitrary log lines from renderer
ipcMain.handle('debug:log', (_evt, line) => {
  if (typeof line === 'string' && line.trim()) {
  log('debug', line.trim(), 'DEBUG');
    return {ok:true};
  }
  return {ok:false, error:'empty'};
});

// Internal stop for health restarts (does not flip userRequestedStop)
function internalStopForHealth() {
  const pid = readPid();
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch(_) {}
  setTimeout(()=>{ try { if (readPid() === pid) process.kill(pid, 'SIGKILL'); } catch(_) {} }, 800);
}

function createWindow() {
  if (_needPassGlobal) {
    // UI requires authentication before showing main window; allow a one-shot suppression
    if (!suppressNextUiPrompt && typeof _promptAndValidateBlocking === 'function') {
      _promptAndValidateBlocking();
      return; // show after user completes prompt via subsequent action
    }
    suppressNextUiPrompt = false; // reset after using suppression
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.show(); mainWindow.focus(); } catch(_) {}
    return mainWindow;
  }
  const iconPath = resolveIconPath();
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: iconPath || undefined,
  });
  mainWindow = win;
  try { log('lifecycle', 'main window created'); } catch(_) {}
  win.on('ready-to-show', () => { try { log('lifecycle', 'main window ready-to-show'); } catch(_) {} });
  win.on('show', () => { try { log('lifecycle', 'main window shown'); } catch(_) {} });
  win.on('closed', () => { try { log('lifecycle', 'main window closed'); } catch(_) {}; mainWindow = null; });
  // Explicitly resolve index.html relative to this file's directory to avoid
  // Electron attempting to load it from the app root when main is outside.
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

function ensureLinuxAppLauncher() {
  if (process.platform !== 'linux') return;
  try {
    const iconPath = resolveIconPath();
    const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
    fs.mkdirSync(appsDir, {recursive: true});
    const file = path.join(appsDir, 'hindsight-recall.desktop');
    if (fs.existsSync(file)) return; // don't overwrite user customizations
    // Dev Exec uses npm start from frontend; for packaged build this should be replaced.
    const execCmd = `sh -c \"cd ${projectRoot()}/frontend && npm start\"`;
    const content = `[Desktop Entry]\nType=Application\nName=Hindsight Recall\nComment=Personal memory archive UI\nExec=${execCmd}\n${iconPath?`Icon=${iconPath}\n`:''}Terminal=false\nCategories=Utility;Productivity;\n`; 
    fs.writeFileSync(file, content, {mode:0o644});
  } catch (e) { console.error('Failed creating Linux desktop launcher', e); }
}

app.whenReady().then(() => {
  // Global error hooks for diagnostics
  process.on('uncaughtException', (err) => { try { log('error', `uncaughtException: ${err.stack||err.message}`, 'ERROR'); } catch(_) {} });
  process.on('unhandledRejection', (reason) => { try { log('error', 'unhandledRejection: ' + (reason&&reason.stack||reason), 'ERROR'); } catch(_) {} });
  const autostartMode = process.env.HINDSIGHT_AUTOSTART === '1';
  // If an encrypted wrapped key exists, require passphrase before starting capture.
  const wrappedKeyPath = path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass');
  const needPass = fs.existsSync(wrappedKeyPath) && !process.env.HINDSIGHT_PASSPHRASE;
  _needPassGlobal = needPass;
  if (!authManager) {
    authManager = new AuthManager({
      broadcast,
      projectRoot,
      forceShowMainWindow,
      startDetached: (i)=> startDetached(i,{userInitiated:true}),
      readPid,
      runPyHelper,
      promptForPassphraseModal,
      promptForRecoveryModal,
      getPrefs: ()=> prefs,
  log,
    });
    authManager.markNeedPass(needPass);
  }
  // Create tray immediately so user sees app presence even if unlock prompt will block later.
  try { createTray(); } catch(e) { try { console.error('early tray failed', e); } catch(_) {} }

  _promptAndValidateBlocking = async () => {
    await authManager.promptAndValidateBlocking();
    unlockedSuccessfully = authManager.isUnlocked();
    _needPassGlobal = authManager.needsPass();
    // If caller invoked the prompt (e.g. via tray) without awaiting, ensure we
    // suppress the immediate re-prompt and show the UI once authentication completed.
    try { suppressNextUiPrompt = true; } catch(_) {}
    try { forceShowMainWindow(/*retries=*/4, /*skipPrompt=*/true); } catch(_) {}
  };

  (async () => {
    if (autostartMode) {
      await authManager.autostartAttempt(needPass);
      unlockedSuccessfully = authManager.isUnlocked();
      _needPassGlobal = authManager.needsPass();
    } else {
      // Desktop launch: prompt BEFORE creating window so UI appears after auth
      if (needPass || !fs.existsSync(path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass'))) {
        await _promptAndValidateBlocking();
        // Prevent double-prompt when we immediately call createWindow next
        suppressNextUiPrompt = true;
      }
    }
  if (!autostartMode) {
      createWindow();
    } else {
      // In autostart mode we stay in tray only until user clicks tray item.
  log('lifecycle', 'autostart tray-only mode (no initial window)');
    }
  // Tray already created earlier; context menu will refresh periodically to reflect unlock state.
    if (!needPass || unlockedSuccessfully) {
      startDetached(prefs.interval || 5);
    } else {
  log('lifecycle', 'initial capture start deferred (waiting for unlock)');
    }
  })();

  // (unlock server managed by AuthManager)
  ensureLinuxAppLauncher();
  // Periodic monitor: if we are unlocked but capture not running, attempt restart.
  setInterval(() => {
    try {
      if (unlockedSuccessfully && !userRequestedStop && !readPid()) {
        startDetached(prefs.interval || 5);
      }
    } catch(_) {}
  }, 7000);
  // macOS dock icon
  if (process.platform === 'darwin') {
    const i = resolveIconPath();
    if (i) { try { app.dock.setIcon(i); } catch(_) {} }
  }
  // System power/session events
  try {
    powerMonitor.on('lock-screen', ()=> pauseCaptureForSystem('lock'));
    powerMonitor.on('unlock-screen', ()=> resumeCaptureAfterSystem('lock'));
    // Newer Electron exposes session-lock/unlock (cross-platform); include for broader Linux DE coverage
    if (powerMonitor.on) {
      powerMonitor.on('session-lock', ()=> pauseCaptureForSystem('session-lock'));
      powerMonitor.on('session-unlock', ()=> resumeCaptureAfterSystem('session-lock'));
    }
    powerMonitor.on('suspend', ()=> pauseCaptureForSystem('suspend'));
    powerMonitor.on('resume', ()=> resumeCaptureAfterSystem('suspend'));
    powerMonitor.on('shutdown', ()=> pauseCaptureForSystem('shutdown'));
  } catch(e) { log('error', `powerMonitor setup failed: ${e.message}`, 'ERROR'); }
  setupLinuxLockPolling();
  log('lifecycle', 'app ready, supervision initialized');
  // Retroactively add levels to existing frontend.log lines once.
  try { levelizeExistingFrontendLog(); } catch(_) {}
});

function promptForPassphraseModal(promptText, opts={}) {
  return new Promise((resolve, _reject) => {
    const modal = new BrowserWindow({
      width: 420,
      height: 220,
      modal: true,
      show: false,
      parent: BrowserWindow.getAllWindows()[0] || undefined,
      webPreferences: {nodeIntegration: true, contextIsolation: false},
    });
    const showComplexity = !!opts.showComplexity;
    const complexityHTML = showComplexity ? '<p style="font-size:12px;color:#555;margin-top:4px">Passphrase: ≥12 chars incl upper/lower/digit/symbol (no spaces) OR PIN: 4–8 digits.</p>' : '';
    const html = `<!doctype html><html><body style="font-family: sans-serif; padding:12px; background:#f7f7f7; color:#111"><h3 style=\"margin:0 0 6px 0;font-size:16px;\">${promptText}</h3><div id=lockmsg style="font-size:12px;color:#b00;margin-top:4px;display:none"></div>${complexityHTML}<input id=pf type=password style="width:100%;font-size:14px;padding:6px;margin-top:8px" autofocus/><div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center"><div id=err style="color:#b00;font-size:11px"></div><div><button id=cancel style=\"font-size:12px;padding:4px 10px;\">Cancel</button> <button id=ok style=\"font-size:12px;padding:4px 12px;\">Submit</button></div></div><script>const {ipcRenderer} = require('electron');
      const pf = document.getElementById('pf');
      const ok = document.getElementById('ok');
      const err = document.getElementById('err');
      const lockmsg = document.getElementById('lockmsg');
      ipcRenderer.on('auth:lock-update', (_e, info) => {
        try {
          if (info && info.lock_until) {
            lockmsg.style.display = 'block';
            const until = new Date(info.lock_until);
            const tick = () => {
              const now = new Date();
              const secs = Math.ceil((until - now)/1000);
              if (secs > 0) {
                lockmsg.textContent = 'Locked for ' + secs + 's (until ' + until.toISOString() + ')';
                ok.disabled = true; pf.disabled = true;
              } else {
                lockmsg.textContent = ''; lockmsg.style.display='none'; ok.disabled=false; pf.disabled=false; clearInterval(iv);
              }
            };
            tick();
            const iv = setInterval(tick, 1000);
          } else {
            lockmsg.style.display='none'; ok.disabled=false; pf.disabled=false;
          }
        } catch (e) {}
      });
      document.getElementById('ok').addEventListener('click', ()=>{ const v=document.getElementById('pf').value; ipcRenderer.send('auth:submit-window', v); });
      document.getElementById('cancel').addEventListener('click', ()=>{ ipcRenderer.send('auth:submit-window', null); });
  document.getElementById('pf').addEventListener('keyup', (e)=>{ if (e.key==='Enter') { document.getElementById('ok').click(); } });</script></body></html>`;
    modal.loadURL('data:text/html,' + encodeURIComponent(html));
    modal.once('ready-to-show', ()=> modal.show());
    ipcMain.once('auth:submit-window', (_e, v) => {
      try { modal.close(); } catch(_) {}
      resolve(v === null ? null : String(v));
    });
  });
}


function promptForRecoveryModal(token) {
  return new Promise((resolve) => {
    const modal = new BrowserWindow({
      width: 640,
      height: 300,
      modal: true,
      show: false,
      parent: BrowserWindow.getAllWindows()[0] || undefined,
      webPreferences: {nodeIntegration: true, contextIsolation: false},
    });
    const html = `<!doctype html><html><body style="font-family: sans-serif; padding:12px; background:#fff; color:#111"><h3>Recovery token — Save this securely</h3><p style="font-size:13px;color:#333">This recovery token can be used to recover your data if you forget your passphrase/PIN. Store it offline.</p><textarea id=tok style="width:100%;height:80px;font-family:monospace;padding:8px" readonly>${token}</textarea><div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center"><div style="font-size:12px;color:#444">Please copy/save this token before continuing.</div><div><button id=copy style="margin-right:8px;">Copy</button><button id=ok>I've saved it</button></div></div><div id=copyMsg style="font-size:11px;color:#060;margin-top:6px;"></div><script>const {ipcRenderer, clipboard} = require('electron');document.getElementById('copy').addEventListener('click', ()=>{ try { clipboard.writeText(document.getElementById('tok').value.trim()); const m=document.getElementById('copyMsg'); m.textContent='Copied to clipboard'; } catch(e) {} });document.getElementById('ok').addEventListener('click', ()=>{ ipcRenderer.send('auth:recovery-saved', true); });</script></body></html>`;
    modal.loadURL('data:text/html,' + encodeURIComponent(html));
    modal.once('ready-to-show', ()=> modal.show());
    ipcMain.once('auth:recovery-saved', () => { try { modal.close(); } catch(_) {} resolve(true); });
  });
}

app.on('window-all-closed', () => {
  // Keep running in tray unless explicit quit.
  if (process.platform !== 'darwin') {
    // Do nothing; background continues. On Linux/Windows we intentionally stay.
  }
});

app.on('before-quit', () => {
  try {
  log('lifecycle', 'app quitting; stopping capture service');
  } catch(_) {}
  try { stopDetached(); } catch(_) {}
});

// ---- Python log tail broadcasting (non-destructive; additive) ----
let _pyLogTailActive = false;
let _pyLogPos = {};
function startPyLogTail() {
  if (_pyLogTailActive) return; // already running
  _pyLogTailActive = true;
  const logDir = path.join(projectRoot(), 'data');
  const files = ['capture.stdout.log', 'capture.stderr.log'];
  for (const f of files) {
    const full = path.join(logDir, f);
    try {
      if (!fs.existsSync(full)) fs.writeFileSync(full, '');
      _pyLogPos[full] = fs.statSync(full).size; // start at end to avoid flooding with history
    } catch(_) {}
  }
  function poll() {
    for (const f of files) {
      const full = path.join(logDir, f);
      try {
        const st = fs.statSync(full);
        const prev = _pyLogPos[full] || 0;
        if (st.size > prev) {
          const fd = fs.openSync(full, 'r');
          const len = st.size - prev;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, prev);
          fs.closeSync(fd);
          _pyLogPos[full] = st.size;
          const text = buf.toString('utf8');
          const lines = text.split(/\r?\n/).filter(l => l.trim().length);
          for (const line of lines) {
            // Skip legacy verbose status prints if still present from prior runs
            if (line.startsWith('STATUS::')) continue;
            let level = 'INFO';
            const m = line.match(/\] (DEBUG|INFO|WARNING|ERROR|CRITICAL) /);
            if (m) level = m[1];
            const payload = {file: f, level, line};
            for (const w of BrowserWindow.getAllWindows()) {
              try { w.webContents.send('pylog:line', payload); } catch(_) {}
            }
          }
        }
      } catch(_) {}
    }
    setTimeout(poll, 1300);
  }
  poll();
}

// Start tailer once app is ready and a window exists (gives renderer a listener)
app.whenReady().then(() => {
  try { startPyLogTail(); } catch(_) {}
});
