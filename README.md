# MicroWizard

A mostly seneca compatible, fast and stable microservice framework.

Seneca started degrading in performance and maintenance tended to be weak.
We first tried maintaining it, but the code is mostly overcomplicated and
hard to maintain.

This framework is being written for ourselves, first of all to replace
seneca and second make it faster than it currently is and last but not
least, make it stable. There were certain issues we faced and some missing
parts which we partially added, like a circuit breaker. However this has
again neither been really maintainable, nor stable.

This codebase will be quite straightforward, plugins will be mostly skipped
and we focus on the important part. Essential parts will be:

- discovery, via SWIM
- tcp transport (or quic if it ever gets released into node)
- alternative transports (the only plugin function we will provide for now)
- a faster pattern matching compatible algorithm
- a secondary `actE` function, which is more explicit in its behavior
- fast method lookups
- fast duplicate call lookups
- load balancing
- circuit breaking
- native promises for act

We used `actAsync` everywhere a promisified `act`, if you used `act` in your
project, this will break. You can monkey patch the act method of course very
easily like

```js
const mc = new MicroWizard();
const act = mc.act;
mc.act = function (x, y, cb) {
  if (typeof y === 'function') {
    cb = y;
    y = undefined;
  }

  if (typeof cb === 'function') {
    act(x, y)
      .catch(cb)
      .then((x) => cb(null, x));
  } else {
    act(x, y).catch(console.error);
  }
};
```

# Benchmarks

While this is not the most important part for us (of course this actually
saves us quite some money), here are some benchmarks.

Already finished are the mostly compatible interfaces. Currently not yet
communicating over the wire, this will be obviously significantly slower.

However here the in process performance comparison of different acts.

```

✔ Moleculer* 2.096.783 rps
✔ Seneca* 25.743 rps
✔ MicroWizard* 529.986 rps
✔ MicroWizard2* 2.044.895 rps
✔ MicroWizard2Str* 3.422.563 rps
✔ MicroWizard2StrNoMix* 4.967.360 rps
✔ MicroWizardStr\* 675.521 rps

Moleculer* -57,79% (2.096.783 rps) (avg: 476ns)
Seneca* -99,48% (25.743 rps) (avg: 38μs)
MicroWizard* -89,33% (529.986 rps) (avg: 1μs)
MicroWizard2* -58,83% (2.044.895 rps) (avg: 489ns)
MicroWizard2Str* -31,1% (3.422.563 rps) (avg: 292ns)
MicroWizard2StrNoMix* 0% (4.967.360 rps) (avg: 201ns)
MicroWizardStr\* -86,4% (675.521 rps) (avg: 1μs)

---

```

Communicating over TCP

```
-----------------------------------------------------------------------
Suite: Call remote actions
✔ Moleculer*                 26.016 rps
✔ Cote*                      34.258 rps
✔ Seneca*                     5.610 rps
✔ MicroWizard1*              26.248 rps
✔ MicroWizard2*              26.844 rps
✔ MicroWizardActE*           30.667 rps

   Moleculer*            -24,06%         (26.016 rps)   (avg: 38μs)
   Cote*                      0%         (34.258 rps)   (avg: 29μs)
   Seneca*               -83,62%          (5.610 rps)   (avg: 178μs)
   MicroWizard1*         -23,38%         (26.248 rps)   (avg: 38μs)
   MicroWizard2*         -21,64%         (26.844 rps)   (avg: 37μs)
   MicroWizardActE*      -10,48%         (30.667 rps)   (avg: 32μs)
-----------------------------------------------------------------------
```

We will link the benchmark repo soon here.
