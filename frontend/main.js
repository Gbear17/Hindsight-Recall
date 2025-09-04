/* SPDX-License-Identifier: GPL-3.0-only */
// Entry point for Electron frontend
const {app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, powerMonitor} = require('electron');
let tray = null;
// Capture key availability (data key accessible for service restarts)
let unlockedSuccessfully = false; // capture-level unlock (raw key or passphrase-derived)
// UI unlock (user has actually provided passphrase this session). Autostart raw key path does NOT set this.
let unlockedUI = false;
// Expose passphrase prompt function & needPass flag to tray handlers after initialization.
let _promptAndValidateBlocking = null;
let _needPassGlobal = false;

// ---- Single Instance Enforcement ----
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another instance already running; exit immediately.
  try { console.log('[lifecycle] secondary instance exiting (single-instance lock)'); } catch(_) {}
  app.quit();
} else {
  app.on('second-instance', (_event, _commandLine, _workingDir) => {
    // Another launch attempt occurred: surface/focus existing window or trigger unlock prompt.
    try {
      if (typeof broadcast === 'function') {
        try { broadcast('log:line', '[lifecycle] second instance attempt; focusing existing window'); } catch(_) {}
      }
      if (_needPassGlobal && !unlockedUI && typeof _promptAndValidateBlocking === 'function') {
        _promptAndValidateBlocking();
        return;
      }
      const wins = BrowserWindow.getAllWindows();
      if (!wins.length) {
        try { createWindow(); } catch(_) {}
      } else {
        const win = wins[0];
        try {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        } catch(_) {}
      }
    } catch(_) {}
  });
}
function resolveIconPath() {
  const p = path.join(__dirname, 'hindsight_icon.png');
  return fs.existsSync(p) ? p : null;
}
function createTray() {
  try {
    const iconPath = resolveIconPath();
    let icon;
    if (iconPath) icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon || nativeImage.createEmpty());
    const buildMenu = () => {
    const running = !!readPid();
      return Menu.buildFromTemplate([
        {label: 'Open Window', click: async () => {
      if (_needPassGlobal && !unlockedUI) {
            if (typeof _promptAndValidateBlocking === 'function') {
              await _promptAndValidateBlocking();
            }
          }
          if (BrowserWindow.getAllWindows().length===0) createWindow(); else BrowserWindow.getAllWindows()[0].show();
        }},
  {label: running ? 'Stop Capture' : 'Start Capture', click: () => { running ? stopDetached() : startDetached(prefs.interval||5,{userInitiated:true}); }},
        {type: 'separator'},
        {label: 'Quit', click: () => { app.quit(); }}
      ]);
    };
    tray.setToolTip('Hindsight Recall');
    tray.setContextMenu(buildMenu());
    setInterval(()=> tray.setContextMenu(buildMenu()), 4000);
    tray.on('click', async () => {
      if (_needPassGlobal && !unlockedUI) {
        if (typeof _promptAndValidateBlocking === 'function') {
          await _promptAndValidateBlocking();
        }
      }
      const wins=BrowserWindow.getAllWindows(); if (wins.length) { wins[0].show(); } else createWindow();
    });
  } catch (e) {
    console.error('Tray init failed', e);
  }
}
const {spawn} = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function projectRoot() { return path.resolve(__dirname, '..'); }

function getPythonCommand() {
  const venv = path.join(projectRoot(), '.venv');
  if (process.platform === 'win32') {
    const pythonw = path.join(venv, 'Scripts', 'pythonw.exe');
    const python = path.join(venv, 'Scripts', 'python.exe');
    if (fs.existsSync(pythonw)) return pythonw;
    if (fs.existsSync(python)) return python;
    return 'pythonw';
  } else {
    const py = path.join(venv, 'bin', 'python');
    if (fs.existsSync(py)) return py;
    return 'python3';
  }
}

// ---- Preferences Handling ----
const PREFS_PATH = path.join(projectRoot(), 'data', 'prefs.json');
function loadPrefs() {
  try {
    const raw = fs.readFileSync(PREFS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign({autostart:false, interval:5, delaySeconds:0, backend:'auto', logTimezone:'LOCAL', dstAdjust:false, logLevel:'INFO'}, parsed);
  } catch {
    return {autostart:false, interval:5, delaySeconds:0, backend:'auto', logTimezone:'LOCAL', dstAdjust:false, logLevel:'INFO'};
  }
}
function savePrefs(p) {
  fs.mkdirSync(path.dirname(PREFS_PATH), {recursive: true});
  fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2), 'utf8');
}
let prefs = loadPrefs();

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

function pauseCaptureForSystem(kind) {
  if (systemPaused) return;
  systemPaused = true;
  broadcast('log:line', '[lifecycle] capture paused (system)');
  const pid = readPid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch(_) {}
    setTimeout(()=>{ try { if (readPid() === pid) process.kill(pid, 'SIGKILL'); } catch(_) {} }, 1000);
  }
}

