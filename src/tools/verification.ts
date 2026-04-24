import { setPending, clearPending, getPending, FLAG_PATH, type PendingFlag } from "../verification-gate.js";

export async function confirmVerification(args: { success: boolean; notes?: string }) {
  const existing = await getPending();
  if (args.success) {
    const cleared = await clearPending();
    return {
      action: "confirm_verification",
      success: true,
      previously_pending: existing,
      cleared,
      flag_path: FLAG_PATH,
      message: cleared
        ? "Gate cleared. You may proceed with further tool calls."
        : "No pending verification was active. Nothing to clear.",
    };
  }
  // success:false → keep the gate closed, annotate with notes
  if (existing) {
    await setPending({ ...existing, reason: args.notes ?? "Verification failed" });
  }
  return {
    action: "confirm_verification",
    success: false,
    still_pending: existing,
    flag_path: FLAG_PATH,
    message:
      "Verification marked failed. Pending gate remains in place. Fix the underlying issue and re-verify manually, then call confirm_verification with success:true.",
  };
}

export async function raisePendingVerification(payload: PendingFlag) {
  await setPending(payload);
}
