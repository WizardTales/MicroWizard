/*
  MIT License,
  Copyright (c) 2015-2017, Richard Rodger and other contributors.
  Copyright (c) 2024 WizardTales GmbH
  Copyright (c) 2024 Tobias Gurtzick
*/

'use strict';

import _ from 'lodash';
import Sneeze from 'sneeze-ng';
import { uid } from 'uid';
import Rif from 'rif';
import Discover from 'node-discover';
import Ip from 'ip';
import Optioner from 'optioner';
import Promise from 'bluebird';
import { pattern, utilClean } from './index.js';

const Joi = Optioner.Joi;

export default mesh;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 39999;

export const intern = makeIntern();

function utilPattern (patobj) {
  if (typeof patobj === 'string') {
    return patobj;
  }

  patobj = patobj || {};
  const sb = [];

  Object.keys(patobj).forEach((k) => {
    const v = patobj[k];
    if (!~k.indexOf('$') && typeof v !== 'function' && typeof v !== 'object') {
      sb.push(k + ':' + v);
    }
  });

  sb.sort();

  return sb.join(',');
}

const optioner = Optioner({
  pin: Joi.alternatives().try(Joi.string(), Joi.object()),
  pins: Joi.array(),
  host: Joi.string(),
  port: Joi.number().integer().min(0).max(65535),
  isbase: false,

  model: 'consume',
  listen: Joi.array(),

  auto: true,
  makeEntry: intern.defaultMakeEntry,

  jointime: 111, // join and wait for network details

  discover: {
    defined: {
      active: true
    },

    guess: {
      active: true
    },

    multicast: {
      active: true,
      address: null,
      // max_search: 22,
      max_search: 2,
      search_interval: 111
    },

    custom: {
      active: true,
      find: function (mc, options, bases, next) {
        next([], false);
      }
    },

    // stop discovery if defined bases are provided
    stop: true,

    // when all base nodes are lost, try to recover
    rediscover: false
  },

  monitor: false,
  sneeze: null
});

