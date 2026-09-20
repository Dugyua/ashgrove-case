# Ashgrove Vaka Dosyası — Çözüm

Sıfır bağımlılık (sadece Node.js `http` modülü). `npm install` gerekmiyor —
deploy sırasında bağımlılık kurulumu patlama riski yok.

## Ne yapıyor?

- **/events/\*** — Servis 1 (platform olay yayıcısı/alıcısı): `call.ended` ve
  `disposition.selected` olaylarını üretir, HMAC imzalı webhook teslim eder,
  en az bir kez teslim + sıra garantisiz + tekrar teslim uçları var.
- **/crm/\*** — Servis 2 (HubSpot benzeri CRM mock'u): contacts/deals GET,
  deals PATCH (409 çakışma + zorunlu `ccs_changed_by`/`ccs_change_reason`
  denetim alanları), activities POST.
- **/campaign/next-list** — Servis 3: `New Lead` aşamasındaki kayıtlardan
  listeyi üretir, bastırma (suppression) uygulanmış/uygulanmamış sorgulanabilir.
- **reconcile()** (dahili katman) — disposition geldiğinde deal'i doğru
  aşamaya taşır, mükerrer event'i idempotent şekilde yok sayar, not/kod
  çelişkisinde **otomatik yazmaz**, insan onay kuyruğuna (`reviewQueue`) atar.
- **/dashboard** — host edilmiş ekran: bekleyen çağrı, bastırılmış hasta
  sayısı, onay bekleyen kayıtlar, deal durumları.
- **/demo/scenario/:name** — Bölüm 8'deki 6 zorunlu senaryoyu tek istekle
  üretir: `clean-flow`, `no-disposition`, `late-disposition`,
  `note-conflict`, `duplicate-event`, `conflict-409`.

## Lokal çalıştırma

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

## Render.com'a deploy (hesabın yoksa, ~10 dakika)

1. **GitHub'a yükle** — github.com'da ücretsiz hesap aç (yoksa), yeni bir repo
   oluştur (`ashgrove-case`), bu klasördeki dosyaları push'la:
   ```bash
   git init && git add . && git commit -m "ashgrove case"
   git branch -M main
   git remote add origin https://github.com/<kullanici-adin>/ashgrove-case.git
   git push -u origin main
   ```
2. **render.com**'da ücretsiz hesap aç (GitHub ile giriş yapabilirsin, kredi
   kartı istemiyor).
3. **New +** → **Web Service** → GitHub reponu seç.
4. Ayarlar:
   - **Environment**: Node
   - **Build Command**: *(boş bırak)*
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. **Deploy** — birkaç dakika içinde `https://ashgrove-case-xxxx.onrender.com`
   gibi canlı bir URL verecek. Bu URL, `/events`, `/crm`, `/campaign`,
   `/dashboard` uçlarının hepsini aynı domain altında barındırıyor.

**Önemli:** Render'ın ücretsiz katmanı 15 dakika hareketsizlikten sonra
uyuyor, ilk istek 30–50 sn gecikebilir. Teslim (5. gün) ve demo (6. gün)
öncesinde servisi bir istekle "uyandır", ideal olarak demodan birkaç dakika
önce `/dashboard`'ı bir kez ziyaret et.

## Eksik / senin tamamlaman gerekenler

- Gerçek bir LLM çağrısı eklemek istersen `reconcile()` içindeki `conflict`
  bloğuna bir API çağrısı ekleyebilirsin (şu an kural tabanlı bir öneri
  üretiyor — bu da savunulabilir bir tasarım kararı, LLM'in deal'i doğrudan
  değiştirmesine izin vermiyoruz).
- Yazılı teslimatlar (müşteri yönetim planı, iç hizalama, devir/kapanış) —
  bunları ayrıca hazırlayacağız.
- Demoda "üç servisi" ayrı adres olarak sunman gerekiyorsa, şu an path bazlı
  ayrım var (`/events`, `/crm`, `/campaign`); tek deploy'da tek URL var.
  Bunun neden bilinçli bir tasarım tercihi olduğunu (zaman kısıtı altında
  operasyonel risk azaltma) teknik derinlik bölümünde savunabilirsin.
