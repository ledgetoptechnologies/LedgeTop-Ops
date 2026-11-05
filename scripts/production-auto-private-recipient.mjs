/** Separate reviewed trust pin for encrypted private release response artifacts.
 * The public key only enables response sealing. Release enablement, authority,
 * readiness, credentials, and profile gates remain independently required.
 */
export const PRODUCTION_AUTO_JOURNAL_RECIPIENT = Object.freeze({
  schemaVersion: 1,
  keyIdSha256: 'a7249feb83c26c1a00c800384b8fc036f421a34dc29e68226a14c40ee71327fa',
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA2pwJyFiuWR7YIaZcsNvw\nJ7yO+rlAMZ71J2B3uWBb0pqNati23FHSv74jMgIykc98TuWiJ5D5vFSwKjAa9OvU\nT+7UC02tb+XFw0paknQu30Bds+cVJmUG/KYXiIU+rJKdBEwZGrX97TaM9MpbalM7\nvX1IGcmtBRrZZPC7p0a4L5fuoBLq57Rf1TvsV0KHAFd0p86ZAbKcuBxMB4rFMqAA\nx9R6cdxo8/GJhN9Mh5m0Oh+6TI4ajxNapBKtewI/7T4gcIpU0nyC3vmkvaR+BgH8\nAtNM7xPTqdG99iNQXvgzlLyfYnUp/zRF1pkV1oc7jraS1XRGvI5yubJhZI2eZwRg\nsc5quQI60T0XFib6sVeBGF/Ewsd9FuKPnYJgoetkUy+IrYbGOpZg/PEfxiobrU8h\nmKxi5820I6TKPgA5AtHSQ/LriRS5xbQ74tsXaW48agQg4r/TpQtWPrsqxOS+t7zK\npP5lCn9OaVmCgVNSlt+QcZZ1tNPQgy0LLYqYUxm4ER7xAgMBAAE=\n-----END PUBLIC KEY-----\n",
});
