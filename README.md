# CLD Hub Store

[CLD Hub](https://github.com/coffeelakedevv/cld-hub-store/releases/latest) mağazasının herkese açık
tarafı. Uygulamanın kaynak kodu ayrı ve gizli bir repoda durur; burada yalnızca mağazanın
okuduğu veriler ve CLD Hub'ın kurulum dosyaları bulunur.

| Ne | Nerede |
|---|---|
| Katalog (CLD Hub bunu okur) | [`catalog.json`](catalog.json) |
| Admin paneli | https://coffeelakedevv.github.io/cld-hub-store/ |
| İndirme istatistikleri (6 saatte bir) | https://coffeelakedevv.github.io/cld-hub-store/stats.json |
| CLD Hub kurulum dosyaları | [Releases](https://github.com/coffeelakedevv/cld-hub-store/releases) |

## Admin paneli

Katalogu tarayıcıdan düzenler, her yayın bu repoya bir commit olur. Bağlanmak için yalnızca
**cld-hub-store** reposuna **Contents: Read and write** izni olan bir
[fine-grained token](https://github.com/settings/personal-access-tokens/new) yeterli. Token
yalnızca tarayıcıdan GitHub'a gönderilir.

Katalog biçimi ve kurulum tipleri için CLD Hub kod reposundaki README'ye bak.

---

© 2026 coffeelakedev. Tüm hakları saklıdır.
