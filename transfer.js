/**
 * Parts of this code are from the original module and under the following
 * copyright.
 *
 * /* Copyright (c) 2015-2017 Richard Rodger, MIT License
 * the rest of the code follows the following copyright
 * /* Copyright (c) 2024 WizardTales GmbH, MIT License
 */

import { LRUCache } from 'lru-cache';
import * as Tcp from './tcp.js';
import { uid } from 'uid';
import Promise from 'bluebird';

const METHODS = { a: 'act', aE: 'actE' };

class TP {
  #context;
  constructor (context, mc) {
    this.#context = context;
    this.mc = mc;
  }

  async handleRequest (data, listenOptions) {
    if (!['a', 'aE'].includes(data.k)) {
      return { input: data, error: 'unknown method' };
    }

    const out = {
      id: data.id,
      k: 'res',
      sync: data.sync
    };

    try {
      const response = await this.mc[METHODS[data.k]](
        data.p || data.args,
        data.d
      );
      out.res = response;
    } catch (err) {
      const errobj = Object.assign({}, err);
      errobj.message = err.message;
      errobj.name = err.name || 'Error';

      out.error = errobj;
    }

    return out;
  }

  handleResponse (data, clientOptions) {
    data.sync = undefined === data.sync ? true : data.sync;

    if (data.k !== 'res') {
      if (this._context.options.warn.invalid_kind) {
        console.log('client', 'invalid_kind_res', clientOptions, data);
      }
      return false;
    }

    if (data.id === null) {
      if (this._context.options.warn.no_message_id) {
        console.log('client', 'no_message_id', clientOptions, data);
      }
      return false;
    }

    let result = null;
    const err = null;
    if (!data.error) {
      result = data.res;
    }

    if (!data.sync) {
      return true;
    }

    const callmeta = this.#context.callmap.get(data.id);

    if (callmeta) {
      setTimeout(() => {
        this.#context.callmap.delete(data.id);
      }, 100);
    } else {
      // this can result when there was a slow request still answering after
      // timeout
      if (this.#context.options.warn.unknown_message_id) {
        console.log('client', 'unknown_message_id', clientOptions, data);
      }
      return false;
    }

    const actinfo = {
      id: data.id
    };

    this.callmeta({
      callmeta: callmeta,
      err: err,
      result: result,
      actinfo: actinfo,
      clientOptions: clientOptions,
      data: data
    });

    return true;
  }

  callmeta (options) {
    try {
      options.callmeta.done(options.err, options.result, options.actinfo);
    } catch (e) {
      console.error(
        'client',
        'callback_error',
        options.clientOptions,
        options.data,
        e.stack || e
      );
    }
  }

  prepareRequest (args, done, meta) {
    const meta$ = meta || {};

    meta$.sync = undefined === meta$.sync ? true : meta$.sync;

    const callmeta = {
      args: args,
      done,
      when: Date.now()
    };

    if (meta$.sync) {
      this.#context.callmap.set(meta$.id, callmeta);
    }

    const output = {
      id: meta$.id,
      k: meta$.k || 'a',
      sync: meta$.sync
    };

    if (output.k === 'aE') {
      output.p = meta$.p;
      output.d = args;
    } else {
      output.args = args;
    }

    return output;
  }

  makeClient (makeSend, clientOptions, cb) {
    makeSend({}, null, function (err, send) {
      if (err) {
        return cb(err);
      }

      const client = {
        id: clientOptions.id || uid(),
        toString: function () {
          return `any-${this.id}`;
        },

        send: async function (args, meta) {
          return Promise.fromCallback((done) =>
            send.call(this, args, done, meta)
          ).catch((x) => {
            throw x;
          });
        }
      };

      cb(null, client);
    });
  }

  // graceful shutdown
  onClose (action) {
    this.closeAction = action;
  }

  async close () {
    return this.closeAction();
  }
}

export default function transport (opts, mc) {
  const callmap = new LRUCache({ max: 10000 });
  const settings = {
    warn: {
      unknown_message_id: true,
      invalid_kind: true,
      invalid_origin: true,
      no_message_id: true,
      message_loop: true,
      own_message: true
    },
    host: '0.0.0.0',
    port: 10201,
    timeout: 5555,
    ...opts
  };
  const tp = new TP(
    {
      callmap,
      opts: settings
    },
    mc
  );

  const listen = Tcp.listen(settings, tp);
  const client = Tcp.client(settings, tp);
  return {
    listen,
    client
  };
}
