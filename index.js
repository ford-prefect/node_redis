'use strict';

var net = require('net');
var tls = require('tls');
var util = require('util');
var utils = require('./lib/utils');
var Queue = require('double-ended-queue');
var CommandError = require('./lib/customError');
var Command = require('./lib/command').Command;
var OfflineCommand = require('./lib/command').OfflineCommand;
var EventEmitter = require('events');
var Parser = require('redis-parser');
var commands = require('redis-commands');
var debug = require('./lib/debug');
var unifyOptions = require('./lib/createClient');
var SUBSCRIBE_COMMANDS = {
    subscribe: true,
    unsubscribe: true,
    psubscribe: true,
    punsubscribe: true
};

// Newer Node.js versions > 0.10 return the EventEmitter right away and using .EventEmitter was deprecated
if (typeof EventEmitter !== 'function') {
    EventEmitter = EventEmitter.EventEmitter;
}

function noop () {}

function handle_detect_buffers_reply (reply, command, buffer_args) {
    if (buffer_args === false || this.message_buffers) {
        // If detect_buffers option was specified, then the reply from the parser will be a buffer.
        // If this command did not use Buffer arguments, then convert the reply to Strings here.
        reply = utils.reply_to_strings(reply);
    }

    if (command === 'hgetall') {
        reply = utils.reply_to_object(reply);
    }
    return reply;
}

exports.debug_mode = /\bredis\b/i.test(process.env.NODE_DEBUG);

// Attention: The second parameter might be removed at will and is not officially supported.
// Do not rely on this
function RedisClient (options, stream) {
    // Copy the options so they are not mutated
    options = utils.clone(options);
    EventEmitter.call(this);
    var cnx_options = {};
    var self = this;
    if (stream) {
        // The stream from the outside is used so no connection from this side is triggered but from the server this client should talk to
        // Reconnect etc won't work with this. This requires monkey patching to work, so it is not officially supported
        options.stream = stream;
        this.address = '"Private stream"';
    } else if (options.path) {
        cnx_options.path = options.path;
        this.address = options.path;
    } else {
        cnx_options.port = +options.port || 6379;
        cnx_options.host = options.host || '127.0.0.1';
        cnx_options.family = (!options.family && net.isIP(cnx_options.host)) || (options.family === 'IPv6' ? 6 : 4);
        this.address = cnx_options.host + ':' + cnx_options.port;
    }
    /* istanbul ignore next: travis does not work with stunnel atm. Therefore the tls tests are skipped on travis */
    for (var tls_option in options.tls) { // jshint ignore: line
        cnx_options[tls_option] = options.tls[tls_option];
    }
    // Warn on misusing deprecated functions
    if (typeof options.retry_strategy === 'function') {
        if ('max_attempts' in options) {
            self.warn('WARNING: You activated the retry_strategy and max_attempts at the same time. This is not possible and max_attempts will be ignored.');
            // Do not print deprecation warnings twice
            delete options.max_attempts;
        }
        if ('retry_max_delay' in options) {
            self.warn('WARNING: You activated the retry_strategy and retry_max_delay at the same time. This is not possible and retry_max_delay will be ignored.');
            // Do not print deprecation warnings twice
            delete options.retry_max_delay;
        }
    }

    this.connection_options = cnx_options;
    this.connection_id = RedisClient.connection_id++;
    this.connected = false;
    this.ready = false;
    if (options.socket_nodelay === undefined) {
        options.socket_nodelay = true;
    } else if (!options.socket_nodelay) { // Only warn users with this set to false
        self.warn(
            'socket_nodelay is deprecated and will be removed in v.3.0.0.\n' +
            'Setting socket_nodelay to false likely results in a reduced throughput. Please use .batch for pipelining instead.\n' +
            'If you are sure you rely on the NAGLE-algorithm you can activate it by calling client.stream.setNoDelay(false) instead.'
        );
    }
    if (options.socket_keepalive === undefined) {
        options.socket_keepalive = true;
    }
    for (var command in options.rename_commands) { // jshint ignore: line
        options.rename_commands[command.toLowerCase()] = options.rename_commands[command];
    }
    options.return_buffers = !!options.return_buffers;
    options.detect_buffers = !!options.detect_buffers;
    // Override the detect_buffers setting if return_buffers is active and print a warning
    if (options.return_buffers && options.detect_buffers) {
        self.warn('WARNING: You activated return_buffers and detect_buffers at the same time. The return value is always going to be a buffer.');
        options.detect_buffers = false;
    }
    if (options.detect_buffers) {
        // We only need to look at the arguments if we do not know what we have to return
        this.handle_reply = handle_detect_buffers_reply;
    }
    this.should_buffer = false;
    this.max_attempts = options.max_attempts | 0;
    if ('max_attempts' in options) {
        self.warn(
            'max_attempts is deprecated and will be removed in v.3.0.0.\n' +
            'To reduce the amount of options and the improve the reconnection handling please use the new `retry_strategy` option instead.\n' +
            'This replaces the max_attempts and retry_max_delay option.'
        );
    }
    this.command_queue = new Queue(); // Holds sent commands to de-pipeline them
    this.offline_queue = new Queue(); // Holds commands issued but not able to be sent
    this.pipeline_queue = new Queue(); // Holds all pipelined commands
    // ATTENTION: connect_timeout should change in v.3.0 so it does not count towards ending reconnection attempts after x seconds
    // This should be done by the retry_strategy. Instead it should only be the timeout for connecting to redis
    this.connect_timeout = +options.connect_timeout || 3600000; // 60 * 60 * 1000 ms
    this.enable_offline_queue = options.enable_offline_queue === false ? false : true;
    this.retry_max_delay = +options.retry_max_delay || null;
    if ('retry_max_delay' in options) {
        self.warn(
            'retry_max_delay is deprecated and will be removed in v.3.0.0.\n' +
            'To reduce the amount of options and the improve the reconnection handling please use the new `retry_strategy` option instead.\n' +
            'This replaces the max_attempts and retry_max_delay option.'
        );
    }
    this.initialize_retry_vars();
    this.pub_sub_mode = 0;
    this.subscription_set = {};
    this.monitoring = false;
    this.message_buffers = false;
    this.closing = false;
    this.server_info = {};
    this.auth_pass = options.auth_pass || options.password;
    this.selected_db = options.db; // Save the selected db here, used when reconnecting
    this.old_state = null;
    this.fire_strings = true; // Determine if strings or buffers should be written to the stream
    this.pipeline = false;
    this.sub_commands_left = 0;
    this.times_connected = 0;
    this.options = options;
    this.buffers = options.return_buffers || options.detect_buffers;
    this.reply = 'ON'; // Returning replies is the default
    // Init parser
    this.reply_parser = create_parser(this, options);
    this.create_stream();
    // The listeners will not be attached right away, so let's print the deprecation message while the listener is attached
    this.on('newListener', function (event) {
        if (event === 'idle') {
            this.warn(
                'The idle event listener is deprecated and will likely be removed in v.3.0.0.\n' +
                'If you rely on this feature please open a new ticket in node_redis with your use case'
            );
        } else if (event === 'drain') {
            this.warn(
                'The drain event listener is deprecated and will be removed in v.3.0.0.\n' +
                'If you want to keep on listening to this event please listen to the stream drain event directly.'
            );
        } else if (event === 'message_buffer' || event === 'pmessage_buffer' || event === 'messageBuffer' || event === 'pmessageBuffer' && !this.buffers) {
            this.message_buffers = true;
            this.handle_reply = handle_detect_buffers_reply;
            this.reply_parser = create_parser(this);
        }
    });
}
util.inherits(RedisClient, EventEmitter);

