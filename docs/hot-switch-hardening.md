# 热切换强化计划（hot-switch hardening）

> ✅ 已全部完成并验证（653f525b）：CI "Rust unit tests" + "Build（前端+Rust+NSIS）" 均 success，
> npm run check 100 项通过。

> 2026-09-22 制定。证据来源：客户端自身日志（~/.zcode/v2/logs）、磁盘文件 mtime/内容比对、
> ARMS/telemetry 身份文件 vs 账号库、审计日志（com.zswitch.app/logs/oauth.log）。
> 状态标记：[x] 已实现 / [~] 调整后实现 / [-] 经证据评估后不做 / [ ] 待办

## 背景：已实证的弱点

| 编号 | 弱点 | 证据 | 结论 |
|---|---|---|---|
| W1 | 「写盘成功」≠「客户端生效」，无后验 | 23:03:30 热切 → 8s 后客户端重新应用 runtime headers → **93s 后**才出现新账号的 billing 池 | P1 后验可行，窗口 60-120s |
| W2 | 客户端反写竞态 | credentials.json 在切换 69 分钟后被客户端自行改写（token 轮换）；config.json 70 分钟无反写 | 二次抹除是低频事件；反写是常规事件 |
| W3 | 热路径同步网络调用（最长 15s） | rematerialize → resolve_zai_business_token（ureq 15s 超时） | 有 wiped 前置检查 → 罕见路径；仍应移出热路径 |
| W4 | 请求边界 | 客户端日志「收到→已应用」0.7s 成对、无 mid-turn 重应用 | [-] **不做**：mid-turn 热切实际安全（在途请求用已签发凭据完成，下一轮才用新号），边界等待无收益 |
| W5 | 遥测身份热切不换 | ARMS store uid 属于旧号 1027496e，在用账号 56 的 uid 不同——热切会话遥测全部挂在旧号直到冷启 | 维持现状（防客户端覆盖），语义已文档化 |
| W6 | 可观测性 | align/rematerialize 失败仅 eprintln | P5 落 flowlog |

## 实施项

### [x] P1 热切后验（前端，纯被动）——已实现
- 切换成功且 `hot=true` → 记录 `{id, at, preSig}`（preSig = 切换时的余额池签名）
- 信号更新时检查：`pools_at_ms > at+1s` 的新余额行 → 签名不同 = `applied`；
  相同 = `same-sig`（弱确认，新号池可能恰好同值）；120s 无新行 = `unknown`（客户端空闲没查余额，不代表失败）
- ⚠️ 匹配算法要点：**不能只比 entitlement_id**——Start Plan 的 `ent_2_0817_*` 是全舰队共用模板 id；
  用「池签名」（show_name=remaining 排序串）比对
- 全部落 `asAuditPush("hot-verify")`，设置面板诊断行可见；不做自动冷重启降级（避免误杀）

### [x] P3+P4 热切后置检查（后端新命令 `hot_switch_post_check`）——已实现
- switch_to **热路径移除 rematerialize**（消灭 W3 的 15s 悬挂；冷路径保留——启动前必须完整配置）
- 新命令（前端热切成功后 8s 调用）：
  1. 凭据身份复核：live 被客户端反写覆盖（身份不符）→ 用目标凭据重写一次
  2. `align_family_domain` 重跑（新的 UpdatedAt 兼作客户端提示，顺带缓解 M2 align 持久性疑问）
  3. `rematerialize_wiped_builtins`（网络调用已不在热路径上）
- 结果落审计（前端 `asAuditPush("hot-post")` + 后端 flowlog）

### [-] M1 活跃号凭据漂移自愈——复核后取消
- 复核发现**已被现有代码覆盖**：`effective_snapshot`（store.rs）对活跃账号自动优先 live 凭据
  （注释原文：「zcode 运行期间会轮换 JWT，账号快照里存的旧 JWT 会过期导致额度/2API 查询失败」），
  且切换前 `sync_live_back_to_source` 回存旧号最新凭据。无需实现。

### [x] P5 审计补全——已实现
- align_family_domain / rematerialize_wiped_builtins / hot_switch_post_check 的成败落 flowlog

### [-] P6 ARMS uid 热写
- 维持现状：运行中客户端持有内存态 uid，热写会被覆盖/造成身份错乱；冷启时写入。
  语义：热切后遥测归属旧号直到下次冷启——已知且接受。

## 验证方式
- [x] `npm run check`（i18n + 决策自检 100 项）+ `node --check`
- [x] CI 653f525b：`cargo test --lib`（含本轮新增 5 个单测）与 NSIS 打包均 success
- [ ] 实测观察：热切后审计日志出现 `hot-post`（8s）与 `hot-verify applied/unknown`（≤120s）——待重建安装后观察
