// msrouter-rules 构建流水线：fetch → merge → compile → verify → manifest
// 依赖：node >= 18、curl、sing-box 二进制（环境变量 SING_BOX 指定）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  encodeGeoSiteList, encodeGeoIpList, decodeGeoSiteList, decodeGeoIpList,
  cidrToWire, cidrContains, matchDomain,
} from './dat.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const DIST = path.join(ROOT, 'dist');
const SING_BOX = process.env.SING_BOX || 'sing-box';
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const DROP = new Set(CFG.options?.drop_types || []);
const TYPES = ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'ip_cidr'];

const log = (...a) => console.log(...a);
const mkdir = d => fs.mkdirSync(d, { recursive: true });

function curl(url, out) {
  if (fs.existsSync(out) && process.env.FORCE_FETCH !== '1') return out;
  mkdir(path.dirname(out));
  execFileSync('curl', ['-fsSL', '--retry', '3', '--max-time', '120', '-o', out, url], { stdio: 'pipe' });
  return out;
}
// rule-set match 专用：区分「命中」与「命令失败」。
// sing-box 命中时退出码 0 并打印匹配项；文件损坏/参数错误时退出码非 0 并打印错误文本。
// 旧实现只判断输出非空，会把错误文本误当成命中。
function matchRuleSet(file, domain) {
  const r = spawnSync(SING_BOX, ['rule-set', 'match', '-f', 'binary', file, domain], { encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0) return { ok: false, reason: out.split('\n')[0] || ('exit ' + r.status) };
  return { ok: true, hit: out.length > 0 };
}

function singbox(args, opts = {}) {
  // 注意：sing-box rule-set match 的结果打印在 stderr，必须合并两路
  const r = spawnSync(SING_BOX, args, { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !opts.allowFail) throw new Error(`sing-box ${args.join(' ')} 失败: ${out}`);
  return out;
}
const strip = v => String(v).replace(/^\+\./, '').replace(/^\*\./, '').replace(/^\./, '').toLowerCase();
const blank = () => ({ domain: new Set(), domain_suffix: new Set(), domain_keyword: new Set(), ip_cidr: new Set() });

// ── 上游适配器：返回 blank() 形状的集合 ──────────────────────────
const adapters = {
  'singbox-json': (up, cat, file) => {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = blank();
    for (const t of TYPES) if (out[t] && !DROP.has(t)) for (const v of d.rules?.[0]?.[t] || []) out[t].add(strip(v));
    return out;
  },
  'clash-list': (up, cat, file) => {
    const out = blank();
    for (let l of fs.readFileSync(file, 'utf8').split('\n')) {
      l = l.trim();
      if (!l || l.startsWith('#') || l.startsWith(';') || l.startsWith('!') || l.startsWith('//')) continue;
      const [kind, val] = l.split(',').map(s => s.trim());
      if (!val) continue;
      if (kind === 'DOMAIN') out.domain.add(strip(val));
      else if (kind === 'DOMAIN-SUFFIX') out.domain_suffix.add(strip(val));
      else if (kind === 'DOMAIN-KEYWORD') out.domain_keyword.add(strip(val));
    }
    return out;
  },
  'clash-payload': (up, cat, file) => {
    const out = blank();
    for (let l of fs.readFileSync(file, 'utf8').split('\n')) {
      l = l.trim();
      if (!l || l.startsWith('#') || l === 'payload:') continue;
      const v = strip(l.replace(/^-\s*/, '').replace(/^'|'$/g, ''));
      if (v) out.domain_suffix.add(v);
    }
    return out;
  },
  'local': (up, cat, file) => adapters['clash-list'](up, cat, file),
  'cidr-list': (up, cat, file) => {
    const out = blank();
    for (let l of fs.readFileSync(file, 'utf8').split('\n')) {
      l = l.trim();
      if (!l || l.startsWith('#') || !l.includes('/')) continue;
      if (up.family === 'inet' && l.includes(':')) continue;   // 默认只留 v4
      out.ip_cidr.add(l);
    }
    return out;
  },
  'ripe-asn': (up, cat, file) => {
    const out = blank();
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of d.data?.prefixes || []) {
      if (up.family === 'inet' && p.prefix.includes(':')) continue;
      out.ip_cidr.add(p.prefix);
    }
    return out;
  },
  'geosite-db': (up, cat, file) => {
    const out = blank();
    const json = path.join(CACHE, 'meta', `${cat}.export.json`);
    if (!fs.existsSync(json) || process.env.FORCE_FETCH === '1') {
      mkdir(path.dirname(json));
      singbox(['geosite', '-f', file, 'export', cat, '-o', json], { allowFail: true });
    }
    if (!fs.existsSync(json)) return null; // meta 没有这个分类
    return adapters['singbox-json'](up, cat, json);
  },
};

function fetchRef(ref) {
  const [upName, cat] = ref.split(':');
  const up = CFG.upstreams[upName];
  if (!up) throw new Error(`未知上游: ${upName}`);
  if (up.kind === 'local') { const f = path.join(ROOT, 'supplements', cat + '.list'); return { up, cat, file: f }; }
  const url = up.url.replaceAll('{cat}', encodeURIComponent(cat)).replaceAll('{file}', cat);
  const file = path.join(CACHE, upName, path.extname(url) && up.kind === 'geosite-db'
    ? 'geosite.db' : `${cat}.${up.kind === 'singbox-json' ? 'json' : up.kind === 'clash-list' ? 'list' : 'txt'}`);
  curl(url, file);
  return { up, cat, file };
}

async function main() {
  mkdir(CACHE); mkdir(path.join(DIST, 'json')); mkdir(path.join(DIST, 'srs'));

  const manifest = { generated_at: new Date().toISOString(), sing_box: singbox(['version']).split('\n')[0].trim(), rule_sets: {} };
  const tags = Object.keys(CFG.rule_sets);
  const builtRules = {};   // tag → 合并后的 rule，.srs 与 .dat 都从这里取，保证同源
  log(`共 ${tags.length} 个 rule_set`);

  for (const tag of tags) {
    const recipe = CFG.rule_sets[tag];
    const refs = recipe.union || [recipe.take];
    const merged = blank();
    const sources = [];

    for (const ref of refs) {
      const { up, cat, file } = fetchRef(ref);
      const set = adapters[up.kind](up, cat, file);
      if (!set) { log(`  ! ${tag}: 上游 ${ref} 没有该分类，跳过`); continue; }
      const upSha = (up.kind === 'geosite-db')
        ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
        : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      sources.push({ ref, url: up.url, upstream_sha256: upSha,
                     counts: Object.fromEntries(TYPES.map(t => [t, set[t]?.size || 0])) });
      for (const t of TYPES) if (merged[t]) for (const v of set[t] || []) merged[t].add(v);
    }

    // 后缀已覆盖的完整域名去掉
    for (const d of merged.domain) if (merged.domain_suffix.has(d)) merged.domain.delete(d);
    const rule = {};
    for (const t of TYPES) if (merged[t]?.size) rule[t] = [...merged[t]].sort();
    const total = Object.values(rule).reduce((a, b) => a + b.length, 0);
    if (!total) throw new Error(`${tag} 合并后为空`);
    builtRules[tag] = rule;

    const jsonPath = path.join(DIST, 'json', `${tag}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ version: 2, rules: [rule] }, null, 2) + '\n');

    const srsPath = path.join(DIST, 'srs', `${tag}.srs`);
    singbox(['rule-set', 'compile', jsonPath, '-o', srsPath]);

    manifest.rule_sets[tag] = {
      sources, total,
      counts: Object.fromEntries(TYPES.filter(t => rule[t]).map(t => [t, rule[t].length])),
      srs_sha256: crypto.createHash('sha256').update(fs.readFileSync(srsPath)).digest('hex'),
      srs_bytes: fs.statSync(srsPath).size,
    };
    log(`  ✓ ${tag.padEnd(14)} ${String(total).padStart(6)} 条  ${String(manifest.rule_sets[tag].srs_bytes).padStart(7)} B  ← ${refs.join(' + ')}`);
  }

  // ── v2ray .dat：geosite.dat / geoip.dat，与 .srs 共用同一份合并结果 ──
  // 类型映射按 v2ray 真实语义（v2fly/domain-list-community 的映射，Landscape 的
  // DomainMatcher 也照此实现）：
  //   domain_suffix → RootDomain(2)，domain → Full(3)，domain_keyword → Plain(0)
  // Plain 是子串匹配，正好等价 sing-box 的 domain_keyword，所以 keyword 没有损失。
  const SITE_TYPES = [['domain_suffix', 2], ['domain', 3], ['domain_keyword', 0], ['domain_regex', 1]];
  const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
  let datState = null;
  if (CFG.dat) {
    const geositeEntries = [];
    for (const [key, tag] of Object.entries(CFG.dat.geosite || {})) {
      const rule = builtRules[tag];
      if (!rule) throw new Error(`dat.geosite 的 ${key} 指向未产出的 rule_set: ${tag}`);
      const domains = [];
      for (const [singboxType, type] of SITE_TYPES)
        for (const value of rule[singboxType] || []) domains.push({ type, value });
      domains.sort((a, b) => a.type - b.type || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      if (!domains.length) throw new Error(`dat.geosite 的 ${key}（${tag}）没有域名条目`);
      geositeEntries.push({ countryCode: key, domains });
    }

    const geoipEntries = [];
    for (const [key, tag] of Object.entries(CFG.dat.geoip || {})) {
      const rule = builtRules[tag];
      if (!rule) throw new Error(`dat.geoip 的 ${key} 指向未产出的 rule_set: ${tag}`);
      const cidrs = (rule.ip_cidr || []).map(cidrToWire);
      cidrs.sort((a, b) => a.ip.length - b.ip.length || Buffer.compare(a.ip, b.ip) || a.prefix - b.prefix);
      if (!cidrs.length) throw new Error(`dat.geoip 的 ${key}（${tag}）没有 ip_cidr 条目`);
      geoipEntries.push({ countryCode: key, cidrs });
    }

    const geositeBuf = encodeGeoSiteList(geositeEntries);
    const geoipBuf = encodeGeoIpList(geoipEntries);
    fs.writeFileSync(path.join(DIST, 'geosite.dat'), geositeBuf);
    fs.writeFileSync(path.join(DIST, 'geoip.dat'), geoipBuf);

    // 读回校验：解码 → 重新编码必须与原文件逐字节一致，条目数必须与源一致
    const backSites = decodeGeoSiteList(fs.readFileSync(path.join(DIST, 'geosite.dat')));
    const backIps = decodeGeoIpList(fs.readFileSync(path.join(DIST, 'geoip.dat')));
    if (!encodeGeoSiteList(backSites).equals(geositeBuf)) throw new Error('geosite.dat 读回后重新编码与原文不一致');
    if (!encodeGeoIpList(backIps).equals(geoipBuf)) throw new Error('geoip.dat 读回后重新编码与原文不一致');
    const siteMap = new Map(backSites.map(e => [e.countryCode, e.domains]));
    const ipMap = new Map(backIps.map(e => [e.countryCode, e.cidrs]));
    for (const e of geositeEntries)
      if (siteMap.get(e.countryCode)?.length !== e.domains.length)
        throw new Error(`geosite.dat 的 ${e.countryCode} 条目数与源不一致`);
    for (const e of geoipEntries)
      if (ipMap.get(e.countryCode)?.length !== e.cidrs.length)
        throw new Error(`geoip.dat 的 ${e.countryCode} 条目数与源不一致`);

    const byType = domains => Object.fromEntries(SITE_TYPES
      .map(([name, type]) => [name, domains.filter(d => d.type === type).length])
      .filter(([, n]) => n > 0));

    manifest.dat = {
      geosite: {
        file: 'geosite.dat',
        sha256: sha256(geositeBuf), bytes: geositeBuf.length,
        entries: geositeEntries.length,
        domains: geositeEntries.reduce((a, e) => a + e.domains.length, 0),
        keys: Object.fromEntries(geositeEntries.map(e => [e.countryCode, e.domains.length])),
        by_type: Object.fromEntries(geositeEntries.map(e => [e.countryCode, byType(e.domains)])),
        roundtrip: 'ok',
      },
      geoip: {
        file: 'geoip.dat',
        sha256: sha256(geoipBuf), bytes: geoipBuf.length,
        entries: geoipEntries.length,
        cidrs: geoipEntries.reduce((a, e) => a + e.cidrs.length, 0),
        keys: Object.fromEntries(geoipEntries.map(e => [e.countryCode, e.cidrs.length])),
        families: Object.fromEntries(geoipEntries.map(e => [e.countryCode, {
          v4: e.cidrs.filter(c => c.ip.length === 4).length,
          v6: e.cidrs.filter(c => c.ip.length === 16).length,
        }])),
        roundtrip: 'ok',
      },
    };
    datState = { siteMap, ipMap };
    const gs = manifest.dat.geosite;
    const gi = manifest.dat.geoip;
    log(`  ✓ geosite.dat ${String(gs.domains).padStart(6)} 条 / ${gs.entries} 类  ${String(gs.bytes).padStart(7)} B  ${gs.sha256}`);
    log(`  ✓ geoip.dat   ${String(gi.cidrs).padStart(6)} 条 / ${gi.entries} 类  ${String(gi.bytes).padStart(7)} B  ${gi.sha256}`);
  }

  // ── 条目数阈值：防止上游把某个分类几乎清空却仍能通过域名断言 ──
  const thresholds = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'thresholds.json'), 'utf8'));
  let thin = 0;
  for (const [tag, min] of Object.entries(thresholds)) {
    const got = manifest.rule_sets[tag]?.total;
    if (got === undefined) { log(`  ✗ 阈值表里的 ${tag} 本次没有产出`); thin++; }
    else if (got < min) { log(`  ✗ ${tag} 只有 ${got} 条，低于阈值 ${min}`); thin++; }
  }
  manifest.thresholds = { checked: Object.keys(thresholds).length, failed: thin };
  if (thin) log(`\n⚠ ${thin} 个规则集条目数低于阈值\n`);

  // ── 断言 ──
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'cases.json'), 'utf8'));
  let pass = 0, fail = 0;
  for (const c of cases) {
    const file = path.join(DIST, 'srs', `${c.set}.srs`);
    // sing-box 对不存在的文件会在 stderr 打错误，按旧的「输出非空即命中」判断会误判为通过
    if (!fs.existsSync(file)) { fail++; log(`  ✗ 断言引用了未产出的规则集 ${c.set}（${c.domain}）`); continue; }
    const m = matchRuleSet(file, c.domain);
    if (!m.ok) { fail++; log(`  ✗ 断言执行失败 ${c.set}/${c.domain}: ${m.reason}`); continue; }
    const ok = c.expect === 'in' ? m.hit : !m.hit;
    if (ok) pass++; else { fail++; log(`  ✗ ${c.domain} 期望${c.expect === 'in' ? '命中' : '不命中'} ${c.set}`); }
  }
  // ── .dat 断言：读回解码后按 v2ray 语义匹配 ──
  let datPass = 0, datFail = 0;
  const datTestsPath = path.join(ROOT, 'tests', 'dat.json');
  if (datState && fs.existsSync(datTestsPath)) {
    const dat = JSON.parse(fs.readFileSync(datTestsPath, 'utf8'));
    const check = (ok, message) => { if (ok) datPass++; else { datFail++; log(`  ✗ ${message}`); } };

    for (const { key, min } of dat.geosite_keys || []) {
      const domains = datState.siteMap.get(key);
      check(Boolean(domains), `geosite 缺少分类 ${key}`);
      if (domains) check(domains.length >= min, `geosite ${key} 只有 ${domains.length} 条，低于阈值 ${min}`);
    }
    for (const { key, domain, expect } of dat.geosite_cases || []) {
      const hit = matchDomain(domain, datState.siteMap.get(key) || []);
      check(expect === 'in' ? hit : !hit, `geosite ${key} ${domain} 期望${expect === 'in' ? '命中' : '不命中'}`);
    }
    for (const { key, min } of dat.geoip_keys || []) {
      const cidrs = datState.ipMap.get(key);
      check(Boolean(cidrs), `geoip 缺少分类 ${key}`);
      if (cidrs) check(cidrs.length >= min, `geoip ${key} 只有 ${cidrs.length} 条，低于阈值 ${min}`);
    }
    for (const { key, ip, expect } of dat.geoip_cases || []) {
      const hit = (datState.ipMap.get(key) || []).some(cidr => cidrContains(cidr, ip));
      check(expect === 'in' ? hit : !hit, `geoip ${key} ${ip} 期望${expect === 'in' ? '命中' : '不命中'}`);
    }
    manifest.dat_tests = { pass: datPass, fail: datFail };
    log(`\ndat 断言 ${datPass} 通过 / ${datFail} 失败`);
  }

  manifest.tests = { pass, fail };
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`\n断言 ${pass} 通过 / ${fail} 失败`);
  if (fail || thin || datFail) process.exit(1);
}

main().catch(e => { console.error('构建失败:', e.message); process.exit(1); });
