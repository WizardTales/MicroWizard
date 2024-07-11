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

Again this was created for us, no hate against seneca, they provided a great
framework, we have used for years and we will speak out our support to them
no matter what!

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

# Why?

We have seneca widely in use, so we needed something compatible as replacement.
Writing modules for one of the other frameworks wouldn't have fit the bill. So
I decided to rewrite it and reuse parts of seneca were it makes sense.

I don't need to justify myself, but if you like to understand the reasoning:

The other frameworks including seneca are either missing features we need, or
just have too much baggage in total. We need something rock solid that can scale
to infinity. If possible it should be fast (seneca got slower and not well
maintained, which is why we turned away from it). Fast means more throughput per
service, which equals in less money spend and lower latencies. Both are very
important to us.

The next thing is flexibility, how complicated it is to add things. In case
of seneca, we consider the code to be actually unmaintainable, adding things
is possible, but it wont live up to our standards, neither quality nor
performance. This way we can add the necessary features. To name the most
important Segmented Service discovery and fault detection by SWIM, load
balancing with different algos + services themself can reject requests and
get selected out temporarily by circuit breaking + tx retry (which is a
loadbalancing strategy by itself). And general resilience against network
errors with refeeding and deduplication.

Further we finally resolved issues we faced in some of our largest systems.
Latency... . Due to time complexity in load balancing algorithms. Almost all non
round robin algorithms tend to be quite costly. We usually have around 1-2k
targets that go in a single load balancing algorithm. So this becomes quite
heavy on high throughput and latency sensitive systems. We solve this with a
(https://github.com/wzrdtales/visigoth-1/blob/fixup/balanceLinkedRing.js#L53)[linked list].
This optimizes most of the things which tend to be issues when dealing with
certain load balancing algorithms. The algorithm itself is round robin again,
but with a few twists. If we want to add a weight to a certain machine, we assign
an execution counter. The algorithm will then select the same target until the counter
goes back to zero. If we encounter an overloaded or failing target, we circuit break
the target and skip to the next (also ignoring any weights). So it is ultimately our services
which tell requestors that they are over their threshold load, and not a central algorithm
monitoring it. And last but not least the linked list allows very cheap adjustments
of items. Either removing them, adding a new item, or updating their score.
Removing has a time complexity of O(1), adding and moving an item O(log n). We could
further optimize this with stored bins, but for our usecase this is more than enough,
at least at the time of writing we have rather very short searches.

# Developing and Debug (repl)

MicroWizard is mostly compatible with seneca, but there are a lot of differences.
So you can't expect any plugins to just work. The most important plugin is the
repl plugin. This can be made to work with `@seneca/repl@5.1.0` and the following code

```javascript
'use strict';

const repl = require('@seneca/repl');
const jsonic = require('@jsonic/jsonic-next');
const Promise = require('bluebird');
const config = require('./config.js'); // optional
const dns = require('dns');
const os = require('os');

function dnsSeed(seneca, options, bases, next) {
  dns.lookup(
    config.baseName,
    {
      all: true,
      family: 4
    },
    (err, addresses) => {
      let bases = [];

      if (err) {
        throw new Error('dns lookup for base node failed');
      }

      if (Array.isArray(addresses)) {
        bases = addresses.map((address) => {
          return address.address;
        });
      } else {
        bases.push(addresses);
      }

      next(bases);
    }
  );
}

(async () => {
  const { default: MicroWizard } = await import('microwizard');
  const seneca = new MicroWizard();

  const initialSenecaConfig = {
    auto: true,
    discover: {
      custom: {
        active: true,
        find: dnsSeed
      }
    }
  };

  const senecaConfig = {
    ...config.seneca,
    ...initialSenecaConfig
  };

  if (senecaConfig.bases && senecaConfig.bases.indexOf(',')) {
    senecaConfig.bases = senecaConfig.bases.split(',');
  }

  seneca.use('mesh-ng', senecaConfig);
  // we need to add this interface, it does absolutely nothing but makes
  // the call repl expects work
  seneca.init = (cb) => cb(() => {});
  // we patch the original jsonic in, to have the full jsonic parser available
  // in repl
  seneca.util.Jsonic = jsonic;
  // the monkey patch for act since the plugin expects of course the callback
  // interface
  const act = seneca.act;
  seneca.act = function (x, y, cb) {
    if (typeof y === 'function') {
      cb = y;
      y = undefined;
    }

    if (typeof cb === 'function') {
      act
        .call(seneca, x, y)
        .catch(cb)
        .then((x) => cb(null, x));
    } else {
      act.call(seneca, x, y).catch(console.error);
    }
  };
  // and finally instead of calling seneca.use, we make the plugin work by
  // defining its context and just calling it
  repl.call(seneca, { ...repl.defaults, ...config.repl });
  // seneca.use('@seneca/repl', config.repl);
})();
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
