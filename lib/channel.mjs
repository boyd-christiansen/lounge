export class InputChannel {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) { if (this.closed) throw new Error('The session input is closed'); const waiter = this.waiters.shift(); waiter ? waiter({ value: item, done: false }) : this.items.push(item); }
  close() { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true }); }
  next() { if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false }); if (this.closed) return Promise.resolve({ done: true }); return new Promise(resolve => this.waiters.push(resolve)); }
  [Symbol.asyncIterator]() { return this; }
}
