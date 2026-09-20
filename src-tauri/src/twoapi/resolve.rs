//! 2API 套餐路由的账号→登录态 JWT 解析。跟随当前账号时，切号后自然命中新 id 的缓存键。
//! 套餐额度只挂在 zcode-plan 体系（JWT），所以这里**只认 JWT**——平台 key 属于
//! 「复制 key / 免费模型 key 池」路径，两条路刻意不混（见 store::account_jwt_key）。
//! 所有涉及账号解密的调用都放进 spawn_blocking，避免占死异步运行时导致界面卡死。

use std::time::{Duration, Instant};

use crate::store::{self, ApiKeyInfo, Paths};

use super::SharedState;

/// JWT 会随 zcode 客户端运行轮换，不能像平台 key 那样长缓存；
/// 60 秒内复用同一把，最多在轮换后旧令牌上多打一分钟（zcode-plan 对旧令牌有宽限）。
const TTL: Duration = Duration::from_secs(60);
const ACTIVE_TTL: Duration = Duration::from_secs(3);

/// 解析当前应该使用的账号 JWT：锁定账号优先，否则跟随激活账号。
pub async fn resolve(st: &SharedState) -> Result<ApiKeyInfo, String> {
    let pinned = st.account.lock().unwrap().clone();
    let id = match pinned {
        Some(id) => id,
        None => {
            // 激活账号 id 带短缓存：全量解密账号很重，不能每个请求都算一遍
            let cached = st.active_cache.lock().unwrap().clone();
            match cached {
                Some((at, Some(id))) if at.elapsed() < ACTIVE_TTL => id,
                _ => {
                    let id = tauri::async_runtime::spawn_blocking(move || {
                        store::active_account_id(&Paths::detect())
                    })
                    .await
                    .map_err(|e| format!("内部任务失败: {e}"))?
                    .ok_or("没有正在使用的账号，请先在主界面切换或保存一个账号")?;
                    *st.active_cache.lock().unwrap() = Some((Instant::now(), Some(id.clone())));
                    id
                }
            }
        }
    };
    // 每次解析对应一次真实请求，记入该账号的累计计数（单次加锁，勿在 if-let 条件里持锁再锁）
    {
        let mut u = st.usage.lock().unwrap();
        *u.entry(id.clone()).or_insert(0) += 1;
    }
    {
        let cache = st.cache.lock().unwrap();
        if let Some((at, info)) = cache.get(&id) {
            if at.elapsed() < TTL {
                return Ok(info.clone());
            }
        }
    }
    let id_for_task = id.clone();
    let info: ApiKeyInfo = tauri::async_runtime::spawn_blocking(move || {
        store::account_jwt_key(&Paths::detect(), &id_for_task)
    })
    .await
    .map_err(|e| format!("内部任务失败: {e}"))??
    .ok_or("该账号没有 zcode 登录态 JWT：套餐模型（glm-5.3 系）只能用登录态在 zcode-plan 端点消费，请先在官方客户端登录此账号")?;
    st.cache.lock().unwrap().insert(id, (Instant::now(), info.clone()));
    Ok(info)
}
