/**
 * One mesh member for the tests, driven over stdin and reporting on
 * stdout, one JSON object per line.
 *
 *   env NAME, BASE (host:port), BASES (host:port,... the mesh's bases,
 *   BASE alone if unset), ROLE (base|svc), OVERLOAD (times to answer a poke
 *   with an overload before taking it), REDISCOVER (1: rejoin when the bases
 *   are gone)
 *
 *   in:  {"op":"act","req":1,"pin":"...","data":{...},"to":"<id>"}
 *        {"op":"listeners","req":2}
 *   out: {"ev":"ready","id":"..."} {"ev":"got",...} {"ev":"res","req":1,...}
 *        {"ev":"listeners","req":2,"error":n,"retry":n}
 */
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import Micro from '../../index.js';

const { NAME, BASE, ROLE } = process.env;
const BASES = process.env.BASES ? process.env.BASES.split(',') : [BASE];

// the sneezes something waits on once for an error or a retry, to count
// what is still waiting there
const waitedOn = new Set();
const once = EventEmitter.prototype.once;
EventEmitter.prototype.once = function (event, listener) {
  if ((event === 'error' || event === 'retry') && '_swim' in this) waitedOn.add(this);
  return once.call(this, event, listener);
};
const waiting = (event) =>
  Math.max(0, ...[...waitedOn].map((e) => e.listenerCount(event)));
let overload = Number(process.env.OVERLOAD || 0);
const out = (o) => process.stdout.write(JSON.stringify({ name: NAME, ...o }) + '\n');

const mc = new Micro();
const [host, port] = BASE.split(':');

if (ROLE === 'base') {
  mc.use('mesh-ng', { isbase: true, base: true, host, port: Number(port), bases: BASES });
} else {
  mc.add('service:demo,command:poke', async (msg, meta) => {
    if (msg.kind === 'overload' && overload > 0) {
      overload--;
      out({ ev: 'got', what: 'poke', n: msg.n, overloaded: true });
      throw new Error('retry_later_err_overload');
    }
    if (msg.kind === 'broken') {
      out({ ev: 'got', what: 'poke', n: msg.n, broke: true });
      throw new Error('handler broke');
    }
    out({ ev: 'got', what: 'poke', n: msg.n, net: meta.n === true });
    return { code: 200, name: NAME, n: msg.n };
  });

  mc.add('service:demo,command:peers', async () => ({
    code: 200,
    peers: mc.peers('service:demo,command:*')
  }));

  mc.add('service:demo,event:happened', async (msg, meta) => {
    out({ ev: 'got', what: 'event', n: msg.n, net: meta.n === true });
    return { code: 200, name: NAME };
  });

  mc.use('mesh-ng', {
    host,
    bases: BASES,
    auto: true,
    discover: { rediscover: process.env.REDISCOVER === '1' },
    sneeze: { silent: true },
    listen: [
      { pin: 'service:demo,command:*', model: 'consume', type: 'tcp' },
      { pin: 'service:demo,event:*', model: 'observe', type: 'tcp' }
    ]
  });
}

out({ ev: 'ready', id: mc.id });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const { op, req, pin, data, to } = JSON.parse(line);
  if (op === 'listeners') {
    return out({ ev: 'listeners', req, error: waiting('error'), retry: waiting('retry') });
  }
  if (op !== 'act') return;

  const t0 = Date.now();
  try {
    const res = await mc.act(pin, data, to ? { to } : {});
    out({ ev: 'res', req, res, ms: Date.now() - t0 });
  } catch (e) {
    const err = e?.err?.message || e?.err || e?.message || String(e);
    out({ ev: 'res', req, err: String(err), code: e?.code, ms: Date.now() - t0 });
  }
});
