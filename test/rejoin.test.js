/**
 * Rejoining after the bases are gone (discover.rediscover): two bases and
 * a service, the bases killed, and what the service is left waiting on.
 *
 * Every rejoin attempt used to wait once on the sneeze for an error and
 * never stop waiting, and every base that left started a chain of its own;
 * the waits piled up, one more every attempt.
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';

const FIXTURE = new URL('./fixtures/node.mjs', import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

class Member {
  constructor (name, env) {
    this.rejoins = 0;
    this.waiting = new Map();
    this.req = 0;
    this.proc = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env, NAME: name, ...env },
      stdio: ['pipe', 'pipe', 'inherit']
    });
    this.ready = new Promise((resolve) => { this.onReady = resolve; });

    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (line.includes('rejoin failed')) this.rejoins++;
      let o;
      try { o = JSON.parse(line); } catch { return; }

      if (o.ev === 'ready') this.onReady();
      if (o.ev === 'listeners') {
        this.waiting.get(o.req)?.(o);
        this.waiting.delete(o.req);
      }
    });
  }

  listeners () {
    const req = ++this.req;
    const answer = new Promise((resolve) => this.waiting.set(req, resolve));
    this.proc.stdin.write(JSON.stringify({ op: 'listeners', req }) + '\n');
    return answer;
  }

  stop () {
    this.proc.kill('SIGKILL');
  }
}

let base0, base1, svc;

test.before(async () => {
  const BASES = [`127.0.0.1:${await freePort()}`, `127.0.0.1:${await freePort()}`];

  base0 = new Member('base0', { BASE: BASES[0], BASES: BASES.join(','), ROLE: 'base' });
  base1 = new Member('base1', { BASE: BASES[1], BASES: BASES.join(','), ROLE: 'base' });
  await Promise.all([base0.ready, base1.ready]);
  await sleep(1000);

  svc = new Member('svc', { BASE: BASES[0], BASES: BASES.join(','), REDISCOVER: '1' });
  await svc.ready;
  await sleep(3000);
});

test.after(() => {
  for (const m of [svc, base0, base1]) m?.stop();
});

test('rejoin: without bases, one chain and one wait at a time', async () => {
  base0.stop();
  base1.stop();

  // until the mesh has noticed the bases are gone and rejoined a while
  await sleep(15000);
  const first = svc.rejoins;
  const before = await svc.listeners();
  await sleep(5000);
  const after = await svc.listeners();
  const perSecond = (svc.rejoins - first) / 5;

  assert.ok(svc.rejoins > 0, 'it did try to rejoin');
  // the one listener join() logs errors with, and the attempt under way
  assert.ok(after.error <= 2, `waits once for an error at most, not ${after.error - 1}`);
  assert.ok(after.error <= before.error, `no more waits pile up (${before.error} -> ${after.error})`);
  assert.ok(perSecond <= 1, `one chain, not several (${perSecond} attempts/s)`);
});
