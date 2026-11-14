import { createRequire } from 'module'; const require = createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { websocketMask, websocketUnmask } = __require("http");
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (websocketMask) {
      module.exports.mask = function(source, mask, output, offset, length) {
        if (length < 24) _mask(source, mask, output, offset, length);
        else websocketMask(source, mask, output, offset, length);
      };
      module.exports.unmask = function(buffer, mask) {
        if (buffer.length < 24) _unmask(buffer, mask);
        else websocketUnmask(buffer, mask);
      };
    } else if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) {
          return dataLength ? [target, data] : [target];
        }
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (!dataLength) return [target];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net2 = __require("net");
    var tls = __require("tls");
    var { randomBytes, createHash } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            if (!options || options.protocols === void 0) {
              protocols = [];
            } else if (Array.isArray(options.protocols)) {
              protocols = options.protocols;
            } else {
              protocols = [options.protocols];
            }
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              if (options.protocols === void 0) {
                protocols = [];
              } else if (Array.isArray(options.protocols)) {
                protocols = options.protocols;
              } else {
                protocols = [options.protocols];
              }
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        this._readyState = _WebSocket.CLOSING;
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        protocols: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const i = opts.path.indexOf(":");
        if (i === -1) {
          opts.socketPath = opts.path;
          opts.path = "";
        } else {
          opts.socketPath = opts.path.slice(0, i);
          opts.path = opts.path.slice(i + 1);
        }
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net2.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net2.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server2 = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server2.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server2, map) {
      for (const event of Object.keys(map)) server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED;
      server2.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server2, req, socket, code, message, headers) {
      if (server2.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server2.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/server.ts
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

// src/probe.ts
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
var SERVICES = [
  { key: "memory", label: "Memory \u8BB0\u5FC6", port: 8001, healthPath: "/health", kind: "http" },
  { key: "painter", label: "Painter \u751F\u56FE", port: 8002, healthPath: "/health", kind: "http" },
  { key: "gamebot", label: "GameBot \u624B\u67C4", port: 8003, healthPath: "/health", kind: "http" },
  { key: "audiocover", label: "AudioCover \u7FFB\u5531", port: 8005, healthPath: "/health", kind: "http" },
  { key: "live", label: "Live-Director \u5F39\u5E55(WS)", port: 9001, kind: "tcp" },
  { key: "indextts", label: "IndexTTS2 \u8BED\u97F3", port: 9881, kind: "tcp" }
];
function probeTcp(port, host = "127.0.0.1", timeoutMs = 2e3) {
  const t0 = Date.now();
  return new Promise((resolve2) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (up, error) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve2({ up, ms: Date.now() - t0, error });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false, `\u8D85\u65F6 ${timeoutMs}ms`));
    sock.once("error", (e) => finish(false, e.message));
    sock.connect(port, host);
  });
}
async function probeHttp(port, path = "/health", timeoutMs = 2e3) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal });
    let detail = "";
    try {
      const j = await r.json();
      if (j && typeof j === "object") {
        const bits = [];
        if (typeof j.ok === "boolean") bits.push(`ok=${j.ok}`);
        if (typeof j.model_loaded === "boolean") bits.push(`model=${j.model_loaded ? "\u5DF2\u52A0\u8F7D" : "\u672A\u52A0\u8F7D"}`);
        if (typeof j.driver_ready === "boolean") bits.push(`driver=${j.driver_ready}`);
        if (typeof j.provider === "string") bits.push(j.provider);
        detail = bits.join(" ");
      }
    } catch {
    }
    return { up: r.ok, ms: Date.now() - t0, detail: detail || void 0 };
  } catch (e) {
    const msg = e.name === "AbortError" ? `\u8D85\u65F6 ${timeoutMs}ms` : e.message;
    return { up: false, ms: Date.now() - t0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
async function probeAll(specs = SERVICES, timeoutMs = 2e3) {
  const tasks = specs.map(async (s) => {
    if (s.kind === "http") {
      const r2 = await probeHttp(s.port, s.healthPath || "/health", timeoutMs);
      return { key: s.key, label: s.label, port: s.port, kind: s.kind, up: r2.up, ms: r2.ms, detail: r2.detail, error: r2.error };
    }
    const r = await probeTcp(s.port, "127.0.0.1", timeoutMs);
    return { key: s.key, label: s.label, port: s.port, kind: s.kind, up: r.up, ms: r.ms, error: r.error };
  });
  const out = await Promise.allSettled(tasks);
  return out.map(
    (r, i) => r.status === "fulfilled" ? r.value : { key: specs[i].key, label: specs[i].label, port: specs[i].port, kind: specs[i].kind, up: false, ms: 0, error: String(r.reason) }
  );
}
function parseNvidiaSmi(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(",").map((x) => x.trim());
    if (parts.length < 4) continue;
    const used = Number(parts[1]);
    const total = Number(parts[2]);
    const util = Number(parts[3]);
    if (!Number.isFinite(used) || !Number.isFinite(total)) continue;
    out.push({ name: parts[0], memUsedMb: used, memTotalMb: total, utilPct: Number.isFinite(util) ? util : 0 });
  }
  return out;
}
function readGpu() {
  return new Promise((resolve2) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 3e3, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve2({ gpus: [], error: err.message.split("\n")[0] });
        resolve2({ gpus: parseNvidiaSmi(String(stdout || "")) });
      }
    );
  });
}
async function readHostInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedMb = Math.round((total - free) / 1024 / 1024);
  const totalMb = Math.round(total / 1024 / 1024);
  const gpu = await readGpu();
  return {
    memUsedMb: usedMb,
    memTotalMb: totalMb,
    memPct: totalMb ? Math.round(usedMb / totalMb * 100) : 0,
    gpus: gpu.gpus,
    gpuError: gpu.error
  };
}

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// src/danmaku.ts
var DEFAULT_DANMAKU_WS = process.env.DANMAKU_WS_URL || "ws://127.0.0.1:9001";
function resolveDanmakuWsUrl() {
  return process.env.DANMAKU_WS_URL || DEFAULT_DANMAKU_WS;
}
function sendTestDanmaku(text, user = "\u9762\u677F\u6307\u6325\u5B98", opts = {}) {
  const url = opts.url || resolveDanmakuWsUrl();
  const timeoutMs = opts.timeoutMs ?? 5e3;
  const t0 = Date.now();
  return new Promise((resolve2) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        ws.terminate();
      } catch {
      }
      resolve2({ ...r, ms: Date.now() - t0 });
    };
    let ws;
    try {
      ws = new wrapper_default(url);
    } catch (e) {
      return resolve2({ ok: false, error: e.message, ms: Date.now() - t0 });
    }
    const timer = setTimeout(() => finish({ ok: false, error: `\u7B49\u5F85\u56DE\u5305\u8D85\u65F6\uFF08${timeoutMs}ms\uFF09` }), timeoutMs);
    ws.on("open", () => {
      ws.send(JSON.stringify({ user, text, gift: 0 }));
    });
    ws.on("message", (raw) => {
      clearTimeout(timer);
      let parsed = String(raw);
      try {
        parsed = JSON.parse(String(raw));
      } catch {
      }
      finish({ ok: true, reply: parsed });
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    });
    ws.on("close", () => {
      clearTimeout(timer);
      finish({ ok: false, error: "\u8FDE\u63A5\u88AB\u5173\u95ED\uFF0C\u6CA1\u6536\u5230\u56DE\u5305" });
    });
  });
}

