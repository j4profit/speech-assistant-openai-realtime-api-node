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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Calculate date 90 days ago
    const retentionDays = 90;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    console.log(`🧹 Starting recording cleanup for records older than ${cutoffDate.toISOString()}`);

    // Find call logs with recordings that are:
    // - Older than 90 days
    // - Have a recording_url
    // - NOT marked as preserve_recording
    const { data: oldRecordings, error: queryError } = await supabase
      .from("call_logs")
      .select("id, call_sid, recording_url, created_at")
      .lt("created_at", cutoffDate.toISOString())
      .not("recording_url", "is", null)
      .or("preserve_recording.is.null,preserve_recording.eq.false")
      .limit(100); // Process in batches to avoid timeout

    if (queryError) {
      console.error("Error querying old recordings:", queryError);
      return new Response(JSON.stringify({ error: queryError.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500
      });
    }

    if (!oldRecordings || oldRecordings.length === 0) {
      console.log("✅ No old recordings to clean up");
      return new Response(JSON.stringify({
        success: true,
        message: "No recordings to clean up",
        deleted_count: 0
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    console.log(`📋 Found ${oldRecordings.length} recordings to delete`);

    let deletedCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    for (const record of oldRecordings) {
      try {
        // Extract filename from recording_url
        // URL format: https://xxx.supabase.co/storage/v1/object/public/call-recordings/CALLSID.mp3
        const filename = `${record.call_sid}.mp3`;

        console.log(`🗑️ Deleting recording: ${filename}`);

        // Delete from Supabase Storage
        const { error: deleteError } = await supabase.storage
          .from("call-recordings")
          .remove([filename]);

        if (deleteError) {
          console.error(`Failed to delete ${filename}:`, deleteError);
          errors.push(`${filename}: ${deleteError.message}`);
          errorCount++;
          continue;
        }

        // Update call_log to clear recording_url and mark as cleaned
        const { error: updateError } = await supabase
          .from("call_logs")
          .update({
            recording_url: null,
            updated_at: new Date().toISOString()
          })
          .eq("id", record.id);

        if (updateError) {
          console.error(`Failed to update call_log ${record.id}:`, updateError);
          errors.push(`Update ${record.call_sid}: ${updateError.message}`);
          errorCount++;
          continue;
        }

        console.log(`✅ Deleted recording for call ${record.call_sid}`);
        deletedCount++;

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        console.error(`Error processing ${record.call_sid}:`, errorMessage);
        errors.push(`${record.call_sid}: ${errorMessage}`);
        errorCount++;
      }
    }

    const summary = {
      success: true,
      message: `Cleanup completed: ${deletedCount} deleted, ${errorCount} errors`,
      deleted_count: deletedCount,
      error_count: errorCount,
      errors: errors.length > 0 ? errors : undefined,
      retention_days: retentionDays,
      cutoff_date: cutoffDate.toISOString()
    };

    console.log(`🧹 Cleanup complete:`, summary);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});
