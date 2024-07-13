'use strict';

export default {
  async challenge (request, h) {
    const session = request.auth.credentials;

    const result = await request.seneca.actE('service:user,command:me', {
      // here we path over our session to the service
      session,
      // the data object is always on the second layer, this will
      // be passed into our function on the other side prepared by
      // our service loader
      data: { message: 'hello, buenos dias, moshi moshi' },
      // first layer information can be also consumed, this usually
      // when you want to use an information during routing also
      hello: 'there'
    });

    if (result.code) {
      return h.response(result).code(result.code);
    }

    return result;
  }
};
