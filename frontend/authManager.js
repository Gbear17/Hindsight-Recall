// AuthManager: encapsulates passphrase / PIN workflow, lock-info polling, unlock server
// Extracted from main.js to reduce complexity.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const {BrowserWindow, ipcMain} = require('electron');

class AuthManager {
  constructor(deps) {
    this.broadcast = deps.broadcast; // function(channel, payload)
    this.log = deps.log || ((cat,msg)=>{ try { this.broadcast('log:line', `[${cat}] ${msg}`); } catch(_) {} });
    this.projectRoot = deps.projectRoot; // () => root path
    this.forceShowMainWindow = deps.forceShowMainWindow; // () => void
    this.startDetached = deps.startDetached; // (interval) => void
    this.readPid = deps.readPid; // () => pid | null
    this.runPyHelper = deps.runPyHelper; // (args, opts) => {status, stdout, stderr, error}
    this.promptForPassphraseModal = deps.promptForPassphraseModal; // async prompt
    this.promptForRecoveryModal = deps.promptForRecoveryModal; // async modal
    this.getPrefs = deps.getPrefs; // () => prefs reference
    this.needPassFlag = false;
    this.unlocked = false; // capture-level unlock (raw key or passphrase-derived)
    this._unlockServer = null;
  }
  needsPass() { return this.needPassFlag; }
  isUnlocked() { return this.unlocked; }
  markNeedPass(flag) { this.needPassFlag = !!flag; }

