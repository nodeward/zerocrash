const fs = require('fs');
const url = require('url');
const path = require('path');
const https = require('http');
const stacktrace = require('stack-trace');
const querystring = require('querystring');

const LINES_OF_CONTEXT = 7;
let port = process.env.SERVER_PORT;
let hostname = process.env.SERVER_HOSTNAME;
const zerocrashVersion = require('../package.json').version;

const protocolMap = {
  http: 80,
  https: 443
};

if (hostname.includes('http://')) {
  hostname = hostname.split('http://')[1];
  port = protocolMap.http;
}

if (hostname.includes('https://')) {
  hostname = hostname.split('https://')[1];
  port = protocolMap.https;
}

if (hostname.includes(':')) {
  hostname = hostname.split(':')[0];
  port = hostname.split(':')[1];
}

let logServerOpts = {
  hostname: hostname,
  method: 'POST',
  port: port,
  path: '/'
};

var consoleAlerts = {};

// Default Node.js REPL depth
var MAX_SERIALIZE_EXCEPTION_DEPTH = 3;
// 50kB, as 100kB is max payload size, so half sounds reasonable
var MAX_SERIALIZE_EXCEPTION_SIZE = 50 * 1024;
var MAX_SERIALIZE_KEYS_LENGTH = 40;

let stringify = (obj, replacer, spaces, cycleReplacer) => {
  return JSON.stringify(obj, serializer(replacer, cycleReplacer), spaces)
}

let serializer = (replacer, cycleReplacer) => {
  var stack = [],
    keys = []

  if (cycleReplacer == null) cycleReplacer = function (key, value) {
    if (stack[0] === value) return "[Circular ~]"
    return "[Circular ~." + keys.slice(0, stack.indexOf(value)).join(".") + "]"
  }

  return function (key, value) {
    if (stack.length > 0) {
      var thisPos = stack.indexOf(this);
      ~thisPos ? stack.splice(thisPos + 1) : stack.push(this);
      ~thisPos ? keys.splice(thisPos, Infinity, key) : keys.push(key);
      if (~stack.indexOf(value)) value = cycleReplacer.call(this, key, value);
    } else stack.push(value)

    return replacer == null ? value : replacer.call(this, key, value)
  }
}

let utf8Length = value => {
  return ~-encodeURI(value).split(/%..|./).length;
}

let jsonSize = value => {
  return utf8Length(JSON.stringify(value));
}

let isPlainObject = what => {
  return Object.prototype.toString.call(what) === '[object Object]';
}

module.exports.isPlainObject = isPlainObject;

let serializeValue = value => {
  let maxLength = 40;

  if (typeof value === 'string') {
    return value.length <= maxLength ? value : value.substr(0, maxLength - 1) + '\u2026';
  } else if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }

  let type = Object.prototype.toString.call(value);

  // Node.js REPL notation
  if (type === '[object Object]') return '[Object]';
  if (type === '[object Array]') return '[Array]';
  if (type === '[object Function]')
    return value.name ? '[Function: ' + value.name + ']' : '[Function]';

  return value;
}

let serializeObject = (value, depth) => {
  if (depth === 0) return serializeValue(value);

  if (isPlainObject(value)) {
    return Object.keys(value).reduce(function (acc, key) {
      acc[key] = serializeObject(value[key], depth - 1);
      return acc;
    }, {});
  } else if (Array.isArray(value)) {
    return value.map(function (val) {
      return serializeObject(val, depth - 1);
    });
  }

  return serializeValue(value);
}

let serializeException = (ex, depth, maxSize) => {
  if (!isPlainObject(ex)) return ex;

  depth = typeof depth !== 'number' ? MAX_SERIALIZE_EXCEPTION_DEPTH : depth;
  maxSize = typeof depth !== 'number' ? MAX_SERIALIZE_EXCEPTION_SIZE : maxSize;

  var serialized = serializeObject(ex, depth);

  if (jsonSize(stringify(serialized)) > maxSize) {
    return serializeException(ex, depth - 1);
  }

  return serialized;
}

module.exports.serializeException = serializeException;

