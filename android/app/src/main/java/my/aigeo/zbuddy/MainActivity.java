package my.aigeo.zbuddy;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import com.google.firebase.messaging.FirebaseMessaging;

public final class MainActivity extends Activity {
    private static volatile boolean visible;
    private static final int PICK_IMAGE = 11, MEDIA_PERMISSION = 21, LOCATION_PERMISSION = 22, NOTIFICATION_PERMISSION = 23;
    private static final int BG = 0xFFF8F1FC, PURPLE = 0xFF906BAE, TEXT = 0xFF604971, MUTED = 0xFFA38BAF;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private FrameLayout container, screen;
    private LinearLayout column, bar;
    private TextView setupStatus;
    private EditText serverInput;
    private Button connectButton;
    private ProgressBar progress;
    private WebView web;
    private int connectGeneration = 0;
    private ServerAddress trusted;
    private PermissionRequest pendingMedia;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingGeoOrigin;
    private ValueCallback<Uri[]> pendingFile;
    private View fullScreenVideo;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private SharedPreferences prefs;
    private String pendingConversation;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("sembang", MODE_PRIVATE);
        pendingConversation = validConversation(getIntent().getStringExtra("conversation"));
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            if (token == null || token.isEmpty()) return;
            prefs.edit().putString("fcm_token", token).apply();
            if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('zbuddy:fcm-token'))", null);
        });
        container = new FrameLayout(this);
        container.setBackgroundColor(BG);
        column = new LinearLayout(this); column.setOrientation(LinearLayout.VERTICAL);
        container.addView(column, new FrameLayout.LayoutParams(-1, -1));
        bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(dp(17), 0, dp(6), 0); bar.setBackgroundColor(BG);
        TextView brand = text("Zbuddy", 18, PURPLE); brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        android.graphics.drawable.Drawable mark = getDrawable(my.aigeo.zbuddy.R.drawable.ic_brand); mark.setBounds(0, 0, dp(25), dp(25)); brand.setCompoundDrawables(mark, null, null, null); brand.setCompoundDrawablePadding(dp(7));
        bar.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton menu = new ImageButton(this); menu.setImageResource(my.aigeo.zbuddy.R.drawable.ic_menu); menu.setBackgroundColor(Color.TRANSPARENT); menu.setImageTintList(android.content.res.ColorStateList.valueOf(PURPLE)); menu.setContentDescription("Server settings");
        bar.addView(menu, new LinearLayout.LayoutParams(dp(48), dp(48))); menu.setOnClickListener(v -> showMenu(menu));
        column.addView(bar, new LinearLayout.LayoutParams(-1, dp(48)));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); progress.setMax(100); progress.setVisibility(View.GONE);
        column.addView(progress, new LinearLayout.LayoutParams(-1, dp(3)));
        screen = new FrameLayout(this); column.addView(screen, new LinearLayout.LayoutParams(-1, 0, 1));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            container.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(safe.left, safe.top, safe.right, safe.bottom); return insets;
            });
        }
        setContentView(container);
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        showSetup(null);
        String saved = prefs.getString("server", BuildConfig.DEFAULT_SERVER);
        if (!saved.isEmpty()) { serverInput.setText(saved); connect(saved); }
    }

    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }
    private TextView text(String value, int size, int color) { TextView t = new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(color); t.setLineSpacing(dp(3), 1); return t; }
    private GradientDrawable rounded(int color, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    private LinearLayout.LayoutParams spaced(int top) { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.topMargin = dp(top); return p; }
    private void notice(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add("Change server"); menu.getMenu().add("Reload"); menu.getMenu().add("About the app");
        menu.setOnMenuItemClickListener(item -> {
            if (item.getTitle().equals("Change server")) {
                if (web == null) showSetup(null);
                else new AlertDialog.Builder(this).setTitle("Change server?").setMessage("Any open chat or call will close. Keys stored on this device will remain available.")
                    .setPositiveButton("Continue", (d, w) -> showSetup(null)).setNegativeButton("Cancel", null).show();
            } else if (item.getTitle().equals("Reload")) { if (web != null) web.reload(); }
            else new AlertDialog.Builder(this).setTitle("Zbuddy " + BuildConfig.VERSION_NAME)
                .setMessage("A private Zbuddy Android app for two people. JavaScript chat, a Node.js server, compressed images, and end-to-end encryption.\n\nCalls and live location require the app to remain open. Sign in with your email and password on another device.").setPositiveButton("Got it", null).show();
            return true;
        }); menu.show();
    }

    private void closeWeb() {
        if (pendingMedia != null) { pendingMedia.deny(); pendingMedia = null; }
        if (pendingGeo != null) { pendingGeo.invoke(pendingGeoOrigin, false, false); pendingGeo = null; }
        if (pendingFile != null) { pendingFile.onReceiveValue(null); pendingFile = null; }
        if (web != null) { WebView old = web; web = null; old.setWebChromeClient(null); old.setWebViewClient(new WebViewClient()); old.stopLoading(); old.loadUrl("about:blank"); if (old.getParent() instanceof ViewGroup) ((ViewGroup) old.getParent()).removeView(old); old.destroy(); }
        trusted = null;
    }
    private void showSetup(String error) {
        connectGeneration++;
        closeWeb(); progress.setVisibility(View.GONE); screen.removeAllViews();
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout form = new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL); form.setPadding(dp(30), dp(30), dp(30), dp(32)); form.setGravity(Gravity.CENTER_VERTICAL);
        TextView badge = text("YOUR SPACE, ANYWHERE", 10, MUTED); form.addView(badge);
        TextView title = text("Hello, let's\nZbuddy.", 38, TEXT); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD); form.addView(title, spaced(17));
        form.addView(text("Connect this app to your Zbuddy server.", 14, MUTED), spaced(15));
        form.addView(text("Server address", 12, TEXT), spaced(28));
        serverInput = new EditText(this); serverInput.setSingleLine(true); serverInput.setTextSize(15); serverInput.setTextColor(TEXT); serverInput.setHintTextColor(MUTED); serverInput.setHint("https://private.aigeo.my"); serverInput.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        serverInput.setBackground(rounded(0xFFEFE3F7, 12)); serverInput.setPadding(dp(16), dp(13), dp(16), dp(13)); serverInput.setText(prefs.getString("server", BuildConfig.DEFAULT_SERVER)); form.addView(serverInput, spaced(9));
        connectButton = new Button(this); connectButton.setText("Connect to Zbuddy"); connectButton.setAllCaps(false); connectButton.setTextSize(14); connectButton.setTextColor(Color.WHITE); connectButton.setBackground(rounded(PURPLE, 12)); LinearLayout.LayoutParams buttonSize = new LinearLayout.LayoutParams(-1, dp(51)); buttonSize.topMargin = dp(20); form.addView(connectButton, buttonSize);
        connectButton.setOnClickListener(v -> connect(serverInput.getText().toString()));
        setupStatus = text(error == null ? "" : error, 12, error == null ? MUTED : 0xFFB26E8E); form.addView(setupStatus, spaced(14));
        TextView privacy = text("Chat keys are stored on your device. The server must use HTTPS for normal use.", 12, MUTED); android.graphics.drawable.Drawable privacyIcon = getDrawable(my.aigeo.zbuddy.R.drawable.ic_lock); privacyIcon.setBounds(0, 0, dp(22), dp(22)); privacy.setCompoundDrawables(privacyIcon, null, null, null); privacy.setCompoundDrawablePadding(dp(8)); form.addView(privacy, spaced(24));
        Button usb = new Button(this, null, android.R.attr.borderlessButtonStyle); usb.setText("Test over USB"); usb.setCompoundDrawablesWithIntrinsicBounds(my.aigeo.zbuddy.R.drawable.ic_usb, 0, 0, 0); usb.setCompoundDrawablePadding(dp(8)); usb.setAllCaps(false); usb.setTextColor(PURPLE); usb.setOnClickListener(v -> { serverInput.setText("http://localhost:3000"); setupStatus.setText("Make sure the computer is running the server and USB test forwarding is configured."); }); form.addView(usb, spaced(12));
        form.addView(text("A server on your computer requires USB test forwarding. For two phones or remote access, use the same HTTPS domain.", 11, MUTED), spaced(4));
        scroll.addView(form); screen.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
    }
    private void connect(String input) {
        final ServerAddress next;
        try { next = ServerAddress.parse(input); } catch (IllegalArgumentException e) { setupStatus.setText(e.getMessage()); return; }
        final int ticket = ++connectGeneration;
        connectButton.setEnabled(false); setupStatus.setText("Connecting to server…");
        network.execute(() -> {
            HttpURLConnection connection = null;
            String error = null;
            try {
                connection = (HttpURLConnection) new URL(next.origin + "/api/health").openConnection();
                connection.setConnectTimeout(8000); connection.setReadTimeout(8000); connection.setInstanceFollowRedirects(false);
                if (connection.getResponseCode() != 200) throw new Exception("The server did not respond as Zbuddy. Check the address and make sure Node.js is running.");
                try (InputStream stream = connection.getInputStream()) {
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    byte[] chunk = new byte[2048]; int size;
                    while ((size = stream.read(chunk)) != -1) { buffer.write(chunk, 0, size); if (buffer.size() > 16384) break; }
                    byte[] response = buffer.toByteArray();
                    if (response.length > 16384 || !new JSONObject(new String(response, StandardCharsets.UTF_8)).optString("service").equals("sembang")) throw new Exception("This address is not a compatible Zbuddy server.");
                }
            } catch (Exception e) { error = "Could not connect. Check your Internet connection, HTTPS address, or USB test forwarding, then try again."; }
            finally { if (connection != null) connection.disconnect(); }
            final String result = error;
            runOnUiThread(() -> { if (isFinishing() || isDestroyed() || ticket != connectGeneration) return; connectButton.setEnabled(true); if (result != null) setupStatus.setText(result); else { prefs.edit().putString("server", next.origin).apply(); openServer(next); } });
        });
    }

    private void openServer(ServerAddress address) {
        closeWeb(); trusted = address; screen.removeAllViews();
        web = new WebView(this); web.setBackgroundColor(BG);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false); settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " SNDChatAndroid/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new AndroidBridge(), "ZbuddyAndroid");
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (trusted != null && trusted.matches(url)) return false;
                if (request.isForMainFrame() && request.hasGesture()) external(request.getUrl());
                return true;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); if (view == web) showSetup("The HTTPS certificate is invalid. Check the certificate on your server domain."); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (view == web && request.isForMainFrame()) showSetup("The page could not be loaded. Check your connection and reconnect."); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) { if (view == web && request.isForMainFrame()) showSetup("The server could not open Zbuddy. Try again shortly."); }
            @Override public void onPageFinished(WebView view, String url) { if (view == web) { progress.setVisibility(View.GONE); view.evaluateJavascript("window.dispatchEvent(new Event('zbuddy:fcm-token'))", null); } CookieManager.getInstance().flush(); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { progress.setProgress(value); progress.setVisibility(value < 100 ? View.VISIBLE : View.GONE); }
            @Override public void onPermissionRequest(PermissionRequest request) { runOnUiThread(() -> requestMedia(request)); }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (pendingMedia == request) pendingMedia = null; }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { requestLocation(origin, callback); }
            @Override public void onGeolocationPermissionsHidePrompt() { if (pendingGeo != null) { pendingGeo.invoke(pendingGeoOrigin, false, false); pendingGeo = null; } }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (trusted == null || !trusted.matches(view.getUrl())) return false;
                if (pendingFile != null) pendingFile.onReceiveValue(null);
                pendingFile = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT); pick.setType("image/*"); pick.addCategory(Intent.CATEGORY_OPENABLE); pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/jpeg", "image/png", "image/webp", "image/gif"});
                try { startActivityForResult(pick, PICK_IMAGE); } catch (Exception e) { pendingFile.onReceiveValue(null); pendingFile = null; notice("The image picker is unavailable."); }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
                if (!gesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() { @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) { external(request.getUrl()); v.destroy(); return true; } });
                ((WebView.WebViewTransport) result.obj).setWebView(popup); result.sendToTarget(); return true;
            }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullScreenVideo != null) { callback.onCustomViewHidden(); return; }
                fullScreenVideo = view; fullScreenCallback = callback; container.addView(view, new FrameLayout.LayoutParams(-1, -1)); column.setVisibility(View.GONE);
            }
            @Override public void onHideCustomView() { closeFullScreen(); }
        });
        screen.addView(web, new FrameLayout.LayoutParams(-1, -1)); web.loadUrl(conversationUrl(address.origin));
    }

    private final class AndroidBridge {
        @JavascriptInterface public String getFcmToken() { return prefs.getString("fcm_token", ""); }
        @JavascriptInterface public boolean notificationsAllowed() { return Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS); }
    }
    private String validConversation(String value) { return value != null && value.matches("[a-f0-9-]{36}") ? value : null; }
    private String conversationUrl(String origin) {
        String id = pendingConversation; pendingConversation = null;
        return id == null ? origin + "/" : origin + "/?conversation=" + id;
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        pendingConversation = validConversation(intent.getStringExtra("conversation"));
        if (pendingConversation != null && web != null && trusted != null) web.loadUrl(conversationUrl(trusted.origin));
    }

    private boolean allowed(String origin) { return trusted != null && web != null && trusted.matches(origin) && trusted.matches(web.getUrl()); }
    private boolean granted(String permission) { return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED; }
    private void requestMedia(PermissionRequest request) {
        if (!allowed(request.getOrigin().toString()) || pendingMedia != null || pendingGeo != null) { request.deny(); return; }
        List<String> permissions = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && !granted(Manifest.permission.RECORD_AUDIO)) permissions.add(Manifest.permission.RECORD_AUDIO);
            if (resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !granted(Manifest.permission.CAMERA)) permissions.add(Manifest.permission.CAMERA);
        }
        pendingMedia = request;
        if (permissions.isEmpty()) finishMediaPermission();
        else requestPermissions(permissions.toArray(new String[0]), MEDIA_PERMISSION);
    }
    private void finishMediaPermission() {
        PermissionRequest request = pendingMedia; pendingMedia = null; if (request == null) return;
        if (!allowed(request.getOrigin().toString())) { request.deny(); return; }
        List<String> resources = new ArrayList<>();
        for (String r : request.getResources()) {
            if (r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && granted(Manifest.permission.RECORD_AUDIO)) resources.add(r);
            if (r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && granted(Manifest.permission.CAMERA)) resources.add(r);
        }
        if (resources.isEmpty()) request.deny(); else request.grant(resources.toArray(new String[0]));
    }
    private void requestLocation(String origin, GeolocationPermissions.Callback callback) {
        if (!allowed(origin) || pendingGeo != null || pendingMedia != null) { callback.invoke(origin, false, false); return; }
        if (granted(Manifest.permission.ACCESS_COARSE_LOCATION) || granted(Manifest.permission.ACCESS_FINE_LOCATION)) { callback.invoke(origin, true, false); return; }
        pendingGeo = callback; pendingGeoOrigin = origin;
        requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == MEDIA_PERMISSION) finishMediaPermission();
        if (requestCode == LOCATION_PERMISSION && pendingGeo != null) {
            GeolocationPermissions.Callback cb = pendingGeo; pendingGeo = null;
            cb.invoke(pendingGeoOrigin, allowed(pendingGeoOrigin) && (granted(Manifest.permission.ACCESS_COARSE_LOCATION) || granted(Manifest.permission.ACCESS_FINE_LOCATION)), false);
        }
    }

    @Override public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_IMAGE && pendingFile != null) {
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            try {
                String mime = uri == null ? null : getContentResolver().getType(uri);
                if (uri != null && (!"content".equals(uri.getScheme()) || mime == null || !mime.startsWith("image/"))) uri = null;
            } catch (Exception e) { uri = null; }
            pendingFile.onReceiveValue(uri == null ? null : new Uri[]{uri}); pendingFile = null;
        }
    }
    private void external(Uri uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception e) { notice("No browser or map app is available."); }
    }
    private void closeFullScreen() {
        if (fullScreenVideo == null) return;
        container.removeView(fullScreenVideo); fullScreenVideo = null; column.setVisibility(View.VISIBLE);
        if (fullScreenCallback != null) { fullScreenCallback.onCustomViewHidden(); fullScreenCallback = null; }
    }
    private void goBack() {
        if (fullScreenVideo != null) { closeFullScreen(); return; }
        if (web == null) { finish(); return; }
        web.evaluateJavascript("typeof window.sembangAndroidBack === 'function' && window.sembangAndroidBack()", result -> {
            if ("true".equals(result)) return;
            new AlertDialog.Builder(this).setTitle("Exit Zbuddy?").setMessage("Incoming calls and live location require the app to remain open.").setPositiveButton("Exit", (d, w) -> finish()).setNegativeButton("Cancel", null).show();
        });
    }
    @Override public void onBackPressed() { goBack(); }
    static boolean isVisible() { return visible; }
    @Override protected void onPause() { visible = false; super.onPause(); if (web != null) web.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onResume() { super.onResume(); visible = true; if (web != null) web.onResume(); }
    @Override protected void onDestroy() { closeWeb(); network.shutdownNow(); super.onDestroy(); }
}
