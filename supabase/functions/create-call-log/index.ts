import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const callData = await req.json();

    if (!callData.call_sid) {
      return new Response(JSON.stringify({ error: "Missing call_sid" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Compose call log data for insert
    const callLogData = {
      call_sid: callData.call_sid,
      restaurant_id: callData.restaurant_id || null,
      from_number: callData.from_number || null,
      to_number: callData.to_number || null,
      call_status: callData.call_status || "completed",
      call_direction: callData.call_direction || "inbound",
      caller_country: callData.caller_country || null,
      caller_state: callData.caller_state || null,
      caller_city: callData.caller_city || null,
      caller_zip: callData.caller_zip || null,
      to_country: callData.to_country || null,
      to_state: callData.to_state || null,
      to_city: callData.to_city || null,
      to_zip: callData.to_zip || null,
      call_duration: callData.call_duration || null,
      call_started_at: callData.call_started_at || null,
      call_ended_at: callData.call_ended_at || null,
      twilio_data: callData.twilio_data || null,
      conversation_transcript: callData.conversation_transcript || null,
      order_id: callData.order_id || null
    };

    // Insert call log record
    const { data: callLog, error: callLogError } = await supabase
      .from("call_logs")
      .insert([callLogData])
      .select()
      .single();

    if (callLogError) {
      console.error("Database error (call_logs):", callLogError);
      return new Response(JSON.stringify({ error: callLogError.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500
      });
    }

    // Billing logic: round call duration up to next minute
    let usageTransaction = null;
    let updatedCallLog = callLog;
    let billingError = null;

    if (callLog.restaurant_id && callLog.call_duration && callLog.call_duration > 0 && callLog.call_status === "completed") {
      // Calculate billed minutes/seconds
      const billed_minutes = Math.ceil(callLog.call_duration / 60);
      const secondsToDeduct = billed_minutes * 60;

      // Fetch restaurant balance
      const { data: balanceRow, error: balanceError } = await supabase
        .from("restaurant_balances")
        .select("id, current_balance_seconds")
        .eq("restaurant_id", callLog.restaurant_id)
        .maybeSingle();

      if (!balanceError && balanceRow) {
        const balance_before = balanceRow.current_balance_seconds;
        const balance_after = balance_before - secondsToDeduct;

        // Insert usage_transaction record
        const { data: usageTxn, error: txnError } = await supabase
          .from("usage_transactions")
          .insert([{
            restaurant_id: callLog.restaurant_id,
            call_log_id: callLog.id,
            transaction_type: "usage",
            seconds_change: -secondsToDeduct,
            minutes_billed: billed_minutes,
            balance_before_seconds: balance_before,
            balance_after_seconds: balance_after,
            call_duration_seconds: callLog.call_duration,
            call_sid: callLog.call_sid,
            description: "Call usage deduction (rounded up to next minute)"
          }])
          .select()
          .single();

        if (!txnError && usageTxn) {
          usageTransaction = usageTxn;

          // Update restaurant balance
          await supabase
            .from("restaurant_balances")
            .update({
              current_balance_seconds: balance_after,
              current_balance_minutes: Math.round((balance_after / 60) * 100) / 100,
              last_updated: new Date().toISOString()
            })
            .eq("id", balanceRow.id);

          // Update call_log with billing details and link usage_transaction
          const { data: updatedLog } = await supabase
            .from("call_logs")
            .update({
              billing_status: "billed",
              billing_processed_at: new Date().toISOString(),
              minutes_billed: billed_minutes,
              billing_amount_cents: null,
              usage_transaction_id: usageTxn.id
            })
            .eq("id", callLog.id)
            .select()
            .single();

          updatedCallLog = updatedLog || callLog;
        } else {
          billingError = txnError ? txnError.message : "Unknown error creating usage transaction";
          await supabase
            .from("call_logs")
            .update({ billing_status: "failed", billing_processed_at: new Date().toISOString() })
            .eq("id", callLog.id);
        }
      } else {
        billingError = "Restaurant balance not found";
        await supabase
          .from("call_logs")
          .update({ billing_status: "failed", billing_processed_at: new Date().toISOString() })
          .eq("id", callLog.id);
      }
    } else {
      await supabase
        .from("call_logs")
        .update({ billing_status: "skipped", billing_processed_at: new Date().toISOString() })
        .eq("id", callLog.id);
    }

    return new Response(JSON.stringify({
      success: true,
      call_log: updatedCallLog,
      usage_transaction: usageTransaction,
      billing_error: billingError
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: billingError ? 207 : 200
    });

  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});