function resumeCaptureAfterSystem(kind) {
  if (!systemPaused) return;
  broadcast('log:line', '[lifecycle] capture resumed (system)');
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
        broadcast('log:line', `[anomaly] detected ${others.length} additional capture process(es): ${others.map(o=>o.pid).join(',')}`);
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
    broadcast('log:line', '[control] auto start suppressed (user stop active)');
    return {action:'suppressed'};
  }
  if (spawnInFlight) {
    broadcast('log:line', '[control] spawn already in-flight; skipping duplicate start request');
    return {action:'in-flight'};
  }
  // If a passphrase is required but not yet unlocked, defer.
  if (_needPassGlobal && !unlockedSuccessfully) {
    broadcast('log:line', '[control] start requested but key not yet unlocked; deferring');
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
          try { process.kill(procInfo.pid, 0); process.kill(procInfo.pid, 'SIGKILL'); broadcast('log:line', `[control] escalated SIGKILL stray pid=${procInfo.pid}`); } catch(_) {}
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
        broadcast('log:line', `[lifecycle] archived legacy status file -> ${path.basename(archived)}`);
      }
    }
  } catch(_) {}
  const py = getPythonCommand();
  const args = [py, '-m', 'capture.cli', '--dir', path.join(projectRoot(),'data'), '--interval', String(interval||5), '--print-status', '--pid-file', PID_FILE, '--log-level', String(prefs.logLevel||'INFO')];
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
    const errFd = fs.openSync(errPath, 'a');
    fs.writeSync(outFd, `\n==== spawn ${new Date().toISOString()} interval=${interval||5} ====`);
    fs.writeSync(errFd, `\n==== spawn ${new Date().toISOString()} interval=${interval||5} ====`);
    spawnInFlight = true;
    captureProc = spawn(args[0], args.slice(1), {detached: false, stdio:['ignore', outFd, errFd], cwd: projectRoot(), env});
    broadcast('log:line', `[control] started capture (interval=${interval||5}s level=${prefs.logLevel||'INFO'})`);
    try { startPyLogTail(); } catch(_) {}
    captureProc.on('exit', (code, signal) => {
      spawnInFlight = false;
      const msg = `[anomaly] capture process exited early code=${code} signal=${signal || 'none'} pidFileExists=${!!readPid()}`;
      broadcast('log:line', msg);
      try { fs.writeSync(errFd, `\n${msg}`); } catch(_) {}
      captureProc = null;
    });
  } catch (e) {
    broadcast('log:line', `[error] failed to spawn capture: ${e.message}`);
    return {action:'error', error:e.message};
  }
  // Verify pid file appears shortly; if not, log anomaly for troubleshooting.
  setTimeout(()=>{ if (!readPid()) broadcast('log:line', '[anomaly] capture spawn produced no pid file (will retry later)'); else spawnInFlight = false; }, 1800);
  return {action:'started'};
}

function stopDetached() {
  const pid = readPid();
  if (!pid) {
    // Fallback: if we have a live child process reference but no pid file yet, terminate it.
    if (captureProc) {
      try { captureProc.kill('SIGTERM'); broadcast('log:line','[control] stop requested (child only, no pid file)'); } catch(_) {}
      return {action:'signaled-child-only'};
    }
    return {action:'not-running'};
  }
  userRequestedStop = true;
  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return {action:'error', error:String(e)};
  }
  broadcast('log:line', '[control] stop requested (SIGTERM)');
  broadcast('log:line', '[control] auto-restart suppressed until user starts capture again');
  // Schedule a verification/escalation if still alive after 800ms.
  setTimeout(() => {
    const still = readPid();
    if (still === pid) {
      try { process.kill(pid, 'SIGKILL'); } catch(_) {}
  broadcast('log:line', '[control] escalated SIGKILL');
    }
  }, 800);
  return {action:'signaled', pid};
}

function readPid() {
  try {
    const txt = fs.readFileSync(PID_FILE,'utf8').trim();
    const pid = Number(txt);
    if (!pid) return null;
    try { process.kill(pid,0); return pid; } catch { return null; }
  } catch { return null; }
}