let serializeKeysForMessage = (keys, maxLength) => {
  if (typeof keys === 'number' || typeof keys === 'string') return keys.toString();
  if (!Array.isArray(keys)) return '';

  keys = keys.filter(function (key) {
    return typeof key === 'string';
  });
  if (keys.length === 0) return '[object has no keys]';

  maxLength = typeof maxLength !== 'number' ? MAX_SERIALIZE_KEYS_LENGTH : maxLength;
  if (keys[0].length >= maxLength) return keys[0];

  for (let usedKeys = keys.length; usedKeys > 0; usedKeys--) {
    let serialized = keys.slice(0, usedKeys).join(', ');
    if (serialized.length > maxLength) continue;
    if (usedKeys === keys.length) return serialized;
    return serialized + '\u2026';
  }

  return '';
}

module.exports.serializeKeysForMessage = serializeKeysForMessage;

module.exports.disableConsoleAlerts = function disableConsoleAlerts() {
  consoleAlerts = false;
};

module.exports.consoleAlert = function consoleAlert(msg) {
  if (consoleAlerts) {
    console.log('zerocrash@' + zerocrashVersion + ' alert: ' + msg);
  }
};

module.exports.consoleAlertOnce = function consoleAlertOnce(msg) {
  if (consoleAlerts && !(msg in consoleAlerts)) {
    consoleAlerts[msg] = true;
    console.log('zerocrash@' + zerocrashVersion + ' alert: ' + msg);
  }
};

