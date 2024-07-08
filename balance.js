import visigoth from '@wzrdtales/visigoth';
import { uid } from 'uid';

class BalanceClient {
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
    this.options = options;
    this.options.circuitBreaker = this.options.circuitBreaker || {
      closingTimeout: 1000,
      retryTimeout: 100
    };
  }

  removeTarget (targetMap, pat, config) {
    const actionId = config.id;
    let found = false;
    let targetState = targetMap[pat];

    targetState = targetState || { targets: {} };
    targetMap = targetState[pat];

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
    this.targets[pg] = this.targets[pg] || {};

    this.addTarget(this.targets, {}, pg, { id: clientOptions.id });

    const model = 'consume';

    const send = function (msg, reply, meta) {
      const targetstate = this.targets[pg];

      if (targetstate) {
        this[model](msg, targetstate, reply, meta);
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

    this.removeTarget(this.targets, pg, msg);
  }

  consume (msg, targetState, done, meta) {
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
          target.action.call(msg, meta).then(function () {
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

  addTarget (targetMap, config, pat, action) {
    let targetState = targetMap[pat];
    let add = true;

    targetState = targetState || {
      targets: {},
      visigoth: visigoth(this.options.circuitBreaker)
    };
    targetMap[pat] = targetState;

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
