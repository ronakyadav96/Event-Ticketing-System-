const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.resolve(APP_DIR, '..', 'event-ticketing-backend');
const BACKEND_ENTRY = path.join(BACKEND_DIR, 'src', 'server.js');
const ANGULAR_CLI = path.join(APP_DIR, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 5001);

let backendProcess;
let frontendProcess;
let shuttingDown = false;

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function isBackendHealthy() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: BACKEND_HOST,
        port: BACKEND_PORT,
        path: '/health',
        timeout: 500,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const health = JSON.parse(body);
            resolve(response.statusCode === 200 && health.status === 'ok');
          } catch {
            resolve(false);
          }
        });
      }
    );

    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBackendHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function startBackend() {
  console.log(`Starting backend on http://${BACKEND_HOST}:${BACKEND_PORT}...`);
  backendProcess = spawn(process.execPath, [BACKEND_ENTRY], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT: String(BACKEND_PORT) },
    stdio: 'inherit',
  });

  backendProcess.once('error', (error) => {
    console.error(`Could not start backend: ${error.message}`);
  });

  backendProcess.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`Backend stopped${signal ? ` (${signal})` : ` with exit code ${code}`}.`);
    }
  });
}

function stopProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill('SIGTERM');
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopProcess(frontendProcess);
  stopProcess(backendProcess);
  setTimeout(() => process.exit(code), 500).unref();
}

async function start() {
  if (await canConnect(BACKEND_PORT, BACKEND_HOST)) {
    console.log(`Using existing backend on http://${BACKEND_HOST}:${BACKEND_PORT}.`);
  } else {
    startBackend();
  }

  if (!(await waitForBackend())) {
    console.warn(
      'Backend is not database-ready yet; Angular will start, but API requests may return 503 until MongoDB connects.'
    );
  }

  frontendProcess = spawn(process.execPath, [ANGULAR_CLI, 'serve', ...process.argv.slice(2)], {
    cwd: APP_DIR,
    env: process.env,
    stdio: 'inherit',
  });

  frontendProcess.once('error', (error) => {
    console.error(`Could not start Angular: ${error.message}`);
    void shutdown(1);
  });

  frontendProcess.once('exit', (code, signal) => {
    if (!shuttingDown) void shutdown(signal ? 1 : code || 0);
  });
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

void start();