function pollStatus() {
  try {
    const raw = fs.readFileSync(STATUS_FILE,'utf8');
    const data = JSON.parse(raw);
    broadcast('status:update', data);
    // Health check: detect stale display errors (e.g., after relogin)
  if (data && data.error) {
      const err = String(data.error);
      if (/unable to open display|cannot open display|xopendisplay/i.test(err)) {
        consecutiveDisplayErrors += 1;
        broadcast('log:line', `[health] display error (${consecutiveDisplayErrors}) ${err}`);
      } else {
        consecutiveDisplayErrors = 0;
      }
      // Auto backend adaptation: if imagegrab keeps producing UnidentifiedImageError, switch prefs.backend to 'mss' and restart once.
      if (/UnidentifiedImageError/.test(err) && /imagegrab/.test(String(data.capture_backend||''))) {
        consecutiveUnidentified++;
        if (consecutiveUnidentified === 3) {
          if (prefs.backend !== 'mss') {
            broadcast('log:line', '[health] repeated UnidentifiedImageError with imagegrab; switching backend to mss and restarting');
            prefs.backend = 'mss';
            savePrefs(prefs);
            backendSwitchReason = 'imagegrab_unidentifiedimageerror';
            internalStopForHealth();
            setTimeout(()=>{ if (!userRequestedStop) startDetached(prefs.interval||5); }, 1000);
          }
        }
      } else if (!/UnidentifiedImageError/.test(err)) {
        consecutiveUnidentified = 0;
      }
    } else {
      consecutiveDisplayErrors = 0;
      lastSuccessfulStatus = Date.now();
      consecutiveUnidentified = 0;
    }
    // Emit capture / error change logs
    if (data) {
      // Skip stale status (older sequence or missing sequence after we've seen one)
      if (typeof data.sequence === 'number') {
        // Detect instance change earlier (before stale check) so we can accept a lower sequence
        if (data.service_instance_id && lastServiceInstance && data.service_instance_id !== lastServiceInstance) {
          broadcast('log:line', `[lifecycle] new service instance detected (sequence baseline reset) ${data.service_instance_id}`);
          lastSequence = -1; // reset baseline to accept new lower sequence
        }
        if (lastSequence !== -1 && data.sequence < lastSequence) {
          broadcast('log:line', `[stale] ignoring out-of-order status sequence=${data.sequence} < ${lastSequence}`);
          return; // do not process further
        }
      } else if (lastSequence !== -1) {
        broadcast('log:line', '[stale] ignoring legacy status without sequence');
        return;
      }
      if (data.service_instance_id && data.service_instance_id !== lastInstanceId) {
        // New service instance detected; reset counters to avoid false regression warnings
        broadcast('log:line', `[lifecycle] detected new capture service instance ${data.service_instance_id}`);
        lastInstanceId = data.service_instance_id;
        lastLoggedCaptureCount = -1;
        lastLoggedError = null;
        lastSequence = -1;
  lastStatusUtc = null;
  // After detecting new instance, scan for strays once.
  scanForOtherCaptureProcesses();
      }
      if (typeof data.capture_count === 'number' && data.capture_count !== lastLoggedCaptureCount) {
        broadcast('log:line', `[capture] #${data.capture_count} window="${data.window_title}" backend=${data.capture_backend||'n/a'}`);
        // Anomaly: capture_count regression implies competing process or stale writer (only within same instance)
        if (lastInstanceId && lastLoggedCaptureCount !== -1 && data.capture_count < lastLoggedCaptureCount - 3) {
          broadcast('log:line', `[anomaly] capture_count regressed from ${lastLoggedCaptureCount} to ${data.capture_count}; possible stale secondary process`);
        }
        lastLoggedCaptureCount = data.capture_count;
      } else if (data.duplicate === true) {
        // Explicitly log duplicate frame skipped to surface suppression behavior.
        broadcast('log:line', `[duplicate] skipped frame (same as previous) window="${data.window_title}"`);
      }
      if (typeof data.sequence === 'number' && data.sequence > lastSequence) {
        lastSequence = data.sequence;
        lastSequenceTs = Date.now();
        if (data.service_instance_id) lastServiceInstance = data.service_instance_id;
      }
      if (!data.sequence && lastInstanceId) {
        // Legacy/no-sequence status after we've seen a proper instance id => likely stale or competing writer.
        const lc = data.last_capture_utc || 'unknown';
        broadcast('log:line', `[anomaly] legacy status overwrite detected (utc=${lc}); possible old process still running`);
        // Trigger scan to list stray processes.
        scanForOtherCaptureProcesses();
      }
      if (data.last_capture_utc) {
        lastStatusUtc = data.last_capture_utc;
      }
      if (data.last_capture_utc && data.last_capture_utc !== lastLoggedUtc) {
        lastLoggedUtc = data.last_capture_utc;
      }
      const errNow = data.error || null;
      if (errNow !== lastLoggedError) {
        if (errNow) broadcast('log:line', `[error] ${errNow}`); else if (lastLoggedError) broadcast('log:line', '[recovery] error cleared');
        lastLoggedError = errNow;
      }
    }
    // Heartbeat every 30s if no new capture logs
    const nowTs = Date.now();
    if (nowTs - lastHeartbeat > 30000) {
      broadcast('log:line', `[heartbeat] pid=${readPid()||'none'} captures=${lastLoggedCaptureCount} displayErrs=${consecutiveDisplayErrors}`);
      lastHeartbeat = nowTs;
    }
    const threshold = lastSuccessfulStatus === 0 ? 1 : 3; // before first success, restart on first display error
  if (!userRequestedStop && !systemPaused && consecutiveDisplayErrors >= threshold) {
      const now = Date.now();
      if (now - lastHealthRestart > 15000) { // 15s cooldown
  broadcast('log:line', '[health] Display error detected repeatedly; scheduling restart');
  internalStopForHealth();
  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); }
  pendingRestartTimer = setTimeout(()=>{ if (!userRequestedStop) startDetached(prefs.interval || 5); pendingRestartTimer=null; }, 1200);
        lastHealthRestart = now;
        consecutiveDisplayErrors = 0; // reset counter
      }
    }
  } catch {/* ignore */}
  setTimeout(pollStatus, 2000);
}
setTimeout(pollStatus, 1500);

