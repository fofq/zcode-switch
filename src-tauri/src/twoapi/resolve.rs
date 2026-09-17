//! 2API 的账号→(apiKey, baseURL) 解析。跟随当前账号时，切号后自然命中新 id 的缓存键。

use std::time::{Duration, Instant};

use crate::store::{self, ApiKeyInfo};

use super::SharedState;

const TTL: Duration = Duration::from_secs(600);

/// 解析当前应该使用的 (apiKey, baseURL)：锁定账号优先，否则跟随激活账号；带 10 分钟缓存。
pub fn resolve(st: &SharedState) -> Result<(String, String), String> {
    let pinned = st.account.lock().unwrap().clone();
    let id = match pinned {
        Some(id) => id,
        None => store::active_account_id(&st.paths).ok_or("没有正在使用的账号，请先在主界面切换或保存一个账号")?,
    };
    {
        let cache = st.cache.lock().unwrap();
        if let Some((at, info)) = cache.get(&id) {
            if at.elapsed() < TTL {
                return Ok((info.api_key.clone(), info.base_url.clone()));
            }
        }
    }
    let info: ApiKeyInfo = store::account_api_key(&st.paths, &id)?
        .ok_or("该账号没有可用的 API Key，请先在账号详情里确认已同步配置")?;
    st.cache.lock().unwrap().insert(id, (Instant::now(), info.clone()));
    Ok((info.api_key, info.base_url))
}
