# Ashgrove Vaka Dosyası — Çözüm

Sıfır bağımlılık (sadece Node.js `http` modülü) — kurulum/dağıtım sırasında
bağımlılık hatası riski yok.

## Mimari

- **/events/\*** — Servis 1 (platform olay yayıcısı/alıcısı): `call.ended` ve
  `disposition.selected` olaylarını üretir, HMAC imzalı webhook teslim eder,
  en az bir kez teslim + sıra garantisiz (disposition, call.ended'dan önce
  gelebilir — sistem bunu bekletip otomatik tamamlar) + tekrar teslim
  uçları vardır.
- **/crm/\*** — Servis 2 (HubSpot benzeri CRM mock'u): contacts GET/PATCH,
  deals GET/PATCH (409 çakışma yönetimi + zorunlu
  `ccs_changed_by`/`ccs_change_reason` denetim alanları), activities POST.
- **/campaign/next-list** — Servis 3: `New Lead` aşamasındaki kayıtlardan
  listeyi üretir; bastırma (suppression) uygulanmış/uygulanmamış sorgulanabilir.
- **reconcile()** (üst katman) — disposition geldiğinde deal'i doğru aşamaya
  taşır, mükerrer event'i idempotent şekilde yok sayar, not/kod çelişkisinde
  **otomatik yazmaz**, insan onay kuyruğuna (`reviewQueue`) düşürür. Sonuç
  kodu 45 sn içinde hiç gelmezse çağrı "belirsiz" statüsüne düşer ve onay
  kuyruğuna işaretlenir (deal bilerek New Lead'de bırakılır — sonuç
  bilinmediği için tekrar aranması doğrudur, ama artık görünür/izlenebilir).
- **/dashboard** — host edilmiş ekran, 3 sn'de bir otomatik yenilenir:
  bekleyen çağrı, toplam/bastırılmış hasta sayısı, onay bekleyen kayıtlar,
  deal durumları.
- **/demo/scenario/:name** — zorunlu senaryoları tek istekle üretir:
  `clean-flow`, `no-disposition`, `late-disposition`, `note-conflict`,
  `duplicate-event`, `conflict-409`, `out-of-order`. Her çağrı, 10 demo
  hastasından bir sonrakini kullanır — tekrar tetiklendikçe farklı kayıtlar
  işlenir ve dashboard'daki sayılar buna göre artar.

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
- CRM mock'unda kimlik doğrulama (401) ve rastgele 429/500 simülasyonu şu an
  yok — demo kolaylığı için bilinçli olarak sadeleştirildi; üretimde API-key
  zorunlu olur, 429/500 aynı retry mekanizmasıyla (409'da olduğu gibi) ele
  alınır.
- LLM önerisi şu an kural tabanlı çalışıyor; gerçek bir LLM çağrısı
  `reconcile()` içindeki çelişki bloğuna eklenebilir — tasarım gereği LLM
  deal'i hiçbir zaman doğrudan değiştirmez, öneri her zaman insan onayına
  düşer.
- Ücretsiz hosting katmanında (Render free tier) uzun süre hareketsizlik
  sonrası ilk istekte birkaç saniye gecikme olabilir.
