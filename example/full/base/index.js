'use strict';

import dns from 'dns';
import os from 'os';
import MicroWizard from 'microwizard';

const mw = new MicroWizard();

const config = {
  baseName: 'localhost',
  seneca: {}
};

function dnsSeed (_seneca, _options, _bases, next) {
  dns.lookup(
    config.baseName,
    {
      all: true,
      family: 4
    },
    (err, addresses) => {
      let bases = [];

      if (err) {
        throw new Error('dns lookup for base node failed', err);
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

const _config = {
  base: true,
  isbase: true,
  discover: {
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

// this will initialize the built in mesh module, over this all your
// services will find each other and also failure detection happens
// automatically in a scalable way
mw.use('mesh-ng', Object.assign(config.seneca || {}, _config));
