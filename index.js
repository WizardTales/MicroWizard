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

export const transport = tp;

const convertPin = (pin) => {
  const r = /([a-zA-Z0-9_-]+)(?:\s+)?:([^,]+)/g;
  let t;
  let final = [];

  if (typeof (pin) === 'object') {
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

  return { c: final.sort((a, b) => a.p < b.p ? -1 : a.p < b.p ? 1 : 0) };
};

const convertData = (pin) => {
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

const FORBIDDEN = { undefined: true, object: true, function: true, symbol: true };

export default class Micro {
  #pinDB = { n: {}, s: {} };
  #hash = {};
  #pinCache = {};
  #convCache = {};

  // constructor () {}

  async actE (x, y, opts = {}) {
    if (opts.mixin?.length) {
      for (const m of opts.mixin) {
        x = `${x},${m}:${y[m]}`;
      }
    }

    if (y && this.#pinCache[x]) {
      const { pin, xConf } = this.#pinCache[x];
      return pin.f({ pin: xConf, data: y });
    }
    let pat;
    let patF;
    let xConv;
    if (typeof (x) === 'object') {
      pat = Object.entries(x).reduce((o, [x, y]) => {
        if (!FORBIDDEN[typeof (y)]) {
          o.push(`${x}:${y}`);
        }

        return o;
      }, []);
      xConv = x;
    } else {
      const conv = convertData(x);
      pat = conv.c;
      xConv = conv.o;
    };

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
    if (typeof (x) === 'string' && pin.f) {
      this.#pinCache[x] = { xConv, pin };
    }

    return pin.f({ pin: xConv, data: y });
  }

  async act (x, y) {
    let pat;
    let xConv;

    if (typeof (x) === 'string' && this.#convCache[x]) {
      ({ xConv, pat } = this.#convCache[x]);
    } else if (typeof (x) === 'object') {
      pat = Object.entries(x).reduce((o, [x, y]) => {
        if (!FORBIDDEN[typeof (y)]) {
          o.push(`${x}:${y}`);
        }

        return o;
      }, []).sort();
      xConv = x;
    } else {
      const conv = convertData(x);
      pat = conv.c;
      xConv = conv.o;
      this.#convCache[x] = { pat, xConv };
    };

    if (typeof (y) === 'object') {
      pat = [...pat, ...Object.entries(y).reduce((o, [x, y]) => {
        if (!FORBIDDEN[typeof (y)]) {
          o.push(`${x}:${y}`);
        }

        return o;
      }, [])];
    } else if (typeof (y) === 'string') {
      const conv = convertData(x);
      pat = [...pat, conv.c];
      y = conv.o;
    } else {
      y = xConv;
    }

    pat = pat.sort();

    const pin = this.#matchPin(pat);

    return pin.f({ data: Object.assign({}, xConv, y) });
  }

  // this simply iterates over every object part since they are sorted non
  // matching elements are no big problem they are skipped over.
  // A one to one check is tested first, next a functional map is tested
  // we only support the wildcard (*) function as of now.
  #matchPin (c, h) {
    let before = this.#pinDB;

    if (h) {
      before = this.#hash[h.join(',')] || before;
      for (const o of h) {
        if (before.n[o]) {
          before = before.n[o];
        } else if (before.s[o.split(':')[0]]) {
          // this equals a * map
          before = before.s[o];
        }
      }
    } else {
      for (const o of c) {
        let part;
        if (before.n[o]) {
          before = before.n[o];
        } else if ((part = before.s[o.split(':')[0]])) {
          // this equals a * map
          before = part;
        }
      }
    }

    if (!before.f) {
      return { o: 'err' };
    } else {
      return before;
    }
  }

  add (c, fu) {
    const f = (d) => {
      return fu(d.data);
    };
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

    return before;
  }
}
