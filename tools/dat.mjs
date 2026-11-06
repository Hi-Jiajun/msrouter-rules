// v2ray geosite.dat / geoip.dat 的 protobuf wire 编解码（零依赖）
//
// schema 见 v2ray-core app/router/routercommon/common.proto。这两种 message 只用到
// wire type 0（varint）与 wire type 2（length-delimited），所以手写编码器即可：
//
//   Domain   { type = 1 varint; value = 2 string; attribute = 3 repeated }
//   GeoSite  { country_code = 1 string; domain = 2 repeated Domain }
//   GeoSiteList { entry = 1 repeated GeoSite }
//   CIDR     { ip = 1 bytes; prefix = 2 uint32 }
//   GeoIP    { country_code = 1 string; cidr = 2 repeated CIDR; reverse_match = 3 bool }
//   GeoIPList { entry = 1 repeated GeoIP }
//
// 类型语义（务必与 v2ray / Landscape 一致，不要按字面猜）：
//   Plain(0)  = 子串匹配（v2fly 的 keyword:）
//   Regex(1)  = 正则
//   Domain(2) = 后缀匹配（v2fly 的 domain:，等价于 sing-box 的 domain_suffix）
//   Full(3)   = 完全相等（v2fly 的 full:，等价于 sing-box 的 domain）
// 证据：v2fly/domain-list-community main.go 把 keyword 映射到 Domain_Plain、
// domain 映射到 Domain_RootDomain；v2ray-core common/strmatcher 里 Substr 即包含匹配。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOMAIN_TYPES = { PLAIN: 0, REGEX: 1, DOMAIN: 2, FULL: 3 };
export const DOMAIN_TYPE_NAME = ['plain', 'regex', 'domain', 'full'];

// ── wire 基础 ──────────────────────────────────────────────────
function varint(value) {
  let n = value;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`varint 只接受非负安全整数，收到 ${value}`);
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

const tag = (field, wire) => varint(field * 8 + wire);
const varintField = (field, value) => Buffer.concat([tag(field, 0), varint(value)]);
const bytesField = (field, payload) =>
  Buffer.concat([tag(field, 2), varint(payload.length), payload]);
const stringField = (field, value) => bytesField(field, Buffer.from(value, 'utf8'));

function readVarint(buf, pos) {
  let result = 0;
  let shift = 1;
  let index = pos;
  while (true) {
    if (index >= buf.length) throw new Error(`varint 越界（偏移 ${pos}）`);
    const byte = buf[index++];
    result += (byte & 0x7f) * shift;
    if (!(byte & 0x80)) return [result, index];
    shift *= 128;
    if (shift > 2 ** 56) throw new Error(`varint 过长（偏移 ${pos}）`);
  }
}

/** 读出一层 message 的字段；未知字段按 wire type 跳过，便于向前兼容。 */
function readFields(buf, start = 0, end = buf.length) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 0) throw new Error(`非法字段号 0（偏移 ${pos}）`);
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      if (pos + length > end) throw new Error(`length-delimited 越界（字段 ${field}）`);
      fields.push({ field, wire, value: buf.subarray(pos, pos + length) });
      pos += length;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`不支持的 wire type ${wire}（字段 ${field}）`);
    }
    if (pos > end) throw new Error(`字段 ${field} 越界`);
  }
  if (pos !== end) throw new Error('message 长度不一致');
  return fields;
}

// ── 编码 ──────────────────────────────────────────────────────
export function encodeDomain({ type, value }) {
  if (!Number.isInteger(type) || type < 0 || type > 3) throw new Error(`非法 domain type: ${type}`);
  if (typeof value !== 'string' || value.length === 0) throw new Error('domain value 不能为空');
  return Buffer.concat([varintField(1, type), stringField(2, value)]);
}

export function encodeGeoSite({ countryCode, domains }) {
  if (!countryCode) throw new Error('GeoSite.country_code 不能为空');
  const parts = [stringField(1, countryCode)];
  for (const domain of domains) parts.push(bytesField(2, encodeDomain(domain)));
  return Buffer.concat(parts);
}

export function encodeGeoSiteList(entries) {
  return Buffer.concat(entries.map(entry => bytesField(1, encodeGeoSite(entry))));
}

