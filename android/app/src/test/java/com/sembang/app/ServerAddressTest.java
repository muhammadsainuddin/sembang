package com.sembang.app;
import org.junit.Test;
import static org.junit.Assert.*;
public class ServerAddressTest {
    @Test public void normalizesTrustedOrigin() {
        assertEquals("https://chat.example.com", ServerAddress.parse(" https://CHAT.example.com:443/ ").origin);
        assertEquals("http://localhost:3000", ServerAddress.parse("http://localhost:3000").origin);
        assertTrue(ServerAddress.parse("https://chat.example.com").matches("https://chat.example.com/api/me"));
    }
    @Test public void rejectsNonSecureOrCredentialBearingServer() {
        for (String s : new String[]{"http://192.168.1.2:3000", "http://10.0.2.2:3000", "https://user:secret@chat.example.com", "javascript:alert(1)", "file:///data/data", "https://chat.example.com/path", "https://chat.example.com?token=x", "https://chat.example.com#fragment", "https://chat.example.com:0", "https://chat.example.com:99999"}) {
            try { ServerAddress.parse(s); fail(s); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void doesNotTreatLookalikeHostOrPortAsSameOrigin() {
        ServerAddress s = ServerAddress.parse("https://chat.example.com");
        assertFalse(s.matches("https://chat.example.com.attacker.test/path"));
        assertFalse(s.matches("https://chat.example.com:8443/path"));
        assertFalse(s.matches("http://chat.example.com/path"));
        assertFalse(s.matches("https://someone@chat.example.com/path"));
        assertTrue(s.matches("https://chat.example.com:443/path"));
    }
}
