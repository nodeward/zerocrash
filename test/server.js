require('dotenv').config();

const PORT = 1333;
const host = `Server running on PORT : ${PORT}`;

const fs = require('fs');
const express = require('express');
const app = express();

const TOKEN = 'XYZ';
const ZeroCrash = require('../libs/zerocrash').install(TOKEN);

app.use(ZeroCrash.requestHandler());

app.get('/', async (req, res, next) => {
  let x = 5;
  let n = 3;

  console.log(x);
  console.log(n);

  let sum = x + n;

  t.doSomeFunction();

  let text = 'some text';
  let code = 'some code that runs';

  console.log('this is the line');
  let z = x + Math.sin(n);

  console.log('our result', z);
});

app.use(ZeroCrash.errorHandler());
/**
 * Catch 404 and forward to error handler
 */
app.use((request, response, next) => {
  response.statusCode = 404;
  response.end('Not found');
});

app.use(function onError(err, req, res, next) {
  res.statusCode = 500;
  res.end('Oops, something bad happened');
});

let server = app.listen(PORT, () => { console.log(host); });