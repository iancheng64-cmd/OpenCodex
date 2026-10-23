// One-time read of OpenCodex's legacy encryption key. Never displays UI,
// changes keychain ACLs, or deletes the source. Only the parent receives bytes.
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 75;
    const char *service = "OpenCodex Safe Storage", *account = "OpenCodex";
    UInt32 length = 0; void *data = NULL;
    OSStatus status = SecKeychainFindGenericPassword(NULL, (UInt32)strlen(service), service,
        (UInt32)strlen(account), account, &length, &data, NULL);
    if (status == errSecItemNotFound) return 44;
    if (status != errSecSuccess) return 75;
    int valid = length == 64;
    for (UInt32 i = 0; valid && i < length; i++) {
        unsigned char c = ((unsigned char *)data)[i];
        valid = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    }
    int result = valid && fwrite(data, 1, length, stdout) == length && fflush(stdout) == 0 ? 0 : 76;
    if (data) { memset(data, 0, length); SecKeychainItemFreeContent(NULL, data); }
    return result;
}
