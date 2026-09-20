# Ashgrove Vaka Dosyası — Çözüm

Sıfır bağımlılık (sadece Node.js `http` modülü) — kurulum/dağıtım sırasında
bağımlılık hatası riski yok.

## Mimari

- **/events/\*** — Servis 1 (platform olay yayıcısı/alıcısı): `call.ended` ve
  `disposition.selected` olaylarını üretir, HMAC imzalı webhook teslim eder,
  en az bir kez teslim + sıra garantisiz + tekrar teslim uçları vardır.
- **/crm/\*** — Servis 2 (HubSpot benzeri CRM mock'u): contacts/deals GET,
  deals PATCH (409 çakışma yönetimi + zorunlu `ccs_changed_by`/`ccs_change_reason`
  denetim alanları), activities POST.
- **/campaign/next-list** — Servis 3: `New Lead` aşamasındaki kayıtlardan
  listeyi üretir; bastırma (suppression) uygulanmış/uygulanmamış sorgulanabilir.
- **reconcile()** (üst katman) — disposition geldiğinde deal'i doğru aşamaya
  taşır, mükerrer event'i idempotent şekilde yok sayar, not/kod çelişkisinde
  **otomatik yazmaz**, insan onay kuyruğuna (`reviewQueue`) düşürür.
- **/dashboard** — host edilmiş ekran: bekleyen çağrı, bastırılmış hasta
  sayısı, onay bekleyen kayıtlar, deal durumları.
- **/demo/scenario/:name** — altı zorunlu senaryoyu tek istekle üretir:
  `clean-flow`, `no-disposition`, `late-disposition`, `note-conflict`,
  `duplicate-event`, `conflict-409`.

Üstteki eşleştirme/yönetişim katmanı, n8n yerine bağımlılıksız tek bir servis
olarak kuruldu; üç servis path bazlı ayrı adreslerde (`/events`, `/crm`,
`/campaign`) çalışıyor. Bu mimari, aynı mantığın ileride ayrı süreçlere veya
n8n workflow'una taşınmasını engellemez.

## Çalıştırma

```bash
node server.js
# http://localhost:3000/dashboard
```

## Hızlı test

```bash
curl -X POST localhost:3000/demo/scenario/clean-flow
curl localhost:3000/campaign/next-list          # randevulu hasta artık listede değil
curl localhost:3000/dashboard
```

## Bilinen sınırlar

- Veri deposu in-memory'dir (demo amaçlı); üretimde Postgres/Redis gibi
  kalıcı bir depoya taşınması gerekir.
- LLM önerisi şu an kural tabanlı çalışıyor; gerçek bir LLM çağrısı
  `reconcile()` içindeki çelişki bloğuna eklenebilir — tasarım gereği LLM
  deal'i hiçbir zaman doğrudan değiştirmez, öneri her zaman insan onayına
  düşer.
- Ücretsiz hosting katmanında (Render free tier) uzun süre hareketsizlik
  sonrası ilk istekte birkaç saniye gecikme olabilir.
