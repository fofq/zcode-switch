//! 2API 的账号→(apiKey, baseURL) 解析。跟随当前账号时，切号后自然命中新 id 的缓存键。
//! 所有涉及账号解密/网络的调用都放进 spawn_blocking，避免占死异步运行时导致界面卡死。

use std::time::{Duration, Instant};

use crate::store::{self, ApiKeyInfo, Paths};

use super::SharedState;

const TTL: Duration = Duration::from_secs(600);
const ACTIVE_TTL: Duration = Duration::from_secs(3);

/// 解析当前应该使用的 (apiKey, baseURL)：锁定账号优先，否则跟随激活账号；带 10 分钟缓存。
pub async fn resolve(st: &SharedState) -> Result<(String, String), String> {
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
                return Ok((info.api_key.clone(), info.base_url.clone()));
            }
        }
    }
    let id_for_task = id.clone();
    let info: ApiKeyInfo = tauri::async_runtime::spawn_blocking(move || {
        store::account_api_key(&Paths::detect(), &id_for_task)
    })
    .await
    .map_err(|e| format!("内部任务失败: {e}"))??
    .ok_or("该账号没有可用的 API Key，请先在账号详情里确认已同步配置")?;
    st.cache.lock().unwrap().insert(id, (Instant::now(), info.clone()));
    Ok((info.api_key, info.base_url))
}
