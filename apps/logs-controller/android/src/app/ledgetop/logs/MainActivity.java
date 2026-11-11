package app.ledgetop.logs;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.text.format.DateUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.IOException;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * One screen: sign in (TV-style code approved in Ledge Top), see what's uploaded, upload now, switch pilot.
 * Built in code so the test build needs nothing beyond the Android platform.
 */
public final class MainActivity extends Activity {
    private static final int INK = Color.parseColor("#F5F3EF"), MUTED = Color.parseColor("#A9B0B8"),
        ORANGE = Color.parseColor("#EE5007"), ACTION = Color.parseColor("#CC4706"), PAGE = Color.parseColor("#0B0D10"),
        CARD = Color.parseColor("#15181D"), LINE = Color.parseColor("#262B32");

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SyncEngine engine;
    private LinearLayout body;
    private TextView status, detail, pilot, code, codeHelp;
    private Button primary, secondary;
    private volatile String pairId, pollToken;
    private boolean visible;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        engine = new SyncEngine(this);
        getWindow().setStatusBarColor(Color.parseColor("#070707"));
        setContentView(layout());
        SyncJob.schedule(this);
    }

    @Override protected void onResume() {
        super.onResume();
        visible = true;
        render();
        if (engine.signedIn() && hasStorage()) syncNow();
        ui.post(refresh);
    }

    @Override protected void onPause() { super.onPause(); visible = false; }

    private final Runnable refresh = new Runnable() {
        @Override public void run() { if (!visible) return; render(); ui.postDelayed(this, 1500); }
    };

    private View layout() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(PAGE);
        LinearLayout page = column();
        page.setPadding(dp(28), dp(20), dp(28), dp(24));
        scroll.addView(page);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.lt_mark);
        header.addView(mark, new LinearLayout.LayoutParams(dp(44), dp(44)));
        LinearLayout titles = column();
        titles.setPadding(dp(12), 0, 0, 0);
        titles.addView(text("Ledge Top", 20, INK, true));
        TextView product = text("LOGS", 12, ORANGE, true);
        product.setLetterSpacing(0.12f);
        titles.addView(product);
        header.addView(titles);
        page.addView(header);

        body = column();
        body.setPadding(dp(20), dp(18), dp(20), dp(20));
        GradientDrawable card = new GradientDrawable();
        card.setColor(CARD); card.setCornerRadius(dp(14)); card.setStroke(dp(1), LINE);
        body.setBackground(card);
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(-1, -2);
        cardParams.topMargin = dp(18);
        page.addView(body, cardParams);

        pilot = text("", 15, MUTED, false);
        status = text("", 22, INK, true);
        status.setPadding(0, dp(4), 0, dp(4));
        detail = text("", 14, MUTED, false);
        code = text("", 44, INK, true);
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setLetterSpacing(0.08f);
        codeHelp = text("", 15, MUTED, false);
        body.addView(pilot); body.addView(status); body.addView(code); body.addView(codeHelp); body.addView(detail);

        LinearLayout actions = new LinearLayout(this);
        actions.setPadding(0, dp(16), 0, 0);
        primary = button(true);
        secondary = button(false);
        actions.addView(primary);
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(-2, -2);
        gap.leftMargin = dp(12);
        actions.addView(secondary, gap);
        body.addView(actions);

        TextView server = text("", 13, MUTED, false);
        server.setPadding(0, dp(16), 0, 0);
        server.setOnClickListener(v -> editServer());
        server.setTag("server");
        page.addView(server);
        return scroll;
    }

    private void render() {
        TextView server = getWindow().getDecorView().findViewWithTag("server");
        if (server != null) server.setText("Server: " + engine.server() + "   (tap to change)   ·   Test build " + version());
        code.setVisibility(View.GONE); codeHelp.setVisibility(View.GONE); secondary.setVisibility(View.VISIBLE);

        if (!hasStorage()) {
            pilot.setText("");
            status.setText("Allow access to flight logs");
            detail.setText("Ledge Top Logs reads DJI Pilot 2’s flight records to upload them. It never moves, changes or deletes a log.");
            primary.setText("Allow access");
            primary.setOnClickListener(v -> requestPermissions(new String[] { Manifest.permission.READ_EXTERNAL_STORAGE }, 1));
            secondary.setVisibility(View.GONE);
            return;
        }
        if (pairId != null) {
            pilot.setText("Sign in");
            status.setText("Approve this code in Ledge Top");
            code.setVisibility(View.VISIBLE); codeHelp.setVisibility(View.VISIBLE);
            code.setText(engine.prefs().getString("pairCode", "…"));
            codeHelp.setText("On your phone or PC, open Ledge Top and enter this code. It works once and expires in 10 minutes.");
            detail.setText("");
            primary.setText("New code");
            primary.setOnClickListener(v -> startPairing());
            secondary.setText("Cancel");
            secondary.setOnClickListener(v -> { pairId = null; render(); });
            return;
        }
        if (!engine.signedIn()) {
            pilot.setText("No pilot signed in");
            status.setText("Sign in to upload flight logs");
            int count = engine.findLogs().size();
            detail.setText(count + (count == 1 ? " flight log" : " flight logs") + " found on this controller"
                + (engine.folderSummary() != null ? " in " + engine.folderSummary() : "") + ". Flights are recorded to the signed-in pilot.");
            primary.setText("Sign in");
            primary.setOnClickListener(v -> startPairing());
            secondary.setVisibility(View.GONE);
            return;
        }
        pilot.setText("Pilot: " + engine.pilot());
        status.setText(engine.prefs().getString("status", "Waiting to check"));
        long last = engine.prefs().getLong("lastSync", 0);
        int logs = engine.prefs().getInt("logCount", 0);
        detail.setText((last == 0 ? "Not synced yet" : "Last checked " + DateUtils.getRelativeTimeSpanString(last))
            + " · " + logs + (logs == 1 ? " flight log" : " flight logs") + " on this controller · New logs upload automatically.");
        primary.setText("Upload now");
        primary.setOnClickListener(v -> syncNow());
        secondary.setText("Switch pilot");
        secondary.setOnClickListener(v -> confirmSwitch());
    }

    private void syncNow() { new Thread(() -> engine.sync(), "ledgetop-sync-now").start(); }

    private void confirmSwitch() {
        new AlertDialog.Builder(this)
            .setTitle("Switch pilot?")
            .setMessage(engine.pilot() + " will be signed out on this controller. Logs already waiting keep the pilot who flew them.")
            .setPositiveButton("Switch pilot", (d, w) -> new Thread(() -> {
                try { new Api(engine.server(), engine.token()).post("/api/v1/device/sign-out", new JSONObject()); } catch (IOException ignored) { }
                engine.signOut();
                ui.post(this::startPairing);
            }).start())
            .setNegativeButton("Cancel", null).show();
    }

    private void startPairing() {
        pairId = "starting";
        engine.prefs().edit().putString("pairCode", "…").apply();
        render();
        new Thread(() -> {
            try {
                JSONObject started = new Api(engine.server(), null).post("/api/v1/device/pair/start", new JSONObject()
                    .put("model", Build.MANUFACTURER + " " + Build.MODEL)
                    .put("deviceName", Build.DEVICE)
                    .put("serial", Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID)));
                String id = started.getString("pairId");
                pollToken = started.getString("pollToken");
                engine.prefs().edit().putString("pairCode", started.getString("code")).apply();
                pairId = id;
                poll(id);
            } catch (IOException | JSONException e) {
                pairId = null;
                engine.prefs().edit().putString("status", "Couldn’t reach Ledge Top to sign in").apply();
            }
        }, "ledgetop-pair").start();
    }

    private void poll(String id) {
        while (id.equals(pairId)) {
            try {
                Thread.sleep(2500);
                JSONObject answer = new Api(engine.server(), null).get("/api/v1/device/pair/" + id + "?poll=" + pollToken);
                String state = answer.getString("status");
                if ("approved".equals(state)) {
                    engine.signedIn(answer.getString("deviceToken"), answer.getJSONObject("pilot").getString("name"));
                    engine.prefs().edit().putString("status", "Signed in").apply();
                    pairId = null;
                    engine.sync();
                    return;
                }
                if ("expired".equals(state)) { ui.post(this::startPairing); return; }
            } catch (InterruptedException e) { return; }
            catch (IOException | JSONException ignored) { /* keep polling until cancelled */ }
        }
    }

    private void editServer() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(engine.server());
        new AlertDialog.Builder(this).setTitle("Ledge Top server").setView(input)
            .setPositiveButton("Save", (d, w) -> {
                String value = input.getText().toString().trim();
                engine.prefs().edit().putString("server", value.isEmpty() ? SyncEngine.DEFAULT_SERVER : value).apply();
                render();
            })
            .setNegativeButton("Cancel", null).show();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        render();
        if (hasStorage() && engine.signedIn()) syncNow();
    }

    private boolean hasStorage() { return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED; }

    private String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (PackageManager.NameNotFoundException e) { return ""; }
    }

    private LinearLayout column() { LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); return layout; }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(sp); view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private Button button(boolean primary) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setTextColor(primary ? Color.WHITE : INK);
        button.setPadding(dp(22), dp(10), dp(22), dp(10));
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(dp(10));
        shape.setColor(primary ? ACTION : CARD);
        if (!primary) shape.setStroke(dp(1), Color.parseColor("#3A414A"));
        button.setBackground(shape);
        button.setMinHeight(dp(48));
        return button;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