export function encodeCidr({ ip, prefix }) {
  if (!Buffer.isBuffer(ip) || (ip.length !== 4 && ip.length !== 16)) {
    throw new Error('CIDR.ip 必须是 4 或 16 字节');
  }
  const max = ip.length * 8;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new Error(`非法 prefix ${prefix}（${max} 位地址）`);
  }
  return Buffer.concat([bytesField(1, ip), varintField(2, prefix)]);
}

export function encodeGeoIp({ countryCode, cidrs, reverseMatch = false }) {
  if (!countryCode) throw new Error('GeoIP.country_code 不能为空');
  const parts = [stringField(1, countryCode)];
  for (const cidr of cidrs) parts.push(bytesField(2, encodeCidr(cidr)));
  if (reverseMatch) parts.push(varintField(3, 1));
  return Buffer.concat(parts);
}

export function encodeGeoIpList(entries) {
  return Buffer.concat(entries.map(entry => bytesField(1, encodeGeoIp(entry))));
}

// ── 解码 ──────────────────────────────────────────────────────
function decodeDomain(buf) {
  const fields = readFields(buf);
  let type = 0;
  let value;
  for (const f of fields) {
    if (f.field === 1 && f.wire === 0) type = f.value;
    else if (f.field === 2 && f.wire === 2) value = f.value.toString('utf8');
  }
  if (value === undefined) throw new Error('Domain 缺少 value');
  if (type < 0 || type > 3) throw new Error(`Domain 类型越界: ${type}`);
  return { type, value };
}

function decodeGeoSite(buf) {
  const fields = readFields(buf);
  let countryCode;
  const domains = [];
  for (const f of fields) {
    if (f.field === 1 && f.wire === 2) countryCode = f.value.toString('utf8');
    else if (f.field === 2 && f.wire === 2) domains.push(decodeDomain(f.value));
  }
  if (!countryCode) throw new Error('GeoSite 缺少 country_code');
  return { countryCode, domains };
}

export function decodeGeoSiteList(buf) {
  return readFields(buf)
    .filter(f => f.field === 1 && f.wire === 2)
    .map(f => decodeGeoSite(f.value));
}

function decodeCidr(buf) {
  const fields = readFields(buf);
  let ip;
  let prefix;
  for (const f of fields) {
    if (f.field === 1 && f.wire === 2) ip = Buffer.from(f.value);
    else if (f.field === 2 && f.wire === 0) prefix = f.value;
  }
  if (!ip) throw new Error('CIDR 缺少 ip');
  if (prefix === undefined) throw new Error('CIDR 缺少 prefix');
  if (ip.length !== 4 && ip.length !== 16) throw new Error(`CIDR.ip 长度非法: ${ip.length}`);
  if (prefix > ip.length * 8) throw new Error(`CIDR.prefix 越界: ${prefix}`);
  return { ip, prefix };
}

function decodeGeoIp(buf) {
  const fields = readFields(buf);
  let countryCode;
  let reverseMatch = false;
  const cidrs = [];
  for (const f of fields) {
    if (f.field === 1 && f.wire === 2) countryCode = f.value.toString('utf8');
    else if (f.field === 2 && f.wire === 2) cidrs.push(decodeCidr(f.value));
    else if (f.field === 3 && f.wire === 0) reverseMatch = f.value !== 0;
  }
  if (!countryCode) throw new Error('GeoIP 缺少 country_code');
  return { countryCode, cidrs, reverseMatch };
}

export function decodeGeoIpList(buf) {
  return readFields(buf)
    .filter(f => f.field === 1 && f.wire === 2)
    .map(f => decodeGeoIp(f.value));
}

// ── IP / CIDR 工具 ────────────────────────────────────────────
function parseIPv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map(p => (p === '' || !/^\d{1,3}$/.test(p) ? NaN : Number(p)));
  if (bytes.some(b => !(b >= 0 && b <= 255))) return null;
  return Buffer.from(bytes);
}

