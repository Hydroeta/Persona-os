import { createRequire } from 'module';import { fileURLToPath as __bannerFileURLToPath } from 'url';import { dirname as __bannerDirname } from 'path';const require = createRequire(import.meta.url);const __filename = __bannerFileURLToPath(import.meta.url);const __dirname = __bannerDirname(__filename);
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
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/task.js
var require_task = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/task.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var Task = class extends EventEmitter {
      constructor(execution) {
        super();
        if (typeof execution !== "function") {
          throw "execution must be a function";
        }
        this._execution = execution;
      }
      execute(now) {
        let exec;
        try {
          exec = this._execution(now);
        } catch (error) {
          return this.emit("task-failed", error);
        }
        if (exec instanceof Promise) {
          return exec.then(() => this.emit("task-finished")).catch((error) => this.emit("task-failed", error));
        } else {
          this.emit("task-finished");
          return exec;
        }
      }
    };
    module.exports = Task;
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/month-names-conversion.js
var require_month_names_conversion = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/month-names-conversion.js"(exports, module) {
    "use strict";
    module.exports = /* @__PURE__ */ (() => {
      const months = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december"
      ];
      const shortMonths = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec"
      ];
      function convertMonthName(expression, items) {
        for (let i = 0; i < items.length; i++) {
          expression = expression.replace(new RegExp(items[i], "gi"), parseInt(i, 10) + 1);
        }
        return expression;
      }
      function interprete(monthExpression) {
        monthExpression = convertMonthName(monthExpression, months);
        monthExpression = convertMonthName(monthExpression, shortMonths);
        return monthExpression;
      }
      return interprete;
    })();
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/week-day-names-conversion.js
var require_week_day_names_conversion = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/week-day-names-conversion.js"(exports, module) {
    "use strict";
    module.exports = /* @__PURE__ */ (() => {
      const weekDays = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday"
      ];
      const shortWeekDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
      function convertWeekDayName(expression, items) {
        for (let i = 0; i < items.length; i++) {
          expression = expression.replace(new RegExp(items[i], "gi"), parseInt(i, 10));
        }
        return expression;
      }
      function convertWeekDays(expression) {
        expression = expression.replace("7", "0");
        expression = convertWeekDayName(expression, weekDays);
        return convertWeekDayName(expression, shortWeekDays);
      }
      return convertWeekDays;
    })();
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/asterisk-to-range-conversion.js
var require_asterisk_to_range_conversion = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/asterisk-to-range-conversion.js"(exports, module) {
    "use strict";
    module.exports = /* @__PURE__ */ (() => {
      function convertAsterisk(expression, replecement) {
        if (expression.indexOf("*") !== -1) {
          return expression.replace("*", replecement);
        }
        return expression;
      }
      function convertAsterisksToRanges(expressions) {
        expressions[0] = convertAsterisk(expressions[0], "0-59");
        expressions[1] = convertAsterisk(expressions[1], "0-59");
        expressions[2] = convertAsterisk(expressions[2], "0-23");
        expressions[3] = convertAsterisk(expressions[3], "1-31");
        expressions[4] = convertAsterisk(expressions[4], "1-12");
        expressions[5] = convertAsterisk(expressions[5], "0-6");
        return expressions;
      }
      return convertAsterisksToRanges;
    })();
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/range-conversion.js
var require_range_conversion = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/range-conversion.js"(exports, module) {
    "use strict";
    module.exports = /* @__PURE__ */ (() => {
      function replaceWithRange(expression, text, init, end) {
        const numbers = [];
        let last = parseInt(end);
        let first = parseInt(init);
        if (first > last) {
          last = parseInt(init);
          first = parseInt(end);
        }
        for (let i = first; i <= last; i++) {
          numbers.push(i);
        }
        return expression.replace(new RegExp(text, "i"), numbers.join());
      }
      function convertRange(expression) {
        const rangeRegEx = /(\d+)-(\d+)/;
        let match = rangeRegEx.exec(expression);
        while (match !== null && match.length > 0) {
          expression = replaceWithRange(expression, match[0], match[1], match[2]);
          match = rangeRegEx.exec(expression);
        }
        return expression;
      }
      function convertAllRanges(expressions) {
        for (let i = 0; i < expressions.length; i++) {
          expressions[i] = convertRange(expressions[i]);
        }
        return expressions;
      }
      return convertAllRanges;
    })();
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/step-values-conversion.js
var require_step_values_conversion = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/step-values-conversion.js"(exports, module) {
    "use strict";
    module.exports = /* @__PURE__ */ (() => {
      function convertSteps(expressions) {
        var stepValuePattern = /^(.+)\/(\w+)$/;
        for (var i = 0; i < expressions.length; i++) {
          var match = stepValuePattern.exec(expressions[i]);
          var isStepValue = match !== null && match.length > 0;
          if (isStepValue) {
            var baseDivider = match[2];
            if (isNaN(baseDivider)) {
              throw baseDivider + " is not a valid step value";
            }
            var values = match[1].split(",");
            var stepValues = [];
            var divider = parseInt(baseDivider, 10);
            for (var j = 0; j <= values.length; j++) {
              var value = parseInt(values[j], 10);
              if (value % divider === 0) {
                stepValues.push(value);
              }
            }
            expressions[i] = stepValues.join(",");
          }
        }
        return expressions;
      }
      return convertSteps;
    })();
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/index.js
var require_convert_expression = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/convert-expression/index.js"(exports, module) {
    "use strict";
    var monthNamesConversion = require_month_names_conversion();
    var weekDayNamesConversion = require_week_day_names_conversion();
    var convertAsterisksToRanges = require_asterisk_to_range_conversion();
    var convertRanges = require_range_conversion();
    var convertSteps = require_step_values_conversion();
    module.exports = /* @__PURE__ */ (() => {
      function appendSeccondExpression(expressions) {
        if (expressions.length === 5) {
          return ["0"].concat(expressions);
        }
        return expressions;
      }
      function removeSpaces(str) {
        return str.replace(/\s{2,}/g, " ").trim();
      }
      function normalizeIntegers(expressions) {
        for (let i = 0; i < expressions.length; i++) {
          const numbers = expressions[i].split(",");
          for (let j = 0; j < numbers.length; j++) {
            numbers[j] = parseInt(numbers[j]);
          }
          expressions[i] = numbers;
        }
        return expressions;
      }
      function interprete(expression) {
        let expressions = removeSpaces(expression).split(" ");
        expressions = appendSeccondExpression(expressions);
        expressions[4] = monthNamesConversion(expressions[4]);
        expressions[5] = weekDayNamesConversion(expressions[5]);
        expressions = convertAsterisksToRanges(expressions);
        expressions = convertRanges(expressions);
        expressions = convertSteps(expressions);
        expressions = normalizeIntegers(expressions);
        return expressions.join(" ");
      }
      return interprete;
    })();
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/pattern-validation.js
var require_pattern_validation = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/pattern-validation.js"(exports, module) {
    "use strict";
    var convertExpression = require_convert_expression();
    var validationRegex = /^(?:\d+|\*|\*\/\d+)$/;
    function isValidExpression(expression, min, max) {
      const options = expression.split(",");
      for (const option of options) {
        const optionAsInt = parseInt(option, 10);
        if (!Number.isNaN(optionAsInt) && (optionAsInt < min || optionAsInt > max) || !validationRegex.test(option))
          return false;
      }
      return true;
    }
    function isInvalidSecond(expression) {
      return !isValidExpression(expression, 0, 59);
    }
    function isInvalidMinute(expression) {
      return !isValidExpression(expression, 0, 59);
    }
    function isInvalidHour(expression) {
      return !isValidExpression(expression, 0, 23);
    }
    function isInvalidDayOfMonth(expression) {
      return !isValidExpression(expression, 1, 31);
    }
    function isInvalidMonth(expression) {
      return !isValidExpression(expression, 1, 12);
    }
    function isInvalidWeekDay(expression) {
      return !isValidExpression(expression, 0, 7);
    }
    function validateFields(patterns, executablePatterns) {
      if (isInvalidSecond(executablePatterns[0]))
        throw new Error(`${patterns[0]} is a invalid expression for second`);
      if (isInvalidMinute(executablePatterns[1]))
        throw new Error(`${patterns[1]} is a invalid expression for minute`);
      if (isInvalidHour(executablePatterns[2]))
        throw new Error(`${patterns[2]} is a invalid expression for hour`);
      if (isInvalidDayOfMonth(executablePatterns[3]))
        throw new Error(
          `${patterns[3]} is a invalid expression for day of month`
        );
      if (isInvalidMonth(executablePatterns[4]))
        throw new Error(`${patterns[4]} is a invalid expression for month`);
      if (isInvalidWeekDay(executablePatterns[5]))
        throw new Error(`${patterns[5]} is a invalid expression for week day`);
    }
    function validate2(pattern) {
      if (typeof pattern !== "string")
        throw new TypeError("pattern must be a string!");
      const patterns = pattern.split(" ");
      const executablePatterns = convertExpression(pattern).split(" ");
      if (patterns.length === 5) patterns.unshift("0");
      validateFields(patterns, executablePatterns);
    }
    module.exports = validate2;
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/time-matcher.js
var require_time_matcher = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/time-matcher.js"(exports, module) {
    var validatePattern = require_pattern_validation();
    var convertExpression = require_convert_expression();
    function matchPattern(pattern, value) {
      if (pattern.indexOf(",") !== -1) {
        const patterns = pattern.split(",");
        return patterns.indexOf(value.toString()) !== -1;
      }
      return pattern === value.toString();
    }
    var TimeMatcher = class {
      constructor(pattern, timezone) {
        validatePattern(pattern);
        this.pattern = convertExpression(pattern);
        this.timezone = timezone;
        this.expressions = this.pattern.split(" ");
        this.dtf = this.timezone ? new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
          fractionalSecondDigits: 3,
          timeZone: this.timezone
        }) : null;
      }
      match(date) {
        date = this.apply(date);
        const runOnSecond = matchPattern(this.expressions[0], date.getSeconds());
        const runOnMinute = matchPattern(this.expressions[1], date.getMinutes());
        const runOnHour = matchPattern(this.expressions[2], date.getHours());
        const runOnDay = matchPattern(this.expressions[3], date.getDate());
        const runOnMonth = matchPattern(this.expressions[4], date.getMonth() + 1);
        const runOnWeekDay = matchPattern(this.expressions[5], date.getDay());
        return runOnSecond && runOnMinute && runOnHour && runOnDay && runOnMonth && runOnWeekDay;
      }
      apply(date) {
        if (this.dtf) {
          return new Date(this.dtf.format(date));
        }
        return date;
      }
    };
    module.exports = TimeMatcher;
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/scheduler.js
var require_scheduler = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/scheduler.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var TimeMatcher = require_time_matcher();
    var Scheduler = class extends EventEmitter {
      constructor(pattern, timezone, autorecover) {
        super();
        this.timeMatcher = new TimeMatcher(pattern, timezone);
        this.autorecover = autorecover;
      }
      start() {
        this.stop();
        let lastCheck = process.hrtime();
        let lastExecution = this.timeMatcher.apply(/* @__PURE__ */ new Date());
        const matchTime = () => {
          const delay = 1e3;
          const elapsedTime = process.hrtime(lastCheck);
          const elapsedMs = (elapsedTime[0] * 1e9 + elapsedTime[1]) / 1e6;
          const missedExecutions = Math.floor(elapsedMs / 1e3);
          for (let i = missedExecutions; i >= 0; i--) {
            const date = new Date((/* @__PURE__ */ new Date()).getTime() - i * 1e3);
            let date_tmp = this.timeMatcher.apply(date);
            if (lastExecution.getTime() < date_tmp.getTime() && (i === 0 || this.autorecover) && this.timeMatcher.match(date)) {
              this.emit("scheduled-time-matched", date_tmp);
              date_tmp.setMilliseconds(0);
              lastExecution = date_tmp;
            }
          }
          lastCheck = process.hrtime();
          this.timeout = setTimeout(matchTime, delay);
        };
        matchTime();
      }
      stop() {
        if (this.timeout) {
          clearTimeout(this.timeout);
        }
        this.timeout = null;
      }
    };
    module.exports = Scheduler;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/rng.js
