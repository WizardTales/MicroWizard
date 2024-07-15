'use strict';

import SQL from 'sql-template-tag';

export default {
  /**
   * @param {Object} request - Request plugin object
   * @param {Object} request.server
   * @param {Object} request.server.plugins
   * @param {Object} request.server.plugins.pg
   * @param {import('pg-pool')} request.server.plugins.pg.pool - CRDB Interface
   */
  request: async (request, data) => {
    const { pool } = request.server.plugins.pg;
    // the service loader by default accepts session information and injects
    // them back here
    const { credentials: session } = request.auth;

    // we do not need the data in this call, but to demonstrate how data is being
    // passed in the function we log the message from the data object here
    console.log(data.message);
    // will log
    // hello, buenos dias, moshi moshi

    // Our example call also contained data not on the data object
    // this can be accessed the following way
    console.log(request.msg.hello);
    // will log
    // there

    // The reason for the data object for us is a clear distinction between
    // control parameters and actual data params. However, there will be also
    // scenarios were you want to use data for routing, in this case we place
    // those on the root level of the object and use mixin in case of `actE`

    if (!session) {
      return { code: 401, msg: 'not authorized!' };
    }

    const {
      rows: [user]
    } = await pool.query(SQL`SELECT * FROM "user" WHERE "id" = ${session.id}`);

    return { code: 200, user };
  },

  // this is the final listen pin, our service loader module takes over the
  // mw.add() logic and also adds a few other features to this, for example
  // it calls pre and post actions which allows to signal back overload
  // scenarios and other things
  pin: 'service:user,command:me'
};
