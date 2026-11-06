# msrouter-rules

家庭网关分流规则集的**构建流水线**。仓库本身不含原创规则，只做「拉取上游 → 合并 → 编译 → 校验 → 发布」。同一份合并结果同时产出 sing-box 的 `.srs` 与 v2ray 的 `geosite.dat` / `geoip.dat`，让两类路由器看到同一套规则。

## 为什么需要它

规则集原先散落在一次性脚本里：从哪几个源取的、怎么合并的、哪一条被剔掉了，都只活在当事人的终端历史里。这个仓库把「配方」变成可审查、可复现、可自动更新的声明式配置。

## 结构

```
sources.json          唯一真相源：每个 rule_set 由哪些上游、哪些分类、怎么合成
tests/cases.json      sing-box 侧断言用例，每次构建自动跑
tests/dat.json        v2ray .dat 侧断言用例（条目数下限 + 已知命中）
tools/build.mjs       构建流水线（无第三方依赖）
tools/dat.mjs         geosite.dat / geoip.dat 的 protobuf 编解码（手写 wire format）
dist/json/*.json      sing-box rule-set 源（提交，便于 diff 审查）
dist/srs/*.srs        sing-box 编译产物（走 Release 分发）
dist/geosite.dat      v2ray 域名分类库（走 Release 分发）
dist/geoip.dat        v2ray IP 分类库（走 Release 分发）
dist/manifest.json    每个产物的来源、条目数、sha256、构建时的 sing-box 版本
```

## 用法

```bash
# 需要：node >= 18、curl、sing-box 二进制
export SING_BOX=/usr/local/bin/sing-box
node tools/build.mjs

# 强制重新拉取上游
FORCE_FETCH=1 node tools/build.mjs

# 不信任产物时，用仓库自带的解码器把 .dat 读回来看看（打印各分类的条目数与类型分布）
node tools/dat.mjs geosite dist/geosite.dat
node tools/dat.mjs geoip dist/geoip.dat
```

## 上游

