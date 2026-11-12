package app.ledgetop.logs;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Background uploads: a persisted periodic job (Android's minimum, 15 minutes, survives reboot) plus a
 * one-off "as soon as there's a network" job used after boot and when the app opens.
 */
public final class SyncJob extends JobService {
    private static final int PERIODIC = 1;
    private static final int SOON = 2;

    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null || scheduler.getPendingJob(PERIODIC) != null) return;
        scheduler.schedule(new JobInfo.Builder(PERIODIC, new ComponentName(context, SyncJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(15 * 60 * 1000L)
            .setPersisted(true)
            .build());
    }

    /** Runs a sync once a network is available (usually within seconds of boot). */
    static void runSoon(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        scheduler.schedule(new JobInfo.Builder(SOON, new ComponentName(context, SyncJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setMinimumLatency(5_000)
            .setOverrideDeadline(10 * 60 * 1000L)
            .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
            .build());
    }

    @Override public boolean onStartJob(JobParameters params) {
        getSharedPreferences("logs", MODE_PRIVATE).edit().putLong("lastJobAt", System.currentTimeMillis())
            .putInt("lastJobId", params.getJobId()).apply();
        new Thread(() -> {
            boolean retry = new SyncEngine(this).sync();
            // Couldn't reach Ledge Top (network still coming up after boot): let JobScheduler retry with backoff.
            jobFinished(params, retry && params.getJobId() == SOON);
        }, "ledgetop-sync").start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) { return true; }
}
