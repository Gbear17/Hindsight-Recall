/* SPDX-License-Identifier: GPL-3.0-only */
// Entry point for Electron frontend
const {app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, powerMonitor} = require('electron');
let tray = null;
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
        {label: 'Open Window', click: () => { if (BrowserWindow.getAllWindows().length===0) createWindow(); else BrowserWindow.getAllWindows()[0].show(); }},
        {label: running ? 'Stop Capture' : 'Start Capture', click: () => { running ? stopDetached() : startDetached(prefs.interval||5); }},
        {type: 'separator'},
        {label: 'Quit', click: () => { app.quit(); }}
      ]);
    };
    tray.setToolTip('Hindsight Recall');
    tray.setContextMenu(buildMenu());
    setInterval(()=> tray.setContextMenu(buildMenu()), 4000);
    tray.on('click', () => { const wins=BrowserWindow.getAllWindows(); if (wins.length) { wins[0].show(); } else createWindow(); });
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
  return Object.assign({autostart: false, interval: 5, delaySeconds: 0, backend: 'auto'}, parsed);
  } catch {
  return {autostart: false, interval: 5, delaySeconds: 0, backend: 'auto'};
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

function startDetached(interval) {
  // If already running (pid file valid) skip.
  const pid = readPid();
  if (pid) return {action:'already', pid};
  userRequestedStop = false;
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
  const args = [py, '-m', 'capture.cli', '--dir', path.join(projectRoot(),'data'), '--interval', String(interval||5), '--print-status', '--pid-file', PID_FILE];
  const env = {...process.env};
  if (prefs.backend && prefs.backend !== 'auto') {
    env.HINDSIGHT_FORCE_BACKEND = prefs.backend;
  }
  if (backendSwitchReason) {
    env.HINDSIGHT_BACKEND_SWITCH_REASON = backendSwitchReason;
  }
  const proc = spawn(args[0], args.slice(1), {detached: true, stdio:'ignore', cwd: projectRoot(), env});
  proc.unref();
  broadcast('log:line', `[control] started capture (interval=${interval||5}s)`);
  return {action:'started'};
}

function stopDetached() {
  const pid = readPid();
  if (!pid) return {action:'not-running'};
  userRequestedStop = true;
  if (pendingRestartTimer) { clearTimeout(pendingRestartTimer); pendingRestartTimer = null; }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return {action:'error', error:String(e)};
  }
  broadcast('log:line', '[control] stop requested (SIGTERM)');
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

function broadcast(channel, payload) {
  // Also append log lines to a rolling file for diagnostics.
  try {
    if (channel === 'log:line') {
      const logPath = path.join(projectRoot(), 'data', 'frontend.log');
  try { fs.mkdirSync(path.dirname(logPath), {recursive:true}); } catch(_) {}
      fs.appendFileSync(logPath, new Date().toISOString() + ' ' + payload + '\n');
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
  prefs = Object.assign(prefs, newPrefs || {});
  savePrefs(prefs);
  if (prefs.autostart) enableAutostart(true); // regenerate with new settings
  if (prefs.interval !== oldInterval) {
    // Restart detached service by signaling stop then start.
    stopDetached();
    setTimeout(()=>startDetached(prefs.interval || 5), 500);
  }
  return {...prefs};
});
// Supervisor control IPC
ipcMain.handle('capture:start', ()=> startDetached(prefs.interval || 5));
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
  if (!autostartMode) {
    createWindow();
  } else {
    // In autostart mode we stay in tray only until user clicks tray item.
    broadcast('log:line', '[lifecycle] autostart tray-only mode (no initial window)');
  }
  createTray();
  startDetached(prefs.interval || 5);
  ensureLinuxAppLauncher();
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

app.on('window-all-closed', () => {
  // Keep running in tray unless explicit quit.
  if (process.platform !== 'darwin') {
    // Do nothing; background continues. On Linux/Windows we intentionally stay.
  }
});