export function parseIPv6(text) {
  let addr = text;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (!addr.includes(':')) return null;

  if (addr.includes('.')) {
    const cut = addr.lastIndexOf(':');
    if (cut === -1) return null;
    const v4 = parseIPv4(addr.slice(cut + 1));
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    addr = `${addr.slice(0, cut + 1)}${high}:${low}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    if (left.length + right.length > 7) return null;
    groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    buf.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  return buf;
}

/** 点分/冒号文本 → 4 或 16 字节；非法返回 null。 */
export function ipToBytes(text) {
  return parseIPv4(text) || parseIPv6(text);
}

/** 把 ip 的低位清零到 prefix 长度，得到规范的网络地址。 */
function maskBytes(ip, prefix) {
  const out = Buffer.from(ip);
  for (let bit = prefix; bit < out.length * 8; bit++) {
    out[bit >> 3] &= ~(0x80 >> (bit & 7));
  }
  return out;
}

/** "1.2.3.0/24" / "2001:db8::/32" → { ip: Buffer(4|16), prefix }。 */
export function cidrToWire(text) {
  const slash = text.indexOf('/');
  if (slash === -1) throw new Error(`不是 CIDR: ${text}`);
  const ip = ipToBytes(text.slice(0, slash));
  if (!ip) throw new Error(`非法 IP: ${text}`);
  const prefixText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) throw new Error(`非法前缀长度: ${text}`);
  const prefix = Number(prefixText);
  if (prefix > ip.length * 8) throw new Error(`前缀长度越界: ${text}`);
  return { ip: maskBytes(ip, prefix), prefix };
}

function bytesToText(ip) {
  if (ip.length === 4) return [...ip].join('.');
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(ip.readUInt16BE(i).toString(16));
  return groups.join(':');
}

export { bytesToText };

/** ip（文本或字节）是否落在 cidr 内。 */
export function cidrContains(cidr, ip) {
  const target = Buffer.isBuffer(ip) ? ip : ipToBytes(ip);
  if (!target || target.length !== cidr.ip.length) return false;
  const prefix = cidr.prefix;
  const fullBytes = prefix >> 3;
  for (let i = 0; i < fullBytes; i++) if (target[i] !== cidr.ip[i]) return false;
  const rest = prefix & 7;
  if (rest === 0) return true;
  const mask = 0xff & (0xff << (8 - rest));
  return (target[fullBytes] & mask) === (cidr.ip[fullBytes] & mask);
}

// ── 匹配（与 v2ray / Landscape 的语义一致，供断言使用）────────
export function matchDomain(domain, domains) {
  const d = String(domain).toLowerCase().replace(/\.$/, '');
  for (const rule of domains) {
    switch (rule.type) {
      case DOMAIN_TYPES.PLAIN:
        if (d.includes(rule.value)) return true;
        break;
      case DOMAIN_TYPES.REGEX:
        if (new RegExp(rule.value).test(d)) return true;
        break;
      case DOMAIN_TYPES.DOMAIN:
        if (d === rule.value || d.endsWith(`.${rule.value}`)) return true;
        break;
      case DOMAIN_TYPES.FULL:
        if (d === rule.value) return true;
        break;
      default:
        throw new Error(`未知 domain type: ${rule.type}`);
    }
  }
  return false;
}

// ── 命令行：读回 .dat 看结构（排查用）────────────────────────
function countByType(domains) {
  const out = { plain: 0, regex: 0, domain: 0, full: 0 };
  for (const d of domains) out[DOMAIN_TYPE_NAME[d.type]]++;
  return out;
}

function cli(argv) {
  const [kind, file] = argv;
  if (!kind || !file) {
    console.error('用法: node tools/dat.mjs <geosite|geoip> <file>');
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  if (kind === 'geosite') {
    const entries = decodeGeoSiteList(buf);
    const summary = entries.map(e => ({
      key: e.countryCode,
      total: e.domains.length,
      by_type: countByType(e.domains),
    }));
    console.log(JSON.stringify({ file, bytes: buf.length, entries: entries.length, keys: summary }, null, 2));
  } else if (kind === 'geoip') {
    const entries = decodeGeoIpList(buf);
    const summary = entries.map(e => ({
      key: e.countryCode,
      total: e.cidrs.length,
      v4: e.cidrs.filter(c => c.ip.length === 4).length,
      v6: e.cidrs.filter(c => c.ip.length === 16).length,
      reverse_match: e.reverseMatch,
    }));
    console.log(JSON.stringify({ file, bytes: buf.length, entries: entries.length, keys: summary }, null, 2));
  } else {
    console.error(`未知类型: ${kind}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2));
}
