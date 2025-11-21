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
      restaurant_id,
      from_number: callData.from_number || null,
      to_number: callData.to_number || null,
      call_status: callData.call_status || null,
      call_direction: callData.call_direction || null,
      caller_country: callData.caller_country || null,
      caller_state: callData.caller_state || null,
      caller_city: callData.caller_city || null,
      caller_zip: callData.caller_zip || null,
      to_country: callData.to_country || null,
      to_state: callData.to_state || null,
      to_city: callData.to_city || null,
      to_zip: callData.to_zip || null,
      call_started_at: callData.call_started_at || null,
      call_ended_at: callData.call_ended_at || null,
      twilio_data: callData.twilio_data || null,
      order_id: callData.order_id || null
    };

    // Only set call_duration if provided (from Twilio webhook)
    if (callData.call_duration) {
      callLogData.call_duration = callData.call_duration;
    }

    // Only set conversation_transcript if provided (from WebSocket)
    // This prevents Twilio webhook from overwriting transcript with null
    if (callData.conversation_transcript) {
      callLogData.conversation_transcript = callData.conversation_transcript;
    }

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