// Stall detector: if no sequence progress for > 20s while pid alive, restart.
setInterval(() => {
  const pid = readPid();
  if (!pid) return;
  if (!systemPaused && lastSequence !== -1 && Date.now() - lastSequenceTs > 20000) {
    broadcast('log:line', '[health] capture appears stalled (no sequence advance >20s); restarting');
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
    if (list.length) broadcast('log:line', `[control] signaled stray capture processes (${list.map(x=>x.pid).join(',')})`);
    setTimeout(()=>{
      scanForOtherCaptureProcesses(remain => { if (remain.length) broadcast('log:line', `[anomaly] stray processes still alive after kill attempt: ${remain.map(r=>r.pid).join(',')}`); });
    }, 1500);
  });
  return {requested:true};
}

function tzTimestamp() {
  // Use user preference `logTimezone` if present.
  // Supported values:
  //   'LOCAL' (default) -> system local time & offset
  //   'UTC'             -> UTC with +00:00 offset
  //   [+|-]HHMM         -> Fixed offset from UTC
  const spec = (typeof prefs !== 'undefined' && prefs && typeof prefs.logTimezone === 'string') ? prefs.logTimezone.trim().toUpperCase() : 'LOCAL';
  const pad = (n, l=2) => String(n).padStart(l,'0');
  const now = new Date();
  let year, mon, day, hr, min, sec, ms, offSign, offH, offM;
  let dstAddHour = prefs && prefs.dstAdjust ? 1 : 0;
  if (spec === 'UTC') {
    year = now.getUTCFullYear();
    mon = pad(now.getUTCMonth()+1);
    day = pad(now.getUTCDate());
    hr = pad((now.getUTCHours()+dstAddHour)%24);
    min = pad(now.getUTCMinutes());
    sec = pad(now.getUTCSeconds());
    ms = pad(now.getUTCMilliseconds(),3);
    offSign = '+'; offH = '00'; offM = '00';
  } else if (/^[+-]\d{4}$/.test(spec)) {
    // Fixed offset: convert to that offset's local wall time by applying offset minutes to UTC
    const sign = spec[0] === '-' ? -1 : 1;
    const h = parseInt(spec.slice(1,3),10);
    const m = parseInt(spec.slice(3,5),10);
    const totalMin = sign * (h*60 + m);
    // Apply DST adjustment to both displayed clock time and resulting offset minutes.
    // For a negative offset (-0800) a DST +1h means -0700 (i.e. totalMin + 60).
    let adjustedMin = totalMin;
    if (dstAddHour) {
      adjustedMin = totalMin + 60; // works for positive & negative offsets
    }
    const dateMs = now.getTime() + adjustedMin * 60000; // shift from UTC using (possibly) adjusted offset
    const d = new Date(dateMs);
    year = d.getUTCFullYear();
    mon = pad(d.getUTCMonth()+1);
    day = pad(d.getUTCDate());
    hr = pad(d.getUTCHours());
    min = pad(d.getUTCMinutes());
    sec = pad(d.getUTCSeconds());
    ms = pad(d.getUTCMilliseconds(),3);
    // Recompute printable offset from adjusted minutes
    const adjAbs = Math.abs(adjustedMin);
    const adjSign = adjustedMin <= 0 ? '-' : '+'; // adjustedMin negative -> west of UTC
    offSign = adjSign;
    offH = pad(Math.floor(adjAbs/60));
    offM = pad(adjAbs % 60);
  } else { // LOCAL fallback
    year = now.getFullYear();
    mon = pad(now.getMonth()+1);
    day = pad(now.getDate());
  hr = pad((now.getHours()+dstAddHour)%24);
    min = pad(now.getMinutes());
    sec = pad(now.getSeconds());
    ms = pad(now.getMilliseconds(),3);
    const offMin = now.getTimezoneOffset();
    const sign = offMin <= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    offH = pad(Math.floor(abs/60));
    offM = pad(abs % 60);
    offSign = sign;
  }
  // Derive a human-friendly timezone abbreviation.
  let abbrev = '';
  try {
    const baseSpec = spec; // user-selected
    // Mapping for standard offsets (non-DST) and DST variants when dstAdjust applied to original spec.
    const stdMap = { '-0800':'PST','-0700':'MST','-0600':'CST','-0500':'EST','-0400':'AST','+0000':'UTC','+0100':'CET','+0200':'EET'};
    const dstMap = { '-0800':'PDT','-0700':'MDT','-0600':'CDT','-0500':'EDT','-0400':'ADT','+0100':'CEST','+0200':'EEST'};
    if (baseSpec === 'LOCAL') {
      // Use Intl API for local abbreviation.
      try {
        const fmt = new Intl.DateTimeFormat(undefined, {timeZoneName:'short'});
        const parts = fmt.formatToParts(new Date());
        const tzp = parts.find(p=>p.type==='timeZoneName');
        if (tzp && tzp.value) abbrev = tzp.value.toUpperCase();
      } catch(_) {}
    } else if (/^[+-]\d{4}$/.test(baseSpec)) {
      const norm = baseSpec.toUpperCase();
      if (prefs && prefs.dstAdjust) {
        // dstAdjust shifts effective offset already; prefer DST map based on original spec before shift.
        if (dstMap[norm]) abbrev = dstMap[norm];
      }
      if (!abbrev && stdMap[norm]) abbrev = stdMap[norm];
      if (!abbrev) {
        // Fallback generic label.
        abbrev = 'UTC' + (offSign==='+'?'+':'-') + offH + (offM!=='00'?(':'+offM):'');
      }
    } else if (baseSpec === 'UTC') {
      abbrev = 'UTC';
    }
  } catch(_) {}
  const ts = `${year}-${mon}-${day}T${hr}:${min}:${sec}.${ms}${offSign}${offH}:${offM}${abbrev?(' '+abbrev):''}`;
  try {
    if (Math.random() < 0.002) { // sample occasionally to avoid log spam
      broadcast('log:line', `[tz] spec=${spec} dst=${!!(prefs && prefs.dstAdjust)} -> ${ts}`);
    }
  } catch(_) {}
  return ts;
}
function broadcast(channel, payload) {
  // Also append log lines to a rolling file for diagnostics (timezone-aware local timestamp with offset).
  try {
    if (channel === 'log:line') {
      const logPath = path.join(projectRoot(), 'data', 'frontend.log');
      try { fs.mkdirSync(path.dirname(logPath), {recursive:true}); } catch(_) {}
      fs.appendFileSync(logPath, tzTimestamp() + ' ' + payload + '\n');
    }
  } catch(_) {}
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload); } catch (_) {}
  }
}