module.exports.extend =
  Object.assign ||
  function (target) {
    for (let i = 1; i < arguments.length; i++) {
      let source = arguments[i];
      for (let key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }
    return target;
  };

module.exports.getAuthHeader = (timestamp, apiKey, apiSecret) => {
  let header = ['Sentry sentry_version=5'];
  header.push('sentry_timestamp=' + timestamp);
  header.push('sentry_client=raven-node/' + ravenVersion);
  header.push('sentry_key=' + apiKey);
  if (apiSecret) header.push('sentry_secret=' + apiSecret);
  return header.join(', ');
};

module.exports.parseDSN = function parseDSN(dsn) {
  if (!dsn) {
    // Let a falsey value return false explicitly
    return false;
  }
  try {
    var parsed = url.parse(dsn),
      response = {
        protocol: parsed.protocol.slice(0, -1),
        public_key: parsed.auth.split(':')[0],
        host: parsed.host.split(':')[0]
      };

    if (parsed.auth.split(':')[1]) {
      response.private_key = parsed.auth.split(':')[1];
    }

    if (~response.protocol.indexOf('+')) {
      response.protocol = response.protocol.split('+')[1];
    }

    // if (!transports.hasOwnProperty(response.protocol)) {
    //   throw new Error('Invalid transport');
    // }

    var index = parsed.pathname.lastIndexOf('/');
    response.path = parsed.pathname.substr(0, index + 1);
    response.project_id = parsed.pathname.substr(index + 1);
    response.port = ~~parsed.port || protocolMap[response.protocol] || 443;
    return response;
  } catch (e) {
    throw new Error('Invalid Sentry DSN: ' + dsn);
  }
};

let getFunction = line => {
  try {
    return (
      line.getFunctionName() ||
      line.getTypeName() + '.' + (line.getMethodName() || '<anonymous>')
    );
  } catch (e) {
    // This seems to happen sometimes when using 'use strict',
    // stemming from `getTypeName`.
    // [TypeError: Cannot read property 'constructor' of undefined]
    return '<anonymous>';
  }
}

let mainModule =
  ((require.main && require.main.filename && path.dirname(require.main.filename)) ||
    global.process.cwd()) + '/';

let getModule = (filename, base) => {
  if (!base) base = mainModule;

  // It's specifically a module
  let file = path.basename(filename, '.js');
  filename = path.dirname(filename);
  let n = filename.lastIndexOf('/node_modules/');
  if (n > -1) {
    // /node_modules/ is 14 chars
    return filename.substr(n + 14).replace(/\//g, '.') + ':' + file;
  }
  // Let's see if it's a part of the main module
  // To be a part of main module, it has to share the same base
  n = (filename + '/').lastIndexOf(base, 0);
  if (n === 0) {
    let module = filename.substr(base.length).replace(/\//g, '.');
    if (module) module += ':';
    module += file;
    return module;
  }
  return file;
}

let readSourceFiles = (filenames, cb) => {
  // we're relying on filenames being de-duped already
  if (filenames.length === 0) return setTimeout(cb, 0, {});

  let sourceFiles = {};
  let numFilesToRead = filenames.length;
  return filenames.forEach(filename => {
    fs.readFile(filename, (readErr, file) => {
      if (!readErr) sourceFiles[filename] = file.toString().split('\n');
      if (--numFilesToRead === 0) cb(sourceFiles);
    });
  });
}

// This is basically just `trim_line` from https://github.com/getsentry/sentry/blob/master/src/sentry/lang/javascript/processor.py#L67
let snipLine = (line, colno) => {
  let ll = line.length;
  if (ll <= 150) return line;
  if (colno > ll) colno = ll;

  let start = Math.max(colno - 60, 0);
  if (start < 5) start = 0;

  let end = Math.min(start + 140, ll);
  if (end > ll - 5) end = ll;
  if (end === ll) start = Math.max(end - 140, 0);

  line = line.slice(start, end);
  if (start > 0) line = '{snip} ' + line;
  if (end < ll) line += ' {snip}';

  return line;
}

let snipLine0 = line => {
  return snipLine(line, 0);
}

let parseStack = (err, cb) => {
  if (!err) return cb([]);

  let stack = stacktrace.parse(err);
  if (!stack || !Array.isArray(stack) || !stack.length || !stack[0].getFileName) {
    // the stack is not the useful thing we were expecting :/
    return cb([]);
  }

  // Sentry expects the stack trace to be oldest -> newest, v8 provides newest -> oldest
  // stack.reverse();

  let frames = [];
  let filesToRead = {};
  stack.forEach(line => {
    let frame = {
      filename: line.getFileName() || '',
      lineno: line.getLineNumber(),
      colno: line.getColumnNumber(),
      function: getFunction(line)
    };

    let isInternal =
      line.isNative() ||
      (frame.filename[0] !== '/' &&
        frame.filename[0] !== '.' &&
        frame.filename.indexOf(':\\') !== 1);

    // in_app is all that's not an internal Node function or a module within node_modules
    // note that isNative appears to return true even for node core libraries
    // see https://github.com/getsentry/raven-node/issues/176
    frame.in_app = !isInternal && frame.filename.indexOf('node_modules/') === -1;

    // Extract a module name based on the filename
    if (frame.filename) {
      frame.module = getModule(frame.filename);
      if (!isInternal) filesToRead[frame.filename] = true;
    }

    frames.push(frame);
  });

  return readSourceFiles(Object.keys(filesToRead), sourceFiles => {
    frames.forEach(frame => {
      if (frame.filename && sourceFiles[frame.filename]) {
        var lines = sourceFiles[frame.filename];
        try {
          frame.pre_context = lines
            .slice(Math.max(0, frame.lineno - (LINES_OF_CONTEXT + 1)), frame.lineno - 1)
            .map(snipLine0);
          frame.context_line = snipLine(lines[frame.lineno - 1], frame.colno);
          frame.post_context = lines
            .slice(frame.lineno, frame.lineno + LINES_OF_CONTEXT)
            .map(snipLine0);
        } catch (e) {
          // anomaly, being defensive in case
          // unlikely to ever happen in practice but can definitely happen in theory
        }
      }
    });

    cb(frames);
  });
}

let sendErrorLogs = (stackTrace, cb) => {
  parseStack(stackTrace, frames => {
    let postData = JSON.stringify({ 'data': frames });
    let request = https.request(logServerOpts, res => { cb(stackTrace); });
    request.write(postData);
    request.end();
  });
}

let errorHandler = () => {
  return (error, req, res, next) => {
    sendErrorLogs(error, next);
  }
};

module.exports.errorHandler = errorHandler;
module.exports.sendErrorLogs = sendErrorLogs;