| 别名 | 仓库 | 取什么 |
|---|---|---|
| `senshinya` | [senshinya/singbox_ruleset](https://github.com/senshinya/singbox_ruleset) | 服务分类 `.json`；`ChinaMax` 作 CN 判定 |
| `meta` | [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) | release 的 `geosite.db`，用 `sing-box geosite export` 逐类导出 |
| `aethersailor` | [Aethersailor/Custom_OpenClash_Rules](https://github.com/Aethersailor/Custom_OpenClash_Rules) | 网关实战补丁（强制直连/代理、Steam CDN、加密 DNS） |
| `loyalsoldier` | [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules) | 只用 `gfw.txt` 作必代理兜底 |
| `chinaip` | [gaoyifan/china-operator-ip](https://github.com/gaoyifan/china-operator-ip) | BGP 汇总的中国运营商网段 `ip-lists/china46.txt`（v4+v6），供 `geoip.dat` 的 `cn` |
| `local` | 本仓库 `supplements/` | 本地补充名单（Clash 格式） |

## 两套产物，同一份合并结果

每次构建产出两种格式，**都来自 `sources.json` 里同一份合并后的 `rule_set`**，不存在「.srs 用一套源、.dat 用另一套」：

| 产物 | 消费端 | 格式 |
|---|---|---|
| `dist/srs/*.srs` | sing-box（remote/local 均可） | sing-box rule-set 二进制 |
| `dist/geosite.dat` | v2ray / v2fly / Landscape / mihomo | `GeoSiteList` protobuf |
| `dist/geoip.dat` | 同上 | `GeoIPList` protobuf |

`build.mjs` 先按 `sources.json` 合并出 `rule`，再分别喂给 sing-box 编译器与 `tools/dat.mjs` 的编码器；`sources.json` 的 `dat.geosite` / `dat.geoip` 决定哪些 rule_set 以哪个 `country_code` 进 `.dat`。

### 类型映射（按 v2ray 真实语义）

这里容易踩坑：v2ray 的 `Plain` **不是**「普通域名后缀」，而是**子串匹配**（v2fly 的 `keyword:`）。证据是 [v2fly/domain-list-community 的 `main.go`](https://github.com/v2fly/domain-list-community/blob/master/main.go)（`keyword` → `Domain_Plain`、`domain` → `Domain_RootDomain`）与 v2ray-core 的 `common/strmatcher`（Substr = 包含匹配）。Landscape 的 `DomainMatcher` 也是这么实现的：`Plain` 走 Aho-Corasick 子串、`Domain` 走后缀 trie。

| sing-box | v2ray `Domain.Type` | 语义 |
|---|---|---|
| `domain_suffix` | `RootDomain` = 2 | 后缀匹配（`a.com` 命中 `a.com` 与 `*.a.com`） |
| `domain` | `Full` = 3 | 完全相等 |
| `domain_keyword` | `Plain` = 0 | 子串匹配 |
| `domain_regex` | `Regex` = 1 | 正则（本仓库在合并阶段就把 `domain_regex` 丢弃了，见下） |

所以 **`domain_keyword` 没有语义损失**：它和 `Plain` 是同一种匹配。早期设想「`domain_suffix` → `Plain`」是反的——那样 `baidu.com` 会变成子串规则，连 `notbaidu.com` 都会命中。`.dat` 里 keyword 条目很少（当前全部 26 个分类合计 49 条，其中 `cn` 占 13 条），转换成本几乎为零。

### `cn` / `private` / `geolocation-!cn` / `github`

- `cn` 来自 `cn-domains`（即 sing-box 侧 CN 判定的同一份 `ChinaMax` 合并结果），全量后缀 + 精确域名 + keyword 都会写进去。
- `private` 来自 `supplements/private.list`：RFC 特殊用途域名（`localhost`/`local`/`home.arpa`/`in-addr.arpa` 等）+ 家用路由器管理入口。它同时也是一份普通的 `private.srs`。
- `github` 等 26 个分类按 v2fly 风格的 lowercase 命名，键名见 `manifest.json` 的 `dat.geosite.keys`。
- **`geolocation-!cn` 故意不输出**。它是 `cn` 的补集，需要「全量非 CN 域名」这个源；本仓库没有，硬造一个「已知分类的并集」只会得到一份看起来像补集、实际不是的名单，比缺条目更危险。消费端有两种正确做法：Landscape 里把 `cn` 规则设 `inverse: true`（其 `GeoKey` 原生支持取反）；或者不配这一条（Landscape 对缺失 key 只丢该条规则，不会误匹配）。

### geoip.dat 的 `cn`

`cn` 取 `cn-ip`（`chinaip` 上游的 `china46.txt`，当前约 6200 条 v4 + 3400 条 v6）。它同时编译成 `cn-ip.srs`，所以「sing-box 用 `cn-ip.srs`」与「Landscape 用 `geoip:cn`」是同一份数据。

注意一个历史细节：`cn-domains`（ChinaMax）自身也带约 1.27 万条 `ip_cidr`，这部分只留在 `cn-domains.srs` 里，**没有**写进 `geoip.dat`。如果家里 sing-box 是靠 `cn-domains.srs` 同时做 CN IP 判定，那两边仍有差异；要对齐就把 sing-box 的 CN IP 规则换成 `cn-ip.srs`（推荐，BGP 源更新更勤），或者反过来把 `dat.geoip.cn` 改成 `cn-domains`。

同理，服务分类 rule_set 里夹带的 `ip_cidr`（如 `netflix` 的 1119 条）不会进 `geosite.dat`（格式装不下），只进各自的 `.srs`。`geoip.dat` 目前只收显式映射的三个 IP 集合：`cn`（`cn-ip`）、`netflix`（`netflix-ip`）、`telegram`（`telegram-ip`）。

### 构建期校验

`build.mjs` 写完 `.dat` 后会**用 `tools/dat.mjs` 的解码器读回**，做两件事：解码后重新编码必须与原文件逐字节一致；每个 `country_code` 的条目数必须与源一致。任何一项不通过直接构建失败。`manifest.json` 里记录两个文件的 `sha256`、字节数、各分类条目数、类型分布与 `roundtrip: ok`。

## 几条踩过的坑（不要改回去）

1. **`domain_regex` 一律丢弃**。meta 导出的是逐字符拆开的垃圾数据，且 Go 的 RE2 与 Clash 正则语法不兼容，留着会让 `sing-box check` 直接失败。
2. **`sing-box rule-set match` 的结果打印在 stderr**，脚本必须合并两路输出，否则所有断言都会误判为失败。
3. **meta 的条目数虚高一倍**（每条同时写成 `x.com` 与 `.x.com`），比较前必须去重，否则会得出「meta 更全」的错误结论。
4. **不要用 `google@cn` 这类属性变体**做直连名单：它把 `fonts.googleapis.com` 这类「有接入点但实际挂起」的域名收了进去。CN 判定统一交给 `ChinaMax`。
5. **`amazon` 分类不要用**：含 `amazonaws.com`，会把 S3 与大量 SaaS 流量一网打进代理。

## 已知缺口

- `gemini`：meta 没有该分类，v2fly 只有存根，目前只有 senshinya 的 13 条。
- `appletv`、`claude`：同上，单源。
- 广告拦截（`Advertising` / `AdGuardDNSFilter`）暂时不纳入，另行处理。

## 发布

`.github/workflows/build.yml` 每天北京时间 04:00 构建，产出滚动 release `rules-YYYYMMDD`，资产为 `dist/srs/*.srs` + `dist/geosite.dat` + `dist/geoip.dat` + `dist/manifest.json`。

消费端**不使用** sing-box 的 `type: remote`（会形成「拉规则要代理、代理要规则」的鸡生蛋），而是保持 `type: local`，由路由器上的定时任务拉 release → 校验 sha256 → 原子替换 → 重载。

## 消费端：怎么把 .srs 送到网关

sing-box 侧用 `type: local`（不用 `remote`，避免「拉规则要代理、代理要规则」的鸡生蛋）。

在运行 sing-box 的容器/主机上加一个定时任务：

```bash
#!/usr/bin/env bash
set -euo pipefail
RULES_DIR=/etc/sing-box/rules
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

TAG=$(gh release list --repo Hi-Jiajun/msrouter-rules --limit 1 --json tagName --jq '.[0].tagName')
gh release download "$TAG" --repo Hi-Jiajun/msrouter-rules --pattern '*.srs' --pattern 'manifest.json' --dir "$TMP"

cd "$TMP"
if ! sha256sum -c <(jq -r '.rule_sets | to_entries[] | "\(.value.srs_sha256)  \(.key).srs"' manifest.json); then
  echo "校验失败，放弃本次更新"; exit 1
fi

mkdir -p "$RULES_DIR"
cp ./*.srs "$RULES_DIR/"
sing-box check -c /etc/sing-box/config.json
systemctl reload-or-restart sing-box   # 或 docker restart
```

要点：

1. **先校验 sha256 再替换**，`manifest.json` 里每个 `.srs` 都有 `srs_sha256`。
2. **替换前跑一次 `sing-box check`**。
3. 规则集更新不频繁（上游每日构建，但分类变化是周级），定时任务一天一次足够。

## 构建产物的可审计性

`dist/manifest.json` 记录：

- 每个 `rule_set` 的 `sources`（ref + 上游 URL + 上游文件 `sha256`）
- 条目数、`.srs` 的 `sha256` 与字节数
- `dat.geosite` / `dat.geoip`：每个分类的条目数、类型分布（suffix/full/keyword）、整个 `.dat` 的 `sha256` 与字节数、读回校验结果
- 构建时的 sing-box 版本
- 断言与阈值检查结果（sing-box 侧 `tests` + `.dat` 侧 `dat_tests`）

要回答「这个版本里的 netflix 集是从哪来的、有多少条」，看这一个文件就够。

## 回归防护

`tests/thresholds.json` 给每个规则集设了条目数下限（当前值的 70%）。上游某天把某个分类清空、或者格式变化导致解析出 0 条时，**光靠域名断言是发现不了的**（那几个测试域名可能还在），阈值检查会直接让构建失败。

## sing-box 侧：remote 直拉（推荐）

仓库已公开，sing-box 可以直接按 tag 拉取，无需任何凭据：

```json
{
  "http_clients": [ { "tag": "via-proxy", "detour": "🐟 漏网之鱼" } ],
  "route": {
    "rule_set": [
      {
        "type": "remote",
        "tag": "netflix",
        "format": "binary",
        "url": "https://github.com/Hi-Jiajun/msrouter-rules/releases/latest/download/netflix.srs",
        "initial_path": "rules/netflix.srs",
        "update_interval": "24h",
        "http_client": "via-proxy"
      }
    ]
  }
}
```

**`initial_path` 不是可选项**。`route/rule/rule_set_remote.go` 的 `StartContext`：既无缓存、又无 `initial_path` 时，首次下载失败会 `return E.Cause(err, "initial rule-set: ")`，**sing-box 直接启动失败**。带上本地文件后，首次启动读本地、跳过下载，之后按 `update_interval` 热更新。

`http_client.detour` 指向代理组是必要的：容器内直连 GitHub 通常不通。注意**不能指向 `direct` 出站**——sing-box 会报 `detour to an empty direct outbound makes no sense`，直连场景应该干脆不写 `http_client`。

### 资源地址规律

```
https://github.com/Hi-Jiajun/msrouter-rules/releases/latest/download/<tag>.srs
https://github.com/Hi-Jiajun/msrouter-rules/releases/latest/download/geosite.dat
https://github.com/Hi-Jiajun/msrouter-rules/releases/latest/download/geoip.dat
```

`<tag>` 与 `sources.json` 里 `rule_sets` 的键一致，共 29 个。

## Landscape 侧：怎么用 .dat

Landscape 的 `GeoSiteSource::Url` 会把 `.dat` 里的全部分类导入缓存（源配置里的 `geo_keys` 只作声明，不参与导入过滤）；具体用哪个分类由 DNS 规则里的 `GeoKey.key` 决定。导入时 key 统一转大写，DNS 规则里的 key 也会转大写，`GeoIP` 的查找还会同时试大写/小写，所以本仓库输出的 lowercase 键可以直接用。

要把家里的 Landscape 从 `MetaCubeX/meta-rules-dat` 切到本仓库，只需要改同步脚本的 BASE（现在通常是 `/opt/landscape/geo-sync.sh` 里的 `BASE=https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download`）：

```bash
BASE=https://github.com/Hi-Jiajun/msrouter-rules/releases/latest/download
curl -fsSL "$BASE/geosite.dat" -o "$TMP/geosite.dat"
curl -fsSL "$BASE/geoip.dat"   -o "$TMP/geoip.dat"
# 可选：核对 manifest.json 里的 sha256 后再替换
```

DNS 规则里引用 `cn` / `private` / `github` 等 key 即可（源配置的 `geo_keys` 可以填这些键作依赖声明，不影响导入）；geoip 源不填 keys 会加载全部条目（`cn` / `netflix` / `telegram`），无害。

`geolocation-!cn` 不在 `.dat` 里（理由见上）。如果现有规则里用了它，改成引用 `cn` 并把该条规则的 `inverse` 打开；或者直接删掉这条规则。
