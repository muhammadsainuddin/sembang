package my.aigeo.zbuddy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public final class LocationForegroundService extends Service {
    private static final String CHANNEL = "zbuddy_live_location";
    private PowerManager.WakeLock wakeLock;
    static void setActive(Context context, boolean active) {
        Intent intent = new Intent(context, LocationForegroundService.class);
        if (!active) { context.stopService(intent); return; }
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
    }
    @Override public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Live location", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Zbuddy shares your live location"); getSystemService(NotificationManager.class).createNotificationChannel(channel);
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Zbuddy:Location"); wakeLock.acquire();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 9, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_brand).setContentTitle("Zbuddy live location")
            .setContentText("Your location is being shared. Tap to open or stop it.").setContentIntent(pending).setOngoing(true).setCategory(Notification.CATEGORY_SERVICE).setVisibility(Notification.VISIBILITY_PRIVATE).build();
        startForeground(802, notification); return START_NOT_STICKY;
    }
    @Override public void onDestroy() { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
