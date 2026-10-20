/**
 * Parts of this code are from the original module and under the following
 * copyright.
 *
 * /* MIT License. Copyright (c) 2015-2018, Richard Rodger and other contributors.
 * the rest of the code follows the following copyright
 * /* Copyright (c) 2024 WizardTales GmbH, MIT License
 */

import visigoth from '@wzrdtales/visigoth';
import { uid } from 'uid';
import { pattern } from './index.js';
import Promise from 'bluebird';

export default class BalanceClient {
  targets = {};
  static defaults = {
    debug: {
      client_updates: false
    }
  };

  static errors = {
    'no-target': 'No targets have been registered for message <%=msg%>',
    'no-current-target': 'No targets are currently active for message <%=msg%>'
  };

  constructor (options = {}) {
    options = Object.assign({}, BalanceClient.defaults, options);
    this.options = options;
    this.options.circuitBreaker = this.options.circuitBreaker || {
      closingTimeout: 1000,
      retryTimeout: 100
    };
  }

  makeHandle (config) {
    return (pat, func) => {
      pat = pattern(pat);
      return this.addTarget(config, pat, func);
    };
  }

  removeTarget (pg, pat, config) {
    const actionId = config.id;
    let found = false;
    let targetState = this.targets[pg];

    if (!targetState?.targets) {
      targetState = { targets: {} };
    }
    this.targets[pg] = targetState;

    if (targetState.targets[actionId]) found = true;

    if (found) {
      targetState.visigoth.remove(targetState.targets[actionId].e);
      delete targetState.targets[actionId];
    }

    if (this.options.debug.client_updates) {
      console.log('remove', pat, actionId, found);
    }
  }

  addClient (msg) {
    const clientOptions = msg;
    const pg = ([clientOptions.pin] || clientOptions.pins)
      .map(pattern)
      .join(':::');
    if (!this.targets[pg]) {
      this.targets[pg] = {};
    }

    // consume: one target of all that serve the pin, the next one if it
    // fails. observe: every target, each one retried on its own.
    const model = msg.model === 'observe' ? 'observe' : 'consume';
    const me = this;

    const send = function (msg, meta) {
      const targetstate = me.targets[pg];

      if (model === 'observe') {
        return Promise.fromCallback((reply) =>
          me.observe(this, msg, targetstate, reply, meta)
        );
      }

      if (targetstate.visigoth) {
        return Promise.fromCallback((reply) =>
          me[model](this, msg, targetstate, reply, meta)
        );
      } else return { err: 'no-target', msg };
    };

    return {
      config: msg,
      send
    };
  }

  removeClient (msg) {
    const pins = (
      msg.config.pin
        ? Array.isArray(msg.config.pin)
          ? msg.config.pin
          : Array(msg.config.pin)
        : msg.config.pins
    ).map(pattern);

    const pg = pins.join(':::');
    this.targets[pg] = this.targets[pg] || {};

    pins.forEach((pin) => this.removeTarget(pg, pin, msg.config));
  }

  consume (mc, msg, targetState, done, meta) {
    let trys = 0;
    const me = this;

    function tryCall () {
      targetState.visigoth.choose(function (err, target, errored, stats) {
        if (err) {
          return done({ err: 'no-current-target', msg });
        }

        // if (trys > 0) {
        //   meta.mi += trys;
        //   meta.tx += trys;
        //   meta.id = `${meta.mi}/${meta.tx}`;
        // }

        target.action
          .call(mc, msg, meta)
          .then(function (msg, _meta) {
            // we don't really need this right now, it slows down as
            // new Date() and even hrtime is suprisingly expensive and it is
            // not utilized, our default rating strategy is none at all. We
            // simply go round robin and fail fast. The service itself decides
            // if it wants to accept a request or answer
            // retry_later_err_overload, a service does get circuit breaked at
            // that time and wont be retried too fast. A system that has too
            // sensitive overload metrics, may be adjusted properly and a
            // system that truly is overloaded will start responding with no
            // targets available.
            // If overload metrics are in sync with autoscaling, everything
            // should be usually fine.
            if (process.env.METRICS) {
              stats.responseTime = new Date() - meta.start;
            }
            done(null, msg, _meta);
          })
          .catch((err) => {
            // seneca.log.error('execute_err', err);
            if (
              err.details?.message === 'retry_later_err_overload' ||
              err.message === 'timeout'
            ) {
              // only error on controlled overload errors
              errored();
              if (++trys < 10) {
                return setTimeout(
                  () => tryCall(),
                  me.options.circuitBreaker.retryTimeout
                );
              }

              if ((process.env.TRACES?.indexOf('MW:D') ?? -1) !== -1) {
                console.error(err);
              }

              return done({ err: 'all-targets-overloaded', msg });
            } else {
              return done({ err, msg });
            }
          });
      });
    }

    tryCall();
  }

  /**
   * Deliver to every target of the pin, for messages that every instance of
   * a service has to see (an event, a cache to drop) rather than one of
   * them to answer.
   *
   * Going on to another target, which is what the circuit breaker does for
   * consume, would be wrong here: the other one gets the message anyway.
   * Each target is retried by itself with a growing pause instead, and
   * given up when it has left the mesh or when its retries are spent. Every
   * delivery has an id of its own, since the answers are matched by id.
   *
   * Answers with how many targets got it and how many did not; whatever a
   * target answered is not passed on. Order is not kept: a message that
   * had to be retried can arrive after one sent later.
   */
  observe (mc, msg, targetState, done, meta = {}) {
    const targets = Object.values(targetState?.targets || {});
    const {
      retries = 5,
      backoff = 100,
      maxBackoff = 5000
    } = this.options.observe || {};

    const deliver = async (target) => {
      for (let attempt = 0; ; ++attempt) {
        if (targetState.targets[target.id] !== target) return false;

        try {
          await target.action.call(mc, msg, { ...meta, id: uid() });
          return true;
        } catch (err) {
          if (attempt >= retries) {
            if ((process.env.TRACES?.indexOf('MW:D') ?? -1) !== -1) {
              console.error('observe: gave up on', target.id, err);
            }

            return false;
          }

          await Promise.delay(Math.min(backoff * 2 ** attempt, maxBackoff));
        }
      }
    };

    Promise.all(targets.map(deliver)).then((got) => {
      const delivered = got.filter(Boolean).length;

      done(null, { delivered, failed: got.length - delivered });
    });
  }

  addTarget (config, pat, action) {
    let targetState = this.targets[pat];
    let add = true;

    if (!targetState?.targets) {
      targetState = {
        targets: {},
        visigoth: visigoth(this.options.circuitBreaker)
      };
    }
    this.targets[pat] = targetState;

    const target = targetState.targets[action.id];
    if (target) add = false;

    if (add) {
      const target = {
        action: action,
        id: action.id,
        config: config
      };

      const { e } = targetState.visigoth.add(target);
      target.e = e;
      targetState.targets[action.id] = target;
    }

    if (this.options.debug.client_updates) {
      console.log('add', pat, action.id, add);
    }
  }
}