// src/events.ts
var EventHub = class {
  clients = /* @__PURE__ */ new Set();
  /** 最近若干条事件，供新连接的页面补历史（/api/event/recent） */
  recent = [];
  /** 新客户端接入 SSE */
  addClient(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write(`event: hello
data: ${JSON.stringify({ ok: true })}

`);
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });
  }
  get clientCount() {
    return this.clients.size;
  }
  /** 广播一条事件；失败静默（页面刷新时连接会短暂失效） */
  publish(ev) {
    const e = { ...ev, at: ev.at ?? Date.now() };
    this.recent.push(e);
    if (this.recent.length > 50) this.recent.shift();
    const payload = `event: panel
data: ${JSON.stringify(e)}

`;
    for (const c of this.clients) {
      try {
        c.write(payload);
      } catch {
        this.clients.delete(c);
      }
    }
  }
  recentEvents() {
    return this.recent.slice();
  }
  closeAll() {
    for (const c of this.clients) {
      try {
        c.end();
      } catch {
      }
    }
    this.clients.clear();
  }
};

// src/server.ts
var LOG_TAG = "[dsh-control-center]";
var hub = new EventHub();
var CONTROL_API = (process.env.SERVICE_CTL_URL || "http://127.0.0.1:8010").replace(/\/+$/, "");
var PAINT_BOARD_PATH = String(process.env.PAINT_BOARD_PATH || "").trim();
var ASSETS_DIR = resolve(process.env.CONTROL_ASSETS_DIR || join(process.cwd(), "web", "assets"));
var MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};
var DEFAULT_PORT = Number(process.env.CONTROL_CENTER_PORT) || 8088;
async function collectSnapshot() {
  const [services, host] = await Promise.all([probeAll(), readHostInfo()]);
  return { at: Date.now(), services, host };
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function readBody(req, limit = 65536) {
  return new Promise((resolve2, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function startControlCenter(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const page = opts.page ?? (() => "<!doctype html><title>dsh-control-center</title><h1>page not provided</h1>");
  const server2 = createServer(async (req, res) => {
    try {
      const url = req.url || "/";
      if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
        const html = page();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(html);
      }
      if (req.method === "GET" && url === "/health") return json(res, 200, { ok: true, service: "dsh-control-center" });
      if (req.method === "GET" && url.startsWith("/api/event/stream")) {
        return hub.addClient(res);
      }
      if (req.method === "GET" && url.startsWith("/api/event/recent")) {
        return json(res, 200, { ok: true, events: hub.recentEvents() });
      }
      if (req.method === "POST" && url === "/api/event") {
        const raw = await readBody(req);
        let ev;
        try {
          ev = JSON.parse(raw || "{}");
        } catch {
          return json(res, 400, { ok: false, error: "JSON \u89E3\u6790\u5931\u8D25" });
        }
        if (!ev || typeof ev.type !== "string") return json(res, 400, { ok: false, error: "\u7F3A\u5C11 type" });
        hub.publish(ev);
        return json(res, 200, { ok: true, listeners: hub.clientCount });
      }
      if (req.method === "GET" && url.startsWith("/api/latest-paint")) {
        if (!PAINT_BOARD_PATH) return json(res, 404, { ok: false, error: "\u672A\u914D\u7F6E PAINT_BOARD_PATH" });
        try {
          const st = await stat(PAINT_BOARD_PATH);
          if (!st.isFile()) return json(res, 404, { ok: false, error: "\u4E0D\u662F\u6587\u4EF6" });
          const buf = await readFile(PAINT_BOARD_PATH);
          res.writeHead(200, {
            "content-type": MIME[extname(PAINT_BOARD_PATH).toLowerCase()] || "application/octet-stream",
            "cache-control": "no-store",
            "x-paint-mtime": String(Math.round(st.mtimeMs))
          });
          return res.end(buf);
        } catch {
          return json(res, 404, { ok: false, error: "\u753B\u677F\u6587\u4EF6\u4E0D\u5B58\u5728" });
        }
      }
      if (url.startsWith("/api/control")) {
        const sub = url.slice("/api/control".length) || "/health";
        try {
          const r = await fetch(`${CONTROL_API}${sub}`, { method: req.method === "POST" ? "POST" : "GET", signal: AbortSignal.timeout(2e4) });
          const body = await r.text();
          res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          return res.end(body);
        } catch (e) {
          return json(res, 502, { ok: false, error: `\u63A7\u5236\u63A5\u53E3\u4E0D\u53EF\u7528\uFF08${CONTROL_API}\uFF09\uFF1A${e.message}` });
        }
      }
      if (req.method === "GET" && url.startsWith("/assets/")) {
        const rel = decodeURIComponent(url.slice("/assets/".length).split("?")[0]);
        const abs = resolve(join(ASSETS_DIR, normalize(rel)));
        if (!abs.startsWith(ASSETS_DIR)) return json(res, 403, { ok: false, error: "forbidden" });
        try {
          const buf = await readFile(abs);
          res.writeHead(200, { "content-type": MIME[extname(abs).toLowerCase()] || "application/octet-stream" });
          return res.end(buf);
        } catch {
          return json(res, 404, { ok: false, error: "not found" });
        }
      }
      if (req.method === "GET" && url.startsWith("/api/status")) {
        const snap = await collectSnapshot();
        return json(res, 200, snap);
      }
      if (req.method === "POST" && url === "/api/danmaku") {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return json(res, 400, { ok: false, error: "JSON \u89E3\u6790\u5931\u8D25" });
        }
        const text = String(body.text || "").trim();
        if (!text) return json(res, 400, { ok: false, error: "text \u4E0D\u80FD\u4E3A\u7A7A" });
        const reply = await sendTestDanmaku(text, String(body.user || "\u9762\u677F\u6307\u6325\u5B98"));
        return json(res, reply.ok ? 200 : 502, { ...reply, target: resolveDanmakuWsUrl() });
      }
      return json(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      console.error(`${LOG_TAG} \u5904\u7406\u5931\u8D25\uFF1A${e.message}`);
      return json(res, 500, { ok: false, error: e.message });
    }
  });
  return new Promise((resolve2, reject) => {
    server2.on("error", reject);
    server2.listen(port, "127.0.0.1", () => {
      const actual = server2.address().port;
      console.log(`${LOG_TAG} \u9762\u677F\u5DF2\u542F\u52A8 http://127.0.0.1:${actual}`);
      resolve2({
        port: actual,
        close: () => new Promise((r) => {
          hub.closeAll();
          server2.close(() => r());
        })
      });
    });
  });
}

// src/page.generated.ts
var PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PERSONA-OS // \u9CB8\u9C7C\u6307\u6325\u8231</title>
<style>
  :root{
    --deep:#0A1128; --panel:#1B263B;
    --cyan:#00F0FF; --white:#FFFFFF; --sea:#5BC0BE;
    --ok:#3ef0a0; --bad:#ff4d6d; --dim:#6b7f99; --warn:#ffc43d;
  }
  *{box-sizing:border-box;image-rendering:pixelated}
  html,body{height:100%;overflow:hidden}
  body{
    margin:0;background:var(--deep);color:var(--white);
    font-family:"VT323","Zpix","Cascadia Mono",Consolas,"Microsoft YaHei",monospace;
    font-size:14px;letter-spacing:.02em;
    background-image:
      repeating-linear-gradient(0deg,rgba(0,240,255,.03) 0 1px,transparent 1px 3px),
      linear-gradient(rgba(0,240,255,.055) 1px,transparent 1px),
      linear-gradient(90deg,rgba(0,240,255,.055) 1px,transparent 1px),
      radial-gradient(900px 500px at 15% -10%,#122a52 0%,transparent 60%),
      radial-gradient(700px 400px at 100% 0%,#1a1a4a 0%,transparent 55%);
    background-size:auto, 32px 32px, 32px 32px, auto, auto;
  }
  body::after{
    content:"";position:fixed;inset:0;pointer-events:none;opacity:.05;z-index:99999;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'><rect width='1' height='1' fill='white'/><rect x='2' y='2' width='1' height='1' fill='white'/></svg>");
  }

  /* ---------- \u9876\u680F ---------- */
  header{
    display:flex;align-items:center;gap:10px;padding:6px 12px;height:42px;
    border-bottom:3px solid var(--cyan);background:rgba(27,38,59,.9);
    box-shadow:0 0 14px rgba(0,240,255,.3);position:relative;z-index:5000;
  }
  .burger{width:32px;height:26px;display:flex;flex-direction:column;justify-content:center;gap:4px;
    padding:0 6px;border:2px solid var(--cyan);background:transparent;cursor:pointer}
  .burger span{display:block;height:2px;background:var(--cyan)}
  .burger:active{transform:translate(2px,2px)}
  h1{margin:0;font-size:16px;letter-spacing:.2em;color:var(--cyan);text-shadow:0 0 8px rgba(0,240,255,.6)}
  header .spacer{flex:1}
  .wsbadge{font-size:12px;padding:1px 7px;border:2px solid var(--bad);color:var(--bad);letter-spacing:.1em}
  .wsbadge.on{border-color:var(--ok);color:var(--ok)}
  header .clock{color:var(--sea);font-size:13px}

  /* ---------- \u2630 \u83DC\u5355 ---------- */
  #drawer{position:fixed;left:0;top:42px;width:280px;z-index:6000;display:none;
    border:3px solid var(--cyan);border-left:none;background:rgba(10,17,40,.98);
    box-shadow:6px 6px 0 rgba(0,240,255,.25);padding:12px}
  #drawer.open{display:block}
  #drawer h3{margin:0 0 10px;font-size:13px;letter-spacing:.18em;color:var(--sea)}
  .dbtn{display:block;width:100%;text-align:left;margin-bottom:8px;padding:8px 10px;cursor:pointer;
    border:2px solid var(--cyan);background:rgba(0,240,255,.08);color:var(--white);font:inherit;font-size:14px}
  .dbtn:hover{background:rgba(0,240,255,.2)}
  .dbtn:active{transform:translate(2px,2px)}
  .dbtn small{display:block;color:var(--dim);font-size:11px;margin-top:2px}
  .dbtn.danger{border-color:var(--bad);background:rgba(255,77,109,.1)}
  #drawer .note{font-size:11px;color:var(--dim);line-height:1.5;margin-top:8px}

  /* ---------- \u684C\u9762\u56FE\u6807 ---------- */
  #dock{position:fixed;left:12px;bottom:12px;z-index:4000;display:flex;flex-direction:row;gap:8px}
  .dockicon{
    width:78px;padding:8px 4px;text-align:center;cursor:pointer;user-select:none;
    border:2px solid rgba(0,240,255,.45);background:rgba(10,17,40,.82);
    font-size:12px;color:var(--sea);transition:background .12s;
  }
  .dockicon:hover{background:rgba(0,240,255,.18);border-color:var(--cyan)}
  .dockicon .glyph{font-size:22px;line-height:1.1;color:var(--cyan);display:block}
  .dockicon.active{border-color:var(--white);color:var(--white)}
  .dockicon.active .glyph{color:var(--white)}

  /* ---------- \u7A97\u53E3 ---------- */
  .win{
    position:fixed;display:none;flex-direction:column;z-index:100;
    border:3px solid var(--cyan);background:var(--panel);
    box-shadow:0 0 14px rgba(0,240,255,.22),0 8px 30px rgba(0,0,0,.55);
    min-width:220px;min-height:130px;
  }
  .win.open{display:flex}
  .win.min{padding-bottom:0}
  .win.min .win-body{display:none}
  .win.max{left:0!important;top:0!important;width:100vw!important;height:100vh!important}
  .win-bar{
    display:flex;align-items:center;gap:8px;padding:3px 4px 3px 10px;cursor:move;user-select:none;
    background:rgba(0,240,255,.15);border-bottom:2px solid var(--cyan);flex:none;height:28px;
  }
  .win-bar .title{flex:1;font-size:12px;letter-spacing:.14em;color:var(--sea);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .win-bar button{
    font:inherit;font-size:13px;line-height:1;width:22px;height:20px;padding:0;cursor:pointer;
    background:transparent;border:2px solid var(--cyan);color:var(--cyan);
  }
  .win-bar button:hover{background:var(--cyan);color:var(--deep)}
  .win-bar button.close:hover{background:var(--bad);border-color:var(--bad);color:#fff}
  .win-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;position:relative}

  /* \u7ACB\u7ED8\u7A97 */
  #win-avatar .win-body{
    align-items:center;justify-content:center;cursor:pointer;
    background:
      radial-gradient(ellipse 70% 45% at 50% 85%, rgba(0,240,255,.16) 0%, transparent 70%),
      repeating-linear-gradient(0deg,rgba(93,192,190,.07) 0 2px,transparent 2px 6px),
      linear-gradient(180deg,#061024 0%,#0A1128 55%,#0d2540 100%);
  }
  #win-avatar .win-body::before{  /* \u6D77\u5E95\u5149\u6655 */
    content:"";position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(circle at 50% 18%, rgba(90,200,255,.16) 0%, transparent 42%);
  }
  #avatarStage{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;
    transform:translate(var(--look-x,0px),var(--look-y,0px));transition:transform .18s ease-out;position:relative;z-index:1}
  #avatarImg{height:92%;width:auto;max-width:92%;object-fit:contain;object-position:center bottom;
    display:block;animation:breathe 3.6s ease-in-out infinite}
  #avatarStage.talking #avatarImg{animation:talkBob .15s steps(2,end) infinite}
  @keyframes breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
  @keyframes talkBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
  #win-avatar.speaking{border-color:var(--white);animation:speakPulse .55s steps(2,end) infinite}
  @keyframes speakPulse{0%,100%{box-shadow:0 0 10px rgba(0,240,255,.35)}50%{box-shadow:0 0 26px 6px rgba(255,255,255,.7)}}
  .fallback{color:var(--dim);font-size:12px;text-align:center;padding:14px;position:relative;z-index:1}

  /* \u72B6\u6001\u7A97 */
  #win-status .win-body{padding:10px 8px 8px;overflow:auto}
  .leds{display:grid;grid-template-columns:1fr 1fr;gap:5px}
  .led{display:flex;align-items:center;gap:6px;padding:3px 6px;border:2px solid rgba(0,240,255,.22);background:rgba(0,0,0,.25)}
  .led i{width:8px;height:8px;background:var(--bad);flex:none}
  .led i.up{background:var(--ok);animation:ledBreath 1.8s steps(2,end) infinite}
  .led i.down{animation:ledBlink 1.2s steps(2,end) infinite}
  @keyframes ledBreath{0%,100%{box-shadow:0 0 0 rgba(62,240,160,.8)}50%{box-shadow:0 0 8px 2px rgba(62,240,160,.8)}}
  @keyframes ledBlink{50%{opacity:.2}}
  .led b{font-weight:400;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .led em{font-style:normal;color:var(--dim);font-size:11px;margin-left:auto}
  .meters{margin-top:8px}
  .meter{margin-top:5px}
  .meter .lbl{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-bottom:2px}
  .meter .bar{height:7px;border:2px solid rgba(0,240,255,.4);background:#08101f}
  .meter .bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--sea),var(--cyan));width:0%}

  /* \u5F39\u5E55\u7A97 */
  #win-console .win-body{padding:8px 8px 8px}
  #feed{flex:1;overflow:auto;background:#04070f;border:2px solid rgba(0,240,255,.22);padding:8px;font-size:13px;line-height:1.45;min-height:0}
  #feed .row{margin-bottom:4px;word-break:break-all;white-space:pre-wrap}
  #feed .me{color:var(--cyan)}
  #feed .bot{color:var(--ok)}
  #feed .err{color:var(--bad)}
  #feed .sys{color:var(--dim)}
  .cmd{display:flex;gap:6px;margin-top:6px;flex:none}
  .cmd input{flex:1;font:inherit;font-size:14px;padding:6px 8px;color:var(--white);
    background:#04070f;border:2px solid var(--cyan);outline:none;min-width:0}
  .cmd input:focus{box-shadow:0 0 10px rgba(0,240,255,.4)}
  .cmd button{font:inherit;font-size:13px;padding:6px 12px;cursor:pointer;color:var(--deep);
    background:var(--cyan);border:2px solid var(--cyan);white-space:nowrap}
  .cmd button:hover{background:var(--white)}
  .cmd button:disabled{opacity:.45;cursor:default}

  /* \u753B\u677F\u7A97 */
  #win-paint .win-body{padding:8px;background:#03060c}
  .crt{position:relative;flex:1;background:#03060c;overflow:hidden;min-height:0}
  .crt img{width:100%;height:100%;object-fit:contain;display:block}
  .crt::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:2;opacity:.22;
    background:repeating-linear-gradient(0deg,rgba(0,0,0,.55) 0 2px,transparent 2px 4px)}
  .crt::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:3;
    box-shadow:inset 0 0 50px rgba(0,0,0,.8)}
  .crt .hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:var(--dim);font-size:13px;letter-spacing:.12em;z-index:1}

  /* ---------- \u9501\u5B9A\u5E03\u5C40\u6309\u94AE\uFF08\u53F3\u4E0B\u89D2\uFF09 ---------- */
  #lockBtn{
    position:fixed;right:12px;bottom:12px;z-index:4100;cursor:pointer;
    padding:6px 10px;font:inherit;font-size:12px;letter-spacing:.1em;
    border:2px solid var(--cyan);background:rgba(10,17,40,.9);color:var(--cyan);
  }
  #lockBtn:hover{background:rgba(0,240,255,.2)}
  #lockBtn.locked{border-color:var(--warn);color:var(--warn);background:rgba(255,196,61,.14)}

  /* ---------- \u76F4\u64AD\u6A21\u5F0F\uFF08OBS \u6D4F\u89C8\u5668\u6E90\uFF09\uFF1A?mode=live ---------- */
  body.live{
    background:none !important;          /* \u53BB\u6389\u50CF\u7D20\u7F51\u683C\u4E0E\u6DF1\u6D77\u6E10\u53D8 */
    background-image:none !important;
    background-color:transparent !important;
  }
  body.live::after{display:none}          /* \u53BB\u6389\u566A\u70B9\u5C42 */
  body.live header{display:none}          /* \u9876\u680F\u4E0D\u8981 */
  body.live #dock{display:none}           /* \u684C\u9762\u56FE\u6807\u4E0D\u8981 */
  body.live #drawer{display:none !important}
  body.live #lockBtn{display:none}
  body.live .win{
    background:transparent;
    border-color:transparent;
    box-shadow:none;
    backdrop-filter:none;
  }
  body.live .win-bar{
    background:transparent;
    border-bottom:none;
    height:0; padding:0; overflow:hidden; cursor:default;
  }
  body.live .win-body{background:transparent}
  /* \u76F4\u64AD\u6A21\u5F0F\u4E0B\u5404\u7A97\u53E3\u7684"\u5E95\u8272"\u4E5F\u8981\u900F\u660E\uFF0C\u53EA\u7559\u5185\u5BB9\u672C\u8EAB */
  body.live #win-console #feed,
  body.live #win-status .win-body,
  body.live #win-paint .win-body{background:transparent;border-color:transparent}
  body.live #win-avatar .win-body{background:none}
  body.live #win-avatar .win-body::before{display:none}
  body.live .led{background:rgba(10,17,40,.55);border-color:rgba(0,240,255,.35)}
  body.live #feed{background:rgba(4,7,15,.55);border-color:rgba(0,240,255,.3)}
  body.live .crt::before,body.live .crt::after{display:none}

  /* ---------- \u5E03\u5C40\u9501\u5B9A\uFF1A\u7981\u7528\u62D6\u62FD\u4E0E\u6309\u94AE ---------- */
  body.locked .win-bar{cursor:default}
  body.locked .win-bar button{pointer-events:none;opacity:.35}
  body.locked #lockBtn{pointer-events:auto}
