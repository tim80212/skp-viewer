// 分享連結的著作權與使用聲明（v0.6.0）。
// ★ 要改聲明文字：只改下面 NOTICE 這一段（Markdown：## 標題、1. 編號、- 項目、**粗體**），存檔後重新發布網頁。
//   { } 裡的欄位由程式帶入，可用的欄位：
//   {收件人稱呼}（分享時填的，只放在連結 # 後面）{代號} {到期日} {設計公司名稱} {聯絡方式}（桌面程式「分享設定」填的）
// 原稿：提案\分享聲明稿_v1.md（主管２號草稿 v1）。唯一的增補：第 4 點最後一行（IP 是用第三方服務查的，要告知）。

export const NOTICE = `
## 著作權與使用聲明

此連結僅提供 **{收件人稱呼}** 個人瀏覽（分享代號 **#{代號}**），有效期限到 **{到期日}**。

1. **著作權**：本 3D 模型和其中的設計內容（含平面配置、立面、造型、材質搭配），著作權都屬於 {設計公司名稱}，受著作權法保護。您只取得在本頁面上線上檢視的權利，不包括其他任何權利。
2. **禁止事項**：沒有 {設計公司名稱} 的書面同意，不得：
   - 轉傳本連結，或用任何方式讓第三人參閱；
   - 下載、擷取、截圖或錄影後散布；
   - 複製、修改本模型，或用於比價、估價、發包、施工，或用在其他案件。
3. **隱私**：本模型可能含有業主住家格局等個人資料，請妥善保密，不要外流。
4. **開啟紀錄**：為了管理分享和保障上述權利，每次開啟本連結時，系統會記錄以下資料並提供給 {設計公司名稱}：
   - 開啟時間；
   - IP 位址；
   - 裝置類型（手機／平板／電腦）、作業系統和瀏覽器。

   這些資料只用於分享管理和權利保護。分享結束後保存一年就會刪除；如果發生爭議，會保存到爭議處理完畢。
   （IP 位址是由公開的 IP 查詢服務 ipify.org 回報給本頁面。）
5. **追溯責任**：畫面上有您的專屬分享代號。如果經查本連結或內容被提供給第三人，{設計公司名稱} 會依開啟紀錄和分享代號追查來源，並依著作權法、民法等相關法律追究責任。
6. 本聲明不影響雙方另外簽訂的合約。有任何問題請聯絡 {設計公司名稱}：{聯絡方式}。

按「我同意並開啟」，代表您已經閱讀並同意以上內容。
`;

export const AGREE = '我同意並開啟';
export const DISAGREE = '不同意';

// PDF 文件（v0.7.0）：同一份聲明，把下面左邊的字換成右邊（照順序換，所以「3D 模型」要排在「模型」前面）
export const PDF_WORDS = [['本 3D 模型', '本文件'], ['3D 模型', '文件'], ['本模型', '本文件']];

// 欄位沒有值時顯示的文字
export const FALLBACK = {
  收件人稱呼: '本連結的收件人',
  設計公司名稱: '本設計公司',
  聯絡方式: '分享本連結給您的人',
};

// 查詢收件人 IP 的服務（Apps Script 看不到 IP，只能由網頁問第三方）。改成空字串就不記 IP。
export const IP_SERVICE = 'https://api.ipify.org?format=json';

// ---- 以下是把上面的文字轉成畫面（不用改）----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderNotice(fields, text = NOTICE, kind = '') {
  if (kind === 'pdf') for (const [a, b] of PDF_WORDS) text = text.split(a).join(b);
  const fill = (s) => esc(s).replace(/\{([^{}]{1,10})\}/g, (m, k) => {
    const v = fields[k] || FALLBACK[k];
    return v ? esc(v) : m;
  });
  const inline = (s) => fill(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const lines = text.replace(/\r/g, '').split('\n');
  let html = '';
  let inOl = false;
  let inUl = false;
  let inLi = false;
  const closeUl = () => { if (inUl) { html += '</ul>'; inUl = false; } };
  const closeLi = () => { closeUl(); if (inLi) { html += '</li>'; inLi = false; } };
  const closeOl = () => { closeLi(); if (inOl) { html += '</ol>'; inOl = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) continue;
    if ((m = line.match(/^##\s+(.*)/))) { closeOl(); html += `<h2>${inline(m[1])}</h2>`; continue; }
    if ((m = line.match(/^(\d+)\.\s+(.*)/))) {
      closeLi();
      if (!inOl) { html += '<ol>'; inOl = true; }
      html += `<li value="${m[1]}">${inline(m[2])}`;
      inLi = true;
      continue;
    }
    if ((m = line.match(/^\s+-\s+(.*)/)) && inLi) {
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    if (/^\s+/.test(line) && inLi) { closeUl(); html += `<p>${inline(line.trim())}</p>`; continue; }
    closeOl();
    html += `<p>${inline(line.trim())}</p>`;
  }
  closeOl();
  return html;
}
