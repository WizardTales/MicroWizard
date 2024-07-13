/* Copyright (c) 2013-2015 Richard Rodger, MIT License */
/* Copyright (c) 2024 WizardTales GmbH, MIT License */

import Net from 'net';
import Stream from 'stream';
import Ndjson from 'ndjson';
import Reconnect from 'reconnect-core';

const internals = {};

export const listen = function (opts, tp) {
  return function (args, callback) {
    const listenOptions = { ...opts, ...args };

    const connections = [];
    let listenAttempts = 0;

    const listener = Net.createServer(
      {
        noDelay: true
      },
      function (connection) {
        if (process.env.DEBUG) {
          console.log(
            'listen',
            'connection',
            listenOptions,
            'remote',
            connection.remoteAddress,
            connection.remotePort
          );
        }

        const parser = Ndjson.parse();
        const stringifier = Ndjson.stringify();
        parser.on('error', function (error) {
          console.error(error);
          connection.end();
        });
        parser.on('data', async (data) => {
          if (data instanceof Error) {
            const out = {};
            out.input = data.input;
            out.error = 'invalid_json';

            stringifier.write(out);
            return;
          }

          const out = await tp.handleRequest(data, opts);
          if (!out?.sync) {
            return;
          }

          stringifier.write(out);
        });

        connection.pipe(parser);
        stringifier.pipe(connection);

        connection.on('error', function (err) {
          console.error(
            'listen',
            'pipe-error',
            listenOptions,
            err && err.stack
          );
        });

        connections.push(connection);
      }
    );

    listener.once('listening', function () {
      listenOptions.port = listener.address().port;
      if (process.env.DEBUG) {
        console.log('listen', 'open', listenOptions);
      }
      return callback(null, listenOptions);
    });

    listener.on('error', function (err) {
      console.log('listen', 'net-error', listenOptions, err && err.stack);

      if (
        err.code === 'EADDRINUSE' &&
        listenAttempts < listenOptions.max_listen_attempts
      ) {
        listenAttempts++;
        console.log(
          'listen',
          'attempt',
          listenAttempts,
          err.code,
          listenOptions
        );
        setTimeout(
          listen,
          100 + Math.floor(Math.random() * listenOptions.attempt_delay)
        );
      }
    });

    listener.on('close', function () {
      if (process.env.DEBUG) {
        console.log('listen', 'close', listenOptions);
      }
    });

    function listen () {
      if (listenOptions.path) {
        listener.listen(listenOptions.path);
      } else {
        listener.listen(listenOptions.port, listenOptions.host);
      }
    }
    listen();

    tp.onClose(async function () {
      // node 0.10 workaround, otherwise it throws
      if (listener._handle) {
        listener.close();
      }
      internals.closeConnections(connections);
    });
  };
};

export const client = function (options, tp) {
  return function (args, callback) {
    let conStream;
    let connection;
    let established = false;
    let stringifier;

    const type = args.type;
    if (args.host) {
      // under Windows host, 0.0.0.0 host will always fail
      args.host = args.host === '0.0.0.0' ? '127.0.0.1' : args.host;
    }
    const clientOptions = { ...options, ...args };
    clientOptions.host =
      !args.host && clientOptions.host === '0.0.0.0'
        ? '127.0.0.1'
        : clientOptions.host;

    const connect = function () {
      if (process.env.DEBUG) {
        console.log('client', type, 'send-init', '', '', clientOptions);
      }

      const reconnect = internals.reconnect(
        { failAfter: clientOptions.failAfter || 3 },
        function (stream) {
          conStream = stream;
          const msger = internals.clientMessager(clientOptions, tp);
          const parser = Ndjson.parse();
          stringifier = Ndjson.stringify();

          stream.pipe(parser).pipe(msger).pipe(stringifier).pipe(stream);

          if (!established) reconnect.emit('s_connected', stringifier);
          established = true;
        }
      );

      reconnect.on('connect', function (connection) {
        if (process.env.DEBUG) {
          console.log('client', type, 'connect', '', '', clientOptions);
        }
        // connection.clientOptions = clientOptions // unique per connection
        // connections.push(connection)
        // established = true
      });

      reconnect.on('reconnect', function () {
        if (process.env.DEBUG) {
          console.log('client', type, 'reconnect', '', '', clientOptions);
        }
      });
      reconnect.on('disconnect', function (err) {
        if (process.env.DEBUG) {
          console.log(
            'client',
            type,
            'disconnect',
            '',
            '',
            clientOptions,
            (err && err.stack) || err
          );
        }

        established = false;
      });
      reconnect.on('error', function (err) {
        console.log('client', type, 'error', '', '', clientOptions, err.stack);
      });

      reconnect.on('fail', function (err) {
        console.log(
          'client',
          type,
          'fail',
          '',
          '',
          clientOptions,
          err,
          err?.stack
        );

        reconnect.disconnect();
        internals.closeConnections([conStream]);
      });

      reconnect.connect({
        port: clientOptions.port,
        host: clientOptions.host
      });

      tp.onClose(async function () {
        reconnect.disconnect();
        internals.closeConnections([conStream]);
      });

      return reconnect;
    };

    function getClient (cb) {
      if (!connection) connection = connect();
      if (established) {
        cb(stringifier);
      } else {
        connection.once('s_connected', cb);
      }
    }

    const send = function (spec, topic, sendDone) {
      sendDone(null, function (args, done, meta) {
        // const self = this;
        const timeout = setTimeout(() => {
          done('timeout');
        }, clientOptions.timeout);

        getClient(function (stringifier) {
          function finish () {
            clearTimeout(timeout);
            done.apply(done, arguments);
          }
          const outmsg = tp.prepareRequest(args, finish, meta);
          if (!outmsg.replied) stringifier.write(outmsg);

          if (!outmsg.sync) {
            finish(null, {});
          }
        });
      });
    };

    tp.makeClient(send, clientOptions, callback);
  };
};

internals.clientMessager = function (options, tp) {
  const messager = new Stream.Duplex({ objectMode: true });
  messager._read = function () {};
  messager._write = function (data, enc, callback) {
    tp.handleResponse(data, options);
    return callback();
  };
  return messager;
};

internals.closeConnections = function (connections) {
  for (let i = 0, il = connections.length; i < il; ++i) {
    internals.destroyConnection(connections[i]);
  }
};

internals.destroyConnection = function (connection) {
  try {
    connection.destroy();
  } catch (e) {
    console.log(e);
  }
};

internals.reconnect = Reconnect(function () {
  const args = [].slice.call(arguments);
  return Net.connect.apply(null, args);
});