</style>
</head>
<body>
<header>
  <button class="burger" id="burger" title="\u83DC\u5355"><span></span><span></span><span></span></button>
  <h1>PERSONA-OS // \u9CB8\u9C7C\u6307\u6325\u8231</h1>
  <span class="spacer"></span>
  <span class="wsbadge" id="wsBadge">[WS \u79BB\u7EBF]</span>
  <span class="clock" id="clock">--:--:--</span>
</header>

<div id="drawer">
  <h3>// \u8230\u6865\u63A7\u5236</h3>
  <button class="dbtn danger" id="btnRestart" data-name="IndexTTS2">\u91CD\u542F TTS<small>POST :8010/restart?name=IndexTTS2</small></button>
  <button class="dbtn danger" id="btnRestartPainter" data-name="Painter">\u91CD\u542F Painter<small>POST :8010/restart?name=Painter</small></button>
  <button class="dbtn" id="btnStartAll">\u62C9\u8D77\u5168\u90E8\u5FAE\u670D\u52A1<small>POST :8010/start-all</small></button>
  <button class="dbtn" id="btnClearFeed">\u6E05\u7A7A\u5F39\u5E55\u6D41<small>\u7EAF\u524D\u7AEF</small></button>
  <button class="dbtn" id="btnRawStatus">\u67E5\u770B /api/status<small>\u6392\u67E5\u7528</small></button>
  <div class="note" id="ctlNote">\u63A7\u5236\u63A5\u53E3\u672A\u63A2\u6D4B</div>
