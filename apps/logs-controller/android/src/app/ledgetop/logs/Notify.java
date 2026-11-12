package app.ledgetop.logs;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/**
 * A reminder on the controller when nobody is signed in, so flights aren't left unrecorded. Posted after a
 * boot and from the background job (at most every few hours), cleared as soon as someone signs in.
 * Local only: nothing is sent from the server.
 */
final class Notify {
    private static final String CHANNEL = "sign-in";
    private static final int ID = 1;
    private static final long REPEAT_MS = 4 * 60 * 60 * 1000L;

    static void signInReminder(Context context, boolean force) {
        SyncEngine engine = new SyncEngine(context);
        if (engine.signedIn()) { clear(context); return; }
        long last = engine.prefs().getLong("reminderAt", 0), now = System.currentTimeMillis();
        if (!force && now - last < REPEAT_MS) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Sign-in reminders", NotificationManager.IMPORTANCE_DEFAULT));
        int waiting = engine.findLogs().size();
        boolean revoked = engine.prefs().getLong("revokedAt", 0) > 0;
        PendingIntent open = PendingIntent.getActivity(context, 0,
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification note = new Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.lt_mark)
            .setContentTitle(revoked ? "This controller was signed out" : "No pilot signed in to Ledge Top Logs")
            .setContentText("Tap to sign in so your flights upload to your account.")
            .setStyle(new Notification.BigTextStyle().bigText("Tap to sign in so your flights upload to your account."
                + (waiting > 0 ? " " + waiting + (waiting == 1 ? " flight log is" : " flight logs are") + " on this controller." : "")))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build();
        manager.notify(ID, note);
        engine.prefs().edit().putLong("reminderAt", now).apply();
    }

    static void clear(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(ID);
    }

    private Notify() {}
}
