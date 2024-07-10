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

    const model = 'consume';
    const me = this;

    const send = function (msg, meta) {
      const targetstate = me.targets[pg];

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
            stats.responseTime = new Date() - meta.start;
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
              if (++trys < 3) {
                return setTimeout(
                  () => tryCall(),
                  me.options.circuitBreaker.retryTimeout
                );
              }

              return done({ err: 'all-targets-overloaded', msg });
            }
          });
      });
    }

    tryCall();
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