function captureCommandArgs() {
  return [
    '-m', 'capture.cli',
    '--dir', path.join(projectRoot(), 'data'),
    '--interval', String(prefs.interval || 5),
    '--print-status', '--pid-file', PID_FILE
  ];
}

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
  // Determine Electron launch command.
  // In dev we assume running from repo with node_modules; attempt 'npx electron'.
  const electronCmd = process.env.HINDSIGHT_ELECTRON_CMD || 'npx electron';
  const script = `#!/usr/bin/env bash\nset -euo pipefail\nLOGDIR=\"${dataDir}\"\nmkdir -p \"$LOGDIR\"\nTS() { date -Iseconds; }\nlog() { echo \"$(TS) [wrapper] $*\" >> \"$LOGDIR/autostart.log\"; }\nlog start pid=$$ DISPLAY=$DISPLAY USER=$USER\n${effectiveDelay>0?`sleep ${effectiveDelay}\n`:''}cd \"${pr}\"\nexport HINDSIGHT_AUTOSTART=1\nlog launching electron interval=${prefs.interval||5} backend=${prefs.backend||'auto'} cmd='${electronCmd}'\n( ${electronCmd} frontend/main.js >> \"$LOGDIR/electron.autostart.out\" 2>&1 & echo $! > \"$LOGDIR/autostart.spawned.pid\" )\nSPAWNED=$(cat \"$LOGDIR/autostart.spawned.pid\")\nlog spawned electron_pid=$SPAWNED\n`;
  try {
    fs.writeFileSync(wrapperPath, script, {mode: 0o755});
  } catch (e) {
    broadcast('log:line', `[error] failed writing wrapper script: ${e.message}`);
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
  const args = captureCommandArgs();
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
  broadcast('log:line', `[lifecycle] autostart enabled file=${p.file}`);
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
  savePrefs(prefs);
  try { broadcast('log:line', `[prefs] updated interval=${prefs.interval} delay=${prefs.delaySeconds} tz=${prefs.logTimezone} dst=${prefs.dstAdjust} level=${prefs.logLevel}`); } catch(_) {}
  if (prefs.autostart) enableAutostart(true);
  if (prefs.interval !== oldInterval || prefs.logLevel !== oldLevel) {
    stopDetached();
    setTimeout(()=>startDetached(prefs.interval||5), 500);
  }
  return {...prefs};
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
  broadcast('log:line', `[control] data purge removed ~${removed} items`);
  return {removed};
});
ipcMain.handle('auth:change', (_evt, payload) => {
  try {
    const {auth, next, useRecovery} = payload || {};
    if (!auth || !next) return {ok:false, err:'missing_fields'};
    const py = getPythonCommand();
    const args = [py, '-m','capture.keymgr','--base-dir', path.join(projectRoot(),'data'),'--change'];
    if (useRecovery) args.push('--use-recovery');
    const spawnSync = require('child_process').spawnSync;
    const res = spawnSync(args[0], args.slice(1), {input: auth + '\n' + next + '\n', encoding:'utf8', cwd: projectRoot()});
    if (res.status === 0) {
      let recovery = null;
      try { const parsed = JSON.parse(res.stdout||''); recovery = parsed.recovery || null; } catch(_) {}
      if (recovery) {
        try { promptForRecoveryModal(recovery); } catch(_) {}
      }
      return {ok:true};
    }
    return {ok:false, code: res.status, err: (res.stderr||res.stdout||'').toString().trim()};
  } catch (e) {
    return {ok:false, err:String(e)};
  }
});

