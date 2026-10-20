/**
 * One mesh member for the tests, driven over stdin and reporting on
 * stdout, one JSON object per line.
 *
 *   env NAME, BASE (host:port), ROLE (base|svc), OVERLOAD (times to answer
 *   a poke with an overload before taking it)
 *
 *   in:  {"op":"act","req":1,"pin":"...","data":{...},"to":"<id>"}
 *   out: {"ev":"ready","id":"..."} {"ev":"got",...} {"ev":"res","req":1,...}
 */
import readline from 'node:readline';
import Micro from '../../index.js';

const { NAME, BASE, ROLE } = process.env;
let overload = Number(process.env.OVERLOAD || 0);
const out = (o) => process.stdout.write(JSON.stringify({ name: NAME, ...o }) + '\n');

const mc = new Micro();
const [host, port] = BASE.split(':');

if (ROLE === 'base') {
  mc.use('mesh-ng', { isbase: true, base: true, host, port: Number(port), bases: [BASE] });
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

  mc.add('service:demo,event:happened', async (msg, meta) => {
    out({ ev: 'got', what: 'event', n: msg.n, net: meta.n === true });
    return { code: 200, name: NAME };
  });

  mc.use('mesh-ng', {
    host,
    bases: [BASE],
    auto: true,
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
