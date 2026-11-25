# RoboSim

محاكي روبوتات يعمل في المتصفح (الهدف: Chromebook). مشروع واحد بملف `package.json` واحد.

## الهيكل (مجلدان فقط)
```
backend/     محرك المحاكاة: العقود والبروتوكول، Rapier، الساعة، الذاكرة المشتركة، sim.worker.ts
frontend/    الصفحة: index.html + main.ts + public/_headers (الواجهة والرسم لاحقاً)
```
قاعدة الاعتماد: `frontend` يستورد من `backend`، و`backend` لا يستورد من `frontend`.

**خارج المشروع:** أي Cloudflare Workers أو قاعدة SQL (مثل D1) أو خادم لاحق تُبنى منفصلة
خارج هذين المجلدين، ولا تدخل في هذا المشروع الآن.

## التشغيل المحلي
```bash
npm install
npm run dev        # http://localhost:5173
npm test
```
افتح الصفحة: يجب أن تظهر ✔ أمام `crossOriginIsolated`، وتسقط 50 صندوقاً وتستقر على الأرض.

## النشر على Cloudflare
**الطريقة 1: من الطرفية**
```bash
npm run cf:preview   # معاينة محلية بنفس ترويسات الإنتاج
npm run deploy       # يطلب تسجيل الدخول أول مرة
```
**الطريقة 2: ربط GitHub** (Workers & Pages ← Import a repository)
- Build command: `npm install && npm run build`
- Deploy command: `npx wrangler deploy`
- متغير بيئة: `NODE_VERSION = 20`

الترويسات `COOP/COEP` مطلوبة لـSharedArrayBuffer وتأتي من `frontend/public/_headers`.
تنبيه COEP: لا تحمّل صوراً أو سكربتات من نطاقات خارجية؛ ضع كل الأصول على نفس النطاق.

## الخارطة
- [x] 0 التأسيس
- [x] 1 نواة المحاكاة (Rapier في Worker، بانتظار اختبار الجهاز)
- [ ] 2 الرسم ثلاثي الأبعاد (Three.js)
- [ ] 3 الروبوت الأول والمحركات
- [ ] 4 الحساسات
- [ ] 5 نظام الوحدات (Plugins)
- [ ] 6 بيئة البرمجة (محرر + API)
- [ ] 7 Python (Pyodide)
- [ ] 8 محرر العوالم والمشاريع
- [ ] 9+ أذرع، أرجل، طيران، سباحة، تعلم معزز، راديو
