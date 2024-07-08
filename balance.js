import visigoth from '@wzrdtales/visigoth';
import { uid } from 'uid';

export default class BalanceClient {
  instance = {};
  static defaults = {
    debug: {
      client_updates: false
    }
  };

  static errors = {
    'no-target': 'No targets have been registered for message <%=msg%>',
    'no-current-target': 'No targets are currently active for message <%=msg%>'
  };

  constructor (options) {
    options = Object.assign({}, ...this.defaults, options);
    this.options = options;
    this.options.circuitBreaker = this.options.circuitBreaker || {
      closingTimeout: 1000,
      retryTimeout: 100
    };
  }

  makeHandle (config) {
    return (pat, func) => {
      this.addTarget(config, pat, func);
    };
  }

  removeTarget (targetMap, pg, pat, config) {
    const actionId = config.id;
    let found = false;
    let targetState = targetMap[pg];

    targetState = targetState || { targets: {} };
    targetMap = targetState[pg];

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
    const pg = ([clientOptions.pin] || clientOptions.pins).join(':::');
    if (!this.targets[pg]) {
      this.targets[pg] = {};
    }

    const model = 'consume';
    const me = this;

    const send = function (msg, reply, meta) {
      const targetstate = this.targets[pg];

      if (targetstate) {
        me[model](this, msg, targetstate, reply, meta);
      } else return reply(new Error('no-target', { msg: msg }));
    };

    return {
      config: msg,
      send
    };
  }

  removeClient (msg) {
    const clientOptions = msg;
    const pg = ([clientOptions.pin] || clientOptions.pins).join(':::');

    this.targets[pg] = this.targets[pg] || {};

    const pins = msg.config.pin ? [msg.config.pin] : msg.config.pins;
    pins.forEach((pin) => this.removeTarget(this.targets, pg, pin, msg));
  }

  consume (mc, msg, targetState, done, meta) {
    let trys = 0;

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

        try {
          target.action.call(mc, msg, meta).then(function () {
            stats.responseTime = new Date() - meta.start;
            done.apply(done, arguments);
          });
        } catch (err) {
          // seneca.log.error('execute_err', err);
          if (err.details.message === 'retry_later_err_overload') {
            // only error on controlled overload errors
            errored();
            if (++trys < 3) {
              return setTimeout(
                () => tryCall(),
                this.options.circuitBreaker.retryTimeout
              );
            }

            return done({ err: 'all-targets-overloaded', msg });
          }
        }
      });
    }

    tryCall();
  }

  addTarget (config, pat, action) {
    let targetState = this.targets[pat];
    let add = true;

    targetState = targetState || {
      targets: {},
      visigoth: visigoth(this.options.circuitBreaker)
    };
    this.targets[pat] = targetState;

    const target = targetState.targets[action.id];
    if (target) add = false;

    if (add) {
      const target = {
        action: action,
        id: action.id,
        config: config
      };

      const e = targetState.visigoth.add(target);
      target.e = e;
      targetState.targets[action.id] = target;
    }

    if (this.this.options.debug.client_updates) {
      console.log('add', pat, action.id, add);
    }
  }
}
