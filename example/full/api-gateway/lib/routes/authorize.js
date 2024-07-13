'use strict';

import controller from '../controllers/authorize.js';
// hapi style validations you can do that on your own
// import validate from '../validations/authorize.js';

export default (() => [
  {
    method: 'GET',
    path: '/me',
    handler: controller.me,
    config: {
      // validate: validate.me,
      handler: controller.me,
      auth: { mode: 'required' } // use try when realizing a login itself that has no session yet
    }
  }
])();