RedisClient.connection_id = 0;

function create_parser (self) {
    return Parser({
        returnReply: function (data) {
            self.return_reply(data);
        },
        returnError: function (err) {
            self.return_error(err);
        },
        returnFatalError: function (err) {
            // Error out all fired commands. Otherwise they might rely on faulty data. We have to reconnect to get in a working state again
            self.flush_and_error(err, ['command_queue']);
            self.stream.destroy();
            self.return_error(err);
        },
        returnBuffers: self.buffers || self.message_buffers,
        name: self.options.parser,
        stringNumbers: self.options.string_numbers
    });
}

/******************************************************************************

    All functions in here are internal besides the RedisClient constructor
    and the exported functions. Don't rely on them as they will be private
    functions in node_redis v.3

******************************************************************************/

// Attention: the function name "create_stream" should not be changed, as other libraries need this to mock the stream (e.g. fakeredis)
RedisClient.prototype.create_stream = function () {
    var self = this;

    if (this.options.stream) {
        // Only add the listeners once in case of a reconnect try (that won't work)
        if (this.stream) {
            return;
        }
        this.stream = this.options.stream;
    } else {
        // On a reconnect destroy the former stream and retry
        if (this.stream) {
            this.stream.removeAllListeners();
            this.stream.destroy();
        }

        /* istanbul ignore if: travis does not work with stunnel atm. Therefore the tls tests are skipped on travis */
        if (this.options.tls) {
            this.stream = tls.connect(this.connection_options);
        } else {
            this.stream = net.createConnection(this.connection_options);
        }
    }

    if (this.options.connect_timeout) {
        this.stream.setTimeout(this.connect_timeout, function () {
            // Note: This is only tested if a internet connection is established
            self.retry_totaltime = self.connect_timeout;
            self.connection_gone('timeout', new Error('Redis connection gone from timeout event'));
        });
    }

    /* istanbul ignore next: travis does not work with stunnel atm. Therefore the tls tests are skipped on travis */
    var connect_event = this.options.tls ? 'secureConnect' : 'connect';
    this.stream.once(connect_event, function () {
        this.removeAllListeners('timeout');
        self.times_connected++;
        self.on_connect();
    });

    this.stream.on('data', function (buffer_from_socket) {
        // The buffer_from_socket.toString() has a significant impact on big chunks and therefore this should only be used if necessary
        debug('Net read ' + self.address + ' id ' + self.connection_id); // + ': ' + buffer_from_socket.toString());
        self.reply_parser.execute(buffer_from_socket);
        self.emit_idle();
    });

    this.stream.on('error', function (err) {
        self.on_error(err);
    });

    /* istanbul ignore next: difficult to test and not important as long as we keep this listener */
    this.stream.on('clientError', function (err) {
        debug('clientError occured');
        self.on_error(err);
    });

    this.stream.once('close', function (hadError) {
        self.connection_gone('close', hadError ? new Error('Stream connection closed with a transmission error') : null);
    });

    this.stream.once('end', function () {
        self.connection_gone('end', null);
    });

    this.stream.on('drain', function () {
        self.drain();
    });

    if (this.options.socket_nodelay) {
        this.stream.setNoDelay();
    }

    // Fire the command before redis is connected to be sure it's the first fired command
    if (this.auth_pass !== undefined) {
        this.ready = true;
        this.auth(this.auth_pass);
        this.ready = false;
    }
};

