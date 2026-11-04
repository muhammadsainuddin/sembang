package my.aigeo.zbuddy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public final class CallForegroundService extends Service {
    private static final String CHANNEL = "zbuddy_active_calls";
    private PowerManager.WakeLock wakeLock;
    private AudioManager audio;
    private AudioFocusRequest focus;

    static void setActive(Context context, boolean active, boolean incoming, String name, boolean video) {
        Intent intent = new Intent(context, CallForegroundService.class);
        if (!active) { context.stopService(intent); return; }
        intent.putExtra("name", name); intent.putExtra("video", video); intent.putExtra("incoming", incoming);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Active calls", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Keeps Zbuddy calls active when the screen is off"); channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Zbuddy:Call"); wakeLock.acquire();
        audio = getSystemService(AudioManager.class); audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= 26) {
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()).build();
            audio.requestAudioFocus(focus);
        } else audio.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String name = intent == null ? "your friend" : intent.getStringExtra("name"); boolean video = intent != null && intent.getBooleanExtra("video", false), incoming = intent != null && intent.getBooleanExtra("incoming", false);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 8, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_brand).setContentTitle(video ? "Zbuddy video call" : "Zbuddy voice call")
            .setContentText("Call with " + (name == null || name.isEmpty() ? "your friend" : name)).setContentIntent(pending).setOngoing(true).setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PRIVATE).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(801, notification, incoming ? 0 : ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | (video ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA : 0));
        else startForeground(801, notification);
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (audio != null) { if (Build.VERSION.SDK_INT >= 26 && focus != null) audio.abandonAudioFocusRequest(focus); else audio.abandonAudioFocus(null); audio.setMode(AudioManager.MODE_NORMAL); }
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
