-- OpenAI Usage Analytics - Useful Queries
-- Copy/paste these into Supabase SQL Editor for analytics

-- =============================================================================
-- 1. DAILY COST SUMMARY (Last 30 Days)
-- =============================================================================
SELECT
  DATE(created_at) AS date,
  COUNT(*) AS total_calls,
  SUM(CASE WHEN order_created THEN 1 ELSE 0 END) AS orders_created,
  ROUND(SUM(total_cost)::numeric, 2) AS daily_cost,
  ROUND(AVG(total_cost)::numeric, 4) AS avg_cost_per_call,
  ROUND(AVG(CASE WHEN order_created THEN total_cost END)::numeric, 4) AS avg_cost_per_order,
  ROUND(SUM(audio_input_cost + audio_output_cost)::numeric, 2) AS audio_costs,
  ROUND(SUM(text_input_cost + text_output_cost)::numeric, 2) AS text_costs
FROM call_usage
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- =============================================================================
-- 2. COST BY RESTAURANT (Top Spenders)
-- =============================================================================
SELECT
  r.name AS restaurant_name,
  r.phone_number,
  COUNT(cu.id) AS total_calls,
  SUM(CASE WHEN cu.order_created THEN 1 ELSE 0 END) AS orders_created,
  ROUND(SUM(cu.total_cost)::numeric, 2) AS total_cost,
  ROUND(AVG(cu.total_cost)::numeric, 4) AS avg_cost_per_call,
  ROUND(SUM(cu.total_cost) / NULLIF(SUM(CASE WHEN cu.order_created THEN 1 ELSE 0 END), 0)::numeric, 4) AS cost_per_order,
  ROUND(SUM(cu.input_tokens + cu.output_tokens)::numeric, 0) AS total_tokens
FROM call_usage cu
JOIN restaurants r ON r.id = cu.restaurant_id
GROUP BY r.id, r.name, r.phone_number
ORDER BY total_cost DESC;

-- =============================================================================
-- 3. MOST EXPENSIVE CALLS (Last 7 Days)
-- =============================================================================
SELECT
  cu.call_sid,
  r.name AS restaurant,
  cu.customer_phone,
  cu.call_duration_seconds AS duration_sec,
  cu.ai_response_count,
  ROUND(cu.total_cost::numeric, 4) AS cost,
  ROUND(cu.audio_input_cost + cu.audio_output_cost::numeric, 4) AS audio_cost,
  ROUND(cu.text_input_cost + cu.text_output_cost::numeric, 4) AS text_cost,
  cu.order_created,
  cu.created_at
FROM call_usage cu
JOIN restaurants r ON r.id = cu.restaurant_id
WHERE cu.created_at >= NOW() - INTERVAL '7 days'
ORDER BY cu.total_cost DESC
LIMIT 50;

-- =============================================================================
-- 4. TOKEN USAGE BREAKDOWN (Audio vs Text)
-- =============================================================================
SELECT
  model_used,
  COUNT(*) AS calls,
  ROUND(AVG(call_duration_seconds)::numeric, 1) AS avg_duration_sec,
  SUM(input_audio_tokens) AS total_audio_in,
  SUM(output_audio_tokens) AS total_audio_out,
  SUM(input_text_tokens) AS total_text_in,
  SUM(output_text_tokens) AS total_text_out,
  SUM(input_tokens + output_tokens) AS total_tokens,
  ROUND(SUM(audio_input_cost + audio_output_cost)::numeric, 2) AS audio_costs,
  ROUND(SUM(text_input_cost + text_output_cost)::numeric, 2) AS text_costs,
  ROUND(SUM(total_cost)::numeric, 2) AS total_cost
FROM call_usage
GROUP BY model_used;

-- =============================================================================
-- 5. HOURLY CALL PATTERNS & COSTS (Today)
-- =============================================================================
SELECT
  EXTRACT(HOUR FROM created_at) AS hour_of_day,
  COUNT(*) AS calls,
  SUM(CASE WHEN order_created THEN 1 ELSE 0 END) AS orders,
  ROUND(SUM(total_cost)::numeric, 2) AS hourly_cost,
  ROUND(AVG(total_cost)::numeric, 4) AS avg_cost
FROM call_usage
WHERE DATE(created_at) = CURRENT_DATE
GROUP BY EXTRACT(HOUR FROM created_at)
ORDER BY hour_of_day;

-- =============================================================================
-- 6. COST EFFICIENCY (Calls with Orders vs Without)
-- =============================================================================
SELECT
  order_created AS resulted_in_order,
  COUNT(*) AS call_count,
  ROUND(AVG(total_cost)::numeric, 4) AS avg_cost,
  ROUND(AVG(call_duration_seconds)::numeric, 1) AS avg_duration,
  ROUND(AVG(ai_response_count)::numeric, 1) AS avg_responses,
  ROUND(AVG(input_tokens + output_tokens)::numeric, 0) AS avg_tokens
FROM call_usage
GROUP BY order_created
ORDER BY order_created DESC;

-- =============================================================================
-- 7. CUSTOMER REPEAT CALLER COSTS
-- =============================================================================
SELECT
  customer_phone,
  COUNT(*) AS total_calls,
  SUM(CASE WHEN order_created THEN 1 ELSE 0 END) AS orders,
  ROUND(SUM(total_cost)::numeric, 2) AS total_spent,
  ROUND(AVG(total_cost)::numeric, 4) AS avg_cost_per_call,
  MAX(created_at) AS last_call
