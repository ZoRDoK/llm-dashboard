/**
 * TCP proxy exposing a containerized Chrome DevTools port on the host.
 *
 * The ai-creds cookie adapters talk CDP on 127.0.0.1:9222 by default (or
 * CHROME_CDP_URL). The user's logged-in Chrome can live inside a container
 * whose CDP port is only bound to loopback; this forwarder bridges each
 * incoming connection through `docker exec`, so it survives container
 * restarts without any changes to the container itself.
 *
 * Env knobs: CDP_PROXY_PORT (host listen port), CDP_CONTAINER (container
 * name), CONTAINER_CDP_PORT (CDP port inside the container).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

const LISTEN_PORT = Number(process.env.CDP_PROXY_PORT ?? 9333);
const CONTAINER = process.env.CDP_CONTAINER ?? 'neurovanya-chrome';
const CONTAINER_CDP_PORT = Number(process.env.CONTAINER_CDP_PORT ?? 9222);

const server = net.createServer((client) => {
  const child = spawn('docker', [
    'exec',
    '-i',
    CONTAINER,
    'socat',
    '-',
    `TCP:127.0.0.1:${CONTAINER_CDP_PORT}`,
  ]);

  client.pipe(child.stdin);
  child.stdout.pipe(client);

  child.stderr.on('data', (chunk) => {
    console.error('[cdp-proxy]', chunk.toString().trim());
  });

  const close = () => {
    child.kill();
    client.destroy();
  };

  child.on('exit', close);
  client.on('close', close);
  client.on('error', close);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.info(`[cdp-proxy] 127.0.0.1:${LISTEN_PORT} -> ${CONTAINER}:${CONTAINER_CDP_PORT}`);
});
