package app.ledgetop.logs;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/** Background sync: every 15 minutes (Android's minimum) when a network is up, and after a reboot. */
public final class SyncJob extends JobService {
    private static final int PERIODIC = 1;

    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null || scheduler.getPendingJob(PERIODIC) != null) return;
        scheduler.schedule(new JobInfo.Builder(PERIODIC, new ComponentName(context, SyncJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(15 * 60 * 1000L)
            .setPersisted(true)
            .build());
    }

    @Override public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            new SyncEngine(this).sync();
            jobFinished(params, false);
        }, "ledgetop-sync").start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) { return true; }
}
