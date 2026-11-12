package app.ledgetop.logs;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * When the controller boots (or the app is updated) the stored, Keystore-encrypted sign-in is still there,
 * so nothing needs re-entering: schedule the periodic check and an immediate upload once a network is up.
 */
public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        context.getSharedPreferences("logs", Context.MODE_PRIVATE).edit()
            .putLong("lastBoot", System.currentTimeMillis()).putString("lastBootAction", action).apply();
        SyncJob.schedule(context);
        SyncJob.runSoon(context);
    }
}
