# Apple root certificate provenance

Downloaded from the [official Apple PKI page](https://www.apple.com/certificateauthority/)
on 2026-08-17. `apple-root-ca.pem` contains only these public trust anchors:

| Certificate        | Official source                                                 | SHA-256 fingerprint                                                                               |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Apple Root CA      | `https://www.apple.com/appleca/AppleIncRootCertificate.cer`     | `B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24` |
| Apple Root CA - G2 | `https://www.apple.com/certificateauthority/AppleRootCA-G2.cer` | `C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50` |
| Apple Root CA - G3 | `https://www.apple.com/certificateauthority/AppleRootCA-G3.cer` | `63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79` |

Review Apple PKI and the official App Store Server Library release notes before
changing this trust store. Certificate additions or removals require a reviewed
pull request and a successful JWS sandbox test.