  async startUnlockServer(secret, opts={}) {
    return new Promise((resolve, reject) => {
      const token = crypto.randomBytes(24).toString('hex');
      const server = net.createServer((sock) => {
        let buf='';
        sock.setEncoding('utf8');
        sock.on('data', chunk => {
          buf += chunk;
          if (!buf.includes('\n')) return;
          let req; try { req = JSON.parse(buf); } catch { sock.end(JSON.stringify({status:'error', msg:'bad_json'})+'\n'); return; }
          if (req.token !== token || req.action !== 'get_key') {
            sock.end(JSON.stringify({status:'error', msg:'invalid_token_or_action'})+'\n');
            return;
          }
          if (opts.raw) {
            sock.end(JSON.stringify({status:'ok', key_b64: secret})+'\n');
            this.unlocked = true;
            return;
          }
          try {
            const oneLiner = ['-c','import sys, base64; from pathlib import Path; from capture.encryption import unwrap_key_with_passphrase; p = Path("data/encrypted/key.fernet.pass").read_bytes(); pw = sys.stdin.read().rstrip("\\n"); key = unwrap_key_with_passphrase(p, pw); sys.stdout.write(base64.b64encode(key).decode())'];
            try { this.log('auth', `spawning python unwrap helper len=${oneLiner[1].length}`); } catch {}
            const res = this.runPyHelper(oneLiner, {input: secret + '\n'});
            if (res.status === 0) {
              const out = (res.stdout || '').toString();
              sock.end(JSON.stringify({status:'ok', key_b64: out})+'\n');
              this.unlocked = true;
            } else {
              sock.end(JSON.stringify({status:'error', msg:(res.stderr||res.stdout||'validation_failed').toString()})+'\n');
            }
          } catch (e) {
            sock.end(JSON.stringify({status:'error', msg:String(e)})+'\n');
          }
        });
      });
      server.on('error', err => reject(err));
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = address.port;
        const ipcInfo = {host:'127.0.0.1', port, token};
        const encDir = path.join(this.projectRoot(), 'data', 'encrypted');
        const legacyPath = path.join(encDir, 'ipc_info.json');
        const serviceExpected = path.join(encDir, 'key.fernet.ipc.json');
        try {
          fs.mkdirSync(encDir, {recursive:true});
          fs.writeFileSync(serviceExpected, JSON.stringify(ipcInfo), {mode:0o600});
          fs.writeFileSync(legacyPath, JSON.stringify(ipcInfo), {mode:0o600});
          this.log('auth', `wrote unlock IPC file ${serviceExpected}`);
        } catch (e) { server.close(); return reject(e); }
        this._unlockServer = server;
        resolve();
      });
    });
  }

  async promptAndValidateBlocking() {
    let lastLockLoggedSeconds = null;
    while (true) {
      const wrappedKeyPath = path.join(this.projectRoot(), 'data', 'encrypted', 'key.fernet.pass');
      const keyExists = fs.existsSync(wrappedKeyPath);
      // lock-info probe
      try {
        const li = this.runPyHelper(['-m','capture.keymgr','--base-dir', path.join(this.projectRoot(),'data'),'--lock-info']);
        if (!li.error && li.status === 0 && li.stdout) {
          try {
            const info = JSON.parse(li.stdout);
            for (const w of BrowserWindow.getAllWindows()) try { w.webContents.send('auth:lock-update', info); } catch {}
            if (info.lock_until) {
              const until = new Date(info.lock_until); const now = new Date();
              if (until > now) {
                const secs = Math.ceil((until - now)/1000);
                const shouldLog = (secs === 5 || secs <= 3 || (secs % 10 === 0 && secs !== lastLockLoggedSeconds));
                if (shouldLog) { this.log('auth', `currently locked until ${until.toISOString()} (${secs}s)`); lastLockLoggedSeconds = secs; }
                await new Promise(r=> setTimeout(r, Math.min(10000, secs*1000)));
                continue; // re-loop
              }
            }
          } catch {}
        }
      } catch {}
      const creating = !keyExists;
      const pass = await this.promptForPassphraseModal(keyExists ? 'Enter passphrase / PIN to unlock' : 'Set a new passphrase or PIN', {showComplexity: creating});
      if (pass === null) continue; // enforce requirement
      try {
        const args = ['-m','capture.keymgr'];
        if (keyExists) args.push('--validate'); else args.push('--create');
        args.push('--base-dir', path.join(this.projectRoot(),'data'), '--pass-stdin');
        const res = this.runPyHelper(args, {input: pass + '\n'});
  if (res.error) { this.log('auth', `helper error: ${res.error.message}`); continue; }
        if (res.status === 0) {
          this.log('auth', 'passphrase accepted');
          try { this.forceShowMainWindow(); } catch {}
          if (!keyExists) {
            const token = (res.stdout||'').toString().trim();
            if (token) { try { await this.promptForRecoveryModal(token); } catch {} }
          }
          try { await this.startUnlockServer(pass); } catch (e) { this.log('auth', `failed starting unlock server: ${e.message}`); continue; }
          // autostart key presence
          try {
            const out = this.runPyHelper(['-m','capture.keymgr','--base-dir', path.join(this.projectRoot(),'data'), '--get-autostart']);
            if (!out.error && out.status === 0 && out.stdout && out.stdout.trim()) this.log('auth', 'autostart key present');
          } catch {}
          const wasLocked = (this.needPassFlag || keyExists) && !this.unlocked;
          this.unlocked = true;
          this.needPassFlag = true; // mark globally protected now
          if (wasLocked && !this.readPid()) {
            this.log('lifecycle', 'starting capture now that key is unlocked');
            this.startDetached(this.getPrefs().interval || 5);
          }
          return true;
        }
        const err = (res.stderr||res.stdout||'').toString();
        if (res.status === 3 || /complexity requirements/i.test(err)) {
          this.log('auth', 'passphrase does not meet complexity requirements (not counted as failure)');
          continue;
        }
  this.log('auth', `validation failed: ${err.trim()}`);
        if (res.status === 1) {
          try {
            const rf = this.runPyHelper(['-m','capture.keymgr','--base-dir', path.join(this.projectRoot(),'data'), '--record-fail']);
            if (!rf.error && rf.status === 0 && rf.stdout) {
              try {
                const info = JSON.parse(rf.stdout);
                for (const w of BrowserWindow.getAllWindows()) try { w.webContents.send('auth:lock-update', info); } catch {}
                if (info.lock_until) this.log('auth', `locked until ${info.lock_until}`);
              } catch {}
            }
          } catch {}
        }
      } catch (e) {
  this.log('auth', `exception validating passphrase: ${e.message}`);
      }
    }
  }

  async autostartAttempt(needPass) {
    // Probe autostart key; if available run unlock server raw; else prompt if needed
    try {
      const ka = this.runPyHelper(['-m','capture.keymgr','--base-dir', path.join(this.projectRoot(),'data'), '--get-autostart']);
  try { this.log('auth', `autostart key probe status=${ka.status} err=${ka.error?ka.error.message:'none'} stdout_len=${(ka.stdout||'').trim().length}`); } catch {}
      if (!ka.error && ka.status === 0 && ka.stdout && ka.stdout.trim()) {
        const rawKey = ka.stdout.trim();
  this.log('auth', 'autostart raw key detected; starting unlock server (raw mode)');
  try { await this.startUnlockServer(rawKey, {raw:true}); this.unlocked = true; this.log('auth', 'capture unlocked via autostart key (UI still locked)'); return; } catch (e) { this.log('auth', `autostart raw key path failed (${e.message}); falling back to prompt`); }
      } else {
  this.log('auth', 'no autostart key present (will prompt if protection enabled)');
      }
    } catch {}
    if (needPass || !fs.existsSync(path.join(this.projectRoot(), 'data', 'encrypted', 'key.fernet.pass'))) {
      await this.promptAndValidateBlocking();
    }
  }
}

module.exports = {AuthManager};