</div>

<!-- \u9501\u5B9A\u5E03\u5C40\uFF08\u53F3\u4E0B\u89D2\uFF09 -->
<button id="lockBtn" title="\u9501\u5B9A\u540E\u7981\u7528\u62D6\u62FD\uFF0C\u9632\u6B62\u76F4\u64AD\u8BEF\u89E6">\u{1F512} \u9501\u5B9A\u5E03\u5C40</button>

<!-- \u684C\u9762\u56FE\u6807 -->
<div id="dock">
  <div class="dockicon" data-win="win-avatar"><span class="glyph">\u25C8</span>\u7ACB\u7ED8</div>
  <div class="dockicon" data-win="win-console"><span class="glyph">\u25A4</span>\u5F39\u5E55</div>
  <div class="dockicon" data-win="win-status"><span class="glyph">\u25A6</span>\u72B6\u6001</div>
  <div class="dockicon" data-win="win-paint"><span class="glyph">\u25A3</span>\u753B\u677F</div>
</div>

<!-- \u7A97\u53E3 1\uFF1A\u7ACB\u7ED8 -->
<div class="win" id="win-avatar" data-title="LIVE FEED">
  <div class="win-bar"><span class="title">LIVE FEED</span>
    <button data-act="min" title="\u6700\u5C0F\u5316">\u2014</button>
    <button data-act="max" title="\u6700\u5927\u5316">\u25A1</button>
    <button data-act="close" class="close" title="\u5173\u95ED">\u2715</button>
  </div>
  <div class="win-body">
    <div id="avatarStage">
      <img id="avatarImg" src="/assets/expr/pixel_smile.png" alt=""
           onerror="this.style.display='none';document.getElementById('avatarFallback').style.display='block'">
    </div>
    <div class="fallback" id="avatarFallback" style="display:none">\u7ACB\u7ED8\u672A\u5C31\u4F4D<br><small>\u68C0\u67E5 web/assets/expr/pixel_*.png</small></div>
  </div>
