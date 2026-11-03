import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export function workerEnvironment(environment = process.env) {
  // The speech credential belongs to the API adapter, not agent subprocesses.
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !['ELEVENLABS_API_KEY','LOUNGE_DESKTOP_HOST','LOUNGE_ENV_FILE','LOUNGE_DB'].includes(key)));
}

// JSON-RPC over the supported app-server stdio transport. No auth files are read.
export class Codex extends EventEmitter {
  constructor({ cwd, binary = process.env.CODEX_BIN || 'codex' } = {}) {
    super(); this.cwd = cwd; this.binary = binary; this.seq = 0; this.pending = new Map(); this.ready = false;
  }
  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.open();
    try { await this.starting; } finally { this.starting = null; }
  }
  async open() {
    this.proc = spawn(this.binary, ['app-server', '-c', 'thread_unload_delay_secs=0', '--listen', 'stdio://'], { cwd: this.cwd, env: workerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', error => this.fail(error));
    this.proc.on('exit', (code, signal) => this.fail(new Error(`Codex disconnected (${signal || code}). Reconnect in Connections.`)));
    // Diagnostic stderr is deliberately not forwarded into task content or the UI.
    this.proc.stderr.on('data', () => {});
    this.reader = createInterface({ input: this.proc.stdout });
    this.reader.on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id != null && (m.result !== undefined || m.error)) {
        const request = this.pending.get(m.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(m.id);
        if (m.error) request.reject(new Error(m.error.message)); else request.resolve(m.result);
      } else if (m.method) this.emit(m.id != null ? 'request' : 'notification', m);
    });
    await this.call('initialize', { clientInfo: { name: 'command_lounge', title: 'Command Lounge', version: '0.3.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.send({ method: 'initialized', params: {} }); this.ready = true; this.emit('connected');
  }
  fail(error) {
    this.ready = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('disconnected', error);
  }
  send(message) {
    if (!this.proc || this.proc.stdin.destroyed) throw new Error('Codex is not connected');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}, timeout = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out. No automatic retry was sent.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  reply(id, result) { this.send({ id, result }); }
  stop() { this.proc?.kill('SIGTERM'); this.ready = false; }
}
