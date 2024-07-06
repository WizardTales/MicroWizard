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



const convertPin = (pin) => {
  const r = new RegExp(/([a-zA-Z0-9_-]+)(?:\s+)?:([^,]+)/g)
  let t;
  let final = [];
  let match = [];

  while(t = r.exec(pin)) {
    if(t[2] !== '*') { 
      final.push(t[0])
    } else {
      match.push( t[1] )
    }
  }

  return { c: final.sort(), m: match.sort() }
}

const convertData = (pin) => {
  const r = new RegExp(/([a-zA-Z0-9_-]+)(?:\s+)?:([^,]+)/g)
  let t;
  let final = [];
  let o = {}

  while(t = r.exec(pin)) {
    final.push(t[0]);
    o[t[1]] = t[2]
  }

  return { c: final.sort(), o }
}



const FORBIDDEN = { 'undefined': true, 'object': true, 'function': true, 'symbol': true }

export default class Micro {

  #pinDB = { n: {}, s: {} };
  #hash = {};
  #pinCache = {};
  #convCache = {};

  constructor() {}

  async actE(x, y, opts = {}) {
    if(opts.mixin?.length) {
      for(const m of opts.mixin) {
        x = `${x},${m}:${y[m]}`
      }
    }

    if(y && this.#pinCache[x]) {
const {pin, xConf} = this.#pinCache[x];
      return pin.f({ pin: xConf, ...y});
    }
    let pat;
    let patF;
    let xConv;
    if(typeof(x) === 'object'){
      pat = Object.entries(x).reduce((o, [x,y]) => {

        if(!FORBIDDEN[typeof(y)]) {
          o.push(`${x}:${y}`)
        }

        return o;
      }, []);
      xConv = x;
    } 
    else {  
      let conv = convertData(x)
      pat = conv.c;
      xConv = conv.o;
    };

    if(typeof(y) === 'object'){
      patF = Object.entries(y).reduce((o, [x,y]) => {

        if(!FORBIDDEN[typeof(y)]) {
          o.push(`${x}:${y}`)
        }

        return o;
      }, []);
    } 
    else if(typeof(y) === 'string'){  
      let conv = convertData(y)
      patF = conv.c;
      y = conv.o;
    };

    pat = pat.sort()


    const pin = this.#matchPin([], patF)
    if(typeof(x) === 'string') {
      this.#pinCache[x] = { xConv, pin };
    }

    return pin.f({pin: xConv, ...y});
  }

  async act(x, y) {
    let pat;
    let patF;
    let xConv;

    if(typeof(x) === 'string' && this.#convCache[x]) {
      ({ xConv, pat } =this.#convCache[x]);
    } else if(typeof(x) === 'object') {
      pat = Object.entries(x).reduce((o, [x,y]) => {

        if(!FORBIDDEN[typeof(y)]) {
          o.push(`${x}:${y}`)
        }

        return o;
      }, []).sort();
      xConv = x;
    } 
    else {  
      let conv = convertData(x)
      pat = conv.c;
      xConv = conv.o;
      this.#convCache[x] = {pat, xConv};
    };

    patF = pat;

    if(typeof(y) === 'object'){
      pat = [...pat, ...Object.entries(y).reduce((o, [x,y]) => {

        if(!FORBIDDEN[typeof(y)]) {
          o.push(`${x}:${y}`)
        }

        return o;
      }, [])];
    } 
    else if(typeof(y) === 'string'){  
      let conv = convertData(x)
      pat = [...pat, conv.c];
      y = conv.o;
    };

    pat = pat.sort()

    const pin = this.#matchPin(pat)

    return pin.f({ pin: xConv, y });
  } 

  // this simply iterates over every object part since they are sorted non
  // matching elements are no big problem they are skipped over.
  // A one to one check is tested first, next a functional map is tested
  // we only support the wildcard (*) function as of now.
  #matchPin (c, h)  {
    let before = this.#pinDB;

    if(h && this.#hash[h]) {
      before = this.#hash[h.join(',')];
      for(const o of c) {
        if(before.n[o]) {
          before = before.n[o];
        } else if(before.s[o.split(':')[0]]) {
          // this equals a * map
          before = before.s[o]
        }
      }
    } else {
      for(const o of c) {
        if(before.n[o]) {
          before = before.n[o];
        } else if(before.s[o.split(':')[0]]) {
          // this equals a * map
          before = before.s[o]
        }
      }
    }

    if(!before.f) {
      return { o: 'err' }
    } else {
      return before;
    }
  }

  add (c, f) {
    let before = this.#pinDB;
    let pin = convertPin(c);

    let i = 0;
    for(; i < pin.c.length; ++i) {
      let o = pin.c[i];
      if(before.n[o]) {
        before = before.n[o];
      } else {
        before.n[o] = { n: {}, s: {} }
        before = before.n[o];
      }
    } 

    this.#hash[pin.c.join(',')] = before;

    if(pin.m.length) {
      let i = 0;
      for(; i < pin.m.length; ++i) {
        let o = pin.m[i];
        if(before.s[o]) {
          // this equals a * map
          before = before.s[o]
        } else {
          before.s[o] = { s: {} }
          before = before.s[o];
        }
      }
    }

    before.f = f;

    return before;
  }
}

