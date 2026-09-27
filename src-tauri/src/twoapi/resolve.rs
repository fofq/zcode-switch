//! 2API 套餐路由的「主候选」解析：锁定账号优先，否则跟随激活账号。
//! 套餐额度只挂在 zcode-plan 体系（JWT），所以这里**只认 JWT**——平台 key 属于
//! 「复制 key / 免费模型 key 池」路径，两条路刻意不混（见 store::account_jwt_key）。
//! 所有涉及账号解密的调用都放进 spawn_blocking，避免占死异步运行时导致界面卡死。
//! 故障切换的后续候选（全账号 JWT 池）由 mod.rs 在主候选失败后按需拉取（store::jwt_pool）。

use std::time::{Duration, Instant};

use crate::store::{self, ApiKeyInfo, Paths};

use super::SharedState;

/// JWT 会随 zcode 客户端运行轮换，不能像平台 key 那样长缓存；
/// 60 秒内复用同一把，最多在轮换后旧令牌上多打一分钟（zcode-plan 对旧令牌有宽限）。
const TTL: Duration = Duration::from_secs(60);
const ACTIVE_TTL: Duration = Duration::from_secs(3);

pub struct Primary {
    pub id: String,
    pub info: ApiKeyInfo,
    /// 打上游用的设备身份：锁定账号带它自己的虚拟 mid；跟随账号用 live telemetry mid
    /// （它就是当前 live 登录者）。服务端按 (user, device_mid) 侧记，带错会 3001。
    pub mid: Option<String>,
}

/// 解析主候选。usage 计数在尝试循环里按实际尝试的账号记（见 mod::relay_plan_multi）。
pub async fn resolve_primary(st: &SharedState) -> Result<Primary, String> {
    let pinned = st.account.lock().unwrap().clone();
    match pinned {
        Some(id) => {
            let (info, mid) = jwt_cached(st, &id).await?;
            Ok(Primary { id, info, mid })
        }
        None => {
            // 激活账号 id 带短缓存：全量解密账号很重，不能每个请求都算一遍
            let id = match st.active_cache.lock().unwrap().clone() {
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
            };
            let (info, _) = jwt_cached(st, &id).await?;
            // 跟随模式：账号就是 live 登录者，mid 用 live telemetry（与官方客户端一致）
            let mid = tauri::async_runtime::spawn_blocking(move || crate::quota::device_mid())
                .await
                .map_err(|e| format!("内部任务失败: {e}"))?;
            Ok(Primary { id, info, mid })
        }
    }
}

/// 账号 JWT（+ 配对虚拟 mid）缓存：60s 内复用，键是账号 id。
async fn jwt_cached(st: &SharedState, id: &str) -> Result<(ApiKeyInfo, Option<String>), String> {
    {
        let cache = st.cache.lock().unwrap();
        if let Some((at, info, mid)) = cache.get(id) {
            if at.elapsed() < TTL {
                return Ok((info.clone(), mid.clone()));
            }
        }
    }
    let id_for_task = id.to_string();
    let (info, mid) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(ApiKeyInfo, Option<String>), String> {
            let paths = Paths::detect();
            let info = store::account_jwt_key(&paths, &id_for_task)?
                .ok_or("该账号没有 zcode 登录态 JWT：套餐模型（glm-5.3 系）只能用登录态在 zcode-plan 端点消费，请先在官方客户端登录此账号")?;
            let mid = store::account_virtual_mid(&paths, &id_for_task);
            Ok((info, mid))
        })
        .await
        .map_err(|e| format!("内部任务失败: {e}"))??;
    st.cache
        .lock()
        .unwrap()
        .insert(id.to_string(), (Instant::now(), info.clone(), mid.clone()));
    Ok((info, mid))
}
