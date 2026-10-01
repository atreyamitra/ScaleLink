'use strict';

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');

const { TEST_REDIS_URL } = require('./redis');

const SERVER_ENTRY = path.join(__dirname, '..', '..', 'src', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the REAL entrypoint (`node src/server.js`) as a separate OS process,
 * i.e. a genuinely independent app instance with its own event loop and its
 * own Redis connection. Resolves once GET /ready answers 200.
 */
async function startInstance({ instanceId, env = {} }) {
  const port = await freePort();
  let output = '';
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: os.tmpdir(), // keep dotenv from picking up a developer's .env
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      INSTANCE_ID: instanceId,
      REDIS_URL: TEST_REDIS_URL,
      LOG_LEVEL: 'warn',
      RATE_LIMIT_MAX_REQUESTS: '100000',
      RATE_LIMIT_WINDOW_SECONDS: '60',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.once('exit', resolve));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`instance ${instanceId} exited early:\n${output}`);
    try {
      const res = await fetch(`${url}/ready`);
      if (res.status === 200) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`instance ${instanceId} never became ready:\n${output}`);
    }
    await sleep(50);
  }

  return {
    id: instanceId,
    url,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(killer);
    },
  };
}

module.exports = { startInstance };
