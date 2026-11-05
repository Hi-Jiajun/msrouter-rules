// msrouter-rules 构建流水线：fetch → merge → compile → verify → manifest
// 依赖：node >= 18、curl、sing-box 二进制（环境变量 SING_BOX 指定）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const DIST = path.join(ROOT, 'dist');
const SING_BOX = process.env.SING_BOX || 'sing-box';
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const DROP = new Set(CFG.options?.drop_types || []);
const TYPES = ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex'];

const log = (...a) => console.log(...a);
const mkdir = d => fs.mkdirSync(d, { recursive: true });

function curl(url, out) {
  if (fs.existsSync(out) && process.env.FORCE_FETCH !== '1') return out;
  mkdir(path.dirname(out));
  execFileSync('curl', ['-fsSL', '--retry', '3', '--max-time', '120', '-o', out, url], { stdio: 'pipe' });
  return out;
}
function singbox(args, opts = {}) {
  // 注意：sing-box rule-set match 的结果打印在 stderr，必须合并两路
  const r = spawnSync(SING_BOX, args, { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !opts.allowFail) throw new Error(`sing-box ${args.join(' ')} 失败: ${out}`);
  return out;
}
const strip = v => String(v).replace(/^\+\./, '').replace(/^\*\./, '').replace(/^\./, '').toLowerCase();
const blank = () => ({ domain: new Set(), domain_suffix: new Set(), domain_keyword: new Set() });

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
      sources.push({ ref, counts: Object.fromEntries(TYPES.map(t => [t, set[t]?.size || 0])) });
      for (const t of TYPES) if (merged[t]) for (const v of set[t] || []) merged[t].add(v);
    }

    // 后缀已覆盖的完整域名去掉
    for (const d of merged.domain) if (merged.domain_suffix.has(d)) merged.domain.delete(d);
    const rule = {};
    for (const t of TYPES) if (merged[t]?.size) rule[t] = [...merged[t]].sort();
    const total = Object.values(rule).reduce((a, b) => a + b.length, 0);
    if (!total) throw new Error(`${tag} 合并后为空`);

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

  // ── 断言 ──
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'cases.json'), 'utf8'));
  let pass = 0, fail = 0;
  for (const c of cases) {
    const file = path.join(DIST, 'srs', `${c.set}.srs`);
    const out = singbox(['rule-set', 'match', '-f', 'binary', file, c.domain], { allowFail: true });
    const hit = out.trim().length > 0;
    const ok = c.expect === 'in' ? hit : !hit;
    if (ok) pass++; else { fail++; log(`  ✗ ${c.domain} 期望${c.expect === 'in' ? '命中' : '不命中'} ${c.set}`); }
  }
  manifest.tests = { pass, fail };
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`\n断言 ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error('构建失败:', e.message); process.exit(1); });
