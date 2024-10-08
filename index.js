/*
 const initialSenecaConfig = {
  auto: true,
  listen: [{ pin: 'service:user,command:*', model: 'consume', type: 'tcp' }],
  discover: {
    rediscover: true,
    custom: {
      active: true,
      find: dnsSeed
    }
  }
};
*/

// request.seneca.actAsync(
//           'service:inventory,command:create,asset:quota,type:w1',
//   { session, data ... }
// );

import tp from './transfer.js';
import Balancer from './balance.js';
import { uid } from 'uid';
import Promise from 'bluebird';
import Mesh from './mesh.js';

const sleep = (time) => new Promise((resolve) => setTimeout(resolve, time));

const start = process.hrtime.bigint();
export const transport = tp;

const convertPin = (pin) => {
  const r = /([a-zA-Z0-9_-]+)(?:\s+)?:([^,]+)/g;
  let t;
  let final = [];

  if (typeof pin === 'object') {
    final = Object.entries(pin).map(([x, y]) => {
      if (y !== '*') {
        return { p: `${x}:${y}`, c: 1 };
      } else {
        return { p: x, c: 2 };
      }
    });
  } else {
    while ((t = r.exec(pin))) {
      if (t[2] !== '*') {
        final.push({ p: t[0], c: 1 });
      } else {
        final.push({ p: t[1], c: 2 });
      }
    }
  }

  return { c: final.sort((a, b) => (a.p < b.p ? -1 : a.p < b.p ? 1 : 0)) };
};

export const convertData = (pin) => {
  const r = /([a-zA-Z0-9_-]+)(?:\s+)?:([^,]+)/g;
  let t;
  const final = [];
  const o = {};

  while ((t = r.exec(pin))) {
    final.push(t[0]);
    o[t[1]] = t[2];
  }

  return { c: final.sort(), o };
};

export const pattern = (pin) => {
  const { c } = convertData(pin);
  return c.join(',');
};

export const utilClean = function (obj, opts) {
  if (obj == null) return obj;

  const out = Array.isArray(obj) ? [] : {};

  const pn = Object.getOwnPropertyNames(obj);
  for (const pnI of pn) {
    const p = pnI;

    if (p[p.length - 1] !== '$') {
      out[p] = obj[p];
    }
  }

  return out;
};

const FORBIDDEN = {
  undefined: true,
  object: true,
  function: true,
  symbol: true
};

export default class Micro {
  #pinDB = { n: {}, s: {} };
  #hash = {};
  #pinCache = {};
  #convCache = {};
  #register = {};
  #balancer;
  #transport;
  #stopped = false;
  #active = 0;
  #clients = {};
  #loaded = {};

