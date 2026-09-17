// misc.js — BInt, DataView extensions, logger, version detection

//#region Logger
const logger = {
  seq: 0,
  verbose: true,
  info(msg)  { this.log(`[+] ${msg}`); },
  error(msg) { this.log(`[-] ${msg}`); },
  debug(msg) { if (this.verbose) this.log(`[*] ${msg}`); },
  log(msg)   { console.log(msg); },
};
//#endregion

//#region Version detection
const version = {
  console: undefined,
  major: undefined,
  minor: undefined,
  init() {
    const ua = navigator.userAgent;
    logger.info(`Agent: ${ua}`);

    const matches = ua.match(/PlayStation\s+(\d+)[/ ](\d+)\.(\d+)/);
    if (matches === null) {
      throw new Error(`${ua} not supported !!`);
    }

    this.console = parseInt(matches[1], 10);
    this.major   = parseInt(matches[2], 10);
    this.minor   = parseInt(matches[3], 16);
  },
  toString() {
    return `${this.major}.${this.minor.toString(16).padStart(2, "0")}`;
  },
};
//#endregion

//#region BInt class
class BInt {
  constructor() {
    let lo = 0;
    let hi = 0;

    switch (arguments.length) {
      case 0:
        break;
      case 1: {
        let value = arguments[0];
        switch (typeof value) {
          case "boolean":
            lo = value ? 1 : 0;
            break;
          case "number":
            if (Number.isNaN(value)) throw new TypeError(`Number ${value} is NaN`);
            if (Number.isInteger(value)) {
              if (!Number.isSafeInteger(value)) {
                throw new RangeError(`Integer ${value} outside safe 53-bit range`);
              }
              lo = value >>> 0;
              hi = Math.floor(value / 0x100000000) >>> 0;
            } else {
              BInt.View.setFloat64(0, value, true);
              lo = BInt.View.getUint32(0, true);
              hi = BInt.View.getUint32(4, true);
            }
            break;
          case "string": {
            if (value.startsWith("0x")) value = value.slice(2);
            if (value.length > 0x10) {
              throw new RangeError(`String ${value} is out of range !!`);
            }
            value = value.padStart(16, "0");
            for (let i = 0; i < 8; i++) {
              const start = value.length - 2 * (i + 1);
              const end = value.length - 2 * i;
              const b = value.slice(start, end);
              BInt.View.setUint8(i, parseInt(b, 16));
            }
            lo = BInt.View.getUint32(0, true);
            hi = BInt.View.getUint32(4, true);
            break;
          }
          case "object":
            if (value !== null) {
              if (Number.isInteger(value.lo) && Number.isInteger(value.hi)) {
                lo = value.lo;
                hi = value.hi;
                break;
              } else if (ArrayBuffer.isView(value) &&
                         value.byteLength === BInt.View.byteLength) {
                new Uint8Array(BInt.View.buffer).set(
                  new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
                lo = BInt.View.getUint32(0, true);
                hi = BInt.View.getUint32(4, true);
                break;
              }
            }
            // fall through
          default:
            throw new TypeError(`Unsupported value ${value} !!`);
        }
        break;
      }
      case 2:
        hi = arguments[0];
        lo = arguments[1];
        if (!Number.isInteger(hi)) throw new RangeError(`hi value ${hi} is not an integer !!`);
        if (!Number.isInteger(lo)) throw new RangeError(`lo value ${lo} is not an integer !!`);
        hi >>>= 0;
        lo >>>= 0;
        break;
      default:
        throw new TypeError("Unsupported input !!");
    }

    this.lo = lo;
    this.hi = hi;
  }

  get i() {
    const hi = this.hi | 0;
    if (hi < -0x200000 || hi > 0x1fffff) {
      throw new RangeError(`${this} outside safe 53-bit range`);
    }
    return hi * 0x100000000 + this.lo;
  }

  get u() {
    const hi = this.hi;
    if (hi > 0x1fffff) {
      throw new RangeError(`${this} outside safe 53-bit range`);
    }
    return hi * 0x100000000 + this.lo;
  }

  toString() {
    return "0x" + this.hi.toString(16).padStart(8, "0") +
                  this.lo.toString(16).padStart(8, "0");
  }

  [Symbol.toPrimitive](hint) {
    if (hint === "string") return this.toString();
    return this.i;
  }

  cmp(value) {
    value = value instanceof BInt ? value : new BInt(value);
    return this.hi !== value.hi
      ? (this.hi > value.hi ? 1 : -1)
      : this.lo !== value.lo
        ? (this.lo > value.lo ? 1 : -1)
        : 0;
  }

  eq(value) {
    value = value instanceof BInt ? value : new BInt(value);
    return this.hi === value.hi && this.lo === value.lo;
  }
  neq(value) {
    value = value instanceof BInt ? value : new BInt(value);
    return this.hi !== value.hi || this.lo !== value.lo;
  }

  add(value) {
    value = value instanceof BInt ? value : new BInt(value);
    const lo = this.lo + value.lo;
    const c = lo > 0xffffffff ? 1 : 0;
    const hi = this.hi + value.hi + c;
    if (hi > 0xffffffff) throw new RangeError("add overflowed !!");
    return new BInt(hi, lo);
  }

  sub(value) {
    value = value instanceof BInt ? value : new BInt(value);
    if (this.cmp(value) < 0) throw new RangeError("sub underflowed !!");
    const b = this.lo < value.lo ? 1 : 0;
    const hi = this.hi - value.hi - b;
    const lo = this.lo - value.lo;
    return new BInt(hi, lo);
  }

  and(value) {
    value = value instanceof BInt ? value : new BInt(value);
    return new BInt((this.hi & value.hi) >>> 0, (this.lo & value.lo) >>> 0);
  }
  or(value) {
    value = value instanceof BInt ? value : new BInt(value);
    return new BInt((this.hi | value.hi) >>> 0, (this.lo | value.lo) >>> 0);
  }
}

BInt.View = new DataView(new ArrayBuffer(8));
//#endregion

//#region DataView extensions
DataView.prototype.getBInt = function (byteOffset, littleEndian = false) {
  const lo = this.getUint32(byteOffset, littleEndian);
  const hi = this.getUint32(byteOffset + 4, littleEndian);
  return new BInt(hi, lo);
};

DataView.prototype.setBInt = function (byteOffset, value, littleEndian = false) {
  value = value instanceof BInt ? value : new BInt(value);
  this.setUint32(byteOffset, value.lo, littleEndian);
  this.setUint32(byteOffset + 4, value.hi, littleEndian);
};
//#endregion