'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _nodemailer = require('nodemailer');

var _nodemailer2 = _interopRequireDefault(_nodemailer);

var _dns = require('dns');

var _dns2 = _interopRequireDefault(_dns);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var SMTP_PORT = 25;

/**
 * Simple debugging method
 * @param {*} message
 */
function debug(message) {
  if (process.env.DEBUG_NODEMAILER_RELAY) {
    process.stdout.write(JSON.stringify(message, null, '  ') + '\n\n');
  }
}

/**
 * Collection map using Promise
 * @param {*} collection
 * @param {*} iteratee
 */
function promiseMap(collection, iteratee) {
  var mapResult = [];
  return Promise.all(_lodash2.default.map(collection, function (value, key) {
    try {
      return Promise.resolve(iteratee(value, key, collection)).then(function (result) {
        mapResult[key] = result;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  })).then(function () {
    return mapResult;
  });
}

/**
 * resolveMx using promises
 * @param {*} hostname
 */
function resolveMxAsync(hostname) {
  return new Promise(function (resolve, reject) {
    try {
      _dns2.default.resolveMx(hostname, function (resolveErr, addresses) {
        return resolveErr ? reject(resolveErr) : resolve(addresses);
      });
    } catch (err) {
      return reject(err);
    }
  });
}

/**
 * Converts a to line to an array of email addresses
 * @param {*} value
 */
function toArray(value) {
  return Array.isArray(value) ? value.map(function (v) {
    return v.trim();
  }) : typeof value === 'string' ? value.split(',').map(function (v) {
    return v.trim().toLowerCase();
  }) : [];
}

/**
 * Creates a map of domain names to email addresses
 * @param {*} addr
 * @param {*} domainMap
 */
function mapDomains(addr, domainMap) {
  toArray(addr).forEach(function (emailAddr) {
    var domain = emailAddr.replace(/^.*@/, '').toLowerCase();
    domainMap[domain] = {
      addrs: domainMap[domain] ? _lodash2.default.union(domainMap[domain].addrs, [emailAddr.toLowerCase()]) : [emailAddr.toLowerCase()]
    };
  });
  return domainMap;
}

/**
 * Looks up mx records for a domain
 * @param {*} domainMap
 */
function lookupMx(domainMap) {
  return Promise.all(_lodash2.default.map(domainMap, function (data, domain) {
    return resolveMxAsync(domain).then(function (addresses) {
      data.mx = _lodash2.default.sortBy(addresses, ['priority']);
    });
  })).then(function () {
    return domainMap;
  });
}

/**
 * Performs the mail send by iterating through each mx record
 * and attempting to send until message is sent
 * @param {*} addr
 * @param {*} to
 * @param {*} cc
 * @param {*} mailOpts
 * @param {*} relayOpts
 * @param {*} mx
 * @param {*} sendInfo
 * @param {*} resolve
 * @param {*} reject
 */
function sendMail(mail, transportOptions, mx, summary, resolve) {
  var to = _lodash2.default.get(mail, 'envelope.to');
  if (!mx.length) {
    summary.push('failed to send to: ' + to);
    return resolve();
  }
  var host = _lodash2.default.get(mx.shift(), 'exchange');
  var transporter = _nodemailer2.default.createTransport(_lodash2.default.merge({ port: SMTP_PORT }, transportOptions, { host }));

  transporter.sendMail(mail, function (error, info) {
    if (error) {
      debug({ sendError: error });
      if (!error.message.match(/ENOTFOUND/)) {
        summary.push({ to, info: error });
        return resolve(); // stop trying to process if an email error
      }
      return sendMail(mail, transportOptions, mx, summary, resolve);
    }
    summary.push({ to, info });
    return resolve();
  });
}

/**
 * Calls sendMail and returns a promise
 * @param {*} mail
 * @param {*} transportOptions
 * @param {*} mx
 * @param {*} summary
 */
function send(mail, transportOptions, mx, summary) {
  debug({
    sending: {
      mail,
      transportOptions
    }
  });
  return new Promise(function (resolve) {
    sendMail(mail, transportOptions, mx, summary, resolve);
  });
}

/**
 * Relay method to send a mail using SMTP relays that are looked up
 * using mx records
 * @param {*} mailOptions
 * @param {*} transportOptions
 * @param {*} callback
 */
function relay(mailOptions, transportOptions, callback) {
  var topts = transportOptions;
  var cb = callback;

  if (_lodash2.default.isFunction(topts)) {
    cb = topts;
    topts = {};
  }

  topts = Object.assign({}, topts);
  cb = _lodash2.default.isFunction(cb) ? cb : _lodash2.default.noop;

  var overrideMx = function overrideMx(domain, mx) {
    return topts[domain] && topts[domain]['mx'] ? [{ exchange: topts[domain]['mx'], priority: 10 }] : mx;
  };
  return new Promise(function (resolve, reject) {
    try {
      if (!_lodash2.default.isPlainObject(mailOptions)) {
        var moptsErr = new Error('mailOptions should be an object');
        cb(moptsErr);
        return reject(moptsErr);
      }

      var summary = [];
      var domainMap = {};
      var from = mailOptions.from;

      // get to and cc addresses for the header
      var to = toArray(mailOptions.to).join(', ');
      var cc = toArray(mailOptions.cc).join(', ');

      // map the email addresses to their domains
      mapDomains(mailOptions.to, domainMap);
      mapDomains(mailOptions.cc, domainMap);
      mapDomains(mailOptions.bcc, domainMap);

      // look up the domain map mx records
      return lookupMx(domainMap).then(function (dmap) {
        return promiseMap(dmap, function (_ref, domain) {
          var addrs = _ref.addrs,
              mx = _ref.mx;

          debug({ addrs, mx, domain });
          var tOpts = _lodash2.default.find(transportOptions, function (opts, name) {
            return _lodash2.default.toLower(name) === _lodash2.default.toLower(domain);
          }) || {};

          return promiseMap(addrs, function (addr) {
            var mail = _lodash2.default.merge({}, mailOptions, {
              to,
              cc,
              bcc: '',
              envelope: {
                from,
                to: addr,
                cc: '',
                bcc: ''
              }
            });
            return send(mail, tOpts, overrideMx(domain, mx), summary);
          });
        });
      }).then(function () {
        cb(null, summary);
        return resolve(summary);
      }).catch(function (err) {
        cb(err);
        return reject(err);
      });
    } catch (err) {
      cb(err);
      return reject(err);
    }
  });
}

/**
 * Extend the nodemailer instance with the relay method
 */
exports.default = Object.assign({}, _nodemailer2.default, { relay });