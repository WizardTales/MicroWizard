/**
 * A real mesh -- a base and three instances of one service, each in a
 * process of its own, talking TCP -- and what reaches whom:
 *
 *   to       one instance by its id, retried on that instance alone
 *   observe  every instance, the sender's own handler included
 *   consume  a pin this instance serves is answered here, as it was
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
    this.name = name;
    this.seen = [];
    this.waiting = new Map();
    this.req = 0;
    this.proc = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env, NAME: name, ...env },
      stdio: ['pipe', 'pipe', 'inherit']
    });
    this.ready = new Promise((resolve) => { this.onReady = resolve; });

    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }

      if (o.ev === 'ready') { this.id = o.id; this.onReady(); }
      if (o.ev === 'got') this.seen.push(o);
      if (o.ev === 'res') {
        this.waiting.get(o.req)?.(o);
        this.waiting.delete(o.req);
      }
    });
  }

  act (pin, data, to) {
    const req = ++this.req;
    const answer = new Promise((resolve) => this.waiting.set(req, resolve));
    this.proc.stdin.write(JSON.stringify({ op: 'act', req, pin, data, to }) + '\n');
    return answer;
  }

  got (what) {
    return this.seen.filter((s) => s.what === what);
  }

  stop () {
    this.proc.kill('SIGKILL');
  }
}

const POKE = 'service:demo,command:poke';
const EVENT = 'service:demo,event:happened';

let base, a, b, c;

test.before(async () => {
  const port = await freePort();
  const BASE = `127.0.0.1:${port}`;

  base = new Member('base', { BASE, ROLE: 'base' });
  await base.ready;
  await sleep(1000);

  a = new Member('A', { BASE });
  b = new Member('B', { BASE, OVERLOAD: '2' });
  c = new Member('C', { BASE });
  await Promise.all([a.ready, b.ready, c.ready]);

  // until every instance can reach every other one by its id
  for (const [from, to] of [[c, a], [c, b], [a, b], [b, c]]) {
    for (let i = 0; ; i++) {
      const r = await from.act(POKE, { n: 0, kind: 'probe' }, to.id);
      if (!r.err) break;
      if (i > 60) throw new Error(`${from.name} never saw ${to.name}: ${r.err}`);
      await sleep(250);
    }
  }
});

test.after(() => {
  for (const m of [a, b, c, base]) m?.stop();
});

test('to: the instance named answers, and no other', async () => {
  const before = a.got('poke').length + c.got('poke').length;

  const r = await c.act(POKE, { n: 1, kind: 'ok' }, b.id);

  assert.deepEqual(r.res, { code: 200, name: 'B', n: 1 });
  assert.ok(b.got('poke').some((p) => p.n === 1 && p.net));
  assert.equal(a.got('poke').length + c.got('poke').length, before);
});

test('to: an overloaded instance is tried again, not passed over', async () => {
  const r = await c.act(POKE, { n: 2, kind: 'overload' }, b.id);

  assert.deepEqual(r.res, { code: 200, name: 'B', n: 2 });
  assert.equal(b.got('poke').filter((p) => p.n === 2).length, 3, 'twice overloaded, then taken');
  assert.ok(r.ms >= 300, `backed off between the tries (${r.ms} ms)`);
  assert.equal(a.got('poke').filter((p) => p.n === 2).length, 0, 'never moved on to A');
});

test('to: an error the handler answers with is the answer, not retried', async () => {
  const r = await c.act(POKE, { n: 3, kind: 'broken' }, b.id);

  assert.match(r.err, /handler broke/);
  assert.equal(b.got('poke').filter((p) => p.n === 3).length, 1);
});

test('to: an id nobody has is no-target at once', async () => {
  const r = await c.act(POKE, { n: 4, kind: 'ok' }, 'nobody');

  assert.match(r.err, /no-target/);
  assert.ok(r.ms < 100);
});

test('to: the sender itself answers locally', async () => {
  const r = await c.act(POKE, { n: 5, kind: 'ok' }, c.id);

  assert.deepEqual(r.res, { code: 200, name: 'C', n: 5 });
  assert.ok(c.got('poke').some((p) => p.n === 5 && !p.net));
});

test('consume: a pin served here is answered here, as before', async () => {
  const r = await c.act(POKE, { n: 6, kind: 'ok' });

  assert.equal(r.res.name, 'C');
});

test('observe: every instance gets it once, nothing goes round again', async () => {
  const r = await c.act(EVENT, { n: 7 });

  assert.equal(r.res.name, 'C', 'the sender\'s own handler answers');
  await sleep(500);

  for (const m of [a, b, c]) {
    assert.equal(m.got('event').filter((e) => e.n === 7).length, 1, m.name);
  }
  assert.ok(c.got('event').find((e) => e.n === 7).net === false);
  assert.ok(a.got('event').find((e) => e.n === 7).net === true);
});

test('to: an instance that left the mesh is given up on', async () => {
  const gone = a.id;
  a.stop();

  // until the mesh has noticed; meanwhile the tries back off and give up
  for (let i = 0; ; i++) {
    const r = await c.act(POKE, { n: 8, kind: 'ok' }, gone);
    assert.ok(r.err, 'nothing answers for a dead instance');
    if (/no-target/.test(r.err)) break;
    if (i > 20) assert.fail(`still not given up: ${r.err}`);
  }
});
