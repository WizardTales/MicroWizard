'use strict';

import Promise from 'bluebird';
import hapiRouter from 'hapi-router-es';
import Hapi from '@hapi/hapi';
import esMain from 'es-main';
import Chairo from '@wzrdtales/chairo-mw';
import dns from 'dns';
import hapiGracefulShutdown from 'hapi-graceful-shutdown-plugin';
import hapiAlive from 'hapi-alive';
import os from 'os';
import Cookie from '@hapi/cookie';
import vision from '@hapi/vision';
import inert from '@hapi/inert';

const config = {
  server: {
    port: 5000,
    routes: {
      cors: {
        origin: ['*'],
        credentials: true,
        headers: [
          'apollo-query-plan-experimental',
          'content-type',
          'x-apollo-tracing'
        ]
      }
    }
  },
  graphql: {},
  redis: {
    port: 6379,
    host: '127.0.0.1'
  },
  cookies: {
    cookie: {
      name: 'session',
      password: {
        id: '1',
        secret: 'cNWNXTNPXbrMEAPFcoPqcUspYvUStEdQ',
        ...[
          '22ddfe02cabd6af2204bf2b76ebd9e3d',
          'cNWNXTNPXbrMEAPFcoPqcUspYvUStEdQ'
        ]
      },
      isSecure: false,
      isHttpOnly: true,
      isSameSite: false,
      ttl: 1000 * 60 * 60 * 24 * 30
    }
  },
  baseName: 'localhost',
  seneca: {}
};

const boot = new Date();
const prefix = config.prefix || '';
const routeConfig = prefix !== '' ? { prefix } : {};

config.server.routes.validate = {
  failAction: async (request, h, err) => {
    if (process.env.NODE_ENV !== 'production') {
      throw err;
    }
  }
};

const server = new Hapi.Server(config.server);

function dnsSeed (seneca, options, bases, next) {
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

async function start () {
  if (!esMain(import.meta)) {
    return;
  }

  try {
    await server.start();
    const bootTime = new Date() - boot;
    console.log(
      `Server running at: ${server.info.uri}, booted in ${bootTime}ms`
    );
  } catch (err) {
    console.log(`Error while starting server: ${err.message}`);
  }
}

async function healthCheck (server) {
  return true;
}

async function register () {
  let _config;
  if (process.env.NODE_ENV !== 'test') {
    try {
      await server.register([
        {
          plugin: Cookie
        },
        {
          plugin: Chairo
        },
        {
          plugin: hapiGracefulShutdown,
          options: {
            sigtermTimeout: 1,
            sigintTimeout: 1
          }
        },
        {
          plugin: hapiAlive,
          options: {
            path: '/health',
            tags: ['health', 'monitor'],
            healthCheck: healthCheck
          }
        }
      ]);

      _config = {
        auto: true,
        discover: {
          rediscover: true,
          custom: {
            active: true,
            find: dnsSeed
          }
        }
      };

      if (process.env.rancher) {
        _config.host = os.networkInterfaces().eth0[0].address;
      }

      if (config.seneca.bases && config.seneca.bases.indexOf(',')) {
        config.seneca.bases = config.seneca.bases.split(',');
      }

      server.auth.strategy('session', 'cookie', config.cookies);
      server.auth.default('session');

      // the chairo plugin already decorated the server object with seneca
      // since this was made seneca compatible, we name the object seneca
      // and not differently. This is so we can just drop in to our old seneca
      // based projects our new framework
      server.seneca.use('mesh-ng', Object.assign(config.seneca || {}, _config));

      await Promise.promisify(server.seneca.ready.bind(server.seneca))();

      await server.register([
        {
          plugin: hapiRouter,
          routes: {
            ...routeConfig
          },
          options: {
            routes: 'lib/routes/**/*.js'
          }
        },
        vision,
        inert
      ]);

      return true;
    } catch (err) {
      console.log(err);
      return false;
    }
  } else {
    return true;
  }
}

if (esMain(import.meta)) {
  (async () => {
    if (await register()) start();
  })();
}

export default register;