function mesh (options, mc) {
  optioner(options, function (err, options) {
    if (err) throw err;

    let closed = false;

    let bases = [];
    let sneeze;

    mc.add('role:mesh,get:bases', function getBases (msg) {
      return { bases: [].concat(bases) };
    });

    const balanceMap = {};
    const mid = uid();

    // fixed network interface specification, as per format of
    // require('os').networkInterfaces. Merged with and overrides same.
    const rif = Rif(options.netif);

    // options.base is deprecated
    const isbase = !!(options.isbase || options.base);
    options.isbase = isbase;

    let pin = options.pin || options.pins;

    if (isbase) {
      pin = pin || 'role:mesh,base:true';
    }

    options.host = intern.resolveInterface(options.host, rif);
    const tag = options.tag;

    const listen = options.listen || [
      { pin: pin, model: options.model || 'consume' }
    ];

    const balanceClientOpts = options.balanceClient || {};
    // mc.use('balance-client-ng$mesh~' + mid, balanceClientOpts);

    mc.register('init:mesh', init);

    function init (msg) {
      return Promise.fromCallback((initDone) => {
        intern.findBases(mc, options, rif, function (foundBases) {
          bases = foundBases;

          // seneca.log.debug({
          //   kind: 'mesh',
          //   host: options.host,
          //   port: options.port,
          //   bases: bases,
          //   options: options
          // });

          const sneezeOpts = options.sneeze || {};

          sneezeOpts.preferCurrentMeta = true;
          sneezeOpts.bases = bases;
          sneezeOpts.isbase = isbase;
          sneezeOpts.port = options.port || undefined;
          sneezeOpts.host = options.host || undefined;
          sneezeOpts.identifier = mc.id;

          sneezeOpts.monitor = sneezeOpts.monitor || {
            active: !!options.monitor
          };

          sneezeOpts.tag =
            undefined !== sneezeOpts.tag
              ? sneezeOpts.tag
              : undefined !== tag
                ? tag === null
                  ? null
                  : 'mc~' + tag
                : 'mc~mesh';

          mc.register(
            'role:transport,cmd:listen',
            intern.makeTransportListen(options, join, listen, initDone)
          );

          // call seneca.listen as a convenience
          // subsequent seneca.listen calls will still publish to network
          if (options.auto) {
            _.each(listen, function (listenOpts) {
              if (options.host && listenOpts.host == null) {
                listenOpts.host = options.host;
              }

              if ((listenOpts.host && listenOpts.host[0]) === '@') {
                listenOpts.host = rif(listenOpts.host.substring(1));
              }

              listenOpts.port =
                listenOpts.port != null
                  ? listenOpts.port
                  : function () {
                    return 50000 + Math.floor(10000 * Math.random());
                  };

              listenOpts.model = listenOpts.model || 'consume';

              listenOpts.ismesh = true;

              mc.listen(listenOpts);
            });
          }

          function join (instance, rawConfig, done) {
            const clientInstance = instance;
            const config = utilClean(rawConfig || {}, { proto: false });
            let aliveBases = 0;
            const baseName = {};

            if (!config.pin && !config.pins) {
              config.pin = 'null:true';
            }

            config.pin = intern.resolve_pins(instance, config);
            delete config.pins;

            const instanceSneezeOpts = _.clone(sneezeOpts);
            instanceSneezeOpts.identifier =
              sneezeOpts.identifier + '~' + config.pin + '~' + Date.now();

            sneeze = Sneeze(instanceSneezeOpts);

            const meta = {
              config: utilClean(config),
              instance: instance.id
            };
            const instanceMeta = meta;

            sneeze.on('error', function (err) {
              // seneca.log.warn(err);
              if (err) {
                console.log(err);
              }
            });
            sneeze.on('add', addClient);
            sneeze.on('remove', removeClient);
            sneeze.on('ready', done);

            mc.register('role:mc,cmd:close', function (msg, meta) {
              closed = true;
              if (sneeze) {
                sneeze.leave();
              }
              return this.rPrior(msg, meta);
            });

            mc.add('role:mesh,get:members', async function getMembers (msg) {
              const members = [];

              _.each(sneeze.members(), function (member) {
                const m = options.makeEntry(member);
                members.push(
                  undefined === m ? intern.defaultMakeEntry(member) : m
                );
              });

              const out = await this.prior(msg, meta).catch((err) => {
                throw err;
              });
              const list = (out && out.list) || [];
              const outlist = list.concat(members);

              return { list: outlist };
            });

            sneeze.join(meta);

            function addClient (meta) {
              if (closed) return;
              if (
                meta.config.pin[0] === 'base:true,role:mesh' &&
                !baseName[meta.instance]
              ) {
                ++aliveBases;
                baseName[meta.instance] = true;
              }
              // ignore myself
              if (clientInstance.id === meta.instance) {
                return;
              }

              const config = meta.config || {};
              const pins = intern.resolve_pins(clientInstance, config);

              _.each(pins, async function (pin) {
                const pinConfig = intern.makePinConfig(
                  clientInstance,
                  meta,
                  pin,
                  config
                );

                if (pinConfig.pin === 'null:true') {
                  return;
                }

                const hasBalanceClient = !!balanceMap[pinConfig.pin];
                const targetMap = (balanceMap[pinConfig.pin] =
                  balanceMap[pinConfig.pin] || {});

                // this is a duplicate, so ignore
                if (targetMap[pinConfig.id]) {
                  return;
                }

                // TODO: how to handle local override?
                // const actmeta = clientInstance.find(pin?.[0] ?? pin);
                // const ignoreClient = !!(actmeta && !actmeta.client);
                const ignoreClient = !!listen.find(
                  (x) => utilPattern(x.pin) === utilPattern(pinConfig.pin)
                );

                if (ignoreClient) {
                  return;
                }

                targetMap[pinConfig.id] = true;

                if (!hasBalanceClient) {
                  // no balancer for this pin, so add one
                  await clientInstance.client({
                    type: 'balance',
                    pin: pinConfig.pin,
                    model: config.model
                  });
                }

                clientInstance.client({
                  ...pinConfig
                });
              });
            }

            function removeClient (meta, cleaningUp) {
              let baseLeft = false;
              if (closed) return;
              if (pattern(meta.config.pin[0]) === 'base:true,role:mesh') {
                baseLeft = true;
                --aliveBases;
                if (baseName[meta.instance]) {
                  delete baseName[meta.instance];
                }
              }

              // ignore myself
              if (clientInstance.id === meta.instance) {
                return;
              }

              const config = meta.config || {};
              const pins = intern.resolve_pins(clientInstance, config);

              _.each(pins, function (pin) {
                const pinConfig = intern.makePinConfig(
                  clientInstance,
                  meta,
                  pin,
                  config
                );

                if (pinConfig.pin === 'null:true') {
                  return;
                }

                const targetMap = balanceMap[pinConfig.pin];

                if (targetMap) {
                  delete targetMap[pinConfig.id];
                }

                clientInstance.removeClient({
                  config: pinConfig,
                  meta: meta
                });
              });

              if (
                options.discover.rediscover &&
                baseLeft === true &&
                aliveBases < 2 &&
                cleaningUp !== true
              ) {
                const members = sneeze.members();
                const rejoin = function rejoin () {
                  intern.findBases(mc, options, rif, function (foundBases) {
                    if (foundBases.length === 0) {
                      return setTimeout(rejoin, 1111);
                    }
                    bases = foundBases;

                    // seneca.log.debug({
                    //   kind: 'mesh',
                    //   host: options.host,
                    //   port: options.port,
                    //   bases: bases,
                    //   options: options
                    // });

                    sneezeOpts.bases = bases;

                    // retry on error
                    if (isbase) {
                      sneeze.once('retry', function () {
                        // sneeze.leave();
                        setTimeout(rejoin, 1111);
                      });
                    } else {
                      sneeze.once('error', function () {
                        // sneeze.leave();
                        setTimeout(rejoin, 1111);
                      });
                    }
                    sneeze._swim.join(bases, (err) => {
                      if (err) {
                        console.log({ msg: 'rejoin failed, try again' });
                        setTimeout(rejoin, 1111);
                      }
                    });
                  });
                };

                // Object.keys(members).forEach(function(member) {
                //   removeClient(members[member].meta, true);
                // });
                // sneeze.leave();
                setTimeout(rejoin, 1111);
              }
            }
          }
        });
      });
    }
  });
}

