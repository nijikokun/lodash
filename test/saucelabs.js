#!/usr/bin/env node
;(function() {
  'use strict';

  /** Environment shortcut */
  var env = process.env;

  if (isFinite(env.TRAVIS_PULL_REQUEST)) {
    console.error('Testing skipped for pull requests');
    process.exit(0);
  }

  /** Load Node.js modules */
  var EventEmitter = require('events').EventEmitter,
      http = require('http'),
      path = require('path'),
      url = require('url');

  /** Load other modules */
  var _ = require('../lodash.js'),
      ecstatic = require('ecstatic'),
      request = require('request'),
      SauceTunnel = require('sauce-tunnel');

  /** Used for Sauce Labs credentials */
  var accessKey = env.SAUCE_ACCESS_KEY,
      username = env.SAUCE_USERNAME;

  /** Used as the maximum number of times to retry a job */
  var maxRetries = 3;

  /** Used by `logInline` to clear previously logged messages */
  var prevLine = '';

  /** Used to detect error messages */
  var reError = /\berror\b/i;

  /** Used to display the wait throbber */
  var throbberId,
      throbberDelay = 500,
      waitCount = -1;

  /** Used as Sauce Labs config values */
  var advisor = getOption('advisor', true),
      build = getOption('build', env.TRAVIS_COMMIT.slice(0, 10)),
      compatMode = getOption('compatMode', null),
      customData = Function('return {' + getOption('customData', '').replace(/^\{|}$/g, '') + '}')(),
      framework = getOption('framework', 'qunit'),
      idleTimeout = getOption('idleTimeout', 180),
      jobName = getOption('name', 'unit tests'),
      maxDuration = getOption('maxDuration', 360),
      port = getOption('port', 9001),
      publicAccess = getOption('public', true),
      recordVideo = getOption('recordVideo', false),
      recordScreenshots = getOption('recordScreenshots', false),
      runner = getOption('runner', 'test/index.html').replace(/^\W+/, ''),
      runnerUrl = getOption('runnerUrl', 'http://localhost:' + port + '/' + runner),
      statusInterval = getOption('statusInterval', 5000),
      tags = getOption('tag', []),
      tunneled = getOption('tunneled', true),
      tunnelId = getOption('tunnelId', 'tunnel_' + env.TRAVIS_JOB_NUMBER),
      tunnelTimeout = getOption('tunnelTimeout', 10000),
      videoUploadOnPass = getOption('videoUploadOnPass', false);

  /** List of platforms to load the runner on */
  var platforms = [
    ['Windows 8.1', 'googlechrome', '33'],
    ['Windows 8.1', 'googlechrome', '32'],
    ['Windows 8.1', 'firefox', '27'],
    ['Windows 8.1', 'firefox', '26'],
    ['Windows 8.1', 'firefox', '20'],
    ['Windows 8.1', 'firefox', '3.0'],
    ['Windows 8.1', 'internet explorer', '11'],
    ['Windows 8', 'internet explorer', '10'],
    ['Windows 7', 'internet explorer', '9'],
    ['Windows 7', 'internet explorer', '8'],
    ['Windows XP', 'internet explorer', '7'],
    ['Windows XP', 'internet explorer', '6'],
    ['Windows 7', 'opera', '12'],
    ['Windows 7', 'opera', '11'],
    ['OS X 10.9', 'safari', '7'],
    ['OS X 10.8', 'safari', '6'],
    ['OS X 10.6', 'safari', '5']
  ];

  /** Used to tailor the `platforms` array */
  var runnerQuery = url.parse(runner, true).query,
      isBackbone = /\bbackbone\b/i.test(runner),
      isMobile = /\bmobile\b/i.test(runnerQuery.build),
      isModern = /\bmodern\b/i.test(runnerQuery.build);

  // platforms to test IE compat mode
  if (compatMode) {
    platforms = [
      ['Windows 8.1', 'internet explorer', '11'],
      ['Windows 8', 'internet explorer', '10'],
      ['Windows 7', 'internet explorer', '9'],
      ['Windows 7', 'internet explorer', '8']
    ];
  }
  // platforms for AMD tests
  if (_.contains(tags, 'amd')) {
    platforms = platforms.filter(function(platform) {
      var browser = platform[1],
          version = +platform[2];

      if (browser == 'opera') {
        return version >= 10;
      }
      return true;
    });
  }
  // platforms for Backbone tests
  if (isBackbone) {
    platforms = platforms.filter(function(platform) {
      var browser = platform[1],
          version = +platform[2];

      switch (browser) {
        case 'firefox': return version >= 4;
        case 'opera': return version >= 12;
      }
      return true;
    });
  }
  // platforms for mobile and modern builds
  if (isMobile || isModern) {
    platforms = platforms.filter(function(platform) {
      var browser = platform[1],
          version = +platform[2];

      switch (browser) {
        case 'firefox': return version >= 10;
        case 'internet explorer': return version >= 9;
        case 'opera': return version >= 12;
        case 'safari': return version >= (isMobile ? 3 : 6);
      }
      return true;
    });
  }

  /** Used as the default `Job` options object */
  var defaultOptions = {
    'build': build,
    'custom-data': customData,
    'framework': framework,
    'idle-timeout': idleTimeout,
    'max-duration': maxDuration,
    'name': jobName,
    'public': publicAccess,
    'platforms': [],
    'record-screenshots': recordScreenshots,
    'record-video': recordVideo,
    'sauce-advisor': advisor,
    'tags': tags,
    'url': runnerUrl,
    'video-upload-on-pass': videoUploadOnPass
  };

  if (publicAccess === true) {
    defaultOptions['public'] = 'public';
  }
  if (tunneled) {
    defaultOptions.tunnel = 'tunnel-identifier:' + tunnelId;
  }

  /*--------------------------------------------------------------------------*/

  /**
   * Gets the value for the given option name. If no value is available the
   * `defaultValue` is returned.
   *
   * @private
   * @param {string} name The name of the option.
   * @param {*} defaultValue The default option value.
   * @returns {*} Returns the option value.
   */
  function getOption(name, defaultValue) {
    var isArr = _.isArray(defaultValue);
    return _.reduce(process.argv, function(result, value) {
      if (isArr) {
        value = optionToArray(name, value);
        return _.isEmpty(value) ? result : value;
      }
      value = optionToValue(name, value);

      return value == null ? result : value;
    }, defaultValue);
  }

  /**
   * Writes an inline message to standard output.
   *
   * @private
   * @param {string} text The text to log.
   */
  function logInline(text) {
    var blankLine = _.repeat(' ', _.size(prevLine));
    if (text.length > 40) {
      text = text.slice(0, 37) + '...';
    }
    prevLine = text;
    process.stdout.write(text + blankLine.slice(text.length) + '\r');
  }

  /**
   * Writes the wait throbber to standard output.
   *
   * @private
   */
  function logThrobber() {
    logInline('Please wait' + _.repeat('.', (++waitCount % 3) + 1));
  }

  /**
   * Converts a comma separated option value into an array.
   *
   * @private
   * @param {string} name The name of the option to inspect.
   * @param {string} string The options string.
   * @returns {Array} Returns the new converted array.
   */
  function optionToArray(name, string) {
    return _.compact(_.invoke((optionToValue(name, string) || '').split(/, */), 'trim'));
  }

  /**
   * Extracts the option value from an option string.
   *
   * @private
   * @param {string} name The name of the option to inspect.
   * @param {string} string The options string.
   * @returns {string|undefined} Returns the option value, else `undefined`.
   */
  function optionToValue(name, string) {
    var result = (result = string.match(RegExp('^' + name + '(?:=([\\s\\S]+))?$'))) && (result[1] ? result[1].trim() : true);
    if (result === 'false') {
      return false;
    }
    return result || undefined;
  }

  /*--------------------------------------------------------------------------*/

  function check() {
    request.post('https://saucelabs.com/rest/v1/' + this.user + '/js-tests/status', {
      'auth': { 'user': this.user, 'pass': this.pass },
      'json': { 'js tests': [this.id] }
    }, onCheck.bind(this));
  }

  function onCheck(error, response, body) {
    var data = _.result(body, 'js tests', [{ 'status': 'test error' }])[0],
        result = data.result,
        failures = _.result(result, 'failed'),
        statusCode = _.result(response, 'statusCode');

    if (error || statusCode != 200 || data.status == 'test error') {
      logInline('');
      console.error('Failed to check test status on Sauce Labs; status: %d, body:\n%s', statusCode, JSON.stringify(body));
      if (error) {
        console.error(error);
      }
      process.exit(4);
    }
    if (!_.result(body, 'completed')) {
      setTimeout(check.bind(this), statusInterval);
      return;
    }
    if (!result || failures || reError.test(result.message)) {
      if (this.attempts < maxRetries) {
        this.attempts++;
        this.run();
        return;
      }
      _.assign(this, data, { 'failed': true });

      var details = 'See ' + this.url + ' for details.',
          message = _.result(result, 'message', 'no results available. ' + details),
          platform = JSON.stringify(this.options.platforms[0]);

      logInline('');
      if (failures) {
        console.error('There was %d failures on %s. %s', failures, platform, details);
      } else {
        console.error('Testing on %s failed; %s', platform, message);
      }
    }
    this.emit('complete');
  }

  function onRun(error, response, body) {
    var id = _.result(body, 'js tests', [])[0],
        statusCode = _.result(response, 'statusCode');

    if (error || !id || statusCode != 200) {
      console.error('Failed to submit test to Sauce Labs; status: %d, body:\n%s', statusCode, JSON.stringify(body));
      if (error) {
        console.error(error);
      }
      process.exit(3);
    }
    this.id = id;
    check.call(this);
  }

  /*--------------------------------------------------------------------------*/

  function Job(options) {
    EventEmitter.call(this);
    _.merge(this, { 'attempts': 0, 'options': {} }, options);
    _.defaults(this.options, _.cloneDeep(defaultOptions));
  }

  Job.prototype = _.create(EventEmitter.prototype);

  Job.prototype.run = function() {
    console.log('Starting saucelabs test: %s', JSON.stringify(this.options));
    request.post('https://saucelabs.com/rest/v1/' + this.user + '/js-tests', {
      'auth': { 'user': this.user, 'pass': this.pass },
      'json': this.options
    }, onRun.bind(this));
  };

  /*--------------------------------------------------------------------------*/

  /**
   * Makes a request for Sauce Labs to start the jobs.
   *
   * @private
   */
  function run(platforms) {
    var failed = 0;

    var jobs = _.map(platforms, function(platform) {
      return new Job({
        'user': username,
        'pass': accessKey,
        'options': { 'platforms': [platform] }
      })
    });

    _.invoke(jobs, 'on', 'complete', function() {
      console.log('Test passed on platform: %s', JSON.stringify(this.options.platforms[0]));
      var job = jobs.shift();

      if (_.isEmpty(jobs)) {
        console.log('Shutting down Sauce Connect tunnel...');
        clearInterval(throbberId);
        tunnel.stop(function() {
          process.exit(failed);
        });
      } else {
        failed |= job.failed;
        jobs[0].run();
      }
    });

    throbberId = setInterval(logThrobber, throbberDelay);
    logThrobber();
    jobs[0].run();
  }

  // cleanup any inline logs when exited via `ctrl+c`
  process.on('SIGINT', function() {
    logInline('');
    process.exit();
  });

  // create a web server for the local dir
  var mount = ecstatic({
    'cache': false,
    'root': process.cwd()
  });

  http.createServer(function(req, res) {
    // see http://msdn.microsoft.com/en-us/library/ff955275(v=vs.85).aspx
    if (compatMode && path.extname(url.parse(req.url).pathname) == '.html') {
      res.setHeader('X-UA-Compatible', 'IE=' + compatMode);
    }
    mount(req, res);
  }).listen(port);

  // set up Sauce Connect so we can use this server from Sauce Labs
  var tunnel = new SauceTunnel(username, accessKey, tunnelId, tunneled, tunnelTimeout);

  console.log('Opening Sauce Connect tunnel...');

  tunnel.start(function(success) {
    if (success) {
      console.log('Sauce Connect tunnel opened');
      run(platforms);
    } else {
      console.error('Failed to open Sauce Connect tunnel');
      process.exit(2);
    }
  });
}());
