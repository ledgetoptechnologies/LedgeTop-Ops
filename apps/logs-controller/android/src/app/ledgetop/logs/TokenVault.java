package app.ledgetop.logs;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keeps device tokens encrypted at rest. The AES-256-GCM key is generated inside the Android Keystore and
 * can't be exported or read by anything, including this app. Only ciphertext is written to storage.
 * The key doesn't require the screen to be unlocked each time, so the controller can sign in and upload
 * by itself after it boots.
 */
final class TokenVault {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "ledgetop-logs-device-token-v1";

    private TokenVault() {}

    private static SecretKey key() throws GeneralSecurityException {
        KeyStore store;
        try { store = KeyStore.getInstance(KEYSTORE); store.load(null); }
        catch (java.io.IOException e) { throw new GeneralSecurityException(e); }
        KeyStore.Entry entry = store.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    /** Encrypts a token; returns "iv:ciphertext" (both base64) for storage. */
    static String seal(String token) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] sealed = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
    }

    /** Decrypts a stored value, or returns null if it's missing, damaged or the key is gone. */
    static String open(String stored) {
        if (stored == null) return null;
        int split = stored.indexOf(':');
        if (split <= 0) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(stored.substring(0, split), Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(stored.substring(split + 1), Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return null;
        }
    }
}