  constructor (options = {}) {
    if (options.debug) {
      setInterval(() => {
        console.dir(this.#clients, { depth: null });
      }, 4000);
    }
    this.root = this;
    this.log = {
      error: (m, e) => console.error(m, e),
      info: (m, e) => console.log(m, e)
    };
    this.util = {
      Jsonic: (x) => convertData(x).o,
      clean: utilClean
    };

    this.actAsync = this.act;
    this.id = uid();
    this.#balancer = new Balancer(options.balance);
    this.#transport = transport(options.transport, this);
    this.register('role:mc,cmd:close', async function (msg) {
      this.#stopped = true;
      while (this.#active > 0) {
        await sleep(500);
      }

      // give the last msgs a chance to be send out
      await sleep(500);
      await this.#transport.tp.close();

      return { code: 200, msg: 'shutdown' };
    });
    this.register('role:transport,cmd:listen', function (msg) {
      return Promise.fromCallback((reply) =>
        this.#transport.listen(msg.config, reply, () => this.reduceActive())
      );
    });
  }

  get offline () {
    return this.#stopped;
  }

  // no emitter yet
  on () {}

  delegate () {
    // in esm we can't do that, not so important for us though
    return this;
    // const del = Object.create(this);
    // del.did = del.did ? `${del.did}/` : '' + uid();

    // return del;
  }

  async client (config) {
    const { type, pin } = config;

    if (type === 'balance') {
      this.#clients[pin] = this.#balancer.addClient(config);
      this.#clients[pin].handle = this.#balancer.makeHandle(config);
    } else if (type === 'web') throw new Error('not supported');
    else {
      const client = await Promise.fromCallback((reply) =>
        this.#transport.client(config, reply)
      );

      const me = this;

      let cl;
      if (me.#clients[pin]) {
        cl = me.#clients[pin];
        const action = function (msg, meta) {
          return client.send.call(this, msg, meta).catch((x) => {
            throw x;
          });
        };
        action.id = config.id;
        cl.handle(pin, action);
      }

      const func = function (msg, meta) {
        if (meta.pin) {
          meta.k = 'aE';
          meta.p = meta.pin;
        }

        if (cl) {
          return cl.send.call(this, msg, meta).catch((x) => {
            throw x;
          });
        } else {
          return client.send.call(this, msg, meta).catch((x) => {
            throw x;
          });
        }
      };

      func.client = true;

      if (Array.isArray(pin)) {
        pin.map((pin) => this.add(pin, func));
      } else {
        this.add(pin, func);
      }
    }
  }

  removeClient (msg) {
    return this.#balancer.removeClient(msg);
  }

  use (module, options) {
    switch (module) {
      case 'mesh':
      case 'mesh-ng':
        this.#loaded.mesh = 'loading';
        Mesh(options, this);
        setTimeout(async () => {
          await this.callInternal('init:mesh', {});
          this.#loaded.mesh = true;
        }, 500);
        break;
    }
  }

  ready (cb) {
    if (this.#loaded.mesh === 'loading') {
      setTimeout(() => {
        this.ready(cb);
      }, 500);

      return false;
    }

    cb();

    return true;
  }

  listen (msg) {
    return this.callInternal('role:transport,cmd:listen', { config: msg });
  }

  callInternal (pin, args) {
    return this.#register[pin][0].call(this, args, { id: uid(), pin });
  }

  register (pin, method) {
    this.#register[pin] = this.#register[pin] || [];
    this.#register[pin].unshift(method);
  }

  async rPrior (msg, meta) {
    if (!meta.priorI) {
      meta.priorI = 0;
    }

    const pin = this.#register[meta.pin];
    const method = pin[++meta.priorI];

    if (method) return method.call(this, msg);
    else return {};
  }

  async prior (msg, meta) {
    if (!meta.priorI) {
      meta.priorI = 0;
    }

    const pin = this.#matchPin(meta.pin);
    const method = pin.fl[meta.priorI++];

    if (method) return method.call(this, msg);
    else return {};
  }

  async actE (x, y, opts = {}, meta = {}) {
    meta.id = meta.id || uid();

    if (opts.mixin?.length) {
      for (const m of opts.mixin) {
        x = `${x},${m}:${y[m]}`;
      }
    }

    if (y && this.#pinCache[x]) {
      const { pin, xConv } = this.#pinCache[x];
      meta.pin = meta.pin || x;

      return pin.f({ data: y, msg: xConv }, meta);
    }
    let pat;
    let patF;
    let xConv;
    if (typeof x === 'object') {
      pat = Object.entries(x).reduce((o, [x, y]) => {
        if (!FORBIDDEN[typeof y]) {
          o.push(`${x}:${y}`);
        }

        return o;
      }, []);
      xConv = x;
    } else {
      const conv = convertData(x);
      pat = conv.c;
      xConv = conv.o;
    }

    // if (typeof (y) === 'object') {
    //   patF = Object.entries(y).reduce((o, [x, y]) => {
    //     if (!FORBIDDEN[typeof (y)]) {
    //       o.push(`${x}:${y}`);
    //     }

    //     return o;
    //   }, []);
    // } else if (typeof (y) === 'string') {
    //   const conv = convertData(y);
    //   patF = conv.c;
    //   y = conv.o;
    // } else {
    //   y = xConv;
    // }

    pat = pat.sort();

    const pin = this.#matchPin([], pat);
    if (typeof x === 'string' && pin.f) {
      this.#pinCache[x] = { xConv, pin };
    }

    if (!pin.f) {
      return console.log('no-target', pat);
    }

    meta.pin = meta.pin || x;

    return pin.f({ data: y, msg: xConv }, meta);
  }

  find (x) {
    let pat;
    let xConv;

    if (typeof x === 'string' && this.#convCache[x]) {
      ({ xConv, pat } = this.#convCache[x]);
    } else if (typeof x === 'object') {
      pat = Object.entries(x)
        .reduce((o, [x, y]) => {
          if (!FORBIDDEN[typeof y]) {
            o.push(`${x}:${y}`);
          }

          return o;
        }, [])
        .sort();
      xConv = x;
    } else {
      const conv = convertData(x);
      pat = conv.c;
      xConv = conv.o;
      this.#convCache[x] = { pat, xConv };
    }

    pat = pat.sort();

    const pin = this.#matchPin(pat);

    return pin.f;
  }

  async act (x, y, meta = {}) {
    let pat;
    let xConv;

    if (typeof x === 'string' && this.#convCache[x]) {
      ({ xConv, pat } = this.#convCache[x]);
    } else if (typeof x === 'object') {
      pat = Object.entries(x)
        .reduce((o, [x, y]) => {
          if (!FORBIDDEN[typeof y]) {
            o.push(`${x}:${y}`);
          }

          return o;
        }, [])
        .sort();
      xConv = x;
    } else {
      const conv = convertData(x);
      pat = conv.c;
      xConv = conv.o;
      this.#convCache[x] = { pat, xConv };
    }

    if (typeof y === 'object') {
      pat = [
        ...pat,
        ...Object.entries(y).reduce((o, [x, y]) => {
          if (!FORBIDDEN[typeof y]) {
            o.push(`${x}:${y}`);
          }

          return o;
        }, [])
      ];
    } else if (typeof y === 'string') {
      const conv = convertData(x);
      pat = [...pat, conv.c];
      y = conv.o;
    } else {
      y = xConv;
    }

    pat = pat.sort();

    const pin = this.#matchPin(pat);

    if (!pin.f) {
      return console.log('no-target', pat);
    }

    meta.id = meta.id || uid();

    return pin.f({ pin$: pin, data: Object.assign({}, xConv, y) }, meta);
  }

  // this simply iterates over every object part since they are sorted non
  // matching elements are no big problem they are skipped over.
  // A one to one check is tested first, next a functional map is tested
  // we only support the wildcard (*) function as of now.
  #matchPin (c, h) {
    let before = this.#pinDB;
    let t = c;

    const beforeParts = [];
    if (h) {
      before = this.#hash[h.join(',')] || before;
      t = h;
    }

    let u = 0;
    const ll = { f: 0 };
    for (const o of t) {
      let part;
      const bP = beforeParts.length;

      for (let i = 0; i < bP; ++i) {
        const beforePart = beforeParts[i].part;
        const b = beforePart;
        if (b.n[o]) {
          beforeParts[i].d++;
          beforeParts[i].part = b.n[o];
          if ((part = b.s[o.split(':')[0]])) {
            beforeParts.push({ d: beforeParts[i].d, part });
            if (i + 1 === beforeParts.length) {
              beforeParts.push({ d: 0, part: this.#pinDB });
            }
          }
        } else if ((part = b.s[o.split(':')[0]])) {
          // this equals a * map
          beforeParts[i].d++;
          beforeParts[i].part = part;
        }

        if (beforeParts[i].d > ll.f) {
          ll.f = beforeParts[i].d;
          ll.p = beforeParts[i].part;
        }
      }

      if (bP === 0) {
        beforeParts.push({ d: 0, part: this.#pinDB });
      }

      part = undefined;

      if (before.n[o]) {
        ++u;
        before = before.n[o];
        if ((part = before.s[o.split(':')[0]])) {
          beforeParts.push({ d: u, part });
        }
      } else if ((part = before.s[o.split(':')[0]])) {
        // this equals a * map
        ++u;
        before = part;
      }
    }

    if ((!before.f || ll.f > u) && ll.p?.f) {
      before = ll.p;
    }

    if (!before.f) {
      return { o: 'err' };
    } else {
      return before;
    }
  }

  reduceActive () {
    this.#active--;
  }

  add (c, fu) {
    let f;
    if (process.env.METRICS) {
      f = (d, meta) => {
        if (meta.n === true) {
          ++this.#active;
        }

        meta.start = Number(process.hrtime.bigint() - start);
        return fu.call(this, d.data, meta);
      };
    } else {
      f = (d, meta) => {
        if (meta.n === true) {
          ++this.#active;
        }

        return fu.call(this, d.data, meta);
      };
    }

    Object.entries(fu).forEach(([x, y]) => {
      f[x] = y;
    });

    let before = this.#pinDB;
    const pin = convertPin(c);

    let i = 0;
    for (; i < pin.c.length; ++i) {
      const o = pin.c[i].p;
      if (pin.c[i].c === 1) {
        if (before.n[o]) {
          before = before.n[o];
        } else {
          before.n[o] = { n: {}, s: {} };
          before = before.n[o];
        }
      } else {
        if (before.s[o]) {
          // this equals a * map
          before = before.s[o];
        } else {
          before.s[o] = { s: {}, n: {} };
          before = before.s[o];
        }
      }
    }

    this.#hash[pin.c.join(',')] = before;

    before.f = f;
    before.fl = before.fl || [];
    before.fl.unshift(f);

    return before;
  }

  async close () {
    return this.callInternal('role:mc,cmd:close', {});
  }
}
