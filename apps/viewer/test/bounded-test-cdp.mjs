// Test-only transport: a browser dialog or lost target must not strand Node.
export class BoundedTestCdp {
  constructor(socket, { timeoutMs = 10_000 } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.closed = null;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { this.fail(new Error('Invalid CDP message')); return; }
      if (!message.id) { this.events.push(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return; // A timed-out request may still produce a late reply.
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
    });
    socket.addEventListener('close', () => this.fail(new Error('CDP socket closed')));
    socket.addEventListener('error', () => this.fail(new Error('CDP socket error')));
  }

  static async connect(url, { timeoutMs = 10_000, WebSocketImpl = WebSocket } = {}) {
    const socket = new WebSocketImpl(url);
    const client = new BoundedTestCdp(socket, { timeoutMs });
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          socket.removeEventListener('open', opened);
          socket.removeEventListener('error', errored);
          socket.removeEventListener('close', closed);
          error ? reject(error) : resolve();
        };
        const opened = () => finish();
        const errored = () => finish(new Error('CDP connection error'));
        const closed = () => finish(new Error('CDP connection closed before opening'));
        const timer = setTimeout(() => finish(new Error(`CDP connection timed out after ${timeoutMs}ms`)), timeoutMs);
        socket.addEventListener('open', opened, { once: true });
        socket.addEventListener('error', errored, { once: true });
        socket.addEventListener('close', closed, { once: true });
      });
      return client;
    } catch (error) { client.close(); throw error; }
  }

  command(method, params = {}) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: CDP command timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.fail(error); }
    });
  }

  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  fail(error) {
    this.closed ||= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.closed);
    }
    this.pending.clear();
  }

  close() {
    this.fail(new Error('CDP client closed'));
    this.socket.close();
  }
}