</div>

<!-- \u7A97\u53E3 2\uFF1A\u5F39\u5E55\u4E3B\u63A7\u53F0 -->
<div class="win" id="win-console" data-title="DANMAKU">
  <div class="win-bar"><span class="title">DANMAKU // \u6307\u6325\u5B98\u6D4B\u8BD5\u53F0</span>
    <button data-act="min" title="\u6700\u5C0F\u5316">\u2014</button>
    <button data-act="max" title="\u6700\u5927\u5316">\u25A1</button>
    <button data-act="close" class="close" title="\u5173\u95ED">\u2715</button>
  </div>
  <div class="win-body">
    <div id="feed"></div>
    <div class="cmd">
      <input id="cmdInput" placeholder="!\u753B \u50CF\u7D20\u98CE\u7684\u732B" autocomplete="off">
      <button id="sendBtn">\u53D1\u9001\u6307\u4EE4</button>
    </div>
  </div>
</div>

<!-- \u7A97\u53E3 3\uFF1A\u670D\u52A1\u72B6\u6001 -->
<div class="win" id="win-status" data-title="SYSTEMS">
  <div class="win-bar"><span class="title">SYSTEMS</span>
    <button data-act="min" title="\u6700\u5C0F\u5316">\u2014</button>
    <button data-act="max" title="\u6700\u5927\u5316">\u25A1</button>
    <button data-act="close" class="close" title="\u5173\u95ED">\u2715</button>
  </div>
  <div class="win-body">
    <div class="leds" id="leds"></div>
    <div class="meters">
      <div class="meter"><div class="lbl"><span>MEMORY</span><span id="memTxt">-</span></div>
        <div class="bar"><i id="memBar"></i></div></div>
      <div id="gpuMeters"></div>
    </div>
  </div>
</div>

<!-- \u7A97\u53E3 4\uFF1A\u753B\u677F\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF09 -->
<div class="win" id="win-paint" data-title="PIXEL ART">
  <div class="win-bar"><span class="title" id="artTitle">PIXEL ART</span>
    <button data-act="min" title="\u6700\u5C0F\u5316">\u2014</button>
    <button data-act="max" title="\u6700\u5927\u5316">\u25A1</button>
    <button data-act="close" class="close" title="\u5173\u95ED">\u2715</button>
  </div>
  <div class="win-body">
    <div class="crt">
      <div class="hint" id="artHint">\u7B49\u5F85\u4F5C\u753B\u2026</div>
      <img id="artImg" alt="" style="display:none">
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id)
const feed = $('feed')
let ctlOk = false
function nowStr(){ return new Date().toLocaleTimeString('zh-CN',{hour12:false}) }
setInterval(()=>{ $('clock').textContent = nowStr() }, 1000)

function pushLine(kind, text){
  const d = document.createElement('div')
  d.className = 'row ' + kind
  d.textContent = text
  feed.appendChild(d)
  feed.scrollTop = feed.scrollHeight
  while (feed.children.length > 400) feed.removeChild(feed.firstChild)
}

