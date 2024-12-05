/* Copyright (c) 2013-2015 Richard Rodger, MIT License */
/* Copyright (c) 2024 WizardTales GmbH, MIT License */

import Net from 'net';
import Stream from 'stream';
import Ndjson from 'ndjson';
import Reconnect from 'reconnect-core';

const internals = {};
const RECOOINT = 1000 * 60 * 2;
const RECONAWAIT = RECOOINT + 1000 * 60;

export const listen = function (opts, tp) {
  return function (args, callback, reduceActive) {
    const listenOptions = { ...opts, ...args };

    const connections = [];
    let listenAttempts = 0;

    const listener = Net.createServer(
      {
        noDelay: true
      },
      function (connection) {
        connection.setTimeout(RECONAWAIT);
        connection.on('timeout', () => {
          if (process.env.TRACE?.includes('MW:D')) {
            console.log('Ending connection');
          }
          connection.end();
        });
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
          // health ping
          if (data.h === 1) {
            stringifier.write({ h: 2 });
            return;
          }

          if (data instanceof Error) {
            const out = {};
            out.input = data.input;
            out.error = 'invalid_json';

            stringifier.write(out);
            return;
          }

          const out = await tp.handleRequest(data, opts);
          reduceActive();
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
      let interval;
      if (process.env.DEBUG) {
        console.log('client', type, 'send-init', '', '', clientOptions);
      }

      const reconnect = internals.reconnect(
        { failAfter: clientOptions.failAfter || 3 },
        function (stream) {
          conStream = stream;
          const keepalive = { called: false };
          const msger = internals.clientMessager(clientOptions, tp, keepalive);
          const parser = Ndjson.parse();
          stringifier = Ndjson.stringify();

          stream.pipe(parser).pipe(msger).pipe(stringifier).pipe(stream);

          interval = setInterval(() => {
            if (established === false) {
              clearInterval(interval);
              interval = null;
              return;
            }
            stringifier.write({ h: 1 });
            setTimeout(() => {
              if (keepalive.called) {
                keepalive.called = false;
              } else {
                // if the connection is dead for whatever reason we close
                // the connection and only restablish upon request
                reconnect.disconnect();
                internals.closeConnections([conStream]);
                // mark this disconnected
                connection = null;
                clearInterval(interval);
                interval = null;
              }
            }, 1000 * 5);
          }, RECOOINT);

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

        clearInterval(interval);
        interval = null;

        established = false;
      });
      reconnect.on('error', function (err) {
        console.log('client', type, 'error', '', '', clientOptions, err.stack);

        clearInterval(interval);
        interval = null;
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

        clearInterval(interval);
        interval = null;

        reconnect.disconnect();
        internals.closeConnections([conStream]);
        // mark this disconnected
        connection = null;
      });

      reconnect.connect({
        port: clientOptions.port,
        host: clientOptions.host
      });

      tp.onClose(async function () {
        clearInterval(interval);
        interval = null;

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
        let timedout = false;
        const connectTimeout = setTimeout(() => {
          timedout = true;
          done('timeout');
        }, meta.$c_to || clientOptions.connectTimeout);

        getClient(function (stringifier) {
          if (!timedout) {
            clearTimeout(connectTimeout);
          } else {
            return;
          }

          const timeout = setTimeout(() => {
            done('timeout');
          }, clientOptions.timeout);

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

internals.clientMessager = function (options, tp, keepalive) {
  const messager = new Stream.Duplex({ objectMode: true });
  messager._read = function () {};
  messager._write = function (data, enc, callback) {
    // we always reset the value on any traffic
    keepalive.called = true;

    // keepalive traffic, this is fine ignore
    if (data?.h === 2) {
      return callback();
    }

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