RedisClient.prototype.handle_reply = function (reply, command) {
    if (command === 'hgetall') {
        reply = utils.reply_to_object(reply);
    }
    return reply;
};

RedisClient.prototype.cork = noop;
RedisClient.prototype.uncork = noop;

RedisClient.prototype.initialize_retry_vars = function () {
    this.retry_timer = null;
    this.retry_totaltime = 0;
    this.retry_delay = 200;
    this.retry_backoff = 1.7;
    this.attempts = 1;
};

RedisClient.prototype.warn = function (msg) {
    var self = this;
    // Warn on the next tick. Otherwise no event listener can be added
    // for warnings that are emitted in the redis client constructor
    process.nextTick(function () {
        if (self.listeners('warning').length !== 0) {
            self.emit('warning', msg);
        } else {
            console.warn('node_redis:', msg);
        }
    });
};

// Flush provided queues, erroring any items with a callback first
RedisClient.prototype.flush_and_error = function (error, queue_names) {
    var callbacks_not_called = [];
    queue_names = queue_names || ['offline_queue', 'command_queue'];
    for (var i = 0; i < queue_names.length; i++) {
        for (var command_obj = this[queue_names[i]].shift(); command_obj; command_obj = this[queue_names[i]].shift()) {
            var err = new CommandError(error);
            err.command = command_obj.command.toUpperCase();
            if (command_obj.args.length) {
                err.args = command_obj.args;
            }
            if (typeof command_obj.callback === 'function') {
                command_obj.callback(err);
            } else {
                callbacks_not_called.push(err);
            }
        }
        this[queue_names[i]] = new Queue();
    }
    // Mutate the original error that will be emitted
    // This is fine, as we don't manipulate any user errors
    if (callbacks_not_called.length !== 0) {
        error.errors = callbacks_not_called;
    }
    return callbacks_not_called.length === 0;
};

RedisClient.prototype.on_error = function (err) {
    if (this.closing) {
        return;
    }

    err.message = 'Redis connection to ' + this.address + ' failed - ' + err.message;
    debug(err.message);
    this.connected = false;
    this.ready = false;

    // Only emit the error if the retry_stategy option is not set
    if (!this.options.retry_strategy) {
        this.emit('error', err);
    }
    // 'error' events get turned into exceptions if they aren't listened for. If the user handled this error
    // then we should try to reconnect.
    this.connection_gone('error', err);
};

RedisClient.prototype.on_connect = function () {
    debug('Stream connected ' + this.address + ' id ' + this.connection_id);

    this.connected = true;
    this.ready = false;
    this.emitted_end = false;
    this.stream.setKeepAlive(this.options.socket_keepalive);
    this.stream.setTimeout(0);

    this.emit('connect');
    this.initialize_retry_vars();

    if (this.options.no_ready_check) {
        this.on_ready();
    } else {
        this.ready_check();
    }
};