/* ================= WindowManager\uFF08\u539F\u751F JS\uFF0C\u65E0\u4F9D\u8D56\uFF09 ================= */
const WM = (() => {
  let zTop = 100
  const state = {}                     // id -> {open, min, max, rects}
  const wins = () => Array.from(document.querySelectorAll('.win'))

  function apply(id){
    const el = document.getElementById(id)
    const s = state[id]
    if (!el || !s) return
    el.classList.toggle('open', s.open)
    el.classList.toggle('min', s.min)
    el.classList.toggle('max', s.max)
    if (s.open && !s.max) {
      el.style.left = s.x + 'px'; el.style.top = s.y + 'px'
      el.style.width = s.w + 'px'; el.style.height = s.h + 'px'
    }
    // \u56FE\u6807\u9AD8\u4EAE
    document.querySelectorAll('.dockicon').forEach(ic => {
      ic.classList.toggle('active', ic.dataset.win === id && s.open && !s.min)
    })
  }

  function raise(id){
    const el = document.getElementById(id)
    if (!el) return
    el.style.zIndex = ++zTop
  }

  function open(id, opts = {}){
    const s = state[id]
    if (!s) return
    s.open = true; s.min = false
    if (opts.rect) { s.x = opts.rect.x; s.y = opts.rect.y; s.w = opts.rect.w; s.h = opts.rect.h }
    apply(id); raise(id)
  }
  function close(id){ const s = state[id]; if (!s) return; s.open = false; s.min = false; s.max = false; apply(id) }
  function minimize(id){ const s = state[id]; if (!s) return; s.min = true; apply(id) }
  function toggleMin(id){ const s = state[id]; if (!s) return; if (s.min) { s.min = false; apply(id); raise(id) } else minimize(id) }
  function toggleMax(id){
    const s = state[id]; if (!s) return
    if (!s.max) { s.saved = {x:s.x,y:s.y,w:s.w,h:s.h}; s.max = true }
    else { s.max = false; if (s.saved) Object.assign(s, s.saved) }
    apply(id); raise(id)
  }
  function isOpen(id){ return !!(state[id] && state[id].open && !state[id].min) }

  // \u521D\u59CB\u5316\uFF1A\u4ECE DOM \u7684 data-rect \u8BFB\u9ED8\u8BA4\u4F4D\u7F6E
  function init(){
    wins().forEach(el => {
      const r = (el.dataset.rect || '60,60,380,300').split(',').map(Number)
      const id = el.id
      state[id] = { open:false, min:false, max:false, x:r[0], y:r[1], w:r[2], h:r[3] }
      el.querySelectorAll('.win-bar button').forEach(b => {
        b.addEventListener('mousedown', e => e.stopPropagation())
        b.addEventListener('click', e => {
          e.stopPropagation()
          const act = b.dataset.act
          if (act === 'min') toggleMin(id)
          else if (act === 'max') toggleMax(id)
          else close(id)
        })
      })
      // \u70B9\u7A97\u53E3\u4EFB\u610F\u5904 -> \u7F6E\u9876
      el.addEventListener('mousedown', () => raise(id))
      // \u62D6\u6807\u9898\u680F
      const bar = el.querySelector('.win-bar')
      let drag = null
      bar.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return
        if (document.body.classList.contains('locked')) return   // \u9501\u5B9A\u540E\u7981\u6B62\u62D6\u62FD
        const s = state[id]
        if (s.max) return
        drag = { sx:e.clientX, sy:e.clientY, ox:s.x, oy:s.y }
        e.preventDefault()
      })
      window.addEventListener('mousemove', e => {
        if (!drag) return
        const s = state[id]
        s.x = Math.max(-s.w + 80, Math.min(window.innerWidth - 80, drag.ox + e.clientX - drag.sx))
        s.y = Math.max(42, Math.min(window.innerHeight - 40, drag.oy + e.clientY - drag.sy))
        el.style.left = s.x + 'px'; el.style.top = s.y + 'px'
      })
      window.addEventListener('mouseup', () => { drag = null })
      apply(id)
    })
  }

  // \u684C\u9762\u56FE\u6807\uFF1A\u5355\u51FB\u6253\u5F00 / \u5DF2\u6253\u5F00\u5219\u7F6E\u9876
  document.querySelectorAll('.dockicon').forEach(ic => {
    ic.addEventListener('click', () => {
      const id = ic.dataset.win
      const s = state[id]
      if (!s) return
      if (!s.open) open(id)
      else if (s.min) { s.min = false; apply(id); raise(id) }
      else raise(id)
    })
  })

  return { init, open, close, minimize, toggleMin, toggleMax, isOpen, raise, state }
})()

/* \u9ED8\u8BA4\u5E03\u5C40\uFF08\u7528\u6237\u62CD\u677F\uFF09 */
WM.init()
/* \u56FA\u5B9A\u5E03\u5C40\uFF08\u7528\u6237\u62CD\u677F\uFF0C\u6B64\u540E\u4E0D\u518D\u6539\u52A8\uFF09\uFF1A\u7ACB\u7ED8 400x400 \u5DE6\u4E0A / \u5F39\u5E55 620x420 \u53F3\u4E0A / \u72B6\u6001 380x260 \u5DE6\u4E0B / \u753B\u677F 480x480 \u53F3\u4E0B */
WM.state['win-avatar'].x = 12;  WM.state['win-avatar'].y = 54;  WM.state['win-avatar'].w = 400; WM.state['win-avatar'].h = 400
WM.state['win-console'].x = Math.max(430, window.innerWidth - 650); WM.state['win-console'].y = 54; WM.state['win-console'].w = 620; WM.state['win-console'].h = 420
WM.state['win-status'].x = 12;  WM.state['win-status'].y = Math.max(60, window.innerHeight - 290); WM.state['win-status'].w = 380; WM.state['win-status'].h = 260
WM.state['win-paint'].x = Math.max(430, window.innerWidth - 500); WM.state['win-paint'].y = Math.max(60, window.innerHeight - 500); WM.state['win-paint'].w = 480; WM.state['win-paint'].h = 480
WM.open('win-avatar'); WM.open('win-console')
WM.open('win-status')
// \u753B\u677F\u9ED8\u8BA4\u5173\u95ED\uFF08\u53D1 !\u753B \u65F6\u81EA\u52A8\u5F00\uFF09

/* ================= \u76F4\u64AD\u6A21\u5F0F ?mode=live ================= */
const IS_LIVE = new URLSearchParams(location.search).get('mode') === 'live'
if (IS_LIVE) document.body.classList.add('live')

/* ================= \u9501\u5B9A\u5E03\u5C40 ================= */
let layoutLocked = false
function setLocked(v){
  layoutLocked = v
  document.body.classList.toggle('locked', v)
  const b = $('lockBtn')
  b.classList.toggle('locked', v)
  b.textContent = v ? '\u{1F512} \u5DF2\u9501\u5B9A\uFF08\u70B9\u51FB\u89E3\u9501\uFF09' : '\u{1F513} \u9501\u5B9A\u5E03\u5C40'
}
$('lockBtn').onclick = () => setLocked(!layoutLocked)
// \u76F4\u64AD\u6A21\u5F0F\u4E0B\u9ED8\u8BA4\u9501\u4F4F\uFF0C\u907F\u514D OBS \u91CC\u8BEF\u62D6
if (IS_LIVE) setLocked(true)

