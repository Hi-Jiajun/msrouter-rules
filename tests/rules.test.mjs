import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyDenyRules, matchesDomainSets, pruneDomains, aggregateCidrs } from '../tools/build.mjs';
import { decodeGeoSiteList, matchDomain } from '../tools/dat.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const HMAC_KEY = Buffer.from('msrouter-rules-desensitize-guard-v1', 'utf8');

// HMAC-SHA256 digests of personal/private domains migrated to infra/oxidns/local_*.txt.
// Stored as keyed hashes so zero personal domain literals exist anywhere in the public repository.
const FORBIDDEN_PRIVATE_DOMAIN_HMACS = new Set([
  'c2337172922b85eb8a9cd90465f1c3f4c92ace6613bc16637296df8e4166040b',
  'c3df4154ac511732d747e2ff2ddc3a5af11852f032a47a0b70626e3e35560ba4',
  'ac0c822438d02f85b7876e46714c3365634448b36a6c1a076aff90b9d6bf10e0',
  '67d0a9e281e4c70fb6988a36619e33bad7462df6b74b97df97c462e50794bedd',
  '862451ec56319d14fba2e774913c15497ded9fcd1d329c9f1c6edcb7eb6b0e66',
  '342d3baa7d31bf854960d8b77985c3b95faa9f6847aeb20d2db686c480d94800',
  '1b7fcfa8dea256ab6506d40c3bac454bcd7500337df67e43e6abdb048db11bbb',
  'b7b100d5a574d4c38758f4a575269d278b713e07de28a603c40f33d80f108cbf',
  'd35c4a628b282e55020355f9f08ccc5c64113113632515ffafd04067f6e35560',
  'e8d76a1a3b0f30277b41a9223606a7bf61def2b7131ee28dc4061fdad9eefc9b',
]);

function hmacDomain(value) {
  return crypto.createHmac('sha256', HMAC_KEY).update(value.toLowerCase()).digest('hex');
}

function loadDistRule(tag) {
  const json = JSON.parse(fs.readFileSync(path.join(DIST, 'json', `${tag}.json`), 'utf8'));
  const r = json.rules[0] || {};
  return {
    domain: new Set(r.domain || []),
    domain_suffix: new Set(r.domain_suffix || []),
    domain_keyword: new Set(r.domain_keyword || []),
    ip_cidr: new Set(r.ip_cidr || []),
  };
}

test('unit: applyDenyRules strips exact_suffix without stripping explicit child domains', () => {
  const set = {
    domain: new Set(['foo.ms', 'voa-lh.akamaihd.net', 'keep.cn']),
    domain_suffix: new Set(['ms', 'bar.ms', 'akamaized.net', 'sub.akamaized.net', 'cn']),
    domain_keyword: new Set(['stripe', 'bilibili']),
  };
  const removed = applyDenyRules(set, [
    'exact_suffix:ms',
    'keyword:stripe',
    'akamaized.net',
    'akamaihd.net',
  ]);
  assert.equal(removed, 5);
  assert.equal(set.domain_suffix.has('ms'), false);
  assert.equal(set.domain_suffix.has('bar.ms'), true);
  assert.equal(set.domain.has('foo.ms'), true);
  assert.equal(set.domain.has('voa-lh.akamaihd.net'), false);
  assert.equal(set.domain_suffix.has('akamaized.net'), false);
  assert.equal(set.domain_suffix.has('sub.akamaized.net'), false);
  assert.equal(set.domain_keyword.has('stripe'), false);
  assert.equal(set.domain_keyword.has('bilibili'), true);
});

test('unit: pruneDomains & aggregateCidrs collapse redundant rules deterministically', () => {
  const pruned = pruneDomains({
    domain: new Set(['a.example.com', 'solo.org']),
    domain_suffix: new Set(['example.com', 'sub.example.com']),
    domain_keyword: new Set([]),
  });
  assert.deepEqual([...pruned.domain_suffix], ['example.com']);
  assert.deepEqual([...pruned.domain], ['solo.org']);

  const cidrs = aggregateCidrs(new Set(['192.0.2.0/25', '192.0.2.128/25', '192.0.2.1/32']));
  assert.deepEqual([...cidrs], ['192.0.2.0/24']);
});

test('contract: cn-domains strips bogus "ms" TLD, stripe, akamai, and pure overseas categories', () => {
  const cn = loadDistRule('cn-domains');
  assert.equal(cn.domain_suffix.has('ms'), false, 'bogus top-level .ms wildcard must not exist in cn-domains');
  assert.equal(cn.domain_suffix.has('in.th'), false, 'bogus .in.th suffix must not exist in cn-domains');
  assert.equal(cn.domain_keyword.has('stripe'), false);

  for (const d of ['aka.ms', 'nyti.ms', '1drv.ms', 'stripe.com', 'akamaized.net', 'akamaihd.net', 'paypal.com', 'spotify.com', 'speedtest.net', 'challenges.cloudflare.com']) {
    assert.equal(matchesDomainSets(d, [cn], true), false, `${d} must not match cn-domains`);
  }
  assert.equal(matchesDomainSets('baidu.com', [cn], true), true);
  assert.equal(matchesDomainSets('www.mi.com', [cn], true), true);
});

