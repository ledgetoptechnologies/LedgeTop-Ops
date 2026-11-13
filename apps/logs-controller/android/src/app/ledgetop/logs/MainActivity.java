package app.ledgetop.logs;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
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
import java.security.GeneralSecurityException;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * One screen: sign in with your Ledge Top username (the code is approved in your own Ops account), see what's
 * uploaded, upload now, switch pilot. After that the controller signs itself in and uploads after every boot.
 */
public final class MainActivity extends Activity {
    private static final int INK = Color.parseColor("#F5F3EF"), MUTED = Color.parseColor("#A9B0B8"),
        ORANGE = Color.parseColor("#EE5007"), ACTION = Color.parseColor("#CC4706"), PAGE = Color.parseColor("#0B0D10"),
        CARD = Color.parseColor("#15181D"), LINE = Color.parseColor("#262B32");
    /** Test builds can point at a local server (adb reverse) with this extra; only loopback or HTTPS is accepted. */
    static final String EXTRA_SERVER = "app.ledgetop.logs.SERVER";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SyncEngine engine;
    private LinearLayout body;
    private TextView status, detail, pilot, code, codeHelp, server;
    private EditText username;
    private Button primary, secondary, folder;
    private static final int PICK_LOG_FOLDER = 7;
    private volatile String signInId, pollToken;
    private boolean visible;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        engine = new SyncEngine(this);
        applyServerExtra(getIntent());
        getWindow().setStatusBarColor(Color.parseColor("#070707"));
        setContentView(layout());
        SyncJob.schedule(this);
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); applyServerExtra(intent); }

    private void applyServerExtra(Intent intent) {
        String value = intent == null ? null : intent.getStringExtra(EXTRA_SERVER);
        if (value == null) return;
        value = value.trim();
        // Only the servers this build allows, and only while nobody is signed in and no previous pilot's logs
        // are still being sent: an existing token never follows a changed setting.
        if (engine.signedIn() || engine.retired().length() > 0 || signInId != null) return;
        if (BuildInfo.allowedServer(value)) engine.prefs().edit().putString("server", value).apply();
    }

    @Override protected void onResume() {
        super.onResume();
        visible = true;
        render();
        if (engine.signedIn() && hasStorage()) SyncJob.runSoon(this);
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
        username = new EditText(this);
        username.setHint("Your Ledge Top username");
        username.setSingleLine(true);
        username.setTextColor(INK); username.setHintTextColor(MUTED); username.setTextSize(18);
        // Landscape controllers otherwise swap the whole app for a full-screen text editor while typing, and
        // suggest words: keep the app visible, no suggestions, and make the keyboard's action key sign in.
        username.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        username.setTypeface(Typeface.DEFAULT);   // the no-suggestions input type would otherwise switch to monospace
        username.setImeOptions(EditorInfo.IME_ACTION_GO | EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_FULLSCREEN);
        username.setOnEditorActionListener((view, action, event) -> {
            if (action == EditorInfo.IME_ACTION_GO || action == EditorInfo.IME_ACTION_DONE) { startSignIn(); return true; }
            return false;
        });
        LinearLayout.LayoutParams field = new LinearLayout.LayoutParams(-1, -2);
        field.topMargin = dp(12);
        body.addView(pilot); body.addView(status); body.addView(code); body.addView(codeHelp); body.addView(detail);
        body.addView(username, field);

        LinearLayout actions = new LinearLayout(this);
        actions.setPadding(0, dp(16), 0, 0);
        primary = button(true);
        secondary = button(false);
        actions.addView(primary);
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(-2, -2);
        gap.leftMargin = dp(12);
        actions.addView(secondary, gap);
        body.addView(actions);
        folder = button(false);
        folder.setText("Choose DJI Fly log folder");
        folder.setOnClickListener(v -> chooseLogFolder());
        LinearLayout.LayoutParams folderParams = new LinearLayout.LayoutParams(-2, -2);
        folderParams.topMargin = dp(12);
        body.addView(folder, folderParams);

        server = text("", 13, MUTED, false);
        server.setPadding(0, dp(16), 0, 0);
        page.addView(server);
        return scroll;
    }

    private void render() {
        String target = engine.signedIn() ? SyncEngine.serverOf(engine.current()) : engine.server();
        server.setText((BuildInfo.DEFAULT_SERVER.equals(target) ? "Ledge Top Logs" : "Test server: " + target) + "   ·   Version " + BuildInfo.VERSION);
        code.setVisibility(View.GONE); codeHelp.setVisibility(View.GONE); secondary.setVisibility(View.VISIBLE); username.setVisibility(View.GONE);
        folder.setVisibility(hasStorage() && signInId == null && engine.canChooseLogFolder() ? View.VISIBLE : View.GONE);

        if (!hasStorage()) {
            pilot.setText("");
            status.setText("Allow access to flight logs");
            detail.setText("Ledge Top Logs reads the DJI app’s flight records (DJI Pilot 2 or DJI Fly) to upload them. It never moves, changes or deletes a log.");
            primary.setText("Allow access");
            primary.setOnClickListener(v -> requestPermissions(new String[] { Manifest.permission.READ_EXTERNAL_STORAGE }, 1));
            secondary.setVisibility(View.GONE);
            return;
        }
        if (signInId != null) {
            pilot.setText("Signing in as " + engine.prefs().getString("pairUsername", ""));
            status.setText("Approve this code in Ledge Top");
            code.setVisibility(View.VISIBLE); codeHelp.setVisibility(View.VISIBLE);
            code.setText(engine.prefs().getString("pairCode", "…"));
            codeHelp.setText("Open Ledge Top on your phone or PC, go to Flight logs and approve this code. It only appears in your own account, works once and expires in 10 minutes.");
            detail.setText("");
            primary.setText("New code");
            primary.setOnClickListener(v -> startSignIn());
            secondary.setText("Cancel");
            secondary.setOnClickListener(v -> { signInId = null; render(); });
            return;
        }
        int pendingRetired = engine.retired().length();
        if (!engine.signedIn()) {
            pilot.setText("No pilot signed in");
            status.setText("Type your username to sign in");
            username.setVisibility(View.VISIBLE);
            int count = engine.findLogs().size();
            boolean needsFolder = count == 0 && engine.canChooseLogFolder();
            String problem = engine.prefs().getString("signInProblem", "");
            detail.setText(!problem.isEmpty() ? problem : needsFolder
                ? "No flight logs found yet. With DJI Fly, tap Choose DJI Fly log folder and allow access to FlightRecord once."
                : count + (count == 1 ? " flight log" : " flight logs") + " on this controller"
                + (engine.folderSummary() != null ? " in " + engine.folderSummary() : "") + ". New flights are recorded to the signed-in pilot."
                + (pendingRetired > 0 ? " Logs from the previous pilot are still being sent to their account." : ""));
            primary.setText("Sign in");
            primary.setOnClickListener(v -> startSignIn());
            secondary.setVisibility(View.GONE);
            return;
        }
        pilot.setText("Pilot: " + engine.pilot());
        status.setText(engine.prefs().getString("status", "Waiting to check"));
        long last = engine.prefs().getLong("lastSync", 0);
        int logs = engine.prefs().getInt("logCount", 0);
        detail.setText((last == 0 ? "Not checked yet" : "Last checked " + DateUtils.getRelativeTimeSpanString(last))
            + " · " + logs + (logs == 1 ? " flight log" : " flight logs") + " on this controller."
            + " Stays signed in after a restart, and uploads new logs automatically."
            + (pendingRetired > 0 ? " Still sending the previous pilot’s logs to their account." : ""));
        primary.setText("Upload now");
        primary.setOnClickListener(v -> new Thread(() -> engine.sync(), "ledgetop-sync-now").start());
        secondary.setText("Switch pilot");
        secondary.setOnClickListener(v -> confirmSwitch());
    }

    private void confirmSwitch() {
        new AlertDialog.Builder(this)
            .setTitle("Switch pilot?")
            .setMessage(engine.pilot() + " will be signed out on this controller. Logs from their flights still upload to their account.")
            .setPositiveButton("Switch pilot", (d, w) -> {
                engine.retireCurrent();
                username.setText("");
                render();
                SyncJob.runSoon(this);
            })
            .setNegativeButton("Cancel", null).show();
    }

    private void startSignIn() {
        if ("starting".equals(signInId)) return;   // a code is already being requested (double tap)
        String name = username.getText().toString().trim().toLowerCase();
        if (name.isEmpty()) name = engine.prefs().getString("pairUsername", "");
        if (name.isEmpty()) { engine.prefs().edit().putString("signInProblem", "Type your username first.").apply(); render(); return; }
        final String user = name;
        // Close the keyboard: the username field disappears once the code shows.
        android.view.inputmethod.InputMethodManager keyboard = getSystemService(android.view.inputmethod.InputMethodManager.class);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(username.getWindowToken(), 0);
        username.clearFocus();
        final String target = engine.server();   // the whole sign-in, and the session it creates, use this one server
        signInId = "starting";
        engine.prefs().edit().putString("pairCode", "…").putString("pairUsername", user).remove("signInProblem").apply();
        render();
        new Thread(() -> {
            try {
                JSONObject started = new Api(target, null).post("/api/v1/device/sign-in", new JSONObject()
                    .put("username", user)
                    .put("model", Build.MODEL.toUpperCase().startsWith(Build.MANUFACTURER.toUpperCase()) ? Build.MODEL : Build.MANUFACTURER + " " + Build.MODEL)
                    .put("name", Build.DEVICE)
                    .put("hardwareId", Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID)));
                String id = started.getString("signInId");
                pollToken = started.getString("pollToken");
                engine.prefs().edit().putString("pairCode", started.getString("code")).apply();
                signInId = id;
                poll(id, target);
            } catch (Api.Failure e) {
                signInId = null;
                engine.prefs().edit().putString("signInProblem", e.getMessage()).apply();
            } catch (IOException | JSONException e) {
                signInId = null;
                engine.prefs().edit().putString("signInProblem", "Couldn’t reach Ledge Top to sign in. Check the connection and try again.").apply();
            }
        }, "ledgetop-sign-in").start();
    }

    private void poll(String id, String target) {
        while (id.equals(signInId)) {
            try {
                Thread.sleep(2500);
                JSONObject answer = new Api(target, null).getWithHeader("/api/v1/device/sign-in/" + id, "X-Poll-Token", pollToken);
                String state = answer.getString("status");
                if ("approved".equals(state)) {
                    JSONObject who = answer.getJSONObject("pilot");
                    engine.signedIn(answer.getString("deviceToken"), who.getString("username"), who.getString("id"), target);
                    pollToken = null;
                    signInId = null;
                    SyncJob.schedule(this);
                    engine.sync();
                    return;
                }
                if ("denied".equals(state)) { signInId = null; engine.prefs().edit().putString("signInProblem", "The sign-in was declined in Ledge Top.").apply(); return; }
                if ("expired".equals(state)) { signInId = null; engine.prefs().edit().putString("signInProblem", "The code expired. Tap Sign in for a new one.").apply(); return; }
            } catch (InterruptedException e) { return; }
            catch (GeneralSecurityException e) { signInId = null; engine.prefs().edit().putString("signInProblem", "This controller couldn’t store the sign-in securely.").apply(); return; }
            catch (Api.Failure e) { if (e.status == 404) { signInId = null; engine.prefs().edit().putString("signInProblem", "That sign-in is no longer valid. Tap Sign in again.").apply(); return; } }
            catch (IOException | JSONException ignored) { /* keep polling until cancelled or expired */ }
        }
    }

    /** Opens the system folder picker at DJI Fly's flight-record folder; the grant is read-only and persists. */
    private void chooseLogFolder() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        pick.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(
            "com.android.externalstorage.documents", "primary:Android/data/dji.go.v5/files/FlightRecord"));
        try { startActivityForResult(pick, PICK_LOG_FOLDER); }
        catch (RuntimeException e) { engine.prefs().edit().putString("signInProblem", "This controller can’t open the folder picker.").apply(); render(); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_LOG_FOLDER || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri tree = data.getData();
        try { engine.rememberLogTree(tree); }
        catch (SecurityException e) { engine.prefs().edit().putString("signInProblem", "Access to that folder wasn’t granted. Try again.").apply(); }
        render();
        if (engine.signedIn()) SyncJob.runSoon(this);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        render();
        if (hasStorage() && engine.signedIn()) SyncJob.runSoon(this);
    }

    private boolean hasStorage() { return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED; }

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