RedisClient.prototype.on_ready = function () {
    var self = this;

    debug('on_ready called ' + this.address + ' id ' + this.connection_id);
    this.ready = true;

    this.cork = function () {
        self.pipeline = true;
        if (self.stream.cork) {
            self.stream.cork();
        }
    };
    this.uncork = function () {
        if (self.fire_strings) {
            self.write_strings();
        } else {
            self.write_buffers();
        }
        self.pipeline = false;
        self.fire_strings = true;
        if (self.stream.uncork) {
            // TODO: Consider using next tick here. See https://github.com/NodeRedis/node_redis/issues/1033
            self.stream.uncork();
        }
    };

    // Restore modal commands from previous connection. The order of the commands is important
    if (this.selected_db !== undefined) {
        this.internal_send_command('select', [this.selected_db]);
    }
    if (this.old_state !== null) {
        this.monitoring = this.old_state.monitoring;
        this.pub_sub_mode = this.old_state.pub_sub_mode;
    }
    if (this.monitoring) { // Monitor has to be fired before pub sub commands
        this.internal_send_command('monitor', []); // The state is still set
    }
    var callback_count = Object.keys(this.subscription_set).length;
    if (!this.options.disable_resubscribing && callback_count) {
        // only emit 'ready' when all subscriptions were made again
        // TODO: Remove the countdown for ready here. This is not coherent with all other modes and should therefore not be handled special
        // We know we are ready as soon as all commands were fired
        var callback = function () {
            callback_count--;
            if (callback_count === 0) {
                self.emit('ready');
            }
        };
        debug('Sending pub/sub on_ready commands');
        for (var key in this.subscription_set) { // jshint ignore: line
            var command = key.slice(0, key.indexOf('_'));
            var args = self.subscription_set[key];
            self.internal_send_command(command, [args], callback);
        }
        this.send_offline_queue();
        return;
    }
    this.send_offline_queue();
    this.emit('ready');
};

RedisClient.prototype.on_info_cmd = function (err, res) {
    if (err) {
        if (err.message === "ERR unknown command 'info'") {
            this.on_ready();
            return;
        }
        err.message = 'Ready check failed: ' + err.message;
        this.emit('error', err);
        return;
    }

    /* istanbul ignore if: some servers might not respond with any info data. This is just a safety check that is difficult to test */
    if (!res) {
        debug('The info command returned without any data.');
        this.on_ready();
        return;
    }

    if (!this.server_info.loading || this.server_info.loading === '0') {
        // If the master_link_status exists but the link is not up, try again after 50 ms
        if (this.server_info.master_link_status && this.server_info.master_link_status !== 'up') {
            this.server_info.loading_eta_seconds = 0.05;
        } else {
            // Eta loading should change
            debug('Redis server ready.');
            this.on_ready();
            return;
        }
    }

    var retry_time = +this.server_info.loading_eta_seconds * 1000;
    if (retry_time > 1000) {
        retry_time = 1000;
    }
    debug('Redis server still loading, trying again in ' + retry_time);
    setTimeout(function (self) {
        self.ready_check();
    }, retry_time, this);
};

RedisClient.prototype.ready_check = function () {
    var self = this;
    debug('Checking server ready state...');
    // Always fire this info command as first command even if other commands are already queued up
    this.ready = true;
    this.info(function (err, res) {
        self.on_info_cmd(err, res);
    });
    this.ready = false;
};

RedisClient.prototype.send_offline_queue = function () {
    for (var command_obj = this.offline_queue.shift(); command_obj; command_obj = this.offline_queue.shift()) {
        debug('Sending offline command: ' + command_obj.command);
        this.internal_send_command(command_obj.command, command_obj.args, command_obj.callback, command_obj.call_on_write);
    }
    this.drain();
};

var retry_connection = function (self, error) {
    debug('Retrying connection...');

    var reconnect_params = {
        delay: self.retry_delay,
        attempt: self.attempts,
        error: error
    };
    if (self.options.camel_case) {
        reconnect_params.totalRetryTime = self.retry_totaltime;
        reconnect_params.timesConnected = self.times_connected;
    } else {
        reconnect_params.total_retry_time = self.retry_totaltime;
        reconnect_params.times_connected = self.times_connected;
    }
    self.emit('reconnecting', reconnect_params);

    self.retry_totaltime += self.retry_delay;
    self.attempts += 1;
    self.retry_delay = Math.round(self.retry_delay * self.retry_backoff);
    self.create_stream();
    self.retry_timer = null;
};

