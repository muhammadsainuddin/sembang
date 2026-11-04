package my.aigeo.zbuddy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public final class ZbuddyMessagingService extends FirebaseMessagingService {
    private static final String CHANNEL_PREFIX = "zbuddy_messages_";

    @Override public void onNewToken(String token) {
        getSharedPreferences("sembang", MODE_PRIVATE).edit().putString("fcm_token", token).apply();
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        if (MainActivity.isVisible()) return;
        Map<String, String> data = message.getData();
        String title = clean(data.get("title"), "Zbuddy", 100);
        String body = clean(data.get("body"), "New message", 200);
        String conversation = data.get("conversationId");
        if (conversation == null || !conversation.matches("[a-f0-9-]{36}")) conversation = null;

        NotificationManager manager = getSystemService(NotificationManager.class);
        String selected = getSharedPreferences("sembang", MODE_PRIVATE).getString("notification_sound_uri", "default");
        Uri sound = "silent".equals(selected) ? null : "default".equals(selected) ? RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION) : Uri.parse(selected);
        String channelId = CHANNEL_PREFIX + Integer.toHexString(selected.hashCode());
        NotificationChannel channel = new NotificationChannel(channelId, "Messages", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Private Zbuddy message notifications");
        channel.enableLights(true); channel.setLightColor(Color.rgb(144, 107, 174));
        channel.enableVibration(!"silent".equals(selected));
        channel.setSound(sound, sound == null ? null : new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        manager.createNotificationChannel(channel);

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (conversation != null) open.putExtra("conversation", conversation);
        int requestCode = conversation == null ? 1 : conversation.hashCode();
        PendingIntent pending = PendingIntent.getActivity(this, requestCode, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_brand).setContentTitle(title).setContentText(body)
            .setCategory(Notification.CATEGORY_MESSAGE).setAutoCancel(true).setContentIntent(pending)
            .setShowWhen(true).build();
        manager.notify(requestCode, notification);
    }

    private String clean(String value, String fallback, int max) {
        if (value == null) return fallback;
        value = value.replaceAll("[\\r\\n\\t]", " ").trim();
        return value.isEmpty() ? fallback : value.substring(0, Math.min(value.length(), max));
    }
}
