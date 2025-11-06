# OpenAI Usage Tracking - Deployment Summary

## What Was Built

Your restaurant AI ordering system now tracks OpenAI Realtime API costs per call with detailed token breakdowns. All data is visible to the system administrator (no multi-tenant restrictions).

---

## 📂 Files Created/Modified

### Database
- `supabase/migrations/create_call_usage_table.sql` - Database table schema
- `supabase/migrations/usage_analytics_queries.sql` - 13 pre-built analytics queries

### Edge Function
- `supabase/functions/save-call-usage/index.ts` - Supabase Edge Function to save usage data

### Backend Code (Already Applied)
- `index.js` - Added usage tracking and cost calculation
- `services/database.js` - Added `saveCallUsage()` function

### Documentation
- `QUICK_START_WEB_UI.md` ⭐ **START HERE** - 5-minute web UI deployment guide
- `USAGE_TRACKING_DEPLOYMENT.md` - Detailed deployment guide with both CLI and web UI options

---

## 🚀 How to Deploy

### For Web UI Users (Recommended - 5 minutes)

**Follow this guide:** [`QUICK_START_WEB_UI.md`](QUICK_START_WEB_UI.md)

This guide uses only the Supabase web dashboard (no terminal needed):
1. Copy/paste SQL in Supabase SQL Editor
2. Copy/paste TypeScript in Edge Functions
3. Test and verify
4. Done!

---

### For CLI Users (Advanced)

**Follow this guide:** [`USAGE_TRACKING_DEPLOYMENT.md`](USAGE_TRACKING_DEPLOYMENT.md)

This guide includes:
- CLI deployment commands
- Testing with curl
- Detailed troubleshooting
- Cost optimization tips
- Example analytics queries

---

## 💰 What Gets Tracked

### Per Call:
- **Total cost** (with audio vs text breakdown)
- **Token usage** (input/output, audio/text)
- **Call duration**
- **Restaurant** (which restaurant)
- **Customer phone**
- **AI response count**
- **Model used**
- **Order created** (yes/no)

### Pricing (OpenAI Realtime API):
- Text Input: $2.50 / 1M tokens
- Text Output: $10.00 / 1M tokens
- Audio Input: $100.00 / 1M tokens
- Audio Output: $200.00 / 1M tokens

**Average call cost: $0.08 - $0.15**

---

## 📊 Console Output Examples

### During Calls:

```
💰 Current call cost: {
  text_input: '$0.0025',
  text_output: '$0.0028',
  audio_input: '$0.0234',
  audio_output: '$0.0566',
  total: '$0.0853'
}
```

### At Call End:

```
📊 Call Statistics: {
  callSid: 'CA1234...',
  duration: 127,
  ai_responses: 8,
  total_cost: '$0.0853',
  usage: {
    input_tokens: 1234,
    output_tokens: 567,
    input_audio_tokens: 234,
    output_audio_tokens: 283
  }
}

✅ Call usage saved successfully - Total cost: $0.085300
```

---

## 📈 Quick Analytics Queries

### Today's Cost

```sql
SELECT
  COUNT(*) AS calls,
  ROUND(SUM(total_cost)::numeric, 2) AS cost
FROM call_usage
WHERE DATE(created_at) = CURRENT_DATE;
```

### Cost by Restaurant (Last 7 Days)

```sql
SELECT
  r.name,
  COUNT(cu.id) AS calls,
  ROUND(SUM(cu.total_cost)::numeric, 2) AS total_cost,
  ROUND(AVG(cu.total_cost)::numeric, 4) AS avg_cost
FROM call_usage cu
JOIN restaurants r ON r.id = cu.restaurant_id
WHERE cu.created_at >= NOW() - INTERVAL '7 days'
GROUP BY r.name
ORDER BY total_cost DESC;
```

### Monthly Projection

```sql
WITH daily_avg AS (
  SELECT AVG(daily_cost) AS avg_cost
  FROM (
    SELECT DATE(created_at), SUM(total_cost) AS daily_cost
    FROM call_usage
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at)
  ) d
)
SELECT
  ROUND(avg_cost::numeric, 2) AS avg_daily,
  ROUND((avg_cost * 30)::numeric, 2) AS projected_monthly
FROM daily_avg;
```

**See more queries in:** `supabase/migrations/usage_analytics_queries.sql`

---

## ✅ Deployment Checklist

- [ ] Create `call_usage` table in Supabase
- [ ] Deploy `save-call-usage` edge function
- [ ] Test edge function with sample data
- [ ] Verify data saves to database
- [ ] Restart Node.js application (if not already running latest code)
- [ ] Make a test call and verify usage data is tracked
- [ ] Run analytics queries to view cost data

---

## 🎯 What's Next?

### 1. Monitor Costs
Set up a simple dashboard to track daily costs:

```sql
-- Add this to your admin dashboard
SELECT
  DATE(created_at) AS date,
  COUNT(*) AS calls,
  SUM(CASE WHEN order_created THEN 1 ELSE 0 END) AS orders,
  ROUND(SUM(total_cost)::numeric, 2) AS daily_cost
FROM call_usage
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### 2. Set Cost Alerts
Create triggers to notify when costs exceed thresholds (see `USAGE_TRACKING_DEPLOYMENT.md` for examples)

### 3. Optimize Costs
- Review most expensive calls
- Adjust `max_response_output_tokens` (currently 400)
- Optimize AI instructions to reduce token usage

---

## 🆘 Troubleshooting

### Usage data not saving?

1. **Check edge function deployed:** Go to Supabase → Edge Functions
2. **Check table exists:** Run `SELECT * FROM call_usage LIMIT 1;`
3. **Check environment variables:** Verify `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`
4. **Check console logs:** Look for `💰 Saving call usage` messages

### Cost seems wrong?

1. **Verify pricing constants** in `index.js` lines 287-290
2. **Check OpenAI pricing:** https://openai.com/api/pricing/
3. **Compare with OpenAI dashboard** usage

### No cost updates during calls?

1. **Check WebSocket connection** is stable
2. **Verify OpenAI is sending `response.done` events** (check logs)
3. **Ensure calls complete normally** (not dropping mid-call)

---

## 📞 Support

For issues:
1. Check console logs for errors
2. Review Supabase Edge Function logs (Functions → save-call-usage → Logs)
3. Test edge function manually using Invoke tab
4. Verify database permissions (Database → Policies)

---

## 📦 Version Info

- **Feature Version:** v2.8
- **Added:** 2025-11-06
- **OpenAI Pricing:** As of January 2025
- **Compatible with:** v2.0+ of restaurant ordering system

---

## 🎉 You're Done!

**Start here:** [`QUICK_START_WEB_UI.md`](QUICK_START_WEB_UI.md)

Once deployed, your system will automatically track all OpenAI costs with no additional configuration needed.