RedisClient.prototype.connection_gone = function (why, error) {
    // If a retry is already in progress, just let that happen
    if (this.retry_timer) {
        return;
    }

    debug('Redis connection is gone from ' + why + ' event.');
    this.connected = false;
    this.ready = false;
    // Deactivate cork to work with the offline queue
    this.cork = noop;
    this.uncork = noop;
    this.pipeline = false;

    var state = {
        monitoring: this.monitoring,
        pub_sub_mode: this.pub_sub_mode
    };
    this.old_state = state;
    this.monitoring = false;
    this.pub_sub_mode = 0;

    // since we are collapsing end and close, users don't expect to be called twice
    if (!this.emitted_end) {
        this.emit('end');
        this.emitted_end = true;
    }

    // If this is a requested shutdown, then don't retry
    if (this.closing) {
        debug('Connection ended by quit / end command, not retrying.');
        error = new Error('Stream connection ended and running command aborted. It might have been processed.');
        error.code = 'NR_OFFLINE';
        this.flush_and_error(error);
        return;
    }

    if (typeof this.options.retry_strategy === 'function') {
        var retry_params = {
            attempt: this.attempts,
            error: error
        };
        if (this.options.camel_case) {
            retry_params.totalRetryTime = this.retry_totaltime;
            retry_params.timesConnected = this.times_connected;
        } else {
            retry_params.total_retry_time = this.retry_totaltime;
            retry_params.times_connected = this.times_connected;
        }
        this.retry_delay = this.options.retry_strategy(retry_params);
        if (typeof this.retry_delay !== 'number') {
            // Pass individual error through
            if (this.retry_delay instanceof Error) {
                error = new CommandError(this.retry_delay);
            }
            // Attention: there might be the case where there's no error!
            if (!error) {
                error = new Error('Stream connection ended and running command aborted. It might have been processed.');
                error.code = 'NR_OFFLINE';
            }
            // Only emit an error in case that a running command had no callback
            if (!this.flush_and_error(error)) {
                error.message = 'Stream connection ended and all running commands aborted. They might have been processed.';
                this.emit('error', error);
            }
            this.end(false);
            return;
        }
    }

    if (this.max_attempts !== 0 && this.attempts >= this.max_attempts || this.retry_totaltime >= this.connect_timeout) {
        var message = this.retry_totaltime >= this.connect_timeout ?
            'connection timeout exceeded.' :
            'maximum connection attempts exceeded.';
        error = new Error('Redis connection in broken state: ' + message);
        error.code = 'CONNECTION_BROKEN';
        this.flush_and_error(error);
        this.emit('error', error);
        this.end(false);
        return;
    }

    // Retry commands after a reconnect instead of throwing an error. Use this with caution
    if (this.options.retry_unfulfilled_commands) {
        this.offline_queue.unshift.apply(this.offline_queue, this.command_queue.toArray());
        this.command_queue.clear();
    } else if (this.command_queue.length !== 0) {
        error = new Error('Redis connection lost and command aborted in uncertain state. It might have been processed.');
        error.code = 'UNCERTAIN_STATE';
        if (!this.flush_and_error(error, ['command_queue'])) {
            // Only emit if not all commands had a callback that already handled the error
            error.message = 'Redis connection lost and commands aborted in uncertain state. They might have been processed.';
            this.emit('error', error);
        }
    }

    if (this.retry_max_delay !== null && this.retry_delay > this.retry_max_delay) {
        this.retry_delay = this.retry_max_delay;
    } else if (this.retry_totaltime + this.retry_delay > this.connect_timeout) {
        // Do not exceed the maximum
        this.retry_delay = this.connect_timeout - this.retry_totaltime;
    }

    debug('Retry connection in ' + this.retry_delay + ' ms');

    this.retry_timer = setTimeout(retry_connection, this.retry_delay, this, error);
};

RedisClient.prototype.return_error = function (err) {
    var command_obj = this.command_queue.shift();
    if (command_obj && command_obj.command && command_obj.command.toUpperCase) {
        err.command = command_obj.command.toUpperCase();
        if (command_obj.args.length) {
            err.args = command_obj.args;
        }
    }

    // Count down pub sub mode if in entering modus
    if (this.pub_sub_mode > 1) {
        this.pub_sub_mode--;
    }

    var match = err.message.match(utils.err_code);
    // LUA script could return user errors that don't behave like all other errors!
    if (match) {
        err.code = match[1];
    }

    utils.callback_or_emit(this, command_obj && command_obj.callback, err);
};

RedisClient.prototype.drain = function () {
    this.emit('drain');
    this.should_buffer = false;
};

RedisClient.prototype.emit_idle = function () {
    if (this.command_queue.length === 0 && this.pub_sub_mode === 0) {
        this.emit('idle');
    }
};

