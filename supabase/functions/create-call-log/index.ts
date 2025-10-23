import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  try {
    const callData = await req.json();
    if (!callData.call_sid) {
      return new Response(JSON.stringify({
        error: "Missing call_sid"
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        },
        status: 400
      });
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
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
    const { data: callLog, error: callLogError } = await supabase.from("call_logs").insert([
      callLogData
    ]).select().single();
    if (callLogError) {
      console.error("Database error (call_logs):", callLogError);
      return new Response(JSON.stringify({
        error: callLogError.message
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        },
        status: 500
      });
    }
    // Process usage - add to total_used_minutes
    let updatedCallLog = callLog;
    let balanceError = null;
    // Check if call should be billed (only needs restaurant_id and duration > 0)
    if (callLog.restaurant_id && callLog.call_duration && callLog.call_duration > 0) {
      // Round UP call_duration (seconds) to minutes
      const billed_minutes = Math.ceil(callLog.call_duration / 60);
      // Fetch restaurant balance
      const { data: balanceRow, error: fetchError } = await supabase.from("restaurant_balances").select("id, total_used_minutes").eq("restaurant_id", callLog.restaurant_id).maybeSingle();
      if (!fetchError && balanceRow) {
        // INCREMENT total_used_minutes
        const new_total_used = balanceRow.total_used_minutes + billed_minutes;
        // Update restaurant balance
        const { error: updateError } = await supabase.from("restaurant_balances").update({
          total_used_minutes: new_total_used,
          last_updated: new Date().toISOString()
        }).eq("id", balanceRow.id);
        if (!updateError) {
          // Update call_log with billing details
          const { data: updatedLog } = await supabase.from("call_logs").update({
            billing_status: "billed",
            billing_processed_at: new Date().toISOString(),
            minutes_billed: billed_minutes
          }).eq("id", callLog.id).select().single();
          updatedCallLog = updatedLog || callLog;
        } else {
          balanceError = updateError.message;
          // Mark as failed
          await supabase.from("call_logs").update({
            billing_status: "failed",
            billing_processed_at: new Date().toISOString()
          }).eq("id", callLog.id);
        }
      } else {
        balanceError = fetchError?.message || "Restaurant balance not found";
        // Mark as failed
        await supabase.from("call_logs").update({
          billing_status: "failed",
          billing_processed_at: new Date().toISOString()
        }).eq("id", callLog.id);
      }
    } else {
      // Mark as skipped (no duration or no restaurant)
      await supabase.from("call_logs").update({
        billing_status: "skipped",
        billing_processed_at: new Date().toISOString()
      }).eq("id", callLog.id);
    }
    return new Response(JSON.stringify({
      success: true,
      call_log: updatedCallLog,
      balance_error: balanceError
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      },
      status: balanceError ? 207 : 200
    });
  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      },
      status: 500
    });
  }
});