test('contract: public repo contains zero personal/private domains across sources, supplements, tests, and dist', () => {
  const textFiles = [
    path.join(ROOT, 'sources.json'),
    path.join(ROOT, 'README.md'),
    ...fs.readdirSync(path.join(ROOT, 'supplements')).map(f => path.join(ROOT, 'supplements', f)),
    ...fs.readdirSync(path.join(ROOT, 'tests')).map(f => path.join(ROOT, 'tests', f)),
  ];
  const tokenRegex = /[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;

  for (const file of textFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const tokens = content.match(tokenRegex) || [];
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      const parts = lower.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        const candidate = parts.slice(i).join('.');
        assert.equal(
          FORBIDDEN_PRIVATE_DOMAIN_HMACS.has(hmacDomain(candidate)),
          false,
          `private domain leak detected in ${path.relative(ROOT, file)}`,
        );
      }
    }
  }

  const siteEntries = decodeGeoSiteList(fs.readFileSync(path.join(DIST, 'geosite.dat')));
  for (const entry of siteEntries) {
    for (const d of entry.domains) {
      const parts = d.value.toLowerCase().split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        assert.equal(
          FORBIDDEN_PRIVATE_DOMAIN_HMACS.has(hmacDomain(parts.slice(i).join('.'))),
          false,
          `private domain leak detected in geosite.dat:${entry.countryCode}`,
        );
      }
    }
  }
});

test('contract: fakeip-filter whitelist shrink & curated direct-extra / force-proxy / ai rules', () => {
  const fakeip = loadDistRule('fakeip-filter');
  for (const removed of ['connectivitycheck.gstatic.com', 'stun.l.google.com', 'stun1.l.google.com', 'stun.cloudflare.com', 'tailscale.com', 'nas.synology.me', 'quickconnect.cn']) {
    assert.equal(matchesDomainSets(removed, [fakeip], true), false, `${removed} must be absent from fakeip-filter`);
  }
  for (const kept of ['time.apple.com', '0.pool.ntp.org', 'msftconnecttest.com', 'captive.apple.com', 'stun.qq.com', 'mcdn.bilivideo.cn', 'home.arpa']) {
    assert.equal(matchesDomainSets(kept, [fakeip], true), true, `${kept} must remain in fakeip-filter`);
  }

  const directExtra = loadDistRule('direct-extra');
  assert.equal(matchesDomainSets('is1-ssl.mzstatic.com', [directExtra], true), true);
  assert.equal(matchesDomainSets('iosapps.itunes.g.aaplimg.com', [directExtra], true), true);
  assert.equal(matchesDomainSets('dispatcher.is.autonavi.com', [directExtra], true), true);
  assert.equal(matchesDomainSets('np-edge.itunes.apple.com', [directExtra], true), false);
  assert.equal(matchesDomainSets('play-edge.itunes.apple.com', [directExtra], true), false);

  const forceDirect = loadDistRule('force-direct');
  assert.equal(matchesDomainSets('cdn.ynuf.aliapp.org', [forceDirect], true), true);
  for (const dirty of ['akamaized.net', 'akamaihd.net', 'stripe.com', 'ifconfig.co', 'ipapi.co', 'tailscale.com', 'nas.synology.me', 'quickconnect.cn']) {
    assert.equal(matchesDomainSets(dirty, [forceDirect], true), false, `${dirty} must be denied from force-direct`);
  }

  const forceProxy = loadDistRule('force-proxy');
  for (const fp of ['challenges.cloudflare.com', 'cloudflarestorage.com', 'home-assistant.io', 'grafana.com', 'np-edge.itunes.apple.com', 'play-edge.itunes.apple.com', 'googleapis.cn']) {
    assert.equal(matchesDomainSets(fp, [forceProxy], true), true, `${fp} must be in force-proxy`);
  }

  const ai = loadDistRule('ai');
  for (const aiDom of ['models.dev', 'api.kilo.ai', 'usemagpie.ai', 'api.tavily.com']) {
    assert.equal(matchesDomainSets(aiDom, [ai], true), true, `${aiDom} must be in ai`);
  }

  const siteMap = new Map(decodeGeoSiteList(fs.readFileSync(path.join(DIST, 'geosite.dat'))).map(e => [e.countryCode, e.domains]));
  assert.equal(matchDomain('aka.ms', siteMap.get('cn') || []), false);
  assert.equal(matchDomain('challenges.cloudflare.com', siteMap.get('force-proxy') || []), true);
  assert.equal(matchDomain('models.dev', siteMap.get('ai') || []), true);
  assert.equal(matchDomain('is1-ssl.mzstatic.com', siteMap.get('direct-extra') || []), true);

  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  assert.equal(manifest.orthogonality?.checked, true);
  assert.equal(manifest.orthogonality?.leaks, 0);
});
