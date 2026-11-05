# msrouter-rules

家庭网关分流规则集的**构建流水线**。仓库本身不含原创规则，只做「拉取上游 → 合并 → 编译 → 校验 → 发布」。

## 为什么需要它

规则集原先散落在一次性脚本里：从哪几个源取的、怎么合并的、哪一条被剔掉了，都只活在当事人的终端历史里。这个仓库把「配方」变成可审查、可复现、可自动更新的声明式配置。

## 结构

```
sources.json          唯一真相源：每个 rule_set 由哪些上游、哪些分类、怎么合成
tests/cases.json      断言用例，每次构建自动跑
tools/build.mjs       构建流水线（无第三方依赖）
dist/json/*.json      sing-box rule-set 源（提交，便于 diff 审查）
dist/srs/*.srs        编译产物（走 Release 分发）
dist/manifest.json    每个产物的来源、条目数、sha256、构建时的 sing-box 版本
```

## 用法

```bash
# 需要：node >= 18、curl、sing-box 二进制
export SING_BOX=/usr/local/bin/sing-box
node tools/build.mjs

# 强制重新拉取上游
FORCE_FETCH=1 node tools/build.mjs
```

## 上游

| 别名 | 仓库 | 取什么 |
|---|---|---|
| `senshinya` | [senshinya/singbox_ruleset](https://github.com/senshinya/singbox_ruleset) | 服务分类 `.json`；`ChinaMax` 作 CN 判定 |
| `meta` | [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) | release 的 `geosite.db`，用 `sing-box geosite export` 逐类导出 |
| `aethersailor` | [Aethersailor/Custom_OpenClash_Rules](https://github.com/Aethersailor/Custom_OpenClash_Rules) | 网关实战补丁（强制直连/代理、Steam CDN、加密 DNS） |
| `loyalsoldier` | [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules) | 只用 `gfw.txt` 作必代理兜底 |

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

`.github/workflows/build.yml` 每天北京时间 04:00 构建，产出滚动 release `rules-YYYYMMDD`，资产为 `dist/srs/*.srs` + `dist/manifest.json`。

消费端**不使用** sing-box 的 `type: remote`（会形成「拉规则要代理、代理要规则」的鸡生蛋），而是保持 `type: local`，由路由器上的定时任务拉 release → 校验 sha256 → 原子替换 → 重载。
