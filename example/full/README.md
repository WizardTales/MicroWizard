# Start this

Run `pnpm install` in all 3 projects. Start base first and then the two other services.

Call [http://127.0.0.1:5000/me](http://127.0.0.1:5000/me).

You will see `{"code":401,"msg":"not authorized!"}` in the browser. Which is the expected
answer, we tried talking to the service without a valid session.

Look now in the console where service1 is running, it should have logged some data it
received from the api gateway during the service call.
