'use strict';

import MicroWizard from 'microwizard';
import dns from 'dns';
import os from 'os';
import Services from 'microwizard-service-loader-es';

const config = {
  baseName: 'localhost',
  seneca: {},
  settings: {}
};

const mw = new MicroWizard();

const _tempPGPlugin = {
  register: (request, options, next) => {
    // an example plugin for our service loader plugin
    const crdb = Object.create(options.config);
    const pool = crdb.pool;
    request.expose('pool', pool);
    next();
  }
};

_tempPGPlugin.register.attributes = {
  name: 'pg'
};

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

const initialSenecaConfig = {
  auto: true,
  // actually service:user is enough, but if you have like a subservice that explicitly
  // listens for
  // { pin: 'service:user,command:extra', model: 'consume', type: 'tcp' }
  // you can do this. This is unlikely, this just to show you, that you have the same
  // flexibility like when you're adding functions to control where things are steered
  listen: [{ pin: 'service:user,command:*', model: 'consume', type: 'tcp' }],
  discover: {
    rediscover: true,
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

if (process.env.rancher) {
  senecaConfig.host = os.networkInterfaces().eth0[0].address;
}

if (senecaConfig.bases && senecaConfig.bases.indexOf(',')) {
  senecaConfig.bases = senecaConfig.bases.split(',');
}

const services = new Services(mw);

services
  .register([
    {
      register: _tempPGPlugin,
      options: {
        config: config.settings,
        connectionCount: 8
      }
    }
  ])
  .then(() => services.load());

mw.use('mesh-ng', senecaConfig);