// Manual debug logging IPC: emit arbitrary log lines from renderer
ipcMain.handle('debug:log', (_evt, line) => {
  if (typeof line === 'string' && line.trim()) {
    broadcast('log:line', `[debug] ${line.trim()}`);
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
  if (_needPassGlobal && !unlockedUI) {
    // UI still locked: require prompt before showing main window.
    if (typeof _promptAndValidateBlocking === 'function') {
      // Fire and rely on caller flow to show window after unlock.
      _promptAndValidateBlocking();
    }
    return; // defer actual window creation until unlocked
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
  // Explicitly resolve index.html relative to this file's directory to avoid
  // Electron attempting to load it from the app root when main is outside.
  win.loadFile(path.join(__dirname, 'index.html'));
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
  const autostartMode = process.env.HINDSIGHT_AUTOSTART === '1';
  // If an encrypted wrapped key exists, require passphrase before starting capture.
  const wrappedKeyPath = path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass');
  const needPass = fs.existsSync(wrappedKeyPath) && !process.env.HINDSIGHT_PASSPHRASE;
  _needPassGlobal = needPass;

  _promptAndValidateBlocking = async function promptAndValidateBlocking() {
    // This opens a modal prompt and then validates using the python keymgr helper.
    // Caller will not proceed until a valid passphrase is created or entered.
    let lastLockLoggedSeconds = null; // remaining seconds when we last emitted [auth] currently locked until
    while (true) {
      // Check lock state before prompting
      try {
        const py = getPythonCommand();
        const li = require('child_process').spawnSync(py, ['-m','capture.keymgr','--base-dir', path.join(projectRoot(), 'data'),'--lock-info'], {encoding:'utf8', cwd: projectRoot()});
        if (!li.error && li.status === 0 && li.stdout) {
          try {
            const info = JSON.parse(li.stdout);
            // broadcast lock info to any open windows so modal can update
            for (const w of BrowserWindow.getAllWindows()) try { w.webContents.send('auth:lock-update', info); } catch(_) {}
            if (info.lock_until) {
              const until = new Date(info.lock_until);
              const now = new Date();
              if (until > now) {
                const secs = Math.ceil((until - now)/1000);
                // Emit log only every 10s boundary, plus at 5s, and a 3,2,1 countdown.
                const shouldLog = (
                  secs === 5 || secs <= 3 || (secs % 10 === 0 && secs !== lastLockLoggedSeconds)
                );
                if (shouldLog) {
                  broadcast('log:line', `[auth] currently locked until ${until.toISOString()} (${secs}s)`);
                  lastLockLoggedSeconds = secs;
                }
                // Sleep a bit before re-checking to avoid tight looping
                await new Promise(r => setTimeout(r, Math.min(10000, secs*1000)));
                continue;
              }
            }
          } catch (e) { /* ignore parse errors */ }
        }
      } catch (e) { /* ignore */ }
  const creating = !needPass;
  const pass = await promptForPassphraseModal(
    needPass ? 'Enter passphrase / PIN to unlock' : 'Set a new passphrase or PIN',
    {showComplexity: creating}
  );
      if (pass === null) {
        // user cancelled; keep looping to enforce requirement
        continue;
      }
      // Use python helper to create/validate via stdin. If wrapped key exists, validate; otherwise create.
      try {
        const py = getPythonCommand();
        const args = [py, '-m', 'capture.keymgr'];
        if (needPass) args.push('--validate'); else args.push('--create');
        args.push('--base-dir', path.join(projectRoot(), 'data'), '--pass-stdin');
        const spawnSync = require('child_process').spawnSync;
        const res = spawnSync(args[0], args.slice(1), {input: pass + '\n', encoding: 'utf8', cwd: projectRoot()});
        if (res.error) {
          broadcast('log:line', `[auth] helper error: ${res.error.message}`);
          continue;
        }
          if (res.status === 0) {
            broadcast('log:line', '[auth] passphrase accepted');
            // If this was a create operation, the helper printed a one-shot recovery token on stdout.
            try {
              if (!needPass) {
                const token = (res.stdout || '').toString().trim();
                if (token) {
                  // show recovery modal and require user to save token before proceeding
                  try { await promptForRecoveryModal(token); } catch (e) { /* ignore modal errors */ }
                }
              }
            } catch (e) {}
            // Start a short-lived IPC server that will hand the unwrapped key to the capture process.
            try {
              await startUnlockServer(pass);
            } catch (e) {
              broadcast('log:line', `[auth] failed starting unlock server: ${e.message}`);
              continue;
            }
            // Check for autostart key presence (best-effort log)
            try {
              const py = getPythonCommand();
              const spawnSync = require('child_process').spawnSync;
              const out = spawnSync(py, ['-m','capture.keymgr','--base-dir', path.join(projectRoot(),'data'), '--get-autostart'], {encoding:'utf8', cwd: projectRoot()});
              if (!out.error && out.status === 0 && out.stdout && out.stdout.trim()) {
                broadcast('log:line', '[auth] autostart key present');
              }
            } catch (e) {}
            const wasLocked = _needPassGlobal && !unlockedSuccessfully;
            unlockedSuccessfully = true;
            unlockedUI = true; // UI explicitly unlocked with passphrase
            // If a deferred start was waiting on unlock, start now.
            if (wasLocked && !readPid()) {
              broadcast('log:line', '[lifecycle] starting capture now that key is unlocked');
              startDetached(prefs.interval || 5);
            }
            return true;
          }
        // Non-zero status indicates invalid or complexity / usage failure.
        const err = (res.stderr || res.stdout || '').toString();
        // Status meanings from keymgr:
        // 1 => invalid passphrase; 3 => complexity (create path) ValueError; 2 misuse; 4 fallback.
        if (res.status === 3 || /complexity requirements/i.test(err)) {
          broadcast('log:line', '[auth] passphrase does not meet complexity requirements (not counted as failure)');
          // Loop again without recording a failed attempt.
          continue;
        }
        broadcast('log:line', `[auth] validation failed: ${err.trim()}`);
        if (res.status === 1) { // only count true invalid passphrase attempts toward lockout
          try {
            const py = getPythonCommand();
            const rf = require('child_process').spawnSync(py, ['-m','capture.keymgr','--base-dir', path.join(projectRoot(),'data'), '--record-fail'], {encoding:'utf8', cwd: projectRoot()});
            if (!rf.error && rf.status === 0 && rf.stdout) {
              try {
                const info = JSON.parse(rf.stdout);
                for (const w of BrowserWindow.getAllWindows()) try { w.webContents.send('auth:lock-update', info); } catch(_) {}
                if (info.lock_until) {
                  broadcast('log:line', `[auth] locked until ${info.lock_until}`);
                }
              } catch (e) { /* ignore */ }
            }
          } catch (e) {}
        }
        // Loop again (the lock-info check at top will pause if needed)
      } catch (e) {
        broadcast('log:line', `[auth] exception validating passphrase: ${e.message}`);
      }
    }
  };

  (async () => {
    if (autostartMode) {
      // Try autostart path: if keyring holds an autostart key, write ipc_info.json so capture can get it.
      try {
        const py = getPythonCommand();
        const res = require('child_process').spawnSync(py, ['-m','capture.keymgr','--base-dir', path.join(projectRoot(),'data'), '--lock-info'], {encoding:'utf8', cwd: projectRoot()});
        // We still need to create an unlock server for the capture to request the key.
        // If keyring stored an autostart credential, write an ipc_info.json that the capture service can use to fetch key via a short-lived helper.
        // Use keymgr helper (supports fallback keyring) instead of raw keyring import
        const ka = require('child_process').spawnSync(py, ['-m','capture.keymgr','--base-dir', path.join(projectRoot(),'data'), '--get-autostart'], {encoding:'utf8', cwd: projectRoot()});
        try {
          broadcast('log:line', `[auth] autostart key probe status=${ka.status} err=${ka.error?ka.error.message:'none'} stdout_len=${(ka.stdout||'').trim().length}`);
        } catch(_) {}
        if (!ka.error && ka.status === 0 && ka.stdout && ka.stdout.trim()) {
          // Autostart key is a base64-encoded raw data key, not the user passphrase.
          const rawKey = ka.stdout.trim();
          broadcast('log:line', '[auth] autostart raw key detected; starting unlock server (raw mode)');
          try {
            await startUnlockServer(rawKey, {raw: true});
            // Mark unlocked (capture will fetch key shortly); if capture fails repeatedly we will still allow manual prompt on tray interaction.
            unlockedSuccessfully = true; // capture may run
            // Do NOT clear _needPassGlobal so tray/UI still prompt for passphrase; unlockedSuccessfully allows capture start.
            // Intentionally leave unlockedUI = false so opening the UI will trigger the prompt path.
            broadcast('log:line', '[auth] capture unlocked via autostart key (UI still locked)');
          } catch (e) {
            broadcast('log:line', `[auth] autostart raw key path failed (${e.message}); falling back to prompt`);
            if (needPass || !fs.existsSync(path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass'))) {
              await _promptAndValidateBlocking();
            }
          }
        } else {
          // no autostart key available, fall back to prompt if needed
          try { broadcast('log:line', '[auth] no autostart key present (will prompt if protection enabled)'); } catch(_) {}
          if (needPass || !fs.existsSync(path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass'))) {
            await _promptAndValidateBlocking();
          }
        }
      } catch (e) {
        if (needPass || !fs.existsSync(path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass'))) {
          await _promptAndValidateBlocking();
        }
      }
    } else {
      if (needPass || !fs.existsSync(path.join(projectRoot(), 'data', 'encrypted', 'key.fernet.pass'))) {
        await _promptAndValidateBlocking();
      }
    }
  if (!autostartMode) {
      createWindow();
    } else {
      // In autostart mode we stay in tray only until user clicks tray item.
      broadcast('log:line', '[lifecycle] autostart tray-only mode (no initial window)');
    }
    createTray();
    if (!needPass || unlockedSuccessfully) {
      startDetached(prefs.interval || 5);
    } else {
      broadcast('log:line', '[lifecycle] initial capture start deferred (waiting for unlock)');
    }
  })();

  // ---- Unlock server management ----
  let _unlockServer = null;
  async function startUnlockServer(secret, opts={}) {
    // Create a TCP server on localhost and write ipc_info.json with port and token.
    return new Promise((resolve, reject) => {
      const crypto = require('crypto');
      const net = require('net');
      const token = crypto.randomBytes(24).toString('hex');
      const server = net.createServer((sock) => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (chunk) => {
          buf += chunk;
          if (buf.indexOf('\n') === -1) return;
          let req;
          try {
            req = JSON.parse(buf);
          } catch (e) {
            sock.end(JSON.stringify({status: 'error', msg: 'bad_json'}) + '\n');
            return;
          }
          if (req.token !== token || req.action !== 'get_key') {
            sock.end(JSON.stringify({status: 'error', msg: 'invalid_token_or_action'}) + '\n');
            return;
          }
          // Raw mode: secret is already base64 encoded data key.
          if (opts.raw) {
            sock.end(JSON.stringify({status: 'ok', key_b64: secret}) + '\n');
            unlockedSuccessfully = true;
            return; // keep server open for future restarts
          }
          // Passphrase mode: unwrap stored wrapped key using Python helper.
          try {
            const spawnSync = require('child_process').spawnSync;
            const py = getPythonCommand();
            const oneLiner = [
              '-c',
              // NOTE: Use \\n inside the rstrip argument so the Python code sees a literal backslash-n, avoiding an actual newline injection that broke the string previously.
              'import sys, base64; from pathlib import Path; from capture.encryption import unwrap_key_with_passphrase; p = Path("data/encrypted/key.fernet.pass").read_bytes(); pw = sys.stdin.read().rstrip("\\n"); key = unwrap_key_with_passphrase(p, pw); sys.stdout.write(base64.b64encode(key).decode())'
            ];
            // Debug: log length of code to help diagnose future truncation issues (no passphrase logged)
            try { broadcast('log:line', `[auth] spawning python unwrap helper len=${oneLiner[1].length}`); } catch(_) {}
            const args = [py].concat(oneLiner);
            const res = spawnSync(args[0], args.slice(1), {input: secret + '\n', encoding: 'utf8', cwd: projectRoot()});
            if (res.status === 0) {
              const out = (res.stdout || '').toString();
              sock.end(JSON.stringify({status: 'ok', key_b64: out}) + '\n');
              unlockedSuccessfully = true;
            } else {
              const reply = JSON.stringify({status: 'error', msg: (res.stderr || res.stdout || 'validation_failed').toString()}) + '\n';
              sock.end(reply);
            }
          } catch (e) {
            sock.end(JSON.stringify({status: 'error', msg: String(e)}) + '\n');
          }
        });
        sock.on('error', () => {});
      });
      server.on('error', (err) => { reject(err); });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = address.port;
        const ipcInfo = {host: '127.0.0.1', port, token};
        const encDir = path.join(projectRoot(), 'data', 'encrypted');
        const legacyPath = path.join(encDir, 'ipc_info.json'); // legacy filename (older builds)
        const serviceExpected = path.join(encDir, 'key.fernet.ipc.json'); // service.py reads this
        try {
          fs.mkdirSync(encDir, {recursive:true});
          fs.writeFileSync(serviceExpected, JSON.stringify(ipcInfo), {mode: 0o600});
          // Also write legacy for backward compatibility / diagnostics
          fs.writeFileSync(legacyPath, JSON.stringify(ipcInfo), {mode: 0o600});
          broadcast('log:line', `[auth] wrote unlock IPC file ${serviceExpected}`);
        } catch (e) {
          server.close();
          return reject(e);
        }
        _unlockServer = server;
        resolve();
      });
    });
  }
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
  } catch(e) { broadcast('log:line', `[error] powerMonitor setup failed: ${e.message}`); }
  setupLinuxLockPolling();
  broadcast('log:line', '[lifecycle] app ready, supervision initialized');
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
    broadcast('log:line', '[lifecycle] app quitting; stopping capture service');
  } catch(_) {}
  try { stopDetached(); } catch(_) {}
});