function normal_reply (self, reply) {
    var command_obj = self.command_queue.shift();
    if (typeof command_obj.callback === 'function') {
        if (command_obj.command !== 'exec') {
            reply = self.handle_reply(reply, command_obj.command, command_obj.buffer_args);
        }
        command_obj.callback(null, reply);
    } else {
        debug('No callback for reply');
    }
}

function subscribe_unsubscribe (self, reply, type) {
    // Subscribe commands take an optional callback and also emit an event, but only the _last_ response is included in the callback
    // The pub sub commands return each argument in a separate return value and have to be handled that way
    var command_obj = self.command_queue.get(0);
    var buffer = self.options.return_buffers || self.options.detect_buffers && command_obj.buffer_args;
    var channel = (buffer || reply[1] === null) ? reply[1] : reply[1].toString();
    var count = +reply[2]; // Return the channel counter as number no matter if `string_numbers` is activated or not
    debug(type, channel);

    // Emit first, then return the callback
    if (channel !== null) { // Do not emit or "unsubscribe" something if there was no channel to unsubscribe from
        self.emit(type, channel, count);
        if (type === 'subscribe' || type === 'psubscribe') {
            self.subscription_set[type + '_' + channel] = channel;
        } else {
            type = type === 'unsubscribe' ? 'subscribe' : 'psubscribe'; // Make types consistent
            delete self.subscription_set[type + '_' + channel];
        }
    }

    if (command_obj.args.length === 1 || self.sub_commands_left === 1 || command_obj.args.length === 0 && (count === 0 || channel === null)) {
        if (count === 0) { // unsubscribed from all channels
            var running_command;
            var i = 1;
            self.pub_sub_mode = 0; // Deactivating pub sub mode
            // This should be a rare case and therefore handling it this way should be good performance wise for the general case
            while (running_command = self.command_queue.get(i)) {
                if (SUBSCRIBE_COMMANDS[running_command.command]) {
                    self.pub_sub_mode = i; // Entering pub sub mode again
                    break;
                }
                i++;
            }
        }
        self.command_queue.shift();
        if (typeof command_obj.callback === 'function') {
            // TODO: The current return value is pretty useless.
            // Evaluate to change this in v.3 to return all subscribed / unsubscribed channels in an array including the number of channels subscribed too
            command_obj.callback(null, channel);
        }
        self.sub_commands_left = 0;
    } else {
        if (self.sub_commands_left !== 0) {
            self.sub_commands_left--;
        } else {
            self.sub_commands_left = command_obj.args.length ? command_obj.args.length - 1 : count;
        }
    }
}

function return_pub_sub (self, reply) {
    var type = reply[0].toString();
    if (type === 'message') { // channel, message
        if (!self.options.return_buffers || self.message_buffers) { // backwards compatible. Refactor this in v.3 to always return a string on the normal emitter
            self.emit('message', reply[1].toString(), reply[2].toString());
            self.emit('message_buffer', reply[1], reply[2]);
            self.emit('messageBuffer', reply[1], reply[2]);
        } else {
            self.emit('message', reply[1], reply[2]);
        }
    } else if (type === 'pmessage') { // pattern, channel, message
        if (!self.options.return_buffers || self.message_buffers) { // backwards compatible. Refactor this in v.3 to always return a string on the normal emitter
            self.emit('pmessage', reply[1].toString(), reply[2].toString(), reply[3].toString());
            self.emit('pmessage_buffer', reply[1], reply[2], reply[3]);
            self.emit('pmessageBuffer', reply[1], reply[2], reply[3]);
        } else {
            self.emit('pmessage', reply[1], reply[2], reply[3]);
        }
    } else {
        subscribe_unsubscribe(self, reply, type);
    }
}