FROM call_usage
WHERE customer_phone IS NOT NULL
GROUP BY customer_phone
HAVING COUNT(*) > 1  -- Only repeat callers
ORDER BY total_spent DESC
LIMIT 100;

-- =============================================================================
-- 8. MONTHLY COST PROJECTION
-- =============================================================================
WITH daily_avg AS (
  SELECT AVG(daily_cost) AS avg_daily_cost
  FROM (
    SELECT
      DATE(created_at) AS date,
      SUM(total_cost) AS daily_cost
    FROM call_usage
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at)
  ) daily
)
SELECT
  ROUND(avg_daily_cost::numeric, 2) AS avg_daily_cost,
  ROUND((avg_daily_cost * 30)::numeric, 2) AS projected_monthly_cost,
  ROUND((avg_daily_cost * 365)::numeric, 2) AS projected_yearly_cost
FROM daily_avg;

-- =============================================================================
-- 9. COST PER ORDER (Only Successful Orders)
-- =============================================================================
SELECT
  r.name AS restaurant,
  COUNT(cu.id) AS orders_created,
  ROUND(SUM(cu.total_cost)::numeric, 2) AS total_cost,
  ROUND(AVG(cu.total_cost)::numeric, 4) AS avg_cost_per_order,
  ROUND(AVG(cu.call_duration_seconds)::numeric, 1) AS avg_call_duration,
  ROUND(AVG(cu.input_tokens + cu.output_tokens)::numeric, 0) AS avg_tokens_per_order
FROM call_usage cu
JOIN restaurants r ON r.id = cu.restaurant_id
WHERE cu.order_created = true
GROUP BY r.id, r.name
ORDER BY total_cost DESC;

-- =============================================================================
-- 10. DETECT ANOMALIES (Unusually Expensive Calls)
-- =============================================================================
WITH avg_cost AS (
  SELECT AVG(total_cost) AS mean, STDDEV(total_cost) AS stddev
  FROM call_usage
  WHERE created_at >= NOW() - INTERVAL '7 days'
)
SELECT
  cu.call_sid,
  r.name AS restaurant,
  cu.customer_phone,
  ROUND(cu.total_cost::numeric, 4) AS cost,
  ROUND((SELECT mean FROM avg_cost)::numeric, 4) AS avg_cost,
  ROUND(((cu.total_cost - (SELECT mean FROM avg_cost)) / NULLIF((SELECT stddev FROM avg_cost), 0))::numeric, 2) AS std_deviations,
  cu.call_duration_seconds,
  cu.ai_response_count,
  cu.created_at
FROM call_usage cu
JOIN restaurants r ON r.id = cu.restaurant_id
CROSS JOIN avg_cost
WHERE cu.total_cost > (avg_cost.mean + (2 * avg_cost.stddev))  -- 2 std deviations above mean
  AND cu.created_at >= NOW() - INTERVAL '7 days'
ORDER BY cu.total_cost DESC;

-- =============================================================================
-- 11. WEEKLY COST TREND (Last 12 Weeks)
-- =============================================================================
SELECT
  DATE_TRUNC('week', created_at) AS week_start,
  COUNT(*) AS calls,
  SUM(CASE WHEN order_created THEN 1 ELSE 0 END) AS orders,
  ROUND(SUM(total_cost)::numeric, 2) AS weekly_cost,
  ROUND(AVG(total_cost)::numeric, 4) AS avg_cost_per_call
FROM call_usage
WHERE created_at >= NOW() - INTERVAL '12 weeks'
GROUP BY DATE_TRUNC('week', created_at)
ORDER BY week_start DESC;

-- =============================================================================
-- 12. COST BY CALL DURATION BRACKET
-- =============================================================================
SELECT
  CASE
    WHEN call_duration_seconds < 60 THEN '< 1 min'
    WHEN call_duration_seconds < 120 THEN '1-2 min'
    WHEN call_duration_seconds < 180 THEN '2-3 min'
    WHEN call_duration_seconds < 300 THEN '3-5 min'
    ELSE '> 5 min'
  END AS duration_bracket,
  COUNT(*) AS calls,
  ROUND(AVG(total_cost)::numeric, 4) AS avg_cost,
  ROUND(MIN(total_cost)::numeric, 4) AS min_cost,
  ROUND(MAX(total_cost)::numeric, 4) AS max_cost
FROM call_usage
GROUP BY duration_bracket
ORDER BY
  CASE duration_bracket
    WHEN '< 1 min' THEN 1
    WHEN '1-2 min' THEN 2
    WHEN '2-3 min' THEN 3
    WHEN '3-5 min' THEN 4
    ELSE 5
  END;

-- =============================================================================
-- 13. CURRENT MONTH SUMMARY
-- =============================================================================
SELECT
  COUNT(*) AS total_calls,
  SUM(CASE WHEN order_created THEN 1 ELSE 0 END) AS orders_created,
  ROUND(SUM(total_cost)::numeric, 2) AS total_cost_this_month,
  ROUND(AVG(total_cost)::numeric, 4) AS avg_cost_per_call,
  ROUND(SUM(total_cost) / NULLIF(SUM(CASE WHEN order_created THEN 1 ELSE 0 END), 0)::numeric, 4) AS cost_per_order,
  ROUND(SUM(input_tokens + output_tokens) / 1000000.0::numeric, 2) AS total_million_tokens,
  ROUND(AVG(call_duration_seconds)::numeric, 1) AS avg_call_duration_sec
FROM call_usage
WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE);