function makeIntern () {
  return {
    makeTransportListen: function (options, join, listen, initDone) {
      let listenCount = 0;
      let lastMeshListenErr = null;

      return async function (msg, meta) {
        const mc = this;
        const ismesh = msg.config && msg.config.ismesh;

        // count of the mesh auto listens
        listenCount += ismesh ? 1 : 0;

        const out = await mc.rPrior(msg, meta).catch((err) => {
          lastMeshListenErr = ismesh ? err : lastMeshListenErr;
          throw err;
        });

        if (ismesh) {
          return Promise.fromCallback((done) => {
            join(mc, out, function () {
              done();

              // only finish mesh plugin init if all auto listens attempted
              if (listen.length === listenCount) {
                setTimeout(function () {
                  initDone(lastMeshListenErr);
                }, options.jointime);
              }
            });
          });
        } else {
          return {};
        }
      };
    },

    resolveInterface: function (spec, rif) {
      let out = spec;

      spec = spec == null ? '' : spec;

      if (spec[0] === '@') {
        if (spec.length === 1) {
          out = '0.0.0.0';
        } else {
          out = rif(spec.substring(1));
        }
      }

      return out;
    },

    findBases: function (mc, options, rif, done) {
      let bases = [];

      intern.addbase_funcmap.custom = function (mc, options, bases, next) {
        options.discover.custom.find(mc, options, bases, function (add, stop) {
          add = add || [];
          next(add, stop == null ? add.length > 0 : !!stop);
        });
      };

      // order is significant
      const addbases = ['defined', 'custom', 'multicast', 'guess'];

      let abI = -1;
      let addbase;

      next();

      function next (add, stop) {
        bases = bases.concat(add || []);
        if (stop && options.discover.stop) abI = addbases.length;

        do {
          ++abI;
        } while (
          abI < addbases.length &&
          !options.discover[addbases[abI]].active
        );

        addbase = addbases[abI];

        if (addbase == null) {
          bases = intern.resolve_bases(bases, options, rif);

          return done(bases);
        }

        intern.addbase_funcmap[addbase](mc, options, bases, next);
      }
    },

    addbase_funcmap: {
      defined: function (mc, options, bases, next) {
        let add =
          (options.sneeze || {}).bases ||
          options.bases ||
          options.remotes ||
          [];

        add = add.filter(function (base) {
          return base && base.length > 0;
        });

        next(add, add.length > 0);
      },

      // order significant! depends on defined as uses bases.length
      guess: function (mc, options, bases, next) {
        const add = [];
        const host = options.host;

        if (bases.length === 0) {
          if (host != null && host !== DEFAULT_HOST) {
            add.push(host + ':' + DEFAULT_PORT);
          }
          add.push(DEFAULT_HOST + ':' + DEFAULT_PORT);
        }

        next(add);
      },

      multicast: function (mc, options, bases, next) {
        const add = [];
        const opts = options.discover.multicast;

        // Determine broadcast address using subnetmask
        if (_.isString(opts.address) && opts.address[0] === '/') {
          const netprefix = parseInt(opts.address.substring(1), 10);
          opts.address = Ip.subnet(
            options.host,
            Ip.fromPrefixLen(netprefix)
          ).broadcastAddress;
        }

        const d = Discover({
          broadcast: opts.address,
          advertisement: {
            mcMesh: true,
            isbase: options.isbase,
            host: options.host || DEFAULT_HOST,
            port: options.port || DEFAULT_PORT
          }
        });

        let findCount = 0;
        const fi = setInterval(function () {
          let count = 0;
          d.eachNode(function (node) {
            const nd = node.advertisement;
            if (nd.mcMesh) {
              add.push(nd.host + ':' + nd.port);
              count++;
            }
          });

          if (count > 0 || opts.max_search < findCount) {
            // only bases should keep broadcasting
            if (!options.isbase) {
              d.stop();
            }

            clearInterval(fi);

            next(add, add.length > 0);
          }

          findCount++;
        }, opts.search_interval);
      }
    },

    defaultMakeEntry: function (member) {
      let entry = member;

      const meta = member.meta;

      if (meta.tag$ && meta.tag$.match(/^mc~/)) {
        entry = {
          pin: meta.config.pin,
          port: meta.config.port,
          host: meta.config.host,
          type: meta.config.type,
          model: meta.config.model,
          instance: meta.instance
        };
      }

      return entry;
    },

    resolve_bases: function (origBases, options, rif) {
      options = options || {};

      const host = options.host;

      // remove empties
      let bases = (origBases || []).filter(function (base) {
        return base && base.length > 0;
      });

      const append = [];

      // first pass: defaults and interfacesx
      bases = bases.map(function (base) {
        // host:port -> host:port
        // :port -> DEFAULT_HOST:port, host:port
        // host -> host:DEFAULT_PORT
        let parts = base.match(/^(.+):(\d+)$/);
        if (parts) {
          parts = parts.slice(1, 3);
        } else {
          if (base[0] === ':') {
            parts = [DEFAULT_HOST, base.substring(1)];
            if (host) {
              append.push(host + ':' + parts[1]);
            }
          } else {
            parts = [base, DEFAULT_PORT];
          }
        }

        if ((parts[0] && parts[0][0]) === '@') {
          parts[0] = rif(parts[0].substring(1));
        }

        return parts.join(':');
      });

      bases = bases.concat(append);

      // TODO second pass: ranges
      // host:10-12 -> host:10, host:11, host:12
      // a.b.c.10-12:port -> a.b.c.10:port, a.b.c.11:port, a.b.c.12:port

      return bases;
    },

    resolve_pins: function (instance, config) {
      const pins = config.pins || [config.pin] || [];

      return pins;
    },

    makePinConfig: function (instance, meta, canonicalPin, config) {
      const pinConfig = _.clone(config);
      delete pinConfig.pins;
      delete pinConfig.pin;

      pinConfig.pin = canonicalPin?.[0] ?? canonicalPin;
      pinConfig.id = utilPattern(pinConfig) + '~' + meta.identifier$;

      return pinConfig;
    }
  };
}
