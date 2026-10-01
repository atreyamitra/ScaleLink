'use strict';

const net = require('net');

/**
 * A tiny TCP proxy that sits between the app and a real Redis so tests can
 * inject real network faults without mocks or needing the redis-server binary:
 *
 *   pass         forward everything (normal operation)
 *   stall        accept connections but forward nothing in either direction
 *                (a hung/black-holed Redis)
 *   dropReplies  forward requests to Redis but swallow its replies (the command
 *                EXECUTES on Redis, the client never learns the outcome)
 *   dropRepliesWhen(regex)
 *                forward normally until a client->Redis chunk matches `regex`,
 *                forward THAT chunk, then behave as dropReplies. Returns a
 *                promise that resolves when the trigger fires. Lets a test
 *                lose the reply to one specific command (e.g. the SET NX).
 *   sever()      destroy every connection and stop listening, so reconnect
 *                attempts get ECONNREFUSED (Redis down)
 *   heal()       listen again on the same port and go back to `pass`
 */
class FaultProxy {
  constructor({ host, port }) {
    this.target = { host, port };
    this.mode = 'pass';
    this.sockets = new Set();
    this.trigger = null;
    this.server = null;
    this.port = 0;
  }

  async start() {
    await this.listen(0);
    return this.port;
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => this.onClient(client));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    });
  }

  onClient(client) {
    const upstream = net.connect(this.target.port, this.target.host);
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        this.sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.on('data', (chunk) => {
      if (this.mode === 'pass' || this.mode === 'dropReplies') upstream.write(chunk);
      if (this.trigger && this.trigger.regex.test(chunk.toString('latin1'))) {
        this.mode = 'dropReplies';
        this.trigger.fire();
        this.trigger = null;
      }
    });
    upstream.on('data', (chunk) => {
      if (this.mode === 'pass') client.write(chunk);
    });
  }

  setMode(mode) {
    this.mode = mode;
  }

  dropRepliesWhen(regex) {
    return new Promise((resolve) => {
      this.trigger = { regex, fire: resolve };
    });
  }

  sever() {
    this.server.close();
    this.server = null;
    for (const socket of [...this.sockets]) socket.destroy();
  }

  async heal() {
    this.mode = 'pass';
    if (!this.server) await this.listen(this.port);
  }

  async stop() {
    if (this.server) this.server.close();
    for (const socket of [...this.sockets]) socket.destroy();
  }
}

module.exports = { FaultProxy };