// ---- Python log tail broadcasting ----
let _pyLogTail = false;
let _pyLogPos = {};
function startPyLogTail() {
  if (_pyLogTail) return; _pyLogTail = true;
  const logDir = path.join(projectRoot(),'data');
  const files = ['capture.stdout.log','capture.stderr.log'];
  for (const f of files) {
    const full = path.join(logDir,f);
    try { if (!fs.existsSync(full)) fs.writeFileSync(full,''); _pyLogPos[full] = fs.statSync(full).size; } catch(_) {}
  }
  function poll() {
    for (const f of files) {
      const full = path.join(logDir,f);
      try {
        const st = fs.statSync(full);
        const prev = _pyLogPos[full]||0;
        if (st.size > prev) {
          const fd = fs.openSync(full,'r');
          const len = st.size - prev;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, prev);
            fs.closeSync(fd);
          _pyLogPos[full] = st.size;
          const text = buf.toString('utf8');
          const lines = text.split(/\r?\n/).filter(l=>l.trim().length);
          for (const line of lines) {
            let level = 'INFO';
            const m = line.match(/\] (DEBUG|INFO|WARNING|ERROR|CRITICAL) /);
            if (m) level = m[1];
            const payload = {file:f, level, line};
            for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('pylog:line', payload); } catch(_) {} }
          }
        }
      } catch(_) {}
    }
    setTimeout(poll, 1200);
  }
  poll();
}