import crypto from "crypto";
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    crypto.randomFillSync(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}
var rnds8Pool, poolPtr;
var init_rng = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/rng.js"() {
    rnds8Pool = new Uint8Array(256);
    poolPtr = rnds8Pool.length;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/regex.js
var regex_default;
var init_regex = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/regex.js"() {
    regex_default = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/validate.js
function validate(uuid) {
  return typeof uuid === "string" && regex_default.test(uuid);
}
var validate_default;
var init_validate = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/validate.js"() {
    init_regex();
    validate_default = validate;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/stringify.js
function stringify(arr, offset = 0) {
  const uuid = (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
  if (!validate_default(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}
var byteToHex, stringify_default;
var init_stringify = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/stringify.js"() {
    init_validate();
    byteToHex = [];
    for (let i = 0; i < 256; ++i) {
      byteToHex.push((i + 256).toString(16).substr(1));
    }
    stringify_default = stringify;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v1.js
function v1(options, buf, offset) {
  let i = buf && offset || 0;
  const b = buf || new Array(16);
  options = options || {};
  let node = options.node || _nodeId;
  let clockseq = options.clockseq !== void 0 ? options.clockseq : _clockseq;
  if (node == null || clockseq == null) {
    const seedBytes = options.random || (options.rng || rng)();
    if (node == null) {
      node = _nodeId = [seedBytes[0] | 1, seedBytes[1], seedBytes[2], seedBytes[3], seedBytes[4], seedBytes[5]];
    }
    if (clockseq == null) {
      clockseq = _clockseq = (seedBytes[6] << 8 | seedBytes[7]) & 16383;
    }
  }
  let msecs = options.msecs !== void 0 ? options.msecs : Date.now();
  let nsecs = options.nsecs !== void 0 ? options.nsecs : _lastNSecs + 1;
  const dt = msecs - _lastMSecs + (nsecs - _lastNSecs) / 1e4;
  if (dt < 0 && options.clockseq === void 0) {
    clockseq = clockseq + 1 & 16383;
  }
  if ((dt < 0 || msecs > _lastMSecs) && options.nsecs === void 0) {
    nsecs = 0;
  }
  if (nsecs >= 1e4) {
    throw new Error("uuid.v1(): Can't create more than 10M uuids/sec");
  }
  _lastMSecs = msecs;
  _lastNSecs = nsecs;
  _clockseq = clockseq;
  msecs += 122192928e5;
  const tl = ((msecs & 268435455) * 1e4 + nsecs) % 4294967296;
  b[i++] = tl >>> 24 & 255;
  b[i++] = tl >>> 16 & 255;
  b[i++] = tl >>> 8 & 255;
  b[i++] = tl & 255;
  const tmh = msecs / 4294967296 * 1e4 & 268435455;
  b[i++] = tmh >>> 8 & 255;
  b[i++] = tmh & 255;
  b[i++] = tmh >>> 24 & 15 | 16;
  b[i++] = tmh >>> 16 & 255;
  b[i++] = clockseq >>> 8 | 128;
  b[i++] = clockseq & 255;
  for (let n = 0; n < 6; ++n) {
    b[i + n] = node[n];
  }
  return buf || stringify_default(b);
}
var _nodeId, _clockseq, _lastMSecs, _lastNSecs, v1_default;
var init_v1 = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v1.js"() {
    init_rng();
    init_stringify();
    _lastMSecs = 0;
    _lastNSecs = 0;
    v1_default = v1;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/parse.js
function parse(uuid) {
  if (!validate_default(uuid)) {
    throw TypeError("Invalid UUID");
  }
  let v;
  const arr = new Uint8Array(16);
  arr[0] = (v = parseInt(uuid.slice(0, 8), 16)) >>> 24;
  arr[1] = v >>> 16 & 255;
  arr[2] = v >>> 8 & 255;
  arr[3] = v & 255;
  arr[4] = (v = parseInt(uuid.slice(9, 13), 16)) >>> 8;
  arr[5] = v & 255;
  arr[6] = (v = parseInt(uuid.slice(14, 18), 16)) >>> 8;
  arr[7] = v & 255;
  arr[8] = (v = parseInt(uuid.slice(19, 23), 16)) >>> 8;
  arr[9] = v & 255;
  arr[10] = (v = parseInt(uuid.slice(24, 36), 16)) / 1099511627776 & 255;
  arr[11] = v / 4294967296 & 255;
  arr[12] = v >>> 24 & 255;
  arr[13] = v >>> 16 & 255;
  arr[14] = v >>> 8 & 255;
  arr[15] = v & 255;
  return arr;
}
var parse_default;
var init_parse = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/parse.js"() {
    init_validate();
    parse_default = parse;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v35.js
function stringToBytes(str) {
  str = unescape(encodeURIComponent(str));
  const bytes = [];
  for (let i = 0; i < str.length; ++i) {
    bytes.push(str.charCodeAt(i));
  }
  return bytes;
}
function v35_default(name, version2, hashfunc) {
  function generateUUID(value, namespace, buf, offset) {
    if (typeof value === "string") {
      value = stringToBytes(value);
    }
    if (typeof namespace === "string") {
      namespace = parse_default(namespace);
    }
    if (namespace.length !== 16) {
      throw TypeError("Namespace must be array-like (16 iterable integer values, 0-255)");
    }
    let bytes = new Uint8Array(16 + value.length);
    bytes.set(namespace);
    bytes.set(value, namespace.length);
    bytes = hashfunc(bytes);
    bytes[6] = bytes[6] & 15 | version2;
    bytes[8] = bytes[8] & 63 | 128;
    if (buf) {
      offset = offset || 0;
      for (let i = 0; i < 16; ++i) {
        buf[offset + i] = bytes[i];
      }
      return buf;
    }
    return stringify_default(bytes);
  }
  try {
    generateUUID.name = name;
  } catch (err) {
  }
  generateUUID.DNS = DNS;
  generateUUID.URL = URL;
  return generateUUID;
}
var DNS, URL;
var init_v35 = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v35.js"() {
    init_stringify();
    init_parse();
    DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/md5.js
import crypto2 from "crypto";
function md5(bytes) {
  if (Array.isArray(bytes)) {
    bytes = Buffer.from(bytes);
  } else if (typeof bytes === "string") {
    bytes = Buffer.from(bytes, "utf8");
  }
  return crypto2.createHash("md5").update(bytes).digest();
}
var md5_default;
var init_md5 = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/md5.js"() {
    md5_default = md5;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v3.js
var v3, v3_default;
var init_v3 = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v3.js"() {
    init_v35();
    init_md5();
    v3 = v35_default("v3", 48, md5_default);
    v3_default = v3;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v4.js
function v4(options, buf, offset) {
  options = options || {};
  const rnds = options.random || (options.rng || rng)();
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    for (let i = 0; i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return stringify_default(rnds);
}
var v4_default;
var init_v4 = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v4.js"() {
    init_rng();
    init_stringify();
    v4_default = v4;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/sha1.js
import crypto3 from "crypto";
function sha1(bytes) {
  if (Array.isArray(bytes)) {
    bytes = Buffer.from(bytes);
  } else if (typeof bytes === "string") {
    bytes = Buffer.from(bytes, "utf8");
  }
  return crypto3.createHash("sha1").update(bytes).digest();
}
var sha1_default;
var init_sha1 = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/sha1.js"() {
    sha1_default = sha1;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v5.js
var v5, v5_default;
var init_v5 = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/v5.js"() {
    init_v35();
    init_sha1();
    v5 = v35_default("v5", 80, sha1_default);
    v5_default = v5;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/nil.js
var nil_default;
var init_nil = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/nil.js"() {
    nil_default = "00000000-0000-0000-0000-000000000000";
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/version.js
function version(uuid) {
  if (!validate_default(uuid)) {
    throw TypeError("Invalid UUID");
  }
  return parseInt(uuid.substr(14, 1), 16);
}
var version_default;
var init_version = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/version.js"() {
    init_validate();
    version_default = version;
  }
});

// ../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/index.js
var esm_node_exports = {};
__export(esm_node_exports, {
  NIL: () => nil_default,
  parse: () => parse_default,
  stringify: () => stringify_default,
  v1: () => v1_default,
  v3: () => v3_default,
  v4: () => v4_default,
  v5: () => v5_default,
  validate: () => validate_default,
  version: () => version_default
});
var init_esm_node = __esm({
  "../../node_modules/.pnpm/uuid@8.3.2/node_modules/uuid/dist/esm-node/index.js"() {
    init_v1();
    init_v3();
    init_v4();
    init_v5();
    init_nil();
    init_version();
    init_validate();
    init_stringify();
    init_parse();
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/scheduled-task.js
var require_scheduled_task = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/scheduled-task.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var Task = require_task();
    var Scheduler = require_scheduler();
    var uuid = (init_esm_node(), __toCommonJS(esm_node_exports));
    var ScheduledTask = class extends EventEmitter {
      constructor(cronExpression, func, options) {
        super();
        if (!options) {
          options = {
            scheduled: true,
            recoverMissedExecutions: false
          };
        }
        this.options = options;
        this.options.name = this.options.name || uuid.v4();
        this._task = new Task(func);
        this._scheduler = new Scheduler(cronExpression, options.timezone, options.recoverMissedExecutions);
        this._scheduler.on("scheduled-time-matched", (now) => {
          this.now(now);
        });
        if (options.scheduled !== false) {
          this._scheduler.start();
        }
        if (options.runOnInit === true) {
          this.now("init");
        }
      }
      now(now = "manual") {
        let result = this._task.execute(now);
        this.emit("task-done", result);
      }
      start() {
        this._scheduler.start();
      }
      stop() {
        this._scheduler.stop();
      }
    };
    module.exports = ScheduledTask;
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/background-scheduled-task/index.js
var require_background_scheduled_task = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/background-scheduled-task/index.js"(exports, module) {
    var EventEmitter = __require("events");
    var path = __require("path");
    var { fork } = __require("child_process");
    var uuid = (init_esm_node(), __toCommonJS(esm_node_exports));
    var daemonPath = `${__dirname}/daemon.js`;
    var BackgroundScheduledTask = class extends EventEmitter {
      constructor(cronExpression, taskPath, options) {
        super();
        if (!options) {
          options = {
            scheduled: true,
            recoverMissedExecutions: false
          };
        }
        this.cronExpression = cronExpression;
        this.taskPath = taskPath;
        this.options = options;
        this.options.name = this.options.name || uuid.v4();
        if (options.scheduled) {
          this.start();
        }
      }
      start() {
        this.stop();
        this.forkProcess = fork(daemonPath);
        this.forkProcess.on("message", (message) => {
          switch (message.type) {
            case "task-done":
              this.emit("task-done", message.result);
              break;
          }
        });
        let options = this.options;
        options.scheduled = true;
        this.forkProcess.send({
          type: "register",
          path: path.resolve(this.taskPath),
          cron: this.cronExpression,
          options
        });
      }
      stop() {
        if (this.forkProcess) {
          this.forkProcess.kill();
        }
      }
      pid() {
        if (this.forkProcess) {
          return this.forkProcess.pid;
        }
      }
      isRunning() {
        return !this.forkProcess.killed;
      }
    };
    module.exports = BackgroundScheduledTask;
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/storage.js
var require_storage = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/storage.js"(exports, module) {
    module.exports = (() => {
      if (!global.scheduledTasks) {
        global.scheduledTasks = /* @__PURE__ */ new Map();
      }
      return {
        save: (task) => {
          if (!task.options) {
            const uuid = (init_esm_node(), __toCommonJS(esm_node_exports));
            task.options = {};
            task.options.name = uuid.v4();
          }
          global.scheduledTasks.set(task.options.name, task);
        },
        getTasks: () => {
          return global.scheduledTasks;
        }
      };
    })();
  }
});

// ../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/node-cron.js
var require_node_cron = __commonJS({
  "../../node_modules/.pnpm/node-cron@3.0.3/node_modules/node-cron/src/node-cron.js"(exports, module) {
    "use strict";
    var ScheduledTask = require_scheduled_task();
    var BackgroundScheduledTask = require_background_scheduled_task();
    var validation = require_pattern_validation();
    var storage = require_storage();
    function schedule(expression, func, options) {
      const task = createTask(expression, func, options);
      storage.save(task);
      return task;
    }
    function createTask(expression, func, options) {
      if (typeof func === "string")
        return new BackgroundScheduledTask(expression, func, options);
      return new ScheduledTask(expression, func, options);
    }
    function validate2(expression) {
      try {
        validation(expression);
        return true;
      } catch (_) {
        return false;
      }
    }
    function getTasks() {
      return storage.getTasks();
    }
    module.exports = { schedule, validate: validate2, getTasks };
  }
});

// src/index.ts
var import_node_cron = __toESM(require_node_cron(), 1);

// src/selfplay.ts
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
var LOCAL_FALLBACK_ROOTS = [];
function resolvePersonasRoot() {
  if (process.env.PERSONA_CONFIG_DIR) {
    if (existsSync(process.env.PERSONA_CONFIG_DIR)) return process.env.PERSONA_CONFIG_DIR;
    throw new Error(`PERSONA_CONFIG_DIR \u4E0D\u5B58\u5728\uFF1A${process.env.PERSONA_CONFIG_DIR}`);
  }
  const osRoot = process.env.PERSONA_OS_ROOT;
  if (osRoot) {
    const p = join(osRoot, "config", "personas");
    if (existsSync(p)) return p;
  }
  for (const r of LOCAL_FALLBACK_ROOTS) {
    const p = join(r, "config", "personas");
    if (existsSync(p)) return p;
  }
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(cur, "config", "personas");
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("\u627E\u4E0D\u5230 config/personas \u76EE\u5F55\uFF08\u53EF\u8BBE PERSONA_CONFIG_DIR \u6216 PERSONA_OS_ROOT\uFF09");
}
function listPersonaDirs(personasRoot) {
  let entries = [];
  try {
    entries = readdirSync(personasRoot);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    try {
      return statSync(join(personasRoot, name)).isDirectory() && existsSync(join(personasRoot, name, "persona.json"));
    } catch {
      return false;
    }
  });
}
function getActiveId(personasRoot) {
  const activeFile = join(personasRoot, "active.json");
  if (existsSync(activeFile)) {
    try {
      const j = JSON.parse(readFileSync(activeFile, "utf-8"));
      if (typeof j?.active_id === "string" && j.active_id) return j.active_id;
    } catch {
    }
  }
  const dirs = listPersonaDirs(personasRoot);
  return dirs[0] ?? "";
}
async function fetchRecentSamples(memoryUrl, limit) {
  const url = `${memoryUrl.replace(/\/$/, "")}/recent?days=7&limit=${Math.min(Math.max(limit * 3, limit), 500)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4e3) });
    if (!r.ok) return [];
    const data = await r.json();
    const list = Array.isArray(data?.results) ? data.results : [];
    const out = [];
    for (const item of list) {
      const c = typeof item?.content === "string" ? item.content.trim() : "";
      if (c.length >= 4) out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}
var AUDIT_SYSTEM_PROMPT = '\u4F60\u662F\u4E00\u4E2A\u4E25\u683C\u7684 AI \u8BED\u611F\u88C1\u5224\u3002\u8BF7\u5BA1\u67E5\u4EE5\u4E0B AI \u89D2\u8272\u7684\u56DE\u590D\u6837\u672C\uFF0C\u627E\u51FA\u5176\u4E2D\u5E26\u6709"\u5BA2\u670D\u8154"\u3001"AI \u5473"\uFF08\u5982\uFF1A\u957F\u7BC7\u5927\u8BBA\u8BF4\u6559\u3001\u7528"\u9996\u5148/\u5176\u6B21"\u3001\u7528"\u5E0C\u671B\u5E2E\u5230\u4F60"\u7ED3\u5C3E\uFF09\u7684\u53E5\u5B50\u3002\u8BF7\u8F93\u51FA\u4E00\u4E2A JSON \u6570\u7EC4\uFF0C\u5305\u542B 1-3 \u6761\u9700\u8981\u907F\u514D\u7684\u8D1F\u5411\u6307\u4EE4\uFF08\u4F8B\u5982\uFF1A"\u7EDD\u5BF9\u4E0D\u8981\u7528\u5BA2\u670D\u8154\u7684\u603B\u7ED3\u7ED3\u5C3E"\uFF09\u3002\u5982\u679C\u6CA1\u6709\u53D1\u73B0 AI \u5473\uFF0C\u8FD4\u56DE\u7A7A\u6570\u7EC4\u3002';
function buildAuditUserPrompt(samples) {
  const body = samples.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `\u4EE5\u4E0B\u662F\u8BE5\u89D2\u8272\u6700\u8FD1\u7684\u56DE\u590D\u6837\u672C\uFF1A

${body}

\u8BF7\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u4ED6\u6587\u5B57\u3001\u89E3\u91CA\u6216 markdown \u4EE3\u7801\u5757\u6807\u8BB0\u3002`;
}
function extractStringArray(raw) {
  if (typeof raw !== "string") return [];
  const start = raw.indexOf("[");
  if (start < 0) return [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  let arr;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => typeof x === "string" ? x.trim() : "").filter((x) => x.length > 0 && x.length <= 300).slice(0, 3);
}
async function auditWithOllama(samples, opts) {
  if (!samples.length) return [];
  const messages = [
    { role: "system", content: AUDIT_SYSTEM_PROMPT },
    { role: "user", content: buildAuditUserPrompt(samples) }
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let text = "";
  try {
    const r = await fetch(`${opts.url.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, messages, stream: false, temperature: 0.3 }),
      signal: controller.signal
    });
    text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return [];
  }
  const content = data?.choices?.[0]?.message?.content ?? "";
  return extractStringArray(content);
}
function loadRules(rulesPath) {
  if (!existsSync(rulesPath)) return { negative_rules: [] };
  try {
    const j = JSON.parse(readFileSync(rulesPath, "utf-8"));
    if (j && typeof j === "object") {
      if (!Array.isArray(j.negative_rules)) j.negative_rules = [];
      return j;
    }
  } catch {
  }
  return { negative_rules: [] };
}
function mergeNegativeRules(existing, incoming) {
  const seen = new Set(existing.map((x) => x.trim()));
  const out = [...existing];
  for (const r of incoming) {
    const t = (typeof r === "string" ? r : "").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
function backupAndWriteRules(rulesPath, next, dryRun) {
  if (dryRun) return { backup_written: false, written: false };
  const backupPath = rulesPath.replace(/\.json$/i, "_backup.json");
  let backupWritten = false;
  try {
    if (existsSync(rulesPath)) {
      writeFileSync(backupPath, readFileSync(rulesPath), "utf-8");
    } else {
      writeFileSync(backupPath, JSON.stringify({ negative_rules: [] }, null, 2), "utf-8");
    }
    backupWritten = true;
  } catch {
    backupWritten = false;
  }
  const tmp = `${rulesPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  renameSync(tmp, rulesPath);
  return { backup_written: backupWritten, written: true };
}
async function runSelfPlay(opts = {}) {
  const dryRun = opts.dry_run !== false;
  const memoryUrl = opts.memoryUrl || process.env.MEMORY_BUS_URL || "http://127.0.0.1:8001";
  const ollamaUrl = opts.ollamaUrl || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ollamaModel = opts.ollamaModel || process.env.OLLAMA_MODEL || "qwen2.5:7b";
  const timeoutMs = opts.timeoutMs ?? 3e3;
  const sampleLimit = opts.sampleLimit ?? 20;
  let samples = Array.isArray(opts.samples) ? opts.samples.filter((s) => typeof s === "string" && s.trim()) : [];
  if (!samples.length) {
    try {
      samples = await fetchRecentSamples(memoryUrl, sampleLimit);
    } catch {
      samples = [];
    }
  }
  if (!samples.length) {
    return { ok: false, reason: "\u65E0\u53EF\u7528\u6837\u672C\uFF08memory \u79BB\u7EBF\u6216\u8FD1\u671F\u65E0\u8BB0\u5F55\uFF09", dry_run: dryRun, samples_count: 0 };
  }
  let negativeRules = [];
  try {
    negativeRules = await auditWithOllama(samples.slice(0, sampleLimit), { url: ollamaUrl, model: ollamaModel, timeoutMs });
  } catch (e) {
    const msg = e?.message ?? String(e);
    const offline = /abort|timeout|fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|network/i.test(msg);
    return {
      ok: false,
      reason: offline ? "Ollama \u79BB\u7EBF" : `Ollama \u8C03\u7528\u5931\u8D25\uFF1A${msg}`,
      dry_run: dryRun,
      samples_count: samples.length
    };
  }
  if (!negativeRules.length) {
    return {
      ok: true,
      reason: "\u672A\u53D1\u73B0 AI \u5473\uFF0C\u65E0\u9700\u66F4\u65B0",
      samples_count: samples.length,
      negative_rules: [],
      dry_run: dryRun,
      written: false
    };
  }
  let personasRoot;
  try {
    personasRoot = resolvePersonasRoot();
  } catch (e) {
    return {
      ok: false,
      reason: `\u627E\u4E0D\u5230 config/personas\uFF1A${e.message}`,
      samples_count: samples.length,
      negative_rules: negativeRules,
      dry_run: dryRun
    };
  }
  const personaId = (opts.persona_id ?? "").trim() || getActiveId(personasRoot);
  if (!personaId) {
    return { ok: false, reason: "\u65E0\u6CD5\u786E\u5B9A persona_id", samples_count: samples.length, negative_rules: negativeRules, dry_run: dryRun };
  }
  const rulesPath = join(personasRoot, personaId, "rules.json");
  const backupPath = rulesPath.replace(/\.json$/i, "_backup.json");
  const cur = loadRules(rulesPath);
  const existing = Array.isArray(cur.negative_rules) ? cur.negative_rules : [];
  const merged = mergeNegativeRules(existing, negativeRules);
  const newCount = merged.length - existing.length;
  if (newCount <= 0) {
    return {
      ok: true,
      reason: "\u63D0\u53D6\u5230\u7684\u89C4\u5219\u5DF2\u5168\u90E8\u5B58\u5728\uFF0C\u65E0\u65B0\u589E",
      persona_id: personaId,
      samples_count: samples.length,
      negative_rules: [],
      rules_path: rulesPath,
      dry_run: dryRun,
      written: false
    };
  }
  const next = { ...cur, negative_rules: merged };
  const { backup_written, written } = backupAndWriteRules(rulesPath, next, dryRun);
  return {
    ok: true,
    reason: dryRun ? "dry_run\uFF1A\u4EC5\u751F\u6210\u5BA1\u67E5\u7ED3\u679C\uFF0C\u672A\u5199\u5165\u6587\u4EF6" : `\u5DF2\u8FFD\u52A0 ${newCount} \u6761\u8D1F\u5411\u89C4\u5219\u5230 ${personaId}/rules.json`,
    persona_id: personaId,
    samples_count: samples.length,
    negative_rules: negativeRules,
    rules_path: rulesPath,
    backup_path: backupPath,
    backup_written,
    written,
    dry_run: dryRun
  };
}

// src/index.ts
var LOG_TAG = "[dsh-self-play]";
var tool = {
  name: "run_self_play_test",
  description: "\u590D\u76D8\u5F53\u524D\u89D2\u8272\u8FD1\u671F\u56DE\u590D\uFF0C\u7528\u672C\u5730 Ollama \u5BA1\u67E5\u5176\u4E2D\u7684 AI \u5473 / \u5BA2\u670D\u8154\uFF0C\u628A\u63D0\u70BC\u51FA\u7684\u8D1F\u5411\u6307\u4EE4\u8FFD\u52A0\u5230 config/personas/<id>/rules.json \u7684 negative_rules\u3002\u9ED8\u8BA4 dry_run=true\uFF1A\u53EA\u8FD4\u56DE\u5BA1\u67E5\u7ED3\u679C\uFF0C\u4E0D\u5199\u6587\u4EF6\uFF08\u5B89\u5168\u9884\u89C8\uFF09\uFF1B\u4F20 dry_run=false \u624D\u4F1A\u5148\u5907\u4EFD rules.json \u4E3A rules_backup.json\uFF0C\u518D\u5199\u5165\u3002\u7CFB\u7EDF\u6BCF\u5929 03:00 \u4F1A\u81EA\u52A8\u4EE5 dry_run=false \u8DD1\u4E00\u6B21\u3002",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      dry_run: {
        type: "boolean",
        default: true,
        description: "true=\u53EA\u9884\u89C8\u4E0D\u5199\u6587\u4EF6\uFF08\u9ED8\u8BA4\uFF09\uFF1Bfalse=\u5907\u4EFD\u540E\u5199\u5165 negative_rules"
      },
      persona_id: {
        type: "string",
        description: "\u6307\u5B9A\u5BA1\u67E5\u54EA\u4E2A\u89D2\u8272\uFF1B\u9ED8\u8BA4\u8BFB active.json \u7684\u5F53\u524D\u6FC0\u6D3B\u89D2\u8272"
      }
    }
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        reason: { type: "string" },
        persona_id: { type: "string" },
        samples_count: { type: "integer" },
        negative_rules: { type: "array" },
        written: { type: "boolean" },
        backup_written: { type: "boolean" },
        rules_path: { type: "string" }
      }
    },
    render: (_args, value) => {
      const lines = [];
      if (value?.ok) {
        lines.push(`\u{1F9E0} \u81EA\u8FDB\u5316\u5B8C\u6210\uFF1A${value.reason ?? ""}`);
        if (Array.isArray(value.negative_rules) && value.negative_rules.length) {
          lines.push("\u63D0\u70BC\u5230\u7684\u8D1F\u5411\u6307\u4EE4\uFF1A");
          value.negative_rules.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
        }
        if (value.written) lines.push(`\u2705 \u5DF2\u5199\u5165 ${value.rules_path ?? "rules.json"}\uFF08\u5DF2\u5907\u4EFD rules_backup.json\uFF09`);
        else if (value.dry_run) lines.push("\uFF08dry_run\uFF1A\u672A\u5199\u5165\u6587\u4EF6\uFF09");
      } else {
        lines.push(`\u26A0\uFE0F \u81EA\u8FDB\u5316\u672A\u6267\u884C\uFF1A${value?.reason ?? "\u672A\u77E5"}`);
      }
      return [{ type: "text", text: lines.join("\n") }];
    }
  },
  async execute(args) {
    return await runSelfPlay({
      dry_run: args?.dry_run !== false,
      persona_id: typeof args?.persona_id === "string" ? args.persona_id : void 0
    });
  },
  presentCall(args) {
    const write = args?.dry_run === false;
    return { card: "generic", title: `run_self_play_test${write ? "\uFF08\u5199\u5165\uFF09" : "\uFF08\u9884\u89C8\uFF09"}`, kind: write ? "write" : "read" };
  }
};
var index_default = {
  name: "dsh-self-play",
  apply(ctx) {
    console.log(`${LOG_TAG} apply`);
    const disposers = [];
    try {
      const d = ctx.tools.register(tool);
      if (typeof d === "function") disposers.push(d);
      console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 run_self_play_test`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C\u5DE5\u5177 run_self_play_test \u5931\u8D25\uFF1A`, e);
    }
    let scheduledTask = null;
    let running = false;
    if (process.env.SELF_PLAY_CRON_DISABLED === "1") {
      console.log(`${LOG_TAG} SELF_PLAY_CRON_DISABLED=1\uFF0C03:00 \u5B9A\u65F6\u4EFB\u52A1\u672A\u542F\u7528`);
    } else {
      try {
        scheduledTask = import_node_cron.default.schedule("0 3 * * *", async () => {
          if (running) {
            console.log(`${LOG_TAG} \u4E0A\u4E00\u8F6E\u81EA\u8FDB\u5316\u4ECD\u5728\u8FDB\u884C\uFF0C\u8DF3\u8FC7\u672C\u6B21 03:00 \u89E6\u53D1`);
            return;
          }
          running = true;
          const t0 = Date.now();
          try {
            const res = await runSelfPlay({ dry_run: false });
            console.log(
              `${LOG_TAG} 03:00 \u81EA\u8FDB\u5316\u5B8C\u6210\uFF08\u8017\u65F6 ${((Date.now() - t0) / 1e3).toFixed(1)}s\uFF09\uFF1A` + JSON.stringify({ ok: res.ok, reason: res.reason, persona_id: res.persona_id, written: res.written })
            );
          } catch (e) {
            console.error(`${LOG_TAG} 03:00 \u81EA\u8FDB\u5316\u5F02\u5E38\uFF08\u5DF2\u964D\u7EA7\uFF0C\u4E0D\u5F71\u54CD\u4E3B\u6D41\u7A0B\uFF09\uFF1A${e.message}`);
          } finally {
            running = false;
          }
        });
        console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5B9A\u65F6\u4EFB\u52A1\uFF1A\u6BCF\u5929 03:00 \u81EA\u8FDB\u5316\uFF08cron '0 3 * * *'\uFF09`);
      } catch (e) {
        console.error(`${LOG_TAG} \u6CE8\u518C cron \u5931\u8D25\uFF08\u5DE5\u5177\u4ECD\u53EF\u7528\uFF0C\u53EA\u662F\u6CA1\u6709\u5B9A\u65F6\u89E6\u53D1\uFF09\uFF1A`, e.message);
      }
    }
    ctx.on("dispose", () => {
      try {
        scheduledTask?.stop?.();
      } catch {
      }
      for (const d of disposers) {
        try {
          d();
        } catch {
        }
      }
      console.log(`${LOG_TAG} disposed`);
    });
  }
};
export {
  auditWithOllama,
  backupAndWriteRules,
  index_default as default,
  extractStringArray,
  fetchRecentSamples,
  loadRules,
  mergeNegativeRules,
  resolvePersonasRoot,
  runSelfPlay
};
//# sourceMappingURL=index.js.map
