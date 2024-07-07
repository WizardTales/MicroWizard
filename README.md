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

This is the test system:

```
Platform info:
==============
   Linux 6.9.7-arch1-1 x64
   Node.JS: 18.14.2
   V8: 10.2.154.26-node.22
   11th Gen Intel(R) Core(TM) i7-11800H @ 2.30GHz × 16
```

Here the in process performance comparison of different acts.

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

Communicating over TCP, first an interpolated benchmark. The library
used does not actually take care of concurrency. So we added it manually.

Seneca and Cote dropped their performance drastically down to a few rps (23)
as soon as the concurrency raised over 2. Moleculer and our framework could
sustain more than 10 in concurrency.

We were able to max out both Moleculer and our framework. However these are not
final numbers. The way we created concurrency is by executing always a batch at
the specified concurrency level. If we would have respawned a finished request
immediately and upheld the concurrency, we could probably get even higher
numbers on both of the top performers.

The methodology of this table is, that we multiplied the test result with the
applied conccurency. We skip Cote in this table, since it failed already on
a concurrency level of 2. So we show you now two tables for concurrency.

```
Concurrency level: 2

✔ Moleculer*                 26.568 rps
✔ Seneca*                     5.972 rps
✔ MicroWizardActE*           32.754 rps

   Moleculer*            -18,88%         (26.568 rps)   (avg: 37μs)
   Seneca*               -81,77%          ( 5.972 rps)   (avg: 167μs)
   MicroWizardActE*           0%         (32.754 rps)   (avg: 30μs)

```

Here the high concurrency one.

```
Concurrency level: 1000

✔ Moleculer*                     71.000 rps
✔ MicroWizardActE*              105.000 rps

   Moleculer*            -32,72%             (71.000 rps)   (avg: 6µs)
   MicroWizardActE*           0%            (105.000 rps)   (avg: 9µs)

```

And to be complete, the last table. Running the test without setup concurrency.

```
Concurrency level: 1
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
