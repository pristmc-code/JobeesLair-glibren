// glibren.41 (T1): a free port for a test payload, from a block of ports that belongs to one test file only.
// Before, each file asked the system for a free port (listen on 0) and closed it; the payload bound it a moment later.
// The test files run in parallel, so another file could take the same port in between ("fetch failed" in bg-convert,
// now and then). The blocks sit below the system's automatic range (32768-60999 on Linux), so nothing else picks them:
// each file gives its own block number (0-19), and a port is handed out once per run.
import net from 'node:net';

const FIRST = 12000;
const BLOCK = 1000;
const used = new Set();

const canListen = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});

export function freePortFrom(block) {
  if (!Number.isInteger(block) || block < 0 || block > 19) throw new Error(`free-port: block ${block} out of 0-19`);
  return async () => {
    const start = FIRST + block * BLOCK;
    for (let port = start; port < start + BLOCK; port++) {
      if (used.has(port)) continue;
      used.add(port);
      if (await canListen(port)) return port;
    }
    throw new Error(`free-port: block ${block} has no free port left`);
  };
}
