//! 真实用量统计：只读访问 ZCode CLI 的本地数据库（~/.zcode/cli/db/db.sqlite）。
//! 客户端在每次模型请求完成后把 token 消耗落库（model_usage 表），这里只读、不写、不加锁，
//! WAL 模式下与客户端并发安全；查询走 started_at 索引，2GB 库上也是毫秒级。

use rusqlite::OpenFlags;
use serde::Serialize;

#[derive(Serialize, Default)]
pub struct UsageModelRow {
    pub model: String,
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub total: u64,
}

#[derive(Serialize, Default)]
pub struct UsageStats {
    pub today: Vec<UsageModelRow>,
    pub week: Vec<UsageModelRow>,
    pub today_total: u64,
    pub week_total: u64,
    pub today_requests: u64,
    pub db_missing: bool,
}

/// 本地时区当天/ N 天前零点的 epoch 毫秒（库内 started_at 即 epoch ms）
fn local_day_start_ms(days_ago: u64) -> i64 {
    let now = chrono::Local::now();
    let midnight = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let dt = midnight
        .and_local_timezone(now.timezone())
        .single()
        .unwrap_or(now);
    dt.timestamp_millis() - (days_ago as i64) * 86_400_000
}

pub fn usage_stats(home: &std::path::Path, days: u32) -> Result<UsageStats, String> {
    let mut out = UsageStats::default();
    let path = home.join(".zcode").join("cli").join("db").join("db.sqlite");
    if !path.exists() {
        out.db_missing = true;
        return Ok(out);
    }
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| crate::i18n::trf("err.usage.db", &[("e", &e.to_string())]))?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));

    let query = |since: i64| -> Result<Vec<UsageModelRow>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT model_id, COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), \
                 COALESCE(SUM(computed_total_tokens),0) \
                 FROM model_usage WHERE started_at >= ?1 GROUP BY model_id ORDER BY 5 DESC",
            )
            .map_err(|e| crate::i18n::trf("err.usage.db", &[("e", &e.to_string())]))?;
        let rows = stmt
            .query_map([since], |r| {
                Ok(UsageModelRow {
                    model: r.get::<_, String>(0)?,
                    requests: r.get::<_, i64>(1)?.max(0) as u64,
                    input: r.get::<_, i64>(2)?.max(0) as u64,
                    output: r.get::<_, i64>(3)?.max(0) as u64,
                    total: r.get::<_, i64>(4)?.max(0) as u64,
                })
            })
            .map_err(|e| crate::i18n::trf("err.usage.db", &[("e", &e.to_string())]))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| crate::i18n::trf("err.usage.db", &[("e", &e.to_string())]))?;
        Ok(rows)
    };

    out.today = query(local_day_start_ms(0))?;
    out.week = query(local_day_start_ms(days.max(1) as u64 - 1))?;
    out.today_total = out.today.iter().map(|r| r.total).sum();
    out.week_total = out.week.iter().map(|r| r.total).sum();
    out.today_requests = out.today.iter().map(|r| r.requests).sum();
    Ok(out)
}
