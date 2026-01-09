import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }

  try {
    const callData = await req.json();

    // Validate core data
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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Try restaurant lookup by phone if restaurant_id is missing
    let restaurant_id = callData.restaurant_id || null;
    if (!restaurant_id && callData.to_number) {
      const { data: restaurant } = await supabase
        .from("restaurants")
        .select("id")
        .eq("phone_number", callData.to_number)
        .maybeSingle();

      if (restaurant) restaurant_id = restaurant.id;
    }

    // Prepare log record
    // IMPORTANT: Only include fields that are actually provided to avoid overwriting with null
    const callLogData: any = {
      call_sid: callData.call_sid,
    };

    // Only add fields if they have actual values (prevents overwriting existing data with null)
    if (restaurant_id) callLogData.restaurant_id = restaurant_id;
    if (callData.from_number) callLogData.from_number = callData.from_number;
    if (callData.to_number) callLogData.to_number = callData.to_number;
    if (callData.call_status) callLogData.call_status = callData.call_status;
    if (callData.call_direction) callLogData.call_direction = callData.call_direction;
    if (callData.caller_country) callLogData.caller_country = callData.caller_country;
    if (callData.caller_state) callLogData.caller_state = callData.caller_state;
    if (callData.caller_city) callLogData.caller_city = callData.caller_city;
    if (callData.caller_zip) callLogData.caller_zip = callData.caller_zip;
    if (callData.to_country) callLogData.to_country = callData.to_country;
    if (callData.to_state) callLogData.to_state = callData.to_state;
    if (callData.to_city) callLogData.to_city = callData.to_city;
    if (callData.to_zip) callLogData.to_zip = callData.to_zip;
    if (callData.call_started_at) callLogData.call_started_at = callData.call_started_at;
    if (callData.call_ended_at) callLogData.call_ended_at = callData.call_ended_at;
    if (callData.twilio_data) callLogData.twilio_data = callData.twilio_data;
    if (callData.order_id) callLogData.order_id = callData.order_id;
    if (callData.call_duration) callLogData.call_duration = callData.call_duration;
    if (callData.conversation_transcript) callLogData.conversation_transcript = callData.conversation_transcript;

    // Recording fields
    if (callData.recording_url) callLogData.recording_url = callData.recording_url;
    if (callData.recording_duration) callLogData.recording_duration = callData.recording_duration;

    // UPSERT: Insert or update based on call_sid
    // This prevents duplicates from WebSocket + Twilio webhook
    const { data: callLog, error: callLogError } = await supabase
      .from("call_logs")
      .upsert([callLogData], {
        onConflict: 'call_sid',
        ignoreDuplicates: false  // Update if exists
      })
      .select()
      .single();

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

    // Only bill for completed calls (and only if not already billed)
    let updatedCallLog = callLog;
    let balanceError = null;

    // Check if billing already processed to avoid double-billing
    const shouldBill = callLog.restaurant_id &&
                      callLog.call_duration &&
                      callLog.call_duration > 0 &&
                      callLog.call_status === "completed" &&
                      (!callLog.billing_status || callLog.billing_status === 'pending');

    if (shouldBill) {
      const billed_minutes = Math.ceil(callLog.call_duration / 60);

      // Fetch balance row
      const { data: balanceRow, error: fetchError } = await supabase
        .from("restaurant_balances")
        .select("id, total_used_minutes, current_balance_minutes")
        .eq("restaurant_id", callLog.restaurant_id)
        .maybeSingle();

      if (!fetchError && balanceRow) {
        // Capture balance BEFORE deduction
        const balance_before = balanceRow.current_balance_minutes;
        const new_total_used = balanceRow.total_used_minutes + billed_minutes;

        // Update restaurant's usage
        const { error: updateError } = await supabase
          .from("restaurant_balances")
          .update({
            total_used_minutes: new_total_used,
            last_updated: new Date().toISOString()
          })
          .eq("id", balanceRow.id);

        if (!updateError) {
          // Fetch updated balance to get current_balance_minutes AFTER deduction
          const { data: updatedBalance } = await supabase
            .from("restaurant_balances")
            .select("current_balance_minutes")
            .eq("id", balanceRow.id)
            .single();

          // Update log with billing and complete balance transaction record
          const { data: updatedLog } = await supabase
            .from("call_logs")
            .update({
              billing_status: "billed",
              billing_processed_at: new Date().toISOString(),
              minutes_billed: billed_minutes,
              balance_before_call: balance_before,
              balance_after_call: updatedBalance?.current_balance_minutes || null
            })
            .eq("id", callLog.id)
            .select()
            .single();

          updatedCallLog = updatedLog || callLog;
        } else {
          balanceError = updateError.message;
          await supabase
            .from("call_logs")
            .update({
              billing_status: "failed",
              billing_processed_at: new Date().toISOString()
            })
            .eq("id", callLog.id);
        }
      } else {
        balanceError = fetchError?.message || "Restaurant balance not found";
        await supabase
          .from("call_logs")
          .update({
            billing_status: "failed",
            billing_processed_at: new Date().toISOString()
          })
          .eq("id", callLog.id);
      }
    } else if (callLog.call_status === "completed" && !callLog.billing_status) {
      // Mark as skipped if completed but doesn't meet billing criteria
      await supabase
        .from("call_logs")
        .update({
          billing_status: "skipped",
          billing_processed_at: new Date().toISOString()
        })
        .eq("id", callLog.id);
    }

    return new Response(JSON.stringify({
      success: true,
      call_log: updatedCallLog,
      balance_error: balanceError,
      action: callData.source || 'upsert'  // Track source (websocket vs webhook)
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
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      },
      status: 500
    });
  }
});
