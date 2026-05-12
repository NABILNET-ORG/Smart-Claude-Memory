import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import type { MetricEvent } from "./types.js";

export async function emit(event: MetricEvent): Promise<void> {
  try {
    const { error } = await supabase.from("daemon_telemetry").insert({
      project_id: currentProjectId,
      daemon: event.daemon,
      event_type: event.event,
      payload: event.payload ?? {},
    });
    if (error) {
      console.error(
        `[telemetry] insert failed (${event.daemon}/${event.event}): ${error.message}`,
      );
    }
  } catch (e) {
    console.error(`[telemetry] emit threw (${event.daemon}/${event.event}):`, e);
  }
}
