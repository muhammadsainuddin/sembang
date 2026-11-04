package my.aigeo.zbuddy;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.ContentValues;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.MediaStore;
import android.app.KeyguardManager;
import android.view.WindowManager;
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
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.io.OutputStream;
import android.util.Base64;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import com.google.firebase.messaging.FirebaseMessaging;

public final class MainActivity extends Activity {
    private static volatile boolean visible;
    private static final int PICK_IMAGE = 11, CAPTURE_IMAGE = 12, CAPTURE_VIDEO = 13, MEDIA_PERMISSION = 21, LOCATION_PERMISSION = 22, NOTIFICATION_PERMISSION = 23, PICK_NOTIFICATION_SOUND = 31, PICK_CALL_RINGTONE = 32, DEVICE_UNLOCK = 41;
    private static final int BG = 0xFFF8F1FC, PURPLE = 0xFF906BAE, TEXT = 0xFF604971, MUTED = 0xFFA38BAF;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private FrameLayout container, screen;
    private LinearLayout column;
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
    private Uri pendingCameraUri;
    private boolean pendingAcceptsImage = true, pendingAcceptsVideo;
    private View fullScreenVideo;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private SharedPreferences prefs;
    private String pendingConversation;
    private final Handler soundHandler = new Handler(Looper.getMainLooper());
    private Ringtone activeRingtone;
    private Runnable ringtoneRepeater;
    private boolean callActive, backgroundLocationActive, lockShowing, skipNextResumeLock;
    private long backgroundAt;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("sembang", MODE_PRIVATE);
        applyPrivacyFlag();
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
        if (prefs.getBoolean("app_lock", false)) new Handler(Looper.getMainLooper()).postDelayed(this::requestAppUnlock, 350);
    }

    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }
    private TextView text(String value, int size, int color) { TextView t = new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(color); t.setLineSpacing(dp(3), 1); return t; }
    private GradientDrawable rounded(int color, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    private LinearLayout.LayoutParams spaced(int top) { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.topMargin = dp(top); return p; }
    private void notice(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

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
        TextView credit = text("Aigeo · Freelance Programmer\nDeveloped for My Purple", 10, MUTED); credit.setGravity(Gravity.CENTER); form.addView(credit, spaced(26));
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
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { if (view == web) { web = null; runOnUiThread(() -> showSetup("The chat renderer restarted after running low on memory. Reconnect and try the photo again.")); } return true; }
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
                String accepts = String.join(",", params.getAcceptTypes()).toLowerCase(); pendingAcceptsVideo = accepts.contains("video/"); pendingAcceptsImage = accepts.isEmpty() || accepts.contains("image/");
                String[] choices = pendingAcceptsVideo && pendingAcceptsImage ? new String[]{"Take a photo","Record a video","Choose from gallery"} : pendingAcceptsVideo ? new String[]{"Record a video","Choose from gallery"} : new String[]{"Take a photo","Choose from gallery"};
                new AlertDialog.Builder(MainActivity.this).setTitle(pendingAcceptsVideo ? "Add media" : "Add a photo")
                    .setItems(choices, (dialog, which) -> { String choice=choices[which]; if(choice.startsWith("Take"))openCamera(); else if(choice.startsWith("Record"))openVideoCamera(); else openGallery(); })
                    .setOnCancelListener(dialog -> { if (pendingFile != null) pendingFile.onReceiveValue(null); pendingFile = null; }).show();
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

    private void openGallery() {
        Intent pick;
        if (pendingAcceptsImage && !pendingAcceptsVideo) {
            pick = new Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI).setType("image/*");
            if (pick.resolveActivity(getPackageManager()) == null && Build.VERSION.SDK_INT >= 33) pick = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*");
        } else {
            pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.setType(pendingAcceptsImage && pendingAcceptsVideo ? "*/*" : pendingAcceptsVideo ? "video/*" : "image/*");
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.putExtra(Intent.EXTRA_MIME_TYPES, pendingAcceptsVideo ? new String[]{"image/jpeg","image/png","image/webp","video/mp4","video/webm"} : new String[]{"image/jpeg", "image/png", "image/webp", "image/gif"});
        }
        try { startActivityForResult(pick, PICK_IMAGE); } catch (Exception error) { if (pendingFile != null) pendingFile.onReceiveValue(null); pendingFile = null; notice("The gallery is unavailable."); }
    }
    private void openCamera() {
        try {
            ContentValues values = new ContentValues(); values.put(MediaStore.Images.Media.DISPLAY_NAME, "Zbuddy-camera-" + System.currentTimeMillis() + ".jpg"); values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            if (Build.VERSION.SDK_INT >= 29) { values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Zbuddy"); values.put(MediaStore.Images.Media.IS_PENDING, 1); }
            pendingCameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (pendingCameraUri == null) throw new IllegalStateException();
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(camera, CAPTURE_IMAGE);
        } catch (Exception error) { if (pendingCameraUri != null) getContentResolver().delete(pendingCameraUri, null, null); pendingCameraUri = null; if (pendingFile != null) pendingFile.onReceiveValue(null); pendingFile = null; notice("The camera is unavailable."); }
    }
    private void openVideoCamera() {
        try {
            ContentValues values=new ContentValues();values.put(MediaStore.Video.Media.DISPLAY_NAME,"Zbuddy-video-"+System.currentTimeMillis()+".mp4");values.put(MediaStore.Video.Media.MIME_TYPE,"video/mp4");
            if(Build.VERSION.SDK_INT>=29){values.put(MediaStore.Video.Media.RELATIVE_PATH,"Movies/Zbuddy");values.put(MediaStore.Video.Media.IS_PENDING,1);}
            pendingCameraUri=getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,values);if(pendingCameraUri==null)throw new IllegalStateException();
            Intent camera=new Intent(MediaStore.ACTION_VIDEO_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT,pendingCameraUri).putExtra(MediaStore.EXTRA_DURATION_LIMIT,60).putExtra(MediaStore.EXTRA_VIDEO_QUALITY,1).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivityForResult(camera,CAPTURE_VIDEO);
        }catch(Exception error){if(pendingCameraUri!=null)getContentResolver().delete(pendingCameraUri,null,null);pendingCameraUri=null;if(pendingFile!=null)pendingFile.onReceiveValue(null);pendingFile=null;notice("The video camera is unavailable.");}
    }

    private void saveImage(String encoded, String mime, String name) {
        network.execute(() -> {
            Uri uri = null;
            try {
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT); if (bytes.length > 12 * 1024 * 1024) throw new IllegalArgumentException();
                ContentValues values = new ContentValues(); values.put(MediaStore.Images.Media.DISPLAY_NAME, name); values.put(MediaStore.Images.Media.MIME_TYPE, mime.startsWith("image/") ? mime : "image/jpeg");
                if (Build.VERSION.SDK_INT >= 29) { values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Zbuddy"); values.put(MediaStore.Images.Media.IS_PENDING, 1); }
                uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values); if (uri == null) throw new IllegalStateException();
                try (OutputStream output = getContentResolver().openOutputStream(uri)) { if (output == null) throw new IllegalStateException(); output.write(bytes); }
                if (Build.VERSION.SDK_INT >= 29) { ContentValues ready = new ContentValues(); ready.put(MediaStore.Images.Media.IS_PENDING, 0); getContentResolver().update(uri, ready, null, null); }
                runOnUiThread(() -> notice("Photo saved to Pictures/Zbuddy."));
            } catch (Exception error) { if (uri != null) getContentResolver().delete(uri, null, null); runOnUiThread(() -> notice("The photo could not be saved.")); }
        });
    }
    private Bitmap decodeCameraImage(Uri uri) throws Exception {
        if (Build.VERSION.SDK_INT >= 28) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(getContentResolver(), uri), (decoder, info, source) -> {
                int width = info.getSize().getWidth(), height = info.getSize().getHeight(), longest = Math.max(width, height);
                if (longest > 2048) { float scale = 2048f / longest; decoder.setTargetSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))); }
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE); decoder.setMemorySizePolicy(ImageDecoder.MEMORY_POLICY_LOW_RAM);
            });
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
        try (InputStream input = getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(input, null, bounds); }
        int sample = 1; while (Math.max(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = sample; options.inPreferredConfig = Bitmap.Config.RGB_565;
        try (InputStream input = getContentResolver().openInputStream(uri)) { Bitmap bitmap = BitmapFactory.decodeStream(input, null, options); if (bitmap == null) throw new IllegalStateException(); return bitmap; }
    }
    private void finishCameraResult(Uri uri) {
        network.execute(() -> {
            try {
                Bitmap bitmap = decodeCameraImage(uri);
                try (OutputStream output = getContentResolver().openOutputStream(uri, "w")) { if (output == null || !bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output)) throw new IllegalStateException(); }
                bitmap.recycle();
            } catch (Exception error) { runOnUiThread(() -> notice("The full photo was used because Android could not optimise it.")); }
            if (Build.VERSION.SDK_INT >= 29) { ContentValues ready = new ContentValues(); ready.put(MediaStore.Images.Media.IS_PENDING, 0); getContentResolver().update(uri, ready, null, null); }
            runOnUiThread(() -> { ValueCallback<Uri[]> callback = pendingFile; pendingFile = null; pendingCameraUri = null; if (callback != null) callback.onReceiveValue(new Uri[]{uri}); });
        });
    }

    private void applyPrivacyFlag() {
        if (prefs.getBoolean("app_lock", false)) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }
    private String pinHash(String pin, String salt) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] value = (salt + pin).getBytes(StandardCharsets.UTF_8);
            for (int i = 0; i < 12000; i++) value = digest.digest(value);
            StringBuilder result = new StringBuilder(); for (byte b : value) result.append(String.format("%02x", b)); return result.toString();
        } catch (Exception error) { throw new IllegalStateException(error); }
    }
    private void showAppLockSettings() {
        if (!prefs.getBoolean("app_lock", false)) { promptNewPin(); return; }
        new AlertDialog.Builder(this).setTitle("App Lock").setItems(new String[]{"Change PIN", "Disable App Lock"}, (dialog, which) -> verifyPin(() -> {
            if (which == 0) promptNewPin();
            else { prefs.edit().remove("app_lock_pin").remove("app_lock_salt").putBoolean("app_lock", false).apply(); applyPrivacyFlag(); notice("App Lock disabled."); }
        })).setNegativeButton("Cancel", null).show();
    }
    private void promptNewPin() {
        EditText input = new EditText(this); input.setHint("6-digit PIN"); input.setSingleLine(true); input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD); input.setPadding(dp(20), dp(12), dp(20), dp(12));
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Set App Lock PIN").setMessage("Zbuddy will also accept your device screen lock when available.").setView(input).setPositiveButton("Save", null).setNegativeButton("Cancel", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String pin = input.getText().toString(); if (!pin.matches("[0-9]{6}")) { input.setError("Use exactly 6 digits"); return; }
            byte[] random = new byte[16]; new SecureRandom().nextBytes(random); String salt = Base64.encodeToString(random, Base64.NO_WRAP);
            prefs.edit().putBoolean("app_lock", true).putString("app_lock_salt", salt).putString("app_lock_pin", pinHash(pin, salt)).apply(); applyPrivacyFlag(); dialog.dismiss(); notice("App Lock enabled.");
        })); dialog.show();
    }
    private void verifyPin(Runnable success) {
        EditText input = new EditText(this); input.setHint("App Lock PIN"); input.setSingleLine(true); input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD); input.setPadding(dp(20), dp(12), dp(20), dp(12));
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Unlock Zbuddy").setView(input).setPositiveButton("Unlock", null).setCancelable(false).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String salt = prefs.getString("app_lock_salt", ""), expected = prefs.getString("app_lock_pin", "");
            if (!expected.equals(pinHash(input.getText().toString(), salt))) { input.setError("Incorrect PIN"); input.setText(""); return; }
            dialog.dismiss(); lockShowing = false; if (container != null) container.setVisibility(View.VISIBLE); success.run();
        })); dialog.show();
    }
    private void requestAppUnlock() {
        if (!prefs.getBoolean("app_lock", false) || lockShowing || isFinishing()) return;
        lockShowing = true; if (container != null) container.setVisibility(View.INVISIBLE);
        KeyguardManager guard = getSystemService(KeyguardManager.class);
        Intent credential = guard == null ? null : guard.createConfirmDeviceCredentialIntent("Unlock Zbuddy", "Use your fingerprint, face, or device PIN");
        if (credential != null) { try { startActivityForResult(credential, DEVICE_UNLOCK); return; } catch (Exception ignored) {} }
        if (container != null) container.setVisibility(View.VISIBLE); verifyPin(() -> {});
    }

    private final class AndroidBridge {
        @JavascriptInterface public String getFcmToken() { return prefs.getString("fcm_token", ""); }
        @JavascriptInterface public boolean notificationsAllowed() { return Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS); }
        @JavascriptInterface public String getSoundName(String kind) {
            if (!"notification".equals(kind) && !"call".equals(kind)) return "Device default";
            return prefs.getString(kind + "_sound_name", "Device default");
        }
        @JavascriptInterface public void chooseSound(String kind) {
            if (!"notification".equals(kind) && !"call".equals(kind)) return;
            runOnUiThread(() -> openSoundPicker(kind));
        }
        @JavascriptInterface public void startRingtone() { runOnUiThread(() -> startSelectedRingtone()); }
        @JavascriptInterface public void stopRingtone() { runOnUiThread(() -> stopActiveRingtone()); }
        @JavascriptInterface public void saveImage(String data, String mime, String name) { if (data != null && mime != null && name != null && name.matches("[A-Za-z0-9._-]{1,120}")) MainActivity.this.saveImage(data, mime, name); }
        @JavascriptInterface public void setCallActive(boolean active, boolean incoming, String name, boolean video) { runOnUiThread(() -> { callActive = active; try { CallForegroundService.setActive(MainActivity.this, active, incoming, name, video); } catch (Exception error) { if (active) notice("Call notification could not start. Check notification permission."); } }); }
        @JavascriptInterface public void setBackgroundLocationActive(boolean active) { runOnUiThread(() -> { backgroundLocationActive = active; try { LocationForegroundService.setActive(MainActivity.this, active); } catch (Exception error) { if (active) notice("Background location needs Android location permission."); } }); }
        @JavascriptInterface public boolean appLockEnabled() { return prefs.getBoolean("app_lock", false); }
        @JavascriptInterface public void configureAppLock() { runOnUiThread(() -> showAppLockSettings()); }
        @JavascriptInterface public void openServerSettings() { runOnUiThread(() -> showSetup(null)); }
    }

    private String soundValue(String kind) { return prefs.getString(kind + "_sound_uri", "default"); }
    private Uri selectedSound(String kind) {
        String value = soundValue(kind);
        if ("silent".equals(value)) return null;
        if ("default".equals(value)) return RingtoneManager.getDefaultUri("call".equals(kind) ? RingtoneManager.TYPE_RINGTONE : RingtoneManager.TYPE_NOTIFICATION);
        try { return Uri.parse(value); } catch (Exception error) { return null; }
    }
    private void openSoundPicker(String kind) {
        int type = "call".equals(kind) ? RingtoneManager.TYPE_RINGTONE : RingtoneManager.TYPE_NOTIFICATION;
        Intent picker = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, type)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, true)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, selectedSound(kind));
        try { startActivityForResult(picker, "call".equals(kind) ? PICK_CALL_RINGTONE : PICK_NOTIFICATION_SOUND); }
        catch (Exception error) { notice("The Android sound picker is unavailable."); }
    }
    private void savePickedSound(String kind, Uri uri) {
        int type = "call".equals(kind) ? RingtoneManager.TYPE_RINGTONE : RingtoneManager.TYPE_NOTIFICATION;
        Uri defaultUri = RingtoneManager.getDefaultUri(type);
        String value = uri == null ? "silent" : uri.equals(defaultUri) ? "default" : uri.toString();
        String name = uri == null ? "Silent" : "Device default";
        if (uri != null) {
            try { Ringtone tone = RingtoneManager.getRingtone(this, uri); if (tone != null) name = tone.getTitle(this); }
            catch (Exception ignored) {}
        }
        prefs.edit().putString(kind + "_sound_uri", value).putString(kind + "_sound_name", name).apply();
        if ("notification".equals(kind)) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            for (NotificationChannel channel : manager.getNotificationChannels()) if (channel.getId().startsWith("zbuddy_messages_")) manager.deleteNotificationChannel(channel.getId());
        }
        if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('zbuddy:sound-changed'))", null);
    }
    private void startSelectedRingtone() {
        stopActiveRingtone();
        Uri uri = selectedSound("call"); if (uri == null) return;
        try {
            activeRingtone = RingtoneManager.getRingtone(this, uri); if (activeRingtone == null) return;
            if (Build.VERSION.SDK_INT >= 28) activeRingtone.setLooping(true);
            activeRingtone.play();
            if (Build.VERSION.SDK_INT < 28) {
                ringtoneRepeater = new Runnable() { @Override public void run() {
                    if (activeRingtone == null) return;
                    if (!activeRingtone.isPlaying()) activeRingtone.play();
                    soundHandler.postDelayed(this, 1200);
                }};
                soundHandler.postDelayed(ringtoneRepeater, 1200);
            }
        } catch (Exception error) { stopActiveRingtone(); }
    }
    private void stopActiveRingtone() {
        if (ringtoneRepeater != null) soundHandler.removeCallbacks(ringtoneRepeater);
        ringtoneRepeater = null;
        if (activeRingtone != null) { try { activeRingtone.stop(); } catch (Exception ignored) {} }
        activeRingtone = null;
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
        if (requestCode == DEVICE_UNLOCK) {
            if (resultCode == RESULT_OK) { lockShowing = false; if (container != null) container.setVisibility(View.VISIBLE); }
            else { if (container != null) container.setVisibility(View.VISIBLE); verifyPin(() -> {}); }
            return;
        }
        if ((requestCode == PICK_NOTIFICATION_SOUND || requestCode == PICK_CALL_RINGTONE) && resultCode == RESULT_OK && data != null) {
            Uri uri = data.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
            savePickedSound(requestCode == PICK_CALL_RINGTONE ? "call" : "notification", uri);
            return;
        }
        if (requestCode == PICK_IMAGE && pendingFile != null) {
            skipNextResumeLock = true; backgroundAt = System.currentTimeMillis();
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            try {
                String mime = uri == null ? null : getContentResolver().getType(uri);
                if (uri != null && (!"content".equals(uri.getScheme()) || mime == null || !(pendingAcceptsImage && mime.startsWith("image/") || pendingAcceptsVideo && mime.startsWith("video/")))) uri = null;
            } catch (Exception e) { uri = null; }
            pendingFile.onReceiveValue(uri == null ? null : new Uri[]{uri}); pendingFile = null;
        }
        if(requestCode==CAPTURE_VIDEO&&pendingFile!=null){Uri uri=resultCode==RESULT_OK?pendingCameraUri:null;skipNextResumeLock=true;backgroundAt=System.currentTimeMillis();if(pendingCameraUri!=null&&Build.VERSION.SDK_INT>=29){ContentValues ready=new ContentValues();ready.put(MediaStore.Video.Media.IS_PENDING,0);getContentResolver().update(pendingCameraUri,ready,null,null);}if(resultCode!=RESULT_OK&&pendingCameraUri!=null)getContentResolver().delete(pendingCameraUri,null,null);pendingFile.onReceiveValue(uri==null?null:new Uri[]{uri});pendingFile=null;pendingCameraUri=null;}
        if (requestCode == CAPTURE_IMAGE && pendingFile != null) {
            Uri uri = resultCode == RESULT_OK ? pendingCameraUri : null;
            skipNextResumeLock = true; backgroundAt = System.currentTimeMillis();
            if (uri != null) finishCameraResult(uri);
            else { if (pendingCameraUri != null) getContentResolver().delete(pendingCameraUri, null, null); pendingFile.onReceiveValue(null); pendingFile = null; pendingCameraUri = null; }
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
    @Override protected void onPause() { visible = false; backgroundAt = System.currentTimeMillis(); super.onPause(); if (web != null && !callActive && !backgroundLocationActive) web.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onResume() { super.onResume(); visible = true; if (web != null) web.onResume(); boolean skipLock = skipNextResumeLock; skipNextResumeLock = false; if (!skipLock && prefs != null && prefs.getBoolean("app_lock", false) && backgroundAt > 0 && System.currentTimeMillis() - backgroundAt > 30000 && !callActive) new Handler(Looper.getMainLooper()).postDelayed(this::requestAppUnlock, 150); }
    @Override protected void onDestroy() { stopActiveRingtone(); if (isFinishing()) { CallForegroundService.setActive(this, false, false, "", false); LocationForegroundService.setActive(this, false); } closeWeb(); network.shutdownNow(); super.onDestroy(); }
}