RedisClient.prototype.return_reply = function (reply) {
    // If in monitor mode, all normal commands are still working and we only want to emit the streamlined commands
    // As this is not the average use case and monitor is expensive anyway, let's change the code here, to improve
    // the average performance of all other commands in case of no monitor mode
    if (this.monitoring) {
        var replyStr;
        if (this.buffers && Buffer.isBuffer(reply)) {
            replyStr = reply.toString();
        } else {
            replyStr = reply;
        }
        // While reconnecting the redis server does not recognize the client as in monitor mode anymore
        // Therefore the monitor command has to finish before it catches further commands
        if (typeof replyStr === 'string' && utils.monitor_regex.test(replyStr)) {
            var timestamp = replyStr.slice(0, replyStr.indexOf(' '));
            var args = replyStr.slice(replyStr.indexOf('"') + 1, -1).split('" "').map(function (elem) {
                return elem.replace(/\\"/g, '"');
            });
            this.emit('monitor', timestamp, args, replyStr);
            return;
        }
    }
    if (this.pub_sub_mode === 0) {
        normal_reply(this, reply);
    } else if (this.pub_sub_mode !== 1) {
        this.pub_sub_mode--;
        normal_reply(this, reply);
    } else if (!(reply instanceof Array) || reply.length <= 2) {
        // Only PING and QUIT are allowed in this context besides the pub sub commands
        // Ping replies with ['pong', null|value] and quit with 'OK'
        normal_reply(this, reply);
    } else {
        return_pub_sub(this, reply);
    }
};

function handle_offline_command (self, command_obj) {
    var command = command_obj.command;
    var callback = command_obj.callback;
    var err, msg;
    if (self.closing || !self.enable_offline_queue) {
        command = command.toUpperCase();
        if (!self.closing) {
            if (self.stream.writable) {
                msg = 'The connection is not yet established and the offline queue is deactivated.';
            } else {
                msg = 'Stream not writeable.';
            }
        } else {
            msg = 'The connection has already been closed.';
        }
        err = new Error(command + " can't be processed. " + msg);
        err.command = command;
        if (command_obj.args.length) {
            err.args = command_obj.args;
        }
        err.code = 'NR_OFFLINE';
        utils.reply_in_order(self, callback, err);
    } else {
        debug('Queueing ' + command + ' for next server connection.');
        self.offline_queue.push(command_obj);
    }
    self.should_buffer = true;
}

// Do not call internal_send_command directly, if you are not absolutly certain it handles everything properly
// e.g. monitor / info does not work with internal_send_command only
RedisClient.prototype.internal_send_command = function (command, args, callback, call_on_write) {
    var arg, prefix_keys, command_obj;
    var i = 0;
    var command_str = '';
    var len = args.length;
    var big_data = false;
    var buffer_args = false;
    var args_copy = new Array(len);

    if (process.domain && callback) {
        callback = process.domain.bind(callback);
    }

    if (this.ready === false || this.stream.writable === false) {
        // Handle offline commands right away
        handle_offline_command(this, new OfflineCommand(command, args, callback, call_on_write));
        return false; // Indicate buffering
    }

    for (i = 0; i < len; i += 1) {
        if (typeof args[i] === 'string') {
            // 30000 seemed to be a good value to switch to buffers after testing and checking the pros and cons
            if (args[i].length > 30000) {
                big_data = true;
                args_copy[i] = new Buffer(args[i], 'utf8');
            } else {
                args_copy[i] = args[i];
            }
        } else if (typeof args[i] === 'object') { // Checking for object instead of Buffer.isBuffer helps us finding data types that we can't handle properly
            if (args[i] instanceof Date) { // Accept dates as valid input
                args_copy[i] = args[i].toString();
            } else if (args[i] === null) {
                this.warn(
                    'Deprecated: The ' + command.toUpperCase() + ' command contains a "null" argument.\n' +
                    'This is converted to a "null" string now and will return an error from v.3.0 on.\n' +
                    'Please handle this in your code to make sure everything works as you intended it to.'
                );
                args_copy[i] = 'null'; // Backwards compatible :/
            } else if (Buffer.isBuffer(args[i])) {
                args_copy[i] = args[i];
                buffer_args = true;
                big_data = true;
            } else {
                this.warn(
                    'Deprecated: The ' + command.toUpperCase() + ' command contains a argument of type ' + args[i].constructor.name + '.\n' +
                    'This is converted to "' + args[i].toString() + '" by using .toString() now and will return an error from v.3.0 on.\n' +
                    'Please handle this in your code to make sure everything works as you intended it to.'
                );
                args_copy[i] = args[i].toString(); // Backwards compatible :/
            }
        } else if (typeof args[i] === 'undefined') {
            this.warn(
                'Deprecated: The ' + command.toUpperCase() + ' command contains a "undefined" argument.\n' +
                'This is converted to a "undefined" string now and will return an error from v.3.0 on.\n' +
                'Please handle this in your code to make sure everything works as you intended it to.'
            );
            args_copy[i] = 'undefined'; // Backwards compatible :/
        } else {
            // Seems like numbers are converted fast using string concatenation
            args_copy[i] = '' + args[i];
        }
    }
    args = null;
    command_obj = new Command(command, args_copy, buffer_args, callback);

    if (this.options.prefix) {
        prefix_keys = commands.getKeyIndexes(command, args_copy);
        for (i = prefix_keys.pop(); i !== undefined; i = prefix_keys.pop()) {
            args_copy[i] = this.options.prefix + args_copy[i];
        }
    }
    if (typeof this.options.rename_commands !== 'undefined' && this.options.rename_commands[command]) {
        command = this.options.rename_commands[command];
    }
    // Always use 'Multi bulk commands', but if passed any Buffer args, then do multiple writes, one for each arg.
    // This means that using Buffers in commands is going to be slower, so use Strings if you don't already have a Buffer.
    command_str = '*' + (len + 1) + '\r\n$' + command.length + '\r\n' + command + '\r\n';

    if (big_data === false) { // Build up a string and send entire command in one write
        for (i = 0; i < len; i += 1) {
            arg = args_copy[i];
            command_str += '$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n';
        }
        debug('Send ' + this.address + ' id ' + this.connection_id + ': ' + command_str);
        this.write(command_str);
    } else {
        debug('Send command (' + command_str + ') has Buffer arguments');
        this.fire_strings = false;
        this.write(command_str);

        for (i = 0; i < len; i += 1) {
            arg = args_copy[i];
            if (typeof arg === 'string') {
                this.write('$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n');
            } else { // buffer
                this.write('$' + arg.length + '\r\n');
                this.write(arg);
                this.write('\r\n');
            }
            debug('send_command: buffer send ' + arg.length + ' bytes');
        }
    }
    if (call_on_write) {
        call_on_write();
    }
    // Handle `CLIENT REPLY ON|OFF|SKIP`
    // This has to be checked after call_on_write
    if (this.reply === 'ON') {
        this.command_queue.push(command_obj);
    } else {
        // Do not expect a reply
        // Does this work in combination with the pub sub mode?
        if (callback) {
            utils.reply_in_order(this, callback, null, undefined, this.command_queue);
        }
        if (this.reply === 'SKIP') {
            this.reply = 'SKIP_ONE_MORE';
        } else if (this.reply === 'SKIP_ONE_MORE') {
            this.reply = 'ON';
        }
    }
    return !this.should_buffer;
};

RedisClient.prototype.write_strings = function () {
    var str = '';
    for (var command = this.pipeline_queue.shift(); command; command = this.pipeline_queue.shift()) {
        // Write to stream if the string is bigger than 4mb. The biggest string may be Math.pow(2, 28) - 15 chars long
        if (str.length + command.length > 4 * 1024 * 1024) {
            this.should_buffer = !this.stream.write(str);
            str = '';
        }
        str += command;
    }
    if (str !== '') {
        this.should_buffer = !this.stream.write(str);
    }
};

RedisClient.prototype.write_buffers = function () {
    for (var command = this.pipeline_queue.shift(); command; command = this.pipeline_queue.shift()) {
        this.should_buffer = !this.stream.write(command);
    }
};

RedisClient.prototype.write = function (data) {
    if (this.pipeline === false) {
        this.should_buffer = !this.stream.write(data);
        return;
    }
    this.pipeline_queue.push(data);
};

Object.defineProperty(exports, 'debugMode', {
    get: function () {
        return this.debug_mode;
    },
    set: function (val) {
        this.debug_mode = val;
    }
});

// Don't officially expose the command_queue directly but only the length as read only variable
Object.defineProperty(RedisClient.prototype, 'command_queue_length', {
    get: function () {
        return this.command_queue.length;
    }
});

Object.defineProperty(RedisClient.prototype, 'offline_queue_length', {
    get: function () {
        return this.offline_queue.length;
    }
});

// Add support for camelCase by adding read only properties to the client
// All known exposed snack_case variables are added here
Object.defineProperty(RedisClient.prototype, 'retryDelay', {
    get: function () {
        return this.retry_delay;
    }
});

Object.defineProperty(RedisClient.prototype, 'retryBackoff', {
    get: function () {
        return this.retry_backoff;
    }
});

Object.defineProperty(RedisClient.prototype, 'commandQueueLength', {
    get: function () {
        return this.command_queue.length;
    }
});

Object.defineProperty(RedisClient.prototype, 'offlineQueueLength', {
    get: function () {
        return this.offline_queue.length;
    }
});

Object.defineProperty(RedisClient.prototype, 'shouldBuffer', {
    get: function () {
        return this.should_buffer;
    }
});

Object.defineProperty(RedisClient.prototype, 'connectionId', {
    get: function () {
        return this.connection_id;
    }
});

Object.defineProperty(RedisClient.prototype, 'serverInfo', {
    get: function () {
        return this.server_info;
    }
});

exports.createClient = function () {
    return new RedisClient(unifyOptions.apply(null, arguments));
};
exports.RedisClient = RedisClient;
exports.print = utils.print;
exports.Multi = require('./lib/multi');

// Add all redis commands / node_redis api to the client
require('./lib/individualCommands');
require('./lib/extendedApi');
require('./lib/commands');