/* ================= \u72B6\u6001 ================= */
const LED_MAP = [
  ['memory','Memory :8001'],['painter','Painter :8002'],
  ['audiocover','Audio :8005'],['indextts','TTS :9881'],
  ['live','Director :9001'],['gamebot','GameBot :8003'],
]
function renderLeds(services){
  const box = $('leds')
  if (!box.children.length) {
    box.innerHTML = LED_MAP.map(([k,label]) => \`<div class="led" data-k="\${k}"><i></i><b>\${label}</b><em></em></div>\`).join('')
  }
  for (const [k] of LED_MAP){
    const s = services.find(x => x.key === k)
    const el = box.querySelector(\`[data-k="\${k}"]\`)
    if (!el || !s) continue
    el.querySelector('i').className = s.up ? 'up' : 'down'
    el.querySelector('em').textContent = s.up ? s.ms + 'ms' : 'off'
  }
}
function renderHost(host){
  $('memBar').style.width = host.memPct + '%'
  $('memTxt').textContent = host.memPct + '%'
  const g = $('gpuMeters')
  if (!host.gpus || !host.gpus.length){
    g.innerHTML = \`<div class="meter"><div class="lbl"><span>GPU</span><span>\${host.gpuError ? 'n/a' : '\u65E0'}</span></div></div>\`
    return
  }
  g.innerHTML = host.gpus.map(x => {
    const pct = x.memTotalMb ? Math.round(x.memUsedMb / x.memTotalMb * 100) : 0
    return \`<div class="meter"><div class="lbl"><span>GPU \${x.name.slice(0,18)}</span><span>\${x.memUsedMb}/\${x.memTotalMb} MB</span></div>
      <div class="bar"><i style="width:\${pct}%"></i></div></div>\`
  }).join('')
}
async function pollStatus(){
  try{
    const r = await fetch('/api/status',{cache:'no-store'})
    if(!r.ok) return
    const j = await r.json()
    renderLeds(j.services)
    renderHost(j.host)
  }catch(_){}
}

/* ================= \u753B\u677F ================= */
let lastPaintTag = ''
let artClosedByUser = false
async function pollPaint(){
  try{
    const r = await fetch('/api/latest-paint?tag=' + Date.now(), {cache:'no-store'})
    if (!r.ok) return
    const tag = r.headers.get('x-paint-mtime') || ''
    if (tag && tag === lastPaintTag) return
    lastPaintTag = tag
    const blob = await r.blob()
    const url = URL.createObjectURL(blob)
    const img = $('artImg')
    const old = img.dataset.url
    img.onload = () => { if (old) URL.revokeObjectURL(old) }
    img.dataset.url = url
    img.src = url
    img.style.display = 'block'
    $('artHint').style.display = 'none'
    $('artTitle').textContent = 'PIXEL ART \xB7 ' + nowStr()
    if (!artClosedByUser) WM.open('win-paint')
  }catch(_){}
}

/* ================= \u53D1\u6307\u4EE4 ================= */
let sending = false
async function sendCmd(){
  const text = $('cmdInput').value.trim()
  if (!text || sending) return
  sending = true; $('sendBtn').disabled = true
  pushLine('me', '\u300E\u9762\u677F\u6307\u6325\u5B98\u300F ' + text)
  // \u753B\u56FE\u6307\u4EE4\uFF1A\u5148\u5F39\u51FA\u753B\u677F\uFF08\u7528\u6237\u62CD\u677F\uFF1A\u7ACB\u523B\u5F39\u5E76\u7F6E\u9876\uFF09
  if (/^[!\uFF01]\u753B/.test(text)) {
    artClosedByUser = false
    WM.open('win-paint')
    WM.raise('win-paint')
    setExpr('starry', 2000)
  }
  try{
    const r = await fetch('/api/danmaku', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ text })
    })
    const j = await r.json()
    if (j.ok) pushLine('bot', '\u2190 ' + JSON.stringify(j.reply))
    else {
      const msg = String(j.error || '\u53D1\u9001\u5931\u8D25')
      if (msg.includes('ECONNREFUSED') || msg.includes('9001'))
        pushLine('err', '\u2717 \u5F39\u5E55\u670D\u52A1\u672A\u8FDE\u63A5\uFF08:9001 Director \u672A\u542F\u52A8\uFF09\uFF0C\u6307\u4EE4\u6CA1\u53D1\u51FA\u53BB')
      else pushLine('err', '\u2717 ' + msg)
    }
  }catch(e){
    const msg = String(e.message || e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed'))
      pushLine('err', '\u2717 \u5F39\u5E55\u670D\u52A1\u672A\u8FDE\u63A5\uFF08:9001 Director \u672A\u542F\u52A8\uFF09\uFF0C\u6307\u4EE4\u6CA1\u53D1\u51FA\u53BB')
    else pushLine('err', '\u2717 \u8BF7\u6C42\u5931\u8D25\uFF1A' + msg)
  }finally{
    sending = false; $('sendBtn').disabled = false; $('cmdInput').value = ''
  }
}
$('sendBtn').onclick = sendCmd
$('cmdInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendCmd() })

/* ================= \u2630 \u83DC\u5355 ================= */
const drawer = $('drawer')
$('burger').onclick = (e) => { e.stopPropagation(); drawer.classList.toggle('open') }
document.addEventListener('click', (e) => { if (!drawer.contains(e.target) && e.target !== $('burger')) drawer.classList.remove('open') })
async function ctl(path, label){
  pushLine('sys', '\u203A ' + label)
  try{
    const r = await fetch('/api/control' + path, { method:'POST' })
    const j = await r.json()
    pushLine(j.ok ? 'bot' : 'err', '\u2190 ' + JSON.stringify(j))
  }catch(e){
    pushLine('err', '\u2717 \u63A7\u5236\u63A5\u53E3\u4E0D\u53EF\u7528\uFF08:8010 \u672A\u542F\u52A8\uFF09')
  }
}
document.querySelectorAll('[data-name]').forEach(b => {
  b.onclick = () => ctl('/restart?name=' + encodeURIComponent(b.dataset.name), '\u91CD\u542F ' + b.dataset.name)
})
$('btnStartAll').onclick = () => ctl('/start-all', '\u62C9\u8D77\u5168\u90E8\u5FAE\u670D\u52A1')
$('btnClearFeed').onclick = () => { feed.innerHTML = ''; pushLine('sys','// \u5DF2\u6E05\u7A7A') }
$('btnRawStatus').onclick = async () => {
  const j = await fetch('/api/status').then(r=>r.json())
  pushLine('sys', JSON.stringify(j, null, 1))
}
async function probeCtl(){
  try{
    const r = await fetch('/api/control/health')
    const j = await r.json()
    ctlOk = !!j.ok
    $('ctlNote').textContent = ctlOk ? '\u2705 \u63A7\u5236\u63A5\u53E3\u5728\u7EBF\uFF08' + (j.services||[]).join(' / ') + '\uFF09' : '\u26A0\uFE0F \u63A7\u5236\u63A5\u53E3\u8FD4\u56DE\u5F02\u5E38'
  }catch(_){
    $('ctlNote').textContent = '\u26A0\uFE0F \u63A7\u5236\u63A5\u53E3 :8010 \u672A\u542F\u52A8\uFF08\u91CD\u542F/\u62C9\u8D77\u6309\u94AE\u4F1A\u5931\u8D25\uFF09'
  }
}

/* ================= \u7ACB\u7ED8 ================= */
const EXPR_BASE = '/assets/expr/pixel_'
const EXPR_DEFAULT = 'smile'
const EXPR_LIST = ['aggrieved','blush','content','giggle','joy','nervous','pout','puzzled',
                   'sad','scared','shy','sleepy','smile','smug','starry','surprise','wink']
const img = $('avatarImg')
const stage = $('avatarStage')
let exprTimer = null, idleTimer = null, talkTimer = null
const preloaded = {}
for (const n of EXPR_LIST) { const im = new Image(); im.src = EXPR_BASE + n + '.png'; preloaded[n] = im }

function setExpr(name, holdMs){
  if (!EXPR_LIST.includes(name)) return
  img.src = EXPR_BASE + name + '.png'
  if (holdMs) {
    if (exprTimer) clearTimeout(exprTimer)
    exprTimer = setTimeout(() => { exprTimer = null; setExpr(EXPR_DEFAULT) }, holdMs)
  }
}
window.setAvatarExpression = (name) => { setExpr(name) }
window.setAvatarExpressionFor = (name, ms) => { setExpr(name, ms) }

function scheduleBlink(){
  if (idleTimer) clearTimeout(idleTimer)
  const wait = 3000 + Math.random() * 3000
  idleTimer = setTimeout(() => {
    if (!stage.classList.contains('talking') && !exprTimer) setExpr('wink', 120)
    scheduleBlink()
  }, wait)
}
scheduleBlink()

let rafPending = false
window.addEventListener('mousemove', (e) => {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    const nx = Math.max(-1, Math.min(1, (e.clientX - window.innerWidth/2) / (window.innerWidth/2)))
    const ny = Math.max(-1, Math.min(1, (e.clientY - window.innerHeight/2) / (window.innerHeight/2)))
    stage.style.setProperty('--look-x', (nx * 4).toFixed(1) + 'px')
    stage.style.setProperty('--look-y', (ny * 3).toFixed(1) + 'px')
    rafPending = false
  })
})

$('win-avatar').querySelector('.win-body').addEventListener('click', () => {
  if (stage.classList.contains('talking')) return
  setExpr('surprise', 1500)
  pushLine('me', '\u300E\u4F60\u300F \uFF08\u6233\u4E86\u4E00\u4E0B\u5979\u7684\u8138\uFF09')
  fetch('/api/danmaku', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '\u522B\u6233\u5566\uFF01', user: '\u4F60' }),
  }).then(r => r.json()).then(j => {
    if (!j.ok) pushLine('sys', '// \u5F39\u5E55\u672A\u9001\u8FBE\uFF08:9001 \u672A\u542F\u52A8\uFF09')
  }).catch(() => pushLine('sys', '// \u5F39\u5E55\u672A\u9001\u8FBE\uFF08:9001 \u672A\u542F\u52A8\uFF09'))
})

function startTalking(){
  $('win-avatar').classList.add('speaking')
  stage.classList.add('talking')
  setExpr(Math.random() < 0.5 ? 'joy' : 'giggle')
  if (talkTimer) clearInterval(talkTimer)
  talkTimer = setInterval(() => {
    setExpr(Math.random() < 0.6 ? 'joy' : (Math.random() < 0.5 ? 'giggle' : 'surprise'))
  }, 420)
}
function stopTalking(){
  $('win-avatar').classList.remove('speaking')
  stage.classList.remove('talking')
  if (talkTimer) { clearInterval(talkTimer); talkTimer = null }
  setExpr(EXPR_DEFAULT)
}

/* ================= SSE \u4E8B\u4EF6\u901A\u9053\uFF08\u5E26\u91CD\u8FDE\uFF09 ================= */
const wsBadge = $('wsBadge')
function setWsBadge(on){
  wsBadge.textContent = on ? '[WS \u5728\u7EBF]' : '[WS \u79BB\u7EBF]'
  wsBadge.classList.toggle('on', on)
}
let esRetry = 1000
function connectEvents(){
  let es
  try { es = new EventSource('/api/event/stream') } catch(_) { setTimeout(connectEvents, esRetry); return }
  es.addEventListener('hello', () => { esRetry = 1000; setWsBadge(true) })
  es.addEventListener('panel', (e) => {
    let ev
    try { ev = JSON.parse(e.data) } catch(_) { return }
    if (!ev || !ev.type) return
    switch(ev.type){
      case 'chat_reply':
        pushLine('bot', '\u300E\u9CB8\u9C7C\u5A18\u300F ' + (ev.text || ''))
        if (ev.text) startTalking()
        break
      case 'tts_start': startTalking(); break
      case 'tts_end': stopTalking(); break
      case 'paint_start':
        artClosedByUser = false
        WM.open('win-paint'); WM.raise('win-paint')
        setExpr('starry', 2000)
        pushLine('sys', '// \u5F00\u59CB\u4F5C\u753B' + (ev.prompt ? '\uFF1A' + ev.prompt : ''))
        break
      case 'paint_end':
        pushLine('sys', '// \u4F5C\u753B\u7ED3\u675F' + (ev.ok === false ? '\uFF08\u5931\u8D25\uFF09' : ''))
        break
    }
  })
  es.onerror = () => {
    setWsBadge(false)
    try { es.close() } catch(_) {}
    // \u6307\u6570\u9000\u907F\uFF0C\u6700\u957F 15 \u79D2
    setTimeout(connectEvents, esRetry)
    esRetry = Math.min(15000, esRetry * 1.7)
  }
}
connectEvents()

pushLine('sys','// \u9CB8\u9C7C\u6307\u6325\u8231\u5DF2\u5C31\u7EEA\uFF08\u70B9\u5DE6\u4E0B\u56FE\u6807\u5F00\u7A97\u53E3\uFF09')
probeCtl(); pollStatus(); pollPaint()
setInterval(pollStatus, 2000)
setInterval(pollPaint, 100)
setInterval(probeCtl, 15000)
</script>
</body>
</html>
`;

// src/index.ts
var LOG_TAG2 = "[dsh-control-center]";
var server = null;
var starting = null;
async function ensureServer() {
  if (server) return server;
  if (!starting) {
    starting = startControlCenter({ page: () => PAGE_HTML }).then((s) => {
      server = s;
      return s;
    }).catch((e) => {
      starting = null;
      throw e;
    });
  }
  return starting;
}
var openDashboardTool = {
  name: "open_dashboard",
  description: "\u542F\u52A8\u5E76\u8FD4\u56DE persona-os \u603B\u63A7\u9762\u677F\u5730\u5740\uFF08\u9ED8\u8BA4 http://127.0.0.1:8088\uFF09\u3002\u9762\u677F\u91CC\u6709\uFF1A\u5404\u5FAE\u670D\u52A1/\u63D2\u4EF6\u7684\u6B7B\u6D3B\uFF08\u7EFF\u706F/\u7EA2\u706F\u5B9E\u65F6\u5237\u65B0\uFF09\u3001\u5185\u5B58\u4E0E GPU \u663E\u5B58\u3001\u4EE5\u53CA\u4E00\u4E2A\u53D1\u9001\u6A21\u62DF\u5F39\u5E55\u5230 :9001 \u7684\u6D4B\u8BD5\u53F0\u3002",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  output: {
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, url: { type: "string" }, error: { type: "string" } }
    },
    render: (_a, v) => [
      { type: "text", text: v?.ok ? `\u{1F5A5}\uFE0F \u603B\u63A7\u9762\u677F\uFF1A${v.url}` : `\u274C \u9762\u677F\u542F\u52A8\u5931\u8D25\uFF1A${v?.error ?? "\u672A\u77E5"}` }
    ]
  },
  async execute() {
    try {
      const s = await ensureServer();
      return { ok: true, url: `http://127.0.0.1:${s.port}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  presentCall() {
    return { card: "generic", title: "open_dashboard", kind: "read" };
  }
};
var index_default = {
  name: "dsh-control-center",
  async apply(ctx) {
    try {
      const s = await ensureServer();
      console.log(`${LOG_TAG2} \u5DF2\u542F\u52A8\uFF1Ahttp://127.0.0.1:${s.port}`);
    } catch (e) {
      console.error(`${LOG_TAG2} \u542F\u52A8\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u5176\u4ED6\u63D2\u4EF6\uFF09\uFF1A${e.message}`);
    }
    try {
      ctx.tools.register(openDashboardTool);
    } catch (e) {
      console.error(`${LOG_TAG2} \u6CE8\u518C\u5DE5\u5177\u5931\u8D25\uFF1A`, e);
    }
    ctx.on("dispose", () => {
      if (server) {
        void server.close();
        server = null;
        starting = null;
      }
      console.log(`${LOG_TAG2} disposed`);
    });
  }
};
export {
  index_default as default,
  ensureServer,
  startControlCenter
};
//# sourceMappingURL=index.js.map